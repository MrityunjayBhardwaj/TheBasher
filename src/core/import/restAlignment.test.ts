// Gates for reconciling two rest poses.
//
// The solver is new code under every retargeted clip, so it is checked against
// answers known without running it: a rotation put in must come back out, a rest
// pair that IS one rotation apart must be accepted with nothing left over, and a
// rest that carries no orientation at all must be refused rather than fitted.
import { describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Vector3, type Bone } from 'three';
import {
  bestRotationAboutAxis,
  solveRestAlignment,
  alignedLocalOffsets,
  restDirectionDisagreement,
  MAX_RESIDUAL_DEGREES,
  MIN_REST_RANK_SPREAD,
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
    expect(alignment.kind).toBe('aligned');
    if (alignment.kind !== 'aligned') return;
    // The fixture was yawed by exactly a quarter turn, so that is the answer.
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(alignment.rotation.angleTo(yaw) * DEG).toBeLessThan(1e-4);
    expect(alignment.disagreementBefore).toBeGreaterThan(45);
    expect(alignment.disagreementAfter).toBeLessThan(1e-4);
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
    expect(alignment.kind).toBe('aligned');
    if (alignment.kind !== 'aligned') return;

    const quarterTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    expect(alignment.rotation.angleTo(quarterTurn) * DEG).toBeLessThan(1e-4);

    // Stated separately from the answer above, because this is the property the
    // caller depends on: whatever the fit wanted, the vertical is untouched.
    const up = new Vector3(0, 1, 0);
    expect(up.clone().applyQuaternion(alignment.rotation).angleTo(up) * DEG).toBeLessThan(1e-9);

    // And the anatomy really is still there to be tempted by — a pair that
    // agreed after the turn would make the assertions above vacuous.
    expect(alignment.disagreementAfter).toBeGreaterThan(5);
  });

  it('refuses a rest that lays every bone on one axis', () => {
    // The rest this project actually receives. It carries no orientation, so
    // there is nothing to solve — and the failure to notice that is what would
    // hand every bone a confidently wrong whole-rig rotation.
    const { src, trg } = build(RANK_ONE, YAWED);
    const refused = solveRestAlignment(src, trg, MAP);
    expect(refused.kind).toBe('direction');
    if (refused.kind !== 'direction') return;
    // NAMED, not merely refused (#960). Which of the two rigs is flat decides
    // what a director is told to do about it — regenerate the clip, or re-import
    // the character — so a refusal that only said "no" would leave the caller
    // inventing the remedy.
    expect(refused.reason).toEqual({
      kind: 'flat-rest',
      side: 'source',
      spread: expect.any(Number) as number,
    });
    expect(refused.reason.kind === 'flat-rest' ? refused.reason.spread : NaN).toBeLessThan(
      MIN_REST_RANK_SPREAD,
    );
  });

  it('refuses when too few bones are mapped to pin a rotation', () => {
    const { src, trg } = build(THREE_DIMENSIONAL, YAWED);
    const refused = solveRestAlignment(src, trg, { t_spine: 's_spine' });
    expect(refused.kind).toBe('direction');
    if (refused.kind !== 'direction') return;
    // A DIFFERENT reason from the flat rest above, and the difference is the
    // whole point: this one is the loud failure the mapping counts already
    // report, so the panel deliberately says nothing extra about it.
    // ZERO, not one: a direction needs a mapped DESCENDANT, and a lone mapped
    // bone has none. The count is the pairs the solve could form, not the map's
    // size — reporting the latter would tell a director they had one when the
    // solver saw none.
    expect(refused.reason).toEqual({ kind: 'too-few-pairs', pairs: 0 });
  });

  it('names the TARGET when it is the character whose bind is flat', () => {
    // 🔴 THIS FIXTURE IS NOT WHAT IT WAS CALLED. It was introduced as "arms
    // folded down and toes turned round, so the disagreement is per-bone rather
    // than whole-rig" — and measured, every one of its eight rest directions
    // lands on ±Y: normalised eigenvalues 1.0000 / 0.0000 / 0.0000. It is a
    // rank-one TARGET, which is a different refusal with a different remedy
    // (re-import the character, not regenerate the clip), and for as long as the
    // solver answered a bare null the two were indistinguishable and the row
    // read as covering a case nothing covered. `CROSSED` below is the fixture
    // the old name described.
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
    const refused = solveRestAlignment(src, trg, MAP);
    expect(refused.kind).toBe('direction');
    if (refused.kind !== 'direction') return;
    expect(refused.reason.kind).toBe('flat-rest');
    if (refused.reason.kind !== 'flat-rest') return;
    // The SIDE, and it is the losing alternative that makes the row witness
    // anything: the row above hands the same predicate a flat SOURCE, so a
    // constant answer cannot satisfy both.
    expect(refused.reason.side).toBe('target');
    expect(refused.reason.spread).toBeLessThan(MIN_REST_RANK_SPREAD);
  });

  it('names BOTH when neither rig can supply a body frame', () => {
    const flatTarget: BoneSpec[] = RANK_ONE.map((b) => ({
      ...b,
      name: b.name.replace('s_', 't_'),
    }));
    const { src, trg } = build(RANK_ONE, flatTarget);
    const refused = solveRestAlignment(src, trg, MAP);
    expect(refused.kind).toBe('direction');
    if (refused.kind !== 'direction') return;
    expect(refused.reason.kind).toBe('flat-rest');
    if (refused.reason.kind !== 'flat-rest') return;
    expect(refused.reason.side).toBe('both');
  });

  it('refuses two rests that no single rotation brings together', () => {
    // Two FULL-RANK rests that no heading reconciles, which is what the name has
    // always claimed and what nothing measured until now. The target's arms are
    // turned to -X against the source's +X (180° apart) while its foot is left
    // pointing +Z exactly as the source does (0° apart). A half turn fixes the
    // arms and breaks the foot; identity does the reverse; nothing fixes both.
    //
    // Rank is preserved on purpose — directions +Y, -X, -Y, +Z give normalised
    // eigenvalues 0.625 / 0.250 / 0.125 — so this cannot be mistaken for the
    // flat-rest case above, and the two arms of the refusal are told apart by a
    // fixture each rather than by the same one twice.
    const CROSSED: BoneSpec[] = YAWED.map((b) =>
      b.name === 't_arm' || b.name === 't_hand'
        ? { ...b, position: [-0.2, 0, 0] as [number, number, number] }
        : b.name === 't_toe'
          ? { ...b, position: [0, 0, 0.15] as [number, number, number] }
          : b,
    );
    const { src, trg } = build(THREE_DIMENSIONAL, CROSSED);
    const alignment = solveRestAlignment(src, trg, MAP);
    expect(alignment.kind).toBe('direction');
    if (alignment.kind !== 'direction') return;
    expect(alignment.reason.kind).toBe('rests-disagree');
    if (alignment.reason.kind !== 'rests-disagree') return;
    expect(alignment.reason.after).toBeGreaterThan(MAX_RESIDUAL_DEGREES);
    expect(alignment.reason.before).toBeGreaterThanOrEqual(alignment.reason.after);
  });
});

describe('the offsets that go with an alignment', () => {
  it('puts the target in its own bind when the source is at its rest and the rests agree', () => {
    // The identity case, and the only assertion here whose answer is known
    // without trusting any of the arithmetic: composed the way the pipeline
    // composes it — R · W · R⁻¹ · B · D with the source at rest, W = I — and two
    // rests that are one rotation apart, so every D is the identity: every
    // target bone must land exactly on its bind. A transfer that cannot return
    // identity for identity is not worth reading anywhere else.
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(YAWED).bones;
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment.kind !== 'aligned') throw new Error('the fixture pair must align');
    const { offsets, absorbed, refused } = alignedLocalOffsets(src, trg, MAP, alignment.rotation);
    trg[0].updateMatrixWorld(true);

    expect(refused, 'nothing in a pair one rotation apart is antiparallel').toEqual([]);
    expect(absorbed.length, 'every bone with a mapped child got a direction term').toBeGreaterThan(
      5,
    );
    for (const bone of trg) {
      if (MAP[bone.name] === undefined) continue;
      const bind = new Quaternion().setFromRotationMatrix(bone.matrixWorld);
      // The pipeline right-multiplies the SOURCE's world rotation by the offset,
      // and the source wrapper carries R. At rest that is R · I · (R⁻¹ · B · I) = B.
      const throughPipeline = alignment.rotation
        .clone()
        .multiply(new Quaternion().setFromRotationMatrix(offsets[bone.name]));
      expect(
        throughPipeline.angleTo(bind) * DEG,
        `${bone.name} must sit on its own bind when the source is at rest`,
      ).toBeLessThan(1e-4);
    }
  });

  it('#866 — points a bone where the SOURCE points it, when the two rests disagree there', () => {
    // The vendor case: one bone (the upper arm, via its hand) resting 40° below
    // the other rig's — an A-pose arm against a T-pose one. Before #866 the
    // target sat on its own bind at the source's rest and carried the 40° through
    // every frame; now the offset carries the target's rest direction onto the
    // source's, so at the source's rest the arm points where the source's arm
    // points — and every other bone, whose rests already agree, still sits
    // exactly on its bind.
    //
    // The ARM, not the foot it used to be (#1455): a foot stands on the floor in
    // both rests, so its gap is where each rig puts its joints under a flat sole
    // and the builder keeps it. That case has its own rows below.
    const BENT = 40;
    const r = (BENT * Math.PI) / 180;
    const bent = YAWED.map((b) =>
      b.name === 't_hand'
        ? {
            ...b,
            position: [0, -0.2 * Math.sin(r), -0.2 * Math.cos(r)] as [number, number, number],
          }
        : b,
    );
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(bent).bones;
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment.kind !== 'aligned') throw new Error('this pair must align');
    const { offsets, absorbed } = alignedLocalOffsets(src, trg, MAP, alignment.rotation);
    src[0].updateMatrixWorld(true);
    trg[0].updateMatrixWorld(true);
    expect(absorbed, 'the bent bone is a direction the offset must absorb').toContain('t_arm');

    const worldDir = (bone: Bone, child: Bone): Vector3 =>
      new Vector3()
        .setFromMatrixPosition(child.matrixWorld)
        .sub(new Vector3().setFromMatrixPosition(bone.matrixWorld))
        .normalize();
    const restLocal = (bone: Bone, child: Bone): Vector3 =>
      worldDir(bone, child).applyQuaternion(
        new Quaternion().setFromRotationMatrix(bone.matrixWorld).invert(),
      );

    const tArm = trg.find((b) => b.name === 't_arm')!;
    const tHand = trg.find((b) => b.name === 't_hand')!;
    const sArm = src.find((b) => b.name === 's_arm')!;
    const sHand = src.find((b) => b.name === 's_hand')!;
    // Before any correction the two arms disagree by the bend — the positive control.
    const gapBefore =
      worldDir(tArm, tHand).angleTo(worldDir(sArm, sHand).applyQuaternion(alignment.rotation)) *
      DEG;
    expect(gapBefore, 'the fixture must actually disagree at the arm').toBeGreaterThan(BENT - 5);

    // Through the pipeline at the source's rest: R · (R⁻¹ · B · D) applied to the
    // arm's own rest direction lands on the heading-turned source direction.
    const throughPipeline = alignment.rotation
      .clone()
      .multiply(new Quaternion().setFromRotationMatrix(offsets['t_arm']));
    const pointed = restLocal(tArm, tHand).applyQuaternion(throughPipeline);
    const wanted = worldDir(sArm, sHand).applyQuaternion(alignment.rotation);
    expect(
      pointed.angleTo(wanted) * DEG,
      `the arm still points ${(pointed.angleTo(wanted) * DEG).toFixed(2)}° away from where the ` +
        `source points it — the direction term is not doing what its docstring says`,
    ).toBeLessThan(1e-4);

    // And the bones whose rests AGREE are untouched: D is the identity there.
    for (const bone of trg) {
      if (MAP[bone.name] === undefined || bone.name === 't_arm') continue;
      const bind = new Quaternion().setFromRotationMatrix(bone.matrixWorld);
      const q = alignment.rotation
        .clone()
        .multiply(new Quaternion().setFromRotationMatrix(offsets[bone.name]));
      expect(
        q.angleTo(bind) * DEG,
        `${bone.name} rests agree, so it must still sit on its bind`,
      ).toBeLessThan(1e-4);
    }
  });

  it('#866 — adds no roll about the bone: the direction term is a pure swing', () => {
    // The third degree of freedom is the rest alignment's to give, not this
    // term's to take. D is the minimal rotation between two directions, so its
    // axis is perpendicular to the bone and its twist about the bone is zero —
    // asserted, because a D that rolled would be #854 reintroduced from the
    // other side.
    const r = (40 * Math.PI) / 180;
    const bent = YAWED.map((b) =>
      b.name === 't_hand'
        ? {
            ...b,
            position: [0, -0.2 * Math.sin(r), -0.2 * Math.cos(r)] as [number, number, number],
          }
        : b,
    );
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(bent).bones;
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment.kind !== 'aligned') throw new Error('this pair must align');
    const { offsets } = alignedLocalOffsets(src, trg, MAP, alignment.rotation);
    trg[0].updateMatrixWorld(true);
    const tArm = trg.find((b) => b.name === 't_arm')!;
    const tHand = trg.find((b) => b.name === 't_hand')!;
    const bind = new Quaternion().setFromRotationMatrix(tArm.matrixWorld);
    // D alone: strip R⁻¹ · B off the front of the offset.
    const D = bind
      .clone()
      .invert()
      .multiply(alignment.rotation)
      .multiply(new Quaternion().setFromRotationMatrix(offsets['t_arm']));
    const axisLocal = new Vector3()
      .setFromMatrixPosition(tHand.matrixWorld)
      .sub(new Vector3().setFromMatrixPosition(tArm.matrixWorld))
      .applyQuaternion(bind.clone().invert())
      .normalize();
    const twist = 2 * Math.atan2(new Vector3(D.x, D.y, D.z).dot(axisLocal), D.w) * DEG;
    expect(
      Math.abs(D.angleTo(new Quaternion()) * DEG),
      'D must be a real rotation here',
    ).toBeGreaterThan(30);
    expect(Math.abs(twist), `D rolls the arm ${twist.toFixed(3)}° about its own axis`).toBeLessThan(
      1e-6,
    );
  });

  it('#866 — refuses a bone whose two rests are nearly opposite, and names it', () => {
    // Point the target's hand the OTHER way. The minimal rotation between two
    // opposite directions is undetermined up to a roll about the bone — exactly
    // the degree of freedom this term must not decide — so the bone keeps
    // R⁻¹ · B and is reported.
    //
    // The builder is called DIRECTLY with the exact heading (identity: the two
    // rigs share an orientation here). Through `solveRestAlignment` one reversed
    // bone among eight pushes the pair's RMS past MAX_RESIDUAL_DEGREES and the
    // whole rig is refused first, which is the right answer for a rig this small
    // and a different row's business. On the live vendor pair no bone is refused
    // — measured: 17 absorbed, 0 refused.
    const reversed = THREE_DIMENSIONAL.map((b) => ({
      ...b,
      name: b.name.replace('s_', 't_'),
      ...(b.name === 's_hand' ? { position: [-0.2, 0, 0] as [number, number, number] } : {}),
    }));
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(reversed).bones;
    const { offsets, absorbed, refused } = alignedLocalOffsets(src, trg, MAP, new Quaternion());
    expect(refused).toEqual(['t_arm']);
    expect(absorbed).not.toContain('t_arm');
    expect(absorbed.length, 'every other directional bone is still absorbed').toBeGreaterThan(5);
    trg[0].updateMatrixWorld(true);
    const tArm = trg.find((b) => b.name === 't_arm')!;
    const bind = new Quaternion().setFromRotationMatrix(tArm.matrixWorld);
    const q = new Quaternion().setFromRotationMatrix(offsets['t_arm']);
    expect(
      q.angleTo(bind) * DEG,
      'a refused bone keeps its bind, with no direction term',
    ).toBeLessThan(1e-4);
  });

  // #1455 — a foot both rigs stand on keeps its own-rest delta. The three rows
  // pin the rule's three edges: kept when BOTH rests stand on it, absorbed the
  // moment the source does not, and never kept for a bone whose subtree leaves
  // the floor however low the bone itself sits.
  const toeDown = (deg: number) =>
    YAWED.map((b) =>
      b.name === 't_toe'
        ? {
            ...b,
            position: [
              0.15 * Math.cos((deg * Math.PI) / 180),
              -0.15 * Math.sin((deg * Math.PI) / 180),
              0,
            ] as [number, number, number],
          }
        : b,
    );

  it('#1455 — a foot BOTH rests stand on keeps its bind: no direction term, named grounded', () => {
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(toeDown(40)).bones;
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment.kind !== 'aligned') throw new Error('this pair must align');
    const { offsets, absorbed, grounded } = alignedLocalOffsets(src, trg, MAP, alignment.rotation);
    expect(grounded).toContain('t_foot');
    expect(absorbed, 'kept and absorbed are exclusive').not.toContain('t_foot');
    expect(grounded, 'nothing above the ankle stands on the floor').not.toContain('t_leg');
    trg[0].updateMatrixWorld(true);
    const tFoot = trg.find((b) => b.name === 't_foot')!;
    const bind = new Quaternion().setFromRotationMatrix(tFoot.matrixWorld);
    const q = alignment.rotation
      .clone()
      .multiply(new Quaternion().setFromRotationMatrix(offsets['t_foot']));
    expect(
      q.angleTo(bind) * DEG,
      'a grounded foot sits on its own bind at the source rest, so its sole stays level',
    ).toBeLessThan(1e-4);
  });

  it('#1455 — the knee is NOT on the floor: the threshold sits below it', () => {
    // On the untouched pair the knee sits at 0.29 of the rest's height above the
    // floor — inside the 0.27–0.30 band the knees of every real rig measured
    // fall in. A threshold that reached it would keep the whole shin on its own
    // rest and stop absorbing a real pose gap there.
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(YAWED).bones;
    const { grounded } = alignedLocalOffsets(src, trg, MAP, new Quaternion());
    expect([...grounded].sort()).toEqual(['t_foot', 't_toe']);
  });

  it('#1455 — the SOURCE must stand on it too: a raised source foot is absorbed as before', () => {
    // The source's toe points straight up, so its foot's subtree leaves the
    // floor: the two rests no longer share a sole, and the gap is a pose again.
    const raised = THREE_DIMENSIONAL.map((b) =>
      b.name === 's_toe' ? { ...b, position: [0, 0.5, 0] as [number, number, number] } : b,
    );
    const src = specToThreeSkeleton(raised).bones;
    const trg = specToThreeSkeleton(YAWED).bones;
    const { absorbed, grounded } = alignedLocalOffsets(src, trg, MAP, new Quaternion());
    expect(grounded).not.toContain('t_foot');
    expect(absorbed).toContain('t_foot');
  });

  it('#1455 — a bone low on the floor whose CHILD is not is never kept', () => {
    // A root parked at the floor with the hips above it — the shape of Kimodo's
    // `Root`. Judged by its own position it is on the floor; judged by its
    // subtree it is the whole body. Only the subtree reading is right.
    const withRoot = (bs: BoneSpec[], prefix: string): BoneSpec[] => [
      { name: `${prefix}root`, parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      ...bs.map((b) => ({ ...b, parent: b.parent + 1 })),
    ];
    const src = specToThreeSkeleton(withRoot(THREE_DIMENSIONAL, 's_')).bones;
    const trg = specToThreeSkeleton(withRoot(YAWED, 't_')).bones;
    const map = { ...MAP, t_root: 's_root' };
    const { grounded } = alignedLocalOffsets(src, trg, map, new Quaternion());
    expect(grounded).not.toContain('t_root');
    expect(grounded, 'the feet are still found under a root').toContain('t_foot');
  });

  it('#866 — refuses to build offsets from a source whose wrapper is already turned', () => {
    // The sequence error that put every arm and foot 82-90° off on the live
    // pair: the caller turned the source wrapper by the heading, THEN asked for
    // offsets, and the heading landed twice. A silent double application gets a
    // detector rather than a comment.
    const src = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
    const trg = specToThreeSkeleton(YAWED).bones;
    const alignment = solveRestAlignment(src, trg, MAP);
    if (alignment.kind !== 'aligned') throw new Error('the fixture pair must align');
    const wrap = new Object3D();
    wrap.add(src[0]);
    wrap.quaternion.copy(alignment.rotation);
    wrap.updateMatrixWorld(true);
    expect(() => alignedLocalOffsets(src, trg, MAP, alignment.rotation)).toThrow(/already rotated/);
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
    expect(solved.kind, 'these two rests are one yaw apart and must solve').toBe('aligned');
    if (solved.kind !== 'aligned') return;

    const gaps = restDirectionDisagreement(source, target, MAP, solved.rotation);
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
    if (solved.kind !== 'aligned') throw new Error('this pair must align');
    expect(solved).toBeTruthy();

    const gaps = restDirectionDisagreement(source, target, MAP, solved.rotation);
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
    if (solved.kind !== 'aligned') throw new Error('this pair must align');
    expect(solved).toBeTruthy();
    const gaps = restDirectionDisagreement(source, target, MAP, solved.rotation);
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
    const solved = solveRestAlignment(source, target, MAP);
    if (solved.kind !== 'aligned') throw new Error('this pair must align');
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

// #1186 — a bone with several mapped children is aimed at ONE of them, and both rigs must aim
// at the same one. Picked in each rig separately, the pick followed each rig's child order and
// paired "hand → thumb" with "hand → middle" (51.59° off on samba → xbot). `s_spine` here has
// two mapped children, `s_neck` and `s_shoulder`.

/** The same rig with every bone's children visited in the reverse order, parents first. */
function childrenReversed(bones: readonly BoneSpec[]): BoneSpec[] {
  const order: number[] = [];
  const visit = (i: number) => {
    order.push(i);
    const kids = bones.map((b, j) => (b.parent === i ? j : -1)).filter((j) => j >= 0);
    for (const j of kids.reverse()) visit(j);
  };
  bones.forEach((b, i) => {
    if (b.parent < 0) visit(i);
  });
  const newIndex = new Map(order.map((old, i) => [old, i]));
  return order.map((old) => ({
    ...bones[old],
    parent: bones[old].parent < 0 ? -1 : (newIndex.get(bones[old].parent) as number),
  }));
}

describe("#1186 — a branching bone's two directions point at the same child", () => {
  const spineKids = (bones: readonly BoneSpec[]) => {
    const spine = bones.findIndex((b) => b.name.endsWith('_spine'));
    return bones.filter((b) => b.parent === spine).map((b) => b.name.slice(2));
  };
  const reversed = childrenReversed(THREE_DIMENSIONAL);

  it('the fixture lists the spine’s children in the two orders', () => {
    expect(spineKids(THREE_DIMENSIONAL)).toEqual(['neck', 'shoulder']);
    expect(spineKids(reversed)).toEqual(['shoulder', 'neck']);
  });

  it('two rests one rotation apart agree everywhere, whatever order the SOURCE lists children in', () => {
    // YAWED is THREE_DIMENSIONAL turned a quarter turn, so a pairing of the SAME joint on both
    // sides leaves nothing over. Pairing spine→neck with spine→shoulder leaves 90° at the spine.
    const source = specToThreeSkeleton(reversed).bones;
    const target = specToThreeSkeleton(YAWED).bones;
    const solved = solveRestAlignment(source, target, MAP);
    expect(solved.kind).toBe('aligned');
    if (solved.kind !== 'aligned') return;
    const gaps = restDirectionDisagreement(source, target, MAP, solved.rotation);
    expect(gaps.has('t_spine'), 'the branching bone was compared').toBe(true);
    expect(Math.max(...gaps.values())).toBeLessThan(0.01);
    expect(solved.disagreementAfter).toBeLessThan(1e-4);
  });

  it("the source's child order changes nothing: rotation, offsets and disagreement", () => {
    // A target whose rest differs from the source's at the neck, so a pick of a DIFFERENT child
    // would change the spine's correction.
    const bentTarget = YAWED.map((b) =>
      b.name === 't_neck' ? { ...b, position: [0.05, 0.19, 0] as [number, number, number] } : b,
    );
    const run = (sourceSpecs: BoneSpec[]) => {
      const source = specToThreeSkeleton(sourceSpecs).bones;
      const target = specToThreeSkeleton(bentTarget).bones;
      const solved = solveRestAlignment(source, target, MAP);
      if (solved.kind !== 'aligned') throw new Error(`expected aligned, got ${solved.kind}`);
      const offsets = alignedLocalOffsets(source, target, MAP, solved.rotation).offsets;
      return {
        rotation: solved.rotation.toArray(),
        spine: offsets.t_spine.elements,
        gaps: Object.fromEntries(restDirectionDisagreement(source, target, MAP, solved.rotation)),
      };
    };
    const a = run(THREE_DIMENSIONAL);
    const b = run(reversed);
    expect(a.gaps.t_spine, 'the spine is compared, and the bend reaches it').toBeGreaterThan(1);
    a.rotation.forEach((v, i) => expect(b.rotation[i]).toBeCloseTo(v, 9));
    a.spine.forEach((v, i) => expect(b.spine[i]).toBeCloseTo(v, 9));
    expect(Object.keys(b.gaps).sort()).toEqual(Object.keys(a.gaps).sort());
    for (const k of Object.keys(a.gaps)) expect(b.gaps[k]).toBeCloseTo(a.gaps[k], 9);
  });

  // #1199 — reds (passes) once the TARGET's child order stops deciding which child a branching
  // bone is aimed by. Today the target's first mapped child is the one.
  it.fails("#1199: the target's child order changes nothing either", () => {
    const bentTarget = YAWED.map((b) =>
      b.name === 't_neck' ? { ...b, position: [0.05, 0.19, 0] as [number, number, number] } : b,
    );
    const spineOffset = (targetSpecs: BoneSpec[]) => {
      const source = specToThreeSkeleton(THREE_DIMENSIONAL).bones;
      const target = specToThreeSkeleton(targetSpecs).bones;
      const solved = solveRestAlignment(source, target, MAP);
      if (solved.kind !== 'aligned') throw new Error(`expected aligned, got ${solved.kind}`);
      return alignedLocalOffsets(source, target, MAP, solved.rotation).offsets.t_spine.elements;
    };
    const a = spineOffset(bentTarget);
    const b = spineOffset(childrenReversed(bentTarget));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 6));
  });
});
