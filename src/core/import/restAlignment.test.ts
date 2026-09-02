// Gates for reconciling two rest poses.
//
// The solver is new code under every retargeted clip, so it is checked against
// answers known without running it: a rotation put in must come back out, a rest
// pair that IS one rotation apart must be accepted with nothing left over, and a
// rest that carries no orientation at all must be refused rather than fitted.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  bestRigidRotation,
  solveRestAlignment,
  alignedLocalOffsets,
  MAX_RESIDUAL_DEGREES,
} from './restAlignment';
import { specToThreeSkeleton } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';

const DEG = 180 / Math.PI;

/** A rest that points three ways: spine up, arms out along X, toes out along Z. */
const THREE_DIMENSIONAL: BoneSpec[] = [
  { name: 's_hips', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 's_spine', parent: 0, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_neck', parent: 1, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  { name: 's_head', parent: 2, position: [0, 0.15, 0], rotation: [0, 0, 0] },
  { name: 's_shoulder', parent: 1, position: [0.1, 0.1, 0], rotation: [0, 0, 0] },
  { name: 's_arm', parent: 4, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_hand', parent: 5, position: [0.2, 0, 0], rotation: [0, 0, 0] },
  { name: 's_upleg', parent: 0, position: [0.1, -0.05, 0], rotation: [0, 0, 0] },
  { name: 's_leg', parent: 7, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_foot', parent: 8, position: [0, -0.4, 0], rotation: [0, 0, 0] },
  { name: 's_toe', parent: 9, position: [0, 0, 0.15], rotation: [0, 0, 0] },
];

/** The same skeleton, yawed a quarter turn: every offset by (x,y,z) -> (z,y,-x). */
const YAWED: BoneSpec[] = THREE_DIMENSIONAL.map((b) => ({
  ...b,
  name: b.name.replace('s_', 't_'),
  position: [b.position[2], b.position[1], -b.position[0]] as [number, number, number],
}));

/** Every bone on one axis — the shape of the rest this project receives today. */
const RANK_ONE: BoneSpec[] = THREE_DIMENSIONAL.map((b, i) => ({
  ...b,
  position: (i === 0 ? [0, 1, 0] : [Math.hypot(...b.position), 0, 0]) as [number, number, number],
}));

const MAP: Record<string, string> = Object.fromEntries(
  THREE_DIMENSIONAL.map((b) => [b.name.replace('s_', 't_'), b.name]),
);

describe('the rotation solver', () => {
  it('gives back a rotation that was put in', () => {
    // Twelve directions spread over the sphere, turned by a known rotation. The
    // answer is known without running the solver, which is what makes this a
    // check rather than a restatement.
    const known = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.9, 0.31).normalize(), 1.1);
    const from: Vector3[] = [];
    const to: Vector3[] = [];
    for (let i = 0; i < 12; i++) {
      const phi = (i * 2.399963) % (Math.PI * 2);
      const z = 1 - (2 * (i + 0.5)) / 12;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const v = new Vector3(r * Math.cos(phi), r * Math.sin(phi), z).normalize();
      from.push(v);
      to.push(v.clone().applyQuaternion(known));
    }
    expect(bestRigidRotation(from, to).angleTo(known) * DEG).toBeLessThan(1e-6);
  });

  it('is not fooled by directions that all lie on one line', () => {
    // Every input parallel: no rotation is determined about that line, and the
    // solver must not pretend otherwise by returning something large.
    const from = [1, 2, 3, 4].map(() => new Vector3(1, 0, 0));
    const to = [1, 2, 3, 4].map(() => new Vector3(1, 0, 0));
    const q = bestRigidRotation(from, to);
    for (const v of from) {
      expect(v.clone().applyQuaternion(q).angleTo(v) * DEG).toBeLessThan(1e-6);
    }
  });
});

describe('accepting or refusing a rest alignment', () => {
  const build = (src: BoneSpec[], trg: BoneSpec[]) => ({
    src: specToThreeSkeleton(src).bones,
    trg: specToThreeSkeleton(trg).bones,
  });

  it('accepts two rests that are one rotation apart, and names that rotation', () => {
    const { src, trg } = build(THREE_DIMENSIONAL, YAWED);
    const alignment = solveRestAlignment(src, trg, MAP);
    expect(alignment).not.toBeNull();
    // The fixture was yawed by exactly a quarter turn, so that is the answer.
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(alignment!.rotation.angleTo(yaw) * DEG).toBeLessThan(1e-4);
    expect(alignment!.disagreementBefore).toBeGreaterThan(45);
    expect(alignment!.disagreementAfter).toBeLessThan(1e-4);
  });

  it('refuses a rest that lays every bone on one axis', () => {
    // The rest this project actually receives. It carries no orientation, so
    // there is nothing to solve — and the failure to notice that is what would
    // hand every bone a confidently wrong whole-rig rotation.
    const { src, trg } = build(RANK_ONE, YAWED);
    expect(solveRestAlignment(src, trg, MAP)).toBeNull();
  });

  it('refuses when too few bones are mapped to pin a rotation', () => {
    const { src, trg } = build(THREE_DIMENSIONAL, YAWED);
    expect(solveRestAlignment(src, trg, { t_spine: 's_spine' })).toBeNull();
  });

  it('refuses two rests that no single rotation brings together', () => {
    // Same skeleton, but with the arms folded down and the toes turned round, so
    // the disagreement is per-bone rather than whole-rig. A solver that accepted
    // this would be reporting a body frame that does not exist.
    const scrambled: BoneSpec[] = YAWED.map((b) =>
      b.name === 't_arm' || b.name === 't_hand'
        ? { ...b, position: [0, -0.2, 0] as [number, number, number] }
        : b.name === 't_toe'
          ? { ...b, position: [0, -0.15, 0] as [number, number, number] }
          : b.name === 't_shoulder'
            ? { ...b, position: [0, -0.1, 0.1] as [number, number, number] }
            : b,
    );
    const { src, trg } = build(THREE_DIMENSIONAL, scrambled);
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment !== null) {
      expect(alignment.disagreementAfter).toBeLessThanOrEqual(MAX_RESIDUAL_DEGREES);
    }
    expect(alignment).toBeNull();
  });
});

describe('the offsets that go with an alignment', () => {
  it('puts the target in its own bind when the source is at its rest', () => {
    // The identity case, and the only assertion here whose answer is known
    // without trusting any of the arithmetic: composed the way the pipeline
    // composes it — R · W · R⁻¹ · B with the source at rest, W = I — every
    // target bone must land exactly on its bind. A transfer that cannot return
    // identity for identity is not worth reading anywhere else.
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(YAWED).bones;
    const alignment = solveRestAlignment(src, trg, MAP)!;
    const offsets = alignedLocalOffsets(trg, MAP, alignment.rotation);
    trg[0].updateMatrixWorld(true);

    for (const bone of trg) {
      if (MAP[bone.name] === undefined) continue;
      const bind = new Quaternion().setFromRotationMatrix(bone.matrixWorld);
      // The pipeline right-multiplies the SOURCE's world rotation by the offset,
      // and the source wrapper carries R. At rest that is R · I · (R⁻¹ · B) = B.
      const throughPipeline = alignment.rotation
        .clone()
        .multiply(new Quaternion().setFromRotationMatrix(offsets[bone.name]));
      expect(
        throughPipeline.angleTo(bind) * DEG,
        `${bone.name} must sit on its own bind when the source is at rest`,
      ).toBeLessThan(1e-4);
    }
  });
});
