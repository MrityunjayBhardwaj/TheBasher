// #1343 — the two-bone solve against Blender 5.1.1's own IK, on the same chain.
//
// The oracle: headless Blender 5.1.1 (`Blender -b --factory-startup`), an armature with `upper`
// (0,0,0)→(0,1,0.05) and `lower` (0,1,0.05)→(0,2,0) connected, root bones `goal` at (0.8,1.2,0.5) and
// `pole` at (0,1,2), an IK constraint on `lower` with chain_count 2 and use_tail. Rest frames as
// Blender reports them (`bone.matrix_local`): upper turned 0.0499584 rad about X, lower turned
// -0.0499584 rad about X in armature space; both 1.001249194 long. Posed elbow (`upper.tail`) per pole
// setting, printed by the same script. Blender's solver is iterative and stops ~1e-4 short of the
// goal (its tip read (0.800073, 1.20007, 0.500031) with no pole), so the elbow is compared at 1e-3.
import { describe, expect, it } from 'vitest';
import { restBonePose } from './bonePose';
import { posedWorldMatrices } from '../viewport/boneShape';
import { ikChainProblem, solveTwoBoneIk, type IkChain } from './twoBoneIk';
import type { BonePose, BoneSpec } from './types';
import { Vector3 } from 'three';

const TURN = 2 * Math.atan2(0.024976602, 0.999688029); // upper's rest turn about X
const LEN = 1.001249194;
const BONES: BoneSpec[] = [
  { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [TURN, 0, 0] },
  { name: 'lower', parent: 0, position: [0, LEN, 0], rotation: [-2 * TURN, 0, 0] },
  { name: 'tip', parent: 1, position: [0, LEN, 0], rotation: [0, 0, 0] },
  { name: 'goal', parent: -1, position: [0.8, 1.2, 0.5], rotation: [0, 0, 0] },
  { name: 'pole', parent: -1, position: [0, 1, 2], rotation: [0, 0, 0] },
];
const REST: BonePose[] = BONES.map(restBonePose);
const CHAIN: IkChain = {
  root: 'upper',
  mid: 'lower',
  tip: 'tip',
  goal: 'goal',
  poleAngle: 0,
  stretch: false,
  orientTip: false,
};

const heads = (bones: readonly BoneSpec[], pose: readonly BonePose[]) =>
  posedWorldMatrices(bones, pose).map((m) => new Vector3().setFromMatrixPosition(m));

function solve(chain: IkChain, pose = REST, bones = BONES) {
  const out = solveTwoBoneIk(bones, pose, chain);
  expect(out, 'the chain must solve').not.toBeNull();
  return heads(bones, out!);
}

const near = (got: Vector3, want: number[], digits: number, what: string) =>
  want.forEach((w, k) => expect(got.getComponent(k), `${what}[${k}]`).toBeCloseTo(w, digits));

describe('#1343 — the tip reaches the goal', () => {
  it('rest frames match Blender (the oracle is about the same chain)', () => {
    const h = heads(BONES, REST);
    // Blender printed the frames to 9 places; the heads they compose agree to 6.
    near(h[1], [0, 1, 0.05], 6, 'lower head');
    near(h[2], [0, 2, 0], 6, 'tip head');
  });

  for (const [label, chain] of [
    ['no pole', CHAIN],
    ['pole, angle 0', { ...CHAIN, pole: 'pole' }],
    ['pole, angle -90', { ...CHAIN, pole: 'pole', poleAngle: -90 }],
  ] as const) {
    it(`${label}: the tip lands on the goal exactly`, () => {
      near(solve(chain)[2], [0.8, 1.2, 0.5], 9, 'tip');
    });
  }
});

describe('#1343 — with a pole, the elbow sits where Blender 5.1.1 puts it', () => {
  // Converged: the same elbows at 500 and 5000 iterations. Measured agreement here: 1.24e-4 at every
  // angle, the size of Blender's own shortfall at the tip.
  for (const [angle, elbow] of [
    [0, [-0.07174, 0.997353, 0.051381]],
    [37, [-0.149073, 0.887172, 0.439548]],
    [90, [0.113741, 0.549635, 0.829135]],
    [150, [0.665728, 0.230702, 0.711395]],
    [-90, [0.686343, 0.650491, -0.329082]],
  ] as const) {
    it(`pole angle ${angle}`, () => {
      const got = solve({ ...CHAIN, pole: 'pole', poleAngle: angle })[1];
      expect(got.distanceTo(new Vector3(...elbow))).toBeLessThan(5e-4);
    });
  }
});

describe('#1343 — without a pole, the arriving elbow is the pole (Houdini)', () => {
  // Blender has no rule to match here: its no-pole elbow, (-0.149215, 0.936348, 0.321694), lies 0.29
  // off the root–goal–elbow plane — where its iteration from the arriving pose happened to stop.
  it('the solved elbow lies in the plane of root, goal and arriving elbow, on its side', () => {
    const [A, B] = heads(BONES, REST);
    const G = new Vector3(0.8, 1.2, 0.5);
    const n = new Vector3().crossVectors(B.clone().sub(A), G.clone().sub(A)).normalize();
    const elbow = solve(CHAIN)[1];
    expect(Math.abs(elbow.clone().sub(A).dot(n))).toBeLessThan(1e-9);
    const off = (v: Vector3) => {
      const e = G.clone().sub(A).normalize();
      return v
        .clone()
        .sub(A)
        .sub(e.multiplyScalar(v.clone().sub(A).dot(e)));
    };
    expect(off(elbow).dot(off(B))).toBeGreaterThan(0);
  });
});

describe('#1343 — without a pole, the root turns no more than it must', () => {
  // The case that showed it in the app (p1343): the FK bends the mid joint 85° toward −X while the
  // goal is off to +X. Turning the chain about the goal line to face the arriving elbow twisted the
  // root 162° and turned a flat skinned bar's back face to the camera.
  it('the root turns by exactly the angle between its old and new bone directions', () => {
    const bones: BoneSpec[] = [
      { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'lower', parent: 0, position: [0, 1, 0], rotation: [0, 0, 85 * (Math.PI / 180)] },
      { name: 'tip', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'goal', parent: -1, position: [1.2, 1.2, 0.4], rotation: [0, 0, 0] },
    ];
    const rest = bones.map(restBonePose);
    const out = solveTwoBoneIk(bones, rest, CHAIN)!;
    const before = heads(bones, rest);
    const after = heads(bones, out);
    near(after[2], [1.2, 1.2, 0.4], 9, 'tip');
    const swing = before[1].clone().sub(before[0]).angleTo(after[1].clone().sub(after[0]));
    const q = out[0].quaternion;
    const turned = 2 * Math.acos(Math.min(1, Math.abs(q[3])));
    expect(turned).toBeCloseTo(swing, 9);
    expect(turned).toBeLessThan(Math.PI / 2);
  });
});

describe('#1343 — reach, stretch and the straight chain', () => {
  const far: BoneSpec[] = BONES.map((b) => (b.name === 'goal' ? { ...b, position: [0, 0, 3] } : b));
  it('out of reach, the chain points straight at the goal at its full length', () => {
    const h = solve(CHAIN, far.map(restBonePose), far);
    near(h[2], [0, 0, 2 * LEN], 9, 'tip');
    near(h[1], [0, 0, LEN], 9, 'elbow');
  });
  it('with stretch, both bones scale to reach it', () => {
    const h = solve({ ...CHAIN, stretch: true }, far.map(restBonePose), far);
    near(h[2], [0, 0, 3], 9, 'tip');
    expect(h[1].distanceTo(h[0])).toBeCloseTo(1.5, 9);
  });
  it('a straight chain bends toward the mid joint’s preferred angle', () => {
    const straight: BoneSpec[] = [
      { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      {
        name: 'lower',
        parent: 0,
        position: [0, 1, 0],
        rotation: [0, 0, 0],
        preferredAngle: [0, 0, 0.5],
      },
      { name: 'tip', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'goal', parent: -1, position: [0, 1.5, 0], rotation: [0, 0, 0] },
    ];
    const h = solve(CHAIN, straight.map(restBonePose), straight);
    near(h[2], [0, 1.5, 0], 9, 'tip');
    // A positive turn about Z swings the lower bone toward -X, so the elbow goes to +X.
    expect(h[1].x).toBeGreaterThan(0.5);
    const flipped = straight.map((b) =>
      b.name === 'lower' ? { ...b, preferredAngle: [0, 0, -0.5] as [number, number, number] } : b,
    );
    expect(solve(CHAIN, flipped.map(restBonePose), flipped)[1].x).toBeLessThan(-0.5);
  });
  it('a straight chain with no preferred angle still reaches (bending about the root’s X axis)', () => {
    const straight: BoneSpec[] = [
      { name: 'upper', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'lower', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'tip', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'goal', parent: -1, position: [0, 1.5, 0], rotation: [0, 0, 0] },
    ];
    const h = solve(CHAIN, straight.map(restBonePose), straight);
    near(h[2], [0, 1.5, 0], 9, 'tip');
    // Bent about X: the elbow leaves the line in the YZ plane.
    expect(Math.abs(h[1].x)).toBeLessThan(1e-9);
    expect(Math.abs(h[1].z)).toBeGreaterThan(0.5);
  });
  it('orient tip gives the tip the goal’s rotation', () => {
    const turned: BoneSpec[] = BONES.map((b) =>
      b.name === 'goal' ? { ...b, rotation: [0.3, -0.2, 0.9] } : b,
    );
    const out = solveTwoBoneIk(turned, turned.map(restBonePose), { ...CHAIN, orientTip: true })!;
    const w = posedWorldMatrices(turned, out);
    const goal = posedWorldMatrices(turned, turned.map(restBonePose))[3];
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      expect(w[2].elements[k], `tip basis ${k}`).toBeCloseTo(goal.elements[k], 9);
    }
  });
});

describe('#1343 — a chain that cannot solve says why', () => {
  it('names a missing bone, a broken chain and a goal under the chain', () => {
    expect(ikChainProblem(BONES, { ...CHAIN, goal: 'hand' })).toMatch(/goal bone "hand"/);
    expect(ikChainProblem(BONES, { ...CHAIN, mid: 'goal' })).toMatch(/not a child/);
    expect(ikChainProblem(BONES, { ...CHAIN, goal: 'tip' })).toMatch(/moves with the chain/);
    expect(ikChainProblem(BONES, CHAIN)).toBeNull();
  });
});
