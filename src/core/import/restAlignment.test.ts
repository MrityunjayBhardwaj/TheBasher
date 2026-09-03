// Gates for reconciling two rest poses.
//
// The solver is new code under every retargeted clip, so it is checked against
// answers known without running it: a rotation put in must come back out, a rest
// pair that IS one rotation apart must be accepted with nothing left over, and a
// rest that carries no orientation at all must be refused rather than fitted.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  bestRotationAboutAxis,
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
    // Twelve directions spread over the sphere, turned by a known rotation about
    // the axis the solver is then given. The answer is known without running the
    // solver, which is what makes this a check rather than a restatement.
    const axis = new Vector3(0.3, 0.9, 0.31).normalize();
    const known = new Quaternion().setFromAxisAngle(axis, 1.1);
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
    expect(bestRotationAboutAxis(from, to, axis).angleTo(known) * DEG).toBeLessThan(1e-6);
  });

  it('turns only about the axis it is given, however the pairs disagree', () => {
    // The pairs here differ by a rotation the constraint CANNOT express. The
    // solver must answer with its best turn about the given axis and leave the
    // rest in the residual — never reach for the degrees of freedom it was
    // denied. That reach is the defect this constraint exists to prevent (#874).
    const known = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.5);
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
    const axis = new Vector3(0, 1, 0);
    const q = bestRotationAboutAxis(from, to, axis);
    expect(axis.clone().applyQuaternion(q).angleTo(axis) * DEG).toBeLessThan(1e-9);
  });

  it('is not fooled by directions that all lie on the axis', () => {
    // Every input along the axis: no rotation about it changes anything, and the
    // solver must not pretend otherwise by returning something large.
    const from = [1, 2, 3, 4].map(() => new Vector3(0, 1, 0));
    const to = [1, 2, 3, 4].map(() => new Vector3(0, 1, 0));
    const q = bestRotationAboutAxis(from, to, new Vector3(0, 1, 0));
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

  it('answers with the heading only, on a pair whose anatomy tempts a lean', () => {
    // The ground truth is known by construction: the target IS the source yawed
    // a quarter turn, then given a RELAXED-T bind — arms hanging below
    // horizontal and a toe turned up — which is the shape of the live rig pair
    // (its bind hangs the upper arms 21° below horizontal and points the foot 6°
    // above, against a source that holds both flat).
    //
    // Per-bone anatomy is not a whole-rig rotation and cannot be fitted by one,
    // so the right answer is still exactly the quarter turn. An unconstrained
    // best fit does not give it: run on these same pairs it answers a rotation
    // tilted 6.0° off the vertical, trading the fit's RMS from 10.65° down to
    // 9.04°. That tilt is what reached the root's travel and made the character
    // climb (#874), so this assertion is the gate on it.
    const relaxed: BoneSpec[] = YAWED.map((b) =>
      b.name === 't_arm' || b.name === 't_hand'
        ? { ...b, position: [b.position[0], -0.076, b.position[2]] as [number, number, number] }
        : b.name === 't_toe'
          ? { ...b, position: [b.position[0], 0.017, b.position[2]] as [number, number, number] }
          : b,
    );
    const { src, trg } = build(THREE_DIMENSIONAL, relaxed);
    const alignment = solveRestAlignment(src, trg, MAP);
    expect(alignment).not.toBeNull();

    const quarterTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(alignment!.rotation.angleTo(quarterTurn) * DEG).toBeLessThan(1e-4);

    // Stated separately from the answer above, because this is the property the
    // caller depends on: whatever the fit wanted, the vertical is untouched.
    const up = new Vector3(0, 1, 0);
    expect(up.clone().applyQuaternion(alignment!.rotation).angleTo(up) * DEG).toBeLessThan(1e-9);

    // And the anatomy really is still there to be tempted by — a pair that
    // agreed after the turn would make the assertions above vacuous.
    expect(alignment!.disagreementAfter).toBeGreaterThan(5);
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
