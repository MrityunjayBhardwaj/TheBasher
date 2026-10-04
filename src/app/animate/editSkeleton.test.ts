import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applySkeletonEdit, boneNameFor, type SkeletonEdit } from './editSkeleton';
import { boneWorldMatrices } from '../../viewport/boneShape';
import type { BoneSpec } from '../../nodes/types';

// A chain with turns and a (uniform) scale in it, and a branch, so a world/local mix-up shows:
//   Hips → Spine → Chest → Neck, and Chest → Arm (a branch). A NON-uniform scale is its own case at
//   the end: under one, a rotated joint's world carries shear, which no joint transform can hold.
const RIG: BoneSpec[] = [
  { name: 'Hips', parent: -1, position: [0, 1, 0], rotation: [0, 0.3, 0] },
  {
    name: 'Spine',
    parent: 0,
    position: [0, 0.4, 0.05],
    rotation: [0.2, 0, 0],
    scale: [1.2, 1.2, 1.2],
  },
  { name: 'Chest', parent: 1, position: [0, 0.35, 0], rotation: [0, 0, 0.4] },
  { name: 'Neck', parent: 2, position: [0, 0.3, 0], rotation: [-0.1, 0, 0] },
  { name: 'Arm', parent: 2, position: [0.2, 0.25, 0], rotation: [0, 0, -1.2] },
];

const worldOf = (bones: readonly BoneSpec[]) => {
  const w = boneWorldMatrices(bones);
  return new Map(bones.map((b, i) => [b.name, w[i]]));
};
function expectSameWorld(a: THREE.Matrix4, b: THREE.Matrix4, what: string) {
  a.elements.forEach((x, i) => expect(x, `${what} [${i}]`).toBeCloseTo(b.elements[i], 9));
}
function run(edit: SkeletonEdit, bones: readonly BoneSpec[] = RIG) {
  const r = applySkeletonEdit(bones, edit);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const parentName = (bones: readonly BoneSpec[], name: string) => {
  const b = bones.find((x) => x.name === name)!;
  return b.parent < 0 ? null : bones[b.parent].name;
};

describe('#1339 — names a bone op gives are channel-safe and unique', () => {
  it('strips the path separators and suffixes with _001, never .001', () => {
    expect(boneNameFor('Arm.L', new Set())).toBe('Arm_L');
    expect(boneNameFor('a[0]:b/c', new Set())).toBe('a_0__b_c');
    expect(boneNameFor('Bone', new Set(['Bone']))).toBe('Bone_001');
    expect(boneNameFor('Bone_001', new Set(['Bone', 'Bone_001']))).toBe('Bone_002');
    expect(boneNameFor('  ', new Set())).toBe('Bone');
  });
});

describe('#1339 — every op keeps the joints it did not move where they stand', () => {
  const before = worldOf(RIG);

  it('extrude adds a child at the end of the list, continuing the chain by default', () => {
    const r = run({ op: 'extrude', from: 'Neck' });
    expect(r.bones.slice(0, 5)).toEqual(RIG);
    expect(r.added).toEqual(['Neck_001']);
    const tip = r.bones[5];
    expect([tip.parent, tip.position]).toEqual([3, [0, 0.3, 0]]);
    // A root extrudes one unit up.
    expect(run({ op: 'extrude', from: 'Hips' }).bones[5].position).toEqual([0, 1, 0]);
  });

  it('subdivide splits the link into equal pieces, and the child does not move', () => {
    const r = run({ op: 'subdivide', bone: 'Spine', cuts: 2 });
    expect(r.added).toEqual(['Spine_001', 'Spine_002']);
    expect(parentName(r.bones, 'Spine_001')).toBe('Spine');
    expect(parentName(r.bones, 'Spine_002')).toBe('Spine_001');
    expect(parentName(r.bones, 'Chest')).toBe('Spine_002');
    const after = worldOf(r.bones);
    for (const b of RIG) expectSameWorld(after.get(b.name)!, before.get(b.name)!, b.name);
    // The pieces lie on the link, a third and two thirds of the way.
    const s = new THREE.Vector3().setFromMatrixPosition(before.get('Spine')!);
    const c = new THREE.Vector3().setFromMatrixPosition(before.get('Chest')!);
    const p1 = new THREE.Vector3().setFromMatrixPosition(after.get('Spine_001')!);
    expect(p1.distanceTo(s.clone().lerp(c, 1 / 3))).toBeLessThan(1e-9);
  });

  it('subdivide refuses a joint with no child, or with two, by saying which', () => {
    expect(applySkeletonEdit(RIG, { op: 'subdivide', bone: 'Neck', cuts: 1 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no child/),
    });
    expect(applySkeletonEdit(RIG, { op: 'subdivide', bone: 'Chest', cuts: 1 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/2 children/),
    });
  });

  it('delete with reparent gives the children to the parent, without leaves them roots; both keep their place', () => {
    for (const reparent of [true, false]) {
      const r = run({ op: 'delete', bone: 'Chest', reparent });
      expect(r.bones.map((b) => b.name)).toEqual(['Hips', 'Spine', 'Neck', 'Arm']);
      expect(parentName(r.bones, 'Neck')).toBe(reparent ? 'Spine' : null);
      expect(parentName(r.bones, 'Arm')).toBe(reparent ? 'Spine' : null);
      const after = worldOf(r.bones);
      for (const n of ['Hips', 'Spine', 'Neck', 'Arm'])
        expectSameWorld(after.get(n)!, before.get(n)!, n);
    }
  });

  it('delete keeps the last bone', () => {
    expect(applySkeletonEdit([RIG[0]], { op: 'delete', bone: 'Hips', reparent: true }).ok).toBe(
      false,
    );
  });

  it('parent keeps the bone where it stands, and refuses a loop', () => {
    const r = run({ op: 'parent', bone: 'Arm', parent: 'Hips' });
    expect(parentName(r.bones, 'Arm')).toBe('Hips');
    expectSameWorld(worldOf(r.bones).get('Arm')!, before.get('Arm')!, 'Arm');
    const cleared = run({ op: 'parent', bone: 'Arm', parent: null });
    expect(parentName(cleared.bones, 'Arm')).toBeNull();
    expectSameWorld(worldOf(cleared.bones).get('Arm')!, before.get('Arm')!, 'Arm');
    expect(applySkeletonEdit(RIG, { op: 'parent', bone: 'Spine', parent: 'Neck' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/loop/),
    });
  });

  it('reroot reverses the path to the old root and moves nothing', () => {
    const r = run({ op: 'reroot', bone: 'Neck' });
    expect(parentName(r.bones, 'Neck')).toBeNull();
    expect(parentName(r.bones, 'Chest')).toBe('Neck');
    expect(parentName(r.bones, 'Spine')).toBe('Chest');
    expect(parentName(r.bones, 'Hips')).toBe('Spine');
    expect(parentName(r.bones, 'Arm')).toBe('Chest');
    const after = worldOf(r.bones);
    for (const b of RIG) expectSameWorld(after.get(b.name)!, before.get(b.name)!, b.name);
  });

  it('transform moves the joint; children follow it, or stay where they stand', () => {
    const follow = run({
      op: 'transform',
      bone: 'Chest',
      position: [0.1, 0.5, 0],
      children: 'follow',
    });
    expect(follow.bones[2].position).toEqual([0.1, 0.5, 0]);
    // Following: the children's local transforms are untouched, so their world moves.
    expect(follow.bones[3]).toEqual(RIG[3]);
    const stay = run({
      op: 'transform',
      bone: 'Chest',
      rotation: [0.5, 0.2, -0.3],
      scale: [2, 2, 2],
      children: 'stay',
    });
    const after = worldOf(stay.bones);
    for (const n of ['Neck', 'Arm']) expectSameWorld(after.get(n)!, before.get(n)!, n);
  });

  it('names a bone that is not there, with the bones that are', () => {
    expect(applySkeletonEdit(RIG, { op: 'extrude', from: 'Tail' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/"Tail" is not on this skeleton.*Hips, Spine/),
    });
  });

  it('under a non-uniform scale, the heads stay exactly where they stand', () => {
    // A joint's transform is position, rotation and scale: it cannot hold the shear a rotated
    // joint picks up under a non-uniformly scaled parent, in Basher as in Maya and Houdini. What
    // every op keeps exactly is where each joint's head is.
    const squashed = RIG.map((b) =>
      b.name === 'Spine' ? { ...b, scale: [1, 1.6, 0.8] as [number, number, number] } : b,
    );
    const head = (bones: readonly BoneSpec[]) =>
      new Map(
        [...worldOf(bones)].map(([n, m]) => [n, new THREE.Vector3().setFromMatrixPosition(m)]),
      );
    const was = head(squashed);
    for (const edit of [
      { op: 'delete', bone: 'Chest', reparent: true },
      { op: 'parent', bone: 'Arm', parent: 'Hips' },
      { op: 'reroot', bone: 'Neck' },
      { op: 'transform', bone: 'Chest', scale: [1, 2, 1], children: 'stay' },
    ] as SkeletonEdit[]) {
      const now = head(run(edit, squashed).bones);
      for (const [n, p] of now)
        expect(p.distanceTo(was.get(n)!), `${edit.op}: ${n}`).toBeLessThan(1e-9);
    }
  });
});

describe('#1340 — orient and roll: each mode against a hand-computed frame', () => {
  // A → B → C with heads at (0,0,0), (1,0,0), (1,1,0), each joint turned arbitrarily so no frame
  // starts aligned: B's +Y must be turned to aim at C, and its +Z to the mode's direction.
  const CHAIN: BoneSpec[] = (() => {
    const heads = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ];
    const turns = [
      [0.4, -0.7, 0.2],
      [1.1, 0.3, -0.5],
      [-0.2, 0.9, 0.6],
    ];
    // Locals that put each head where listed, under its parent's turned frame.
    const out: BoneSpec[] = [];
    let parentWorld = new THREE.Matrix4();
    heads.forEach((h, i) => {
      const world = new THREE.Matrix4().compose(
        new THREE.Vector3(...h),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...(turns[i] as [number, number, number]), 'XYZ'),
        ),
        new THREE.Vector3(1, 1, 1),
      );
      const local = parentWorld.clone().invert().multiply(world);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      local.decompose(p, q, new THREE.Vector3());
      const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
      out.push({
        name: 'ABC'[i],
        parent: i - 1,
        position: [p.x, p.y, p.z],
        rotation: [e.x, e.y, e.z],
      });
      parentWorld = world;
    });
    return out;
  })();
  const was = worldOf(CHAIN);
  const axes = (bones: readonly BoneSpec[], name: string) => {
    const m = worldOf(bones).get(name)!;
    return [0, 1, 2].map((c) =>
      new THREE.Vector3()
        .setFromMatrixColumn(m, c)
        .toArray()
        .map((v) => Math.round(v * 1e6) / 1e6 + 0),
    );
  };
  const headsStay = (bones: readonly BoneSpec[]) => {
    const now = worldOf(bones);
    for (const n of ['A', 'B', 'C']) {
      const a = new THREE.Vector3().setFromMatrixPosition(now.get(n)!);
      const b = new THREE.Vector3().setFromMatrixPosition(was.get(n)!);
      expect(a.distanceTo(b), `${n} head`).toBeLessThan(1e-9);
    }
  };
  const orient = (up: unknown, extra: object = {}) =>
    run({ op: 'orient', bone: 'B', up, ...extra } as SkeletonEdit, CHAIN).bones;

  it('Global +Z: +Y aims at C (0,1,0), +Z is (0,0,1), +X is (1,0,0)', () => {
    const b = orient({ kind: 'axis', axis: [0, 0, 1] });
    expect(axes(b, 'B')).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    headsStay(b);
    // A is not oriented, so it does not move at all.
    expectSameWorld(worldOf(b).get('A')!, was.get('A')!, 'A');
  });

  it('Global +X: +Z is (1,0,0), +X = Y × Z = (0,0,−1)', () => {
    expect(axes(orient({ kind: 'axis', axis: [1, 0, 0] }), 'B')).toEqual([
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  });

  it('Local +Z Tangent: aim × (A − B) = (0,1,0) × (−1,0,0) = (0,0,1)', () => {
    expect(axes(orient({ kind: 'tangent', axis: '+Z' }), 'B')[2]).toEqual([0, 0, 1]);
    expect(axes(orient({ kind: 'tangent', axis: '-Z' }), 'B')[2]).toEqual([0, 0, -1]);
  });

  it('Local +X Tangent: the bisector (−1,1,0), made perpendicular to the aim, is (−1,0,0)', () => {
    expect(axes(orient({ kind: 'tangent', axis: '+X' }), 'B')[2]).toEqual([-1, 0, 0]);
  });

  it('Cursor at (5,1,3): (4,1,3) made perpendicular to the aim is (0.8,0,0.6)', () => {
    expect(axes(orient({ kind: 'point', point: [5, 1, 3] }), 'B')[2]).toEqual([0.8, 0, 0.6]);
  });

  it('Active Bone: +Z matches A’s +Z made perpendicular to the aim', () => {
    const az = new THREE.Vector3().setFromMatrixColumn(was.get('A')!, 2);
    const want = az.sub(new THREE.Vector3(0, az.y, 0)).normalize();
    const got = axes(orient({ kind: 'matchBone', bone: 'A' }), 'B')[2];
    got.forEach((v, i) => expect(v).toBeCloseTo(want.getComponent(i), 6));
  });

  it('a chain from A: each joint aims at its child, and the end joint takes its parent’s frame', () => {
    const b = run(
      { op: 'orient', bone: 'A', up: { kind: 'axis', axis: [0, 0, 1] }, chain: true },
      CHAIN,
    ).bones;
    expect(axes(b, 'A')).toEqual([
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(axes(b, 'B')).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(axes(b, 'C')).toEqual(axes(b, 'B'));
    headsStay(b);
  });

  it('Shortest Rotation flips the result rather than turn +Z past 90°', () => {
    // B's +Z as it stands, and the up opposite it: without the flip +Z turns by more than 90°.
    const bz = new THREE.Vector3().setFromMatrixColumn(was.get('B')!, 2);
    const up = bz.clone().negate().toArray() as [number, number, number];
    const flipped = axes(orient({ kind: 'axis', axis: up }, { axisOnly: true }), 'B')[2];
    expect(new THREE.Vector3(...flipped).dot(bz)).toBeGreaterThan(0);
    const plain = axes(orient({ kind: 'axis', axis: up }), 'B')[2];
    expect(new THREE.Vector3(...plain).dot(bz)).toBeLessThan(0);
  });

  it('a preferred angle is stored on the bone, and cleared', () => {
    const set = run({ op: 'preferredAngle', bone: 'B', angle: [0, 0, 0.5] }, CHAIN).bones;
    expect(set[1].preferredAngle).toEqual([0, 0, 0.5]);
    const cleared = run({ op: 'preferredAngle', bone: 'B', angle: null }, set).bones;
    expect('preferredAngle' in cleared[1]).toBe(false);
  });
});
