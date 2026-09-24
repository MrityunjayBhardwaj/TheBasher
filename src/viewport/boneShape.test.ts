// boneShape — pure octahedral bone geometry for the #972 armature helper.
//
// The load-bearing rows are the ROLL ones. Everything else here is arithmetic;
// "a roll changes the drawing, and a position-only witness cannot see it" is the
// reason this module exists instead of THREE.SkeletonHelper.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneSpec } from '../nodes/types';
import {
  LEAF_LENGTH_RATIO,
  OCTAHEDRAL_SOLID_TRIS,
  OCTAHEDRAL_VERTS,
  OCTAHEDRAL_WIRE_LINES,
  boneTransforms,
  boneWorldMatrices,
  octahedralIndices,
  octahedralPositions,
  octahedralWireSegments,
} from './boneShape';

/** A rig drawn in its own rest pose: posed and rest are the same bones. */
function atRest(bones: readonly BoneSpec[]) {
  return boneTransforms(bones, bones);
}

/** The 6 unit-shape vertices put through a bone matrix, rounded and sorted —
 *  i.e. what the eye actually sees, independent of vertex ORDER. */
function drawnPoints(m: THREE.Matrix4): string[] {
  return OCTAHEDRAL_VERTS.map((v) => {
    const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
    return [p.x, p.y, p.z].map((n) => n.toFixed(4)).join(',');
  }).sort();
}

/** root → child at +Y, so head→tail is +Y and a Y-rotation is a pure roll.
 *  Takes DEGREES for readability and converts, because BoneSpec.rotation is in
 *  RADIANS — writing 45 there would be 45 radians, which is how the units bug
 *  this file now pins got in. */
function twoBoneRig(rootRotationDeg: [number, number, number]): BoneSpec[] {
  const r = rootRotationDeg.map((d) => THREE.MathUtils.degToRad(d)) as [number, number, number];
  return [
    { name: 'root', parent: -1, position: [0, 0, 0], rotation: r },
    { name: 'child', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];
}

describe('the octahedral tables (Blender v5.1.1, overlay_shape.cc)', () => {
  it('is 6 verts, 8 tris, 12 wire edges', () => {
    expect(OCTAHEDRAL_VERTS.length).toBe(6);
    expect(OCTAHEDRAL_SOLID_TRIS.length).toBe(8);
    expect(OCTAHEDRAL_WIRE_LINES.length).toBe(12);
    expect(octahedralPositions().length).toBe(6 * 3);
    expect(octahedralIndices().length).toBe(8 * 3);
    expect(octahedralWireSegments().length).toBe(12 * 2 * 3);
  });

  it('runs head(0,0,0) → tail(0,1,0) along +Y', () => {
    expect(OCTAHEDRAL_VERTS[0]).toEqual([0, 0, 0]);
    expect(OCTAHEDRAL_VERTS[5]).toEqual([0, 1, 0]);
  });

  it('puts the ring at 10% of the length, as a square of half-side 0.1', () => {
    const ring = OCTAHEDRAL_VERTS.slice(1, 5);
    for (const v of ring) {
      expect(v[1]).toBeCloseTo(0.1);
      expect(Math.abs(v[0])).toBeCloseTo(0.1);
      expect(Math.abs(v[2])).toBeCloseTo(0.1);
    }
    // All four corners, no duplicates.
    expect(new Set(ring.map((v) => `${v[0]},${v[2]}`)).size).toBe(4);
  });

  it('every index is in range', () => {
    for (const i of [...octahedralIndices(), ...OCTAHEDRAL_WIRE_LINES.flat()]) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(6);
    }
  });
});

describe('boneWorldMatrices', () => {
  it('composes translation down the parent chain', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [1, 0, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 2, 0], rotation: [0, 0, 0] },
      { name: 'c', parent: 1, position: [0, 0, 3], rotation: [0, 0, 0] },
    ];
    const p = boneWorldMatrices(bones).map((m) =>
      new THREE.Vector3().setFromMatrixPosition(m).toArray(),
    );
    expect(p[0]).toEqual([1, 0, 0]);
    expect(p[1]).toEqual([1, 2, 0]);
    expect(p[2]).toEqual([1, 2, 3]);
  });

  it('reads rotation as RADIANS — the exception to the degrees convention', () => {
    // Deliberately pinned, because the first version of this module assumed
    // degrees (the general DAG convention) and every row still passed: the rows
    // encoded the assumption instead of checking it. Ground truth is the three
    // consumers, which all read BoneSpec.rotation raw into a THREE.Euler —
    // threeAdapter.ts:250 and :317, retarget.ts:377.
    //
    // Math.PI/2 about Z takes the child's local +Y offset onto world -X.
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, Math.PI / 2] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const p = new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[1]);
    expect(p.x).toBeCloseTo(-1);
    expect(p.y).toBeCloseTo(0);
  });

  it('does NOT treat rotation as degrees — 90 would be 14 full turns', () => {
    // The falsification of the row above: under the old degrees reading, a
    // rotation of `90` was a quarter turn. Under radians it is 90 rad, which is
    // NOT a quarter turn — so this pins the units rather than merely a rotation.
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 90] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const p = new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[1]);
    expect(Math.abs(p.x - -1)).toBeGreaterThan(0.1);
  });

  it('applies optional bind scale, defaulting to 1', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    expect(new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[1]).y).toBeCloseTo(2);
  });

  it('survives a child listed before its parent', () => {
    const bones: BoneSpec[] = [
      { name: 'child', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'root', parent: -1, position: [5, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(
      new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[0]).toArray(),
    ).toEqual([5, 1, 0]);
  });

  it('does not hang on a parent cycle or an out-of-range parent', () => {
    const cyclic: BoneSpec[] = [
      { name: 'a', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const bad: BoneSpec[] = [{ name: 'a', parent: 99, position: [0, 1, 0], rotation: [0, 0, 0] }];
    for (const rig of [cyclic, bad]) {
      const ms = boneWorldMatrices(rig);
      expect(ms.length).toBe(rig.length);
      expect(ms.every((m) => m.elements.every((n) => Number.isFinite(n)))).toBe(true);
    }
  });
});

describe('boneTransforms — placement', () => {
  it("takes a bone's tail from its child's head", () => {
    const [root] = atRest(twoBoneRig([0, 0, 0]));
    expect(root.tail).toEqual([0, 1, 0]);
    expect(root.length).toBeCloseTo(1);
    expect(root.isLeaf).toBe(false);
  });

  it('averages multiple children (Blender import_bvh.py:321-327)', () => {
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'l', parent: 0, position: [-1, 2, 0], rotation: [0, 0, 0] },
      { name: 'r', parent: 0, position: [1, 2, 0], rotation: [0, 0, 0] },
    ];
    expect(atRest(bones)[0].tail).toEqual([0, 2, 0]);
  });

  it('scales the shape UNIFORMLY by length (overlay_armature.cc:970-983)', () => {
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'child', parent: 0, position: [0, 4, 0], rotation: [0, 0, 0] },
    ];
    const m = atRest(bones)[0].matrix;
    const basis = [0, 1, 2].map((c) => new THREE.Vector3().setFromMatrixColumn(m, c).length());
    // A 4-long bone is 4x wider too — not just 4x longer.
    basis.forEach((len) => expect(len).toBeCloseTo(4));
  });

  it('manufactures a leaf tail at LEAF_LENGTH_RATIO of the parent, continuing its direction', () => {
    const frames = atRest(twoBoneRig([0, 0, 0]));
    const leaf = frames[1];
    expect(leaf.isLeaf).toBe(true);
    // Parent runs +Y with length 1, so the leaf continues +Y at the ratio.
    expect(leaf.length).toBeCloseTo(LEAF_LENGTH_RATIO);
    expect(leaf.tail[1]).toBeCloseTo(1 + LEAF_LENGTH_RATIO);
  });

  it('yields finite matrices for a single degenerate bone', () => {
    const lone: BoneSpec[] = [{ name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }];
    const f = atRest(lone)[0];
    expect(f.matrix.elements.every((n) => Number.isFinite(n))).toBe(true);
    expect(f.length).toBeGreaterThan(0);
  });

  it('does not collapse when a parent and child share a position', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    const frames = atRest(bones);
    expect(frames.every((f) => f.matrix.elements.every((n) => Number.isFinite(n)))).toBe(true);
    expect(frames.every((f) => f.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rows this module exists for.
// ---------------------------------------------------------------------------

describe('boneTransforms — roll is visible (the reason SkeletonHelper is disqualified)', () => {
  it('a 45° roll changes the drawing while every joint POSITION stays put', () => {
    const straight = atRest(twoBoneRig([0, 0, 0]));
    const rolled = atRest(twoBoneRig([0, 45, 0]));

    // The position-only witness — SkeletonHelper's `setFromMatrixPosition` — is
    // blind here: heads and tails are identical to the last decimal. V427.
    straight.forEach((f, i) => {
      f.head.forEach((n, k) => expect(n).toBeCloseTo(rolled[i].head[k], 6));
      f.tail.forEach((n, k) => expect(n).toBeCloseTo(rolled[i].tail[k], 6));
    });

    // Ours is not.
    expect(drawnPoints(rolled[0].matrix)).not.toEqual(drawnPoints(straight[0].matrix));
  });

  it('roll survives as an actual 45° turn of the ring, not just any difference', () => {
    const straight = atRest(twoBoneRig([0, 0, 0]))[0];
    const rolled = atRest(twoBoneRig([0, 45, 0]))[0];
    // Ring vertex v1 sits at local (0.1, 0.1, 0.1). Its angle about the bone's
    // +Y axis must have moved by exactly the roll we applied.
    const ringOf = (m: THREE.Matrix4) => {
      const v = OCTAHEDRAL_VERTS[1];
      const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
      return Math.atan2(p.z, p.x);
    };
    let d = THREE.MathUtils.radToDeg(ringOf(rolled.matrix) - ringOf(straight.matrix));
    d = ((d % 360) + 360) % 360;
    expect(Math.min(d, 360 - d)).toBeCloseTo(45, 3);
  });

  it('DOCUMENTED LIMIT: a 90° roll is invisible — the ring is a square', () => {
    // Not a bug and not a gap in the witness: Blender's own table has the same
    // 4-fold symmetry. It is here so nobody "fixes" a falsification test by
    // reaching for 90/180/270 and concludes the helper is roll-blind.
    const straight = atRest(twoBoneRig([0, 0, 0]))[0];
    const quarter = atRest(twoBoneRig([0, 90, 0]))[0];
    expect(drawnPoints(quarter.matrix)).toEqual(drawnPoints(straight.matrix));
  });

  it('the roll comes from the BONE, not from a world-fixed reference', () => {
    // The falsification #972 asks for, as a permanent row: if the X axis were
    // taken from world-up (the naive head→tail-only construction) every one of
    // these rolls would draw identically. Sweep past the 90° symmetry.
    const seen = new Set<string>();
    for (const deg of [0, 15, 30, 45, 60, 75]) {
      seen.add(drawnPoints(atRest(twoBoneRig([0, deg, 0]))[0].matrix).join('|'));
    }
    expect(seen.size).toBe(6);
  });

  it('keeps the octahedron pointing at the child even when the bone axis is not +Y', () => {
    // A joint rig's local +Y need not point down the bone. The shape must still
    // run head→tail — this is the half of the design the roll test cannot pin.
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'child', parent: 0, position: [3, 0, 0], rotation: [0, 0, 0] },
    ];
    const m = atRest(bones)[0].matrix;
    // Local tail (0,1,0) must land on the child's head.
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    expect(tip.x).toBeCloseTo(3);
    expect(tip.y).toBeCloseTo(0);
    expect(tip.z).toBeCloseTo(0);
  });

  it('stays orthonormal-up-to-scale so the shape is never sheared', () => {
    const m = atRest(twoBoneRig([20, 35, 50]))[0].matrix;
    const [x, y, z] = [0, 1, 2].map((c) => new THREE.Vector3().setFromMatrixColumn(m, c));
    expect(x.dot(y)).toBeCloseTo(0, 6);
    expect(y.dot(z)).toBeCloseTo(0, 6);
    expect(x.dot(z)).toBeCloseTo(0, 6);
    expect(x.length()).toBeCloseTo(y.length(), 6);
    expect(y.length()).toBeCloseTo(z.length(), 6);
  });
});

describe('#1206 — a bone is drawn by its own pose, from a shape decided at rest', () => {
  // skinned-bar's rig: Bone0 at the origin, Bone1 (the leaf) one unit up.
  const REST: BoneSpec[] = [
    { name: 'Bone0', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'Bone1', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];

  it('a rotated leaf swings its tail with its own rotation, as Blender 5.1.1 draws it', () => {
    // Blender, skinned-bar frame 12 (ref/probes/blender-native-character/q1206_leaf_tail.py):
    // Bone1's pose quaternion (w 0.8686, z 0.3378) and its tail − head = (−0.6756, 0, 0.7373)
    // in Blender's Z-up, i.e. (−0.6756, 0.7373, 0) in glTF's Y-up.
    const angle = 2 * Math.atan2(0.3378, 0.8686);
    const posed: BoneSpec[] = [REST[0], { ...REST[1], rotation: [0, 0, angle] }];
    const leaf = boneTransforms(posed, REST)[1];
    const dir = new THREE.Vector3(...leaf.tail).sub(new THREE.Vector3(...leaf.head)).normalize();
    expect(dir.x).toBeCloseTo(-0.6756, 4);
    expect(dir.y).toBeCloseTo(0.7373, 4);
    expect(dir.z).toBeCloseTo(0, 6);
    // The rest length is kept: posing never stretches a bone.
    expect(leaf.length).toBeCloseTo(boneTransforms(REST, REST)[1].length, 9);
  });

  it("a parent's tail stays put when its child translates, as Blender 5.1.1 draws it", () => {
    // Blender (q1206_child_translate.py): child moved +0.5 on x, parent tail still (0, 0, 1).
    const posed: BoneSpec[] = [REST[0], { ...REST[1], position: [0.5, 1, 0] }];
    const parent = boneTransforms(posed, REST)[0];
    expect(parent.tail[0]).toBeCloseTo(0, 9);
    expect(parent.tail[1]).toBeCloseTo(1, 9);
    expect(parent.tail[2]).toBeCloseTo(0, 9);
  });

  it('a whole-rig pose carries every bone rigidly, head, tail and roll together', () => {
    const turned: BoneSpec[] = [{ ...REST[0], rotation: [0.3, 0.2, 0.1] }, REST[1]];
    const rest = boneTransforms(REST, REST);
    const posed = boneTransforms(turned, REST);
    const root = boneWorldMatrices(turned)[0];
    for (let i = 0; i < 2; i++) {
      const expected = new THREE.Matrix4().multiplyMatrices(root, rest[i].matrix);
      posed[i].matrix.elements.forEach((e, k) => expect(e).toBeCloseTo(expected.elements[k], 9));
    }
  });

  it('with the pose standing in for rest, the drawing is the pose-derived shape', () => {
    // The clone road's live scans pass their pose as rest: they must draw what they drew.
    const posed: BoneSpec[] = [REST[0], { ...REST[1], position: [0.5, 1, 0] }];
    const asRest = boneTransforms(posed, posed);
    expect(asRest[0].tail[0]).toBeCloseTo(0.5, 9);
  });
});
