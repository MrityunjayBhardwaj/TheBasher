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
  restDirectionDisagreement,
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

describe('what the two rests still disagree about, bone by bone', () => {
  const skeletons = (source: BoneSpec[], target: BoneSpec[]) => ({
    source: specToThreeSkeleton(source).bones,
    target: specToThreeSkeleton(target).bones,
  });

  it('reports nothing left over when one rotation explains the whole difference', () => {
    const { source, target } = skeletons(THREE_DIMENSIONAL, YAWED);
    const solved = solveRestAlignment(source, target, MAP);
    expect(solved, 'these two rests are one yaw apart and must solve').toBeTruthy();

    const gaps = restDirectionDisagreement(source, target, MAP, solved!.rotation);
    expect(gaps.size, 'no bone was compared — a clean report of nothing').toBeGreaterThan(5);
    const worst = Math.max(...gaps.values());
    expect(
      worst,
      `the worst bone still differs by ${worst.toFixed(2)}° after a rotation that explains ` +
        `everything, so this is measuring something other than the leftover`,
    ).toBeLessThan(0.01);
  });

  it('names the bone that is left over, and leaves the rest at zero', () => {
    // One bone bent away from the other rig's anatomy: exactly the vendor case,
    // where the feet disagree and the arms do not.
    // The yawed toe sits at [0.15, 0, 0]; tilt it DOWNWARD by 40°, which changes
    // the foot's rest direction without changing its azimuth or its length. That
    // matters: the whole-rig solve is a heading, so a bend that also turned the
    // bone in the horizontal plane would be partly absorbed by the solve and the
    // leftover would appear spread across every other bone instead of on this one.
    const BENT = 40;
    const r = (BENT * Math.PI) / 180;
    const bent = YAWED.map((b) =>
      b.name === 't_toe'
        ? {
            ...b,
            position: [0.15 * Math.cos(r), -0.15 * Math.sin(r), 0] as [number, number, number],
          }
        : b,
    );
    const { source, target } = skeletons(THREE_DIMENSIONAL, bent);
    const solved = solveRestAlignment(source, target, MAP);
    expect(solved).toBeTruthy();

    const gaps = restDirectionDisagreement(source, target, MAP, solved!.rotation);
    // The bent bone is the FOOT — a bone's rest direction is the direction to
    // its child, so moving the toe is what points the foot somewhere else.
    const foot = gaps.get('t_foot') ?? NaN;
    expect(
      foot,
      `the bone whose child was moved by ${BENT}° reports ${foot.toFixed(1)}°, so the report is ` +
        `not tracking the anatomy it claims to`,
    ).toBeGreaterThan(BENT - 15);

    const others = [...gaps.entries()].filter(([n]) => n !== 't_foot');
    const worstOther = Math.max(...others.map(([, v]) => v));
    expect(
      worstOther,
      `an untouched bone reports ${worstOther.toFixed(1)}°, so the disagreement is being spread ` +
        `across the rig instead of named where it is`,
    ).toBeLessThan(1);
  });

  it('THE LIMIT: a disagreement the heading can partly absorb is spread, not named', () => {
    // Tilt the same toe SIDEWAYS instead of downward, so the change is in the
    // horizontal plane the whole-rig heading can turn in. The solve then spends
    // some of itself absorbing this one bone, and what is left over appears on
    // every other bone as well — measured 11.3° on bones nothing touched.
    //
    // So a large reading on one bone is trustworthy; a small reading spread
    // evenly across the rig can be one bone's anatomy wearing a disguise. The
    // report says where the leftover IS, not where it came from, and that is a
    // property of fitting one rotation to many bones rather than of this
    // function. Written down because the obvious reading — "every bone is a
    // little off" — invites a search for a global defect that is not there.
    const r = (40 * Math.PI) / 180;
    const sideways = YAWED.map((b) =>
      b.name === 't_toe'
        ? {
            ...b,
            position: [0.15 * Math.cos(r), 0, 0.15 * Math.sin(r)] as [number, number, number],
          }
        : b,
    );
    const { source, target } = skeletons(THREE_DIMENSIONAL, sideways);
    const solved = solveRestAlignment(source, target, MAP);
    expect(solved).toBeTruthy();
    const gaps = restDirectionDisagreement(source, target, MAP, solved!.rotation);
    const others = [...gaps.entries()].filter(([n]) => n !== 't_foot').map(([, v]) => v);
    const worstOther = Math.max(...others);
    expect(
      worstOther,
      `an in-plane disagreement on one bone no longer spreads (worst other ` +
        `${worstOther.toFixed(1)}°), so either the solver changed or this limit is stale`,
    ).toBeGreaterThan(5);
  });

  it('leaves out a bone it cannot measure rather than calling it zero', () => {
    // A chain end has no mapped descendant, so it has no rest DIRECTION at all.
    // Reporting 0° for it would read as "these two agree perfectly" — the one
    // thing an absent measurement does not mean.
    const { source, target } = skeletons(THREE_DIMENSIONAL, YAWED);
    const gaps = restDirectionDisagreement(source, target, MAP);
    expect(gaps.has('t_toe'), 'the chain end has no direction and must be absent').toBe(false);
    expect(gaps.has('t_hand'), 'the hand is a chain end here too').toBe(false);
    expect(gaps.has('t_foot'), 'a bone WITH a mapped child must be present').toBe(true);
  });

  it("measures in world, which is not the same question as each bone's own frame", () => {
    // Measured on the stand-in pair: 113.5° in the bones\' own frames, 0.3° in
    // the world. The retarget conjugates the target\'s axis into the world
    // beside the source\'s, so the world answer is the one that predicts what is
    // left over — reading the own-frame number instead sent one investigation
    // after a defect that was not there (#979).
    const { source, target } = skeletons(THREE_DIMENSIONAL, YAWED);
    const solved = solveRestAlignment(source, target, MAP)!;
    const worldGaps = restDirectionDisagreement(source, target, MAP, solved.rotation);
    const noRotation = restDirectionDisagreement(source, target, MAP);
    const worstWorld = Math.max(...worldGaps.values());
    const worstRaw = Math.max(...noRotation.values());
    expect(worstWorld).toBeLessThan(0.01);
    expect(
      worstRaw,
      `without the whole-rig rotation the same two rests read ${worstRaw.toFixed(1)}°, so the ` +
        `rotation argument is not doing the work this function says it does`,
    ).toBeGreaterThan(60);
  });
});
