// #999 — a LEAF of the map gets a direction too, when the target rig has a
// bone-axis convention to give it one.
//
// #866 pointed every mapped bone where the source points it by measuring the
// direction to its mapped CHILD. A leaf has no mapped child, so it kept the
// whole rest gap: measured on the live vendor pair, constant across the clip,
// toe bases 22-24°, head 9.5°, hands 3-4°.
//
// 🔴 EVERY ROW HERE HAS ITS LOSING ALTERNATIVE BESIDE IT, because each part of
// this fix is a rule that would look right and be wrong one step over:
//
//   · a rig with NO convention must keep the pre-#999 behaviour, or the leaf
//     term is inferring a direction from bones that disagree about everything
//   · the ROOT must not count toward the convention, or a rig that has one reads
//     as if it does not (the tripo rig: 17 of 17 without it, 17 of 18 with)
//   · an `*End` child is the tail, not the mean of the children — measured, the
//     mean drags the head 28.2° off because the jaw and eyes point FORWARD
//   · a measured mapped child must still WIN over the convention, or seventeen
//     bones' agreement about a rig quietly outranks a bone's own measurement
//
// REF: src/core/import/restAlignment.ts (`boneAxisConvention`, the tail rule);
//      issues #999, #866.

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3, type Bone } from 'three';
import { alignedLocalOffsets, boneAxisConvention } from './restAlignment';
import { specToThreeSkeleton } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';

const DEG = 180 / Math.PI;
const IDENTITY = new Quaternion();

/** World position of a bone, after the rig's matrices are up to date. */
function worldPos(bone: Bone): Vector3 {
  return new Vector3().setFromMatrixPosition(bone.matrixWorld);
}

function bonesOf(spec: BoneSpec[]): Bone[] {
  const bones = specToThreeSkeleton(spec).bones as Bone[];
  bones[0].updateMatrixWorld(true);
  return bones;
}

function byName(bones: readonly Bone[], name: string): Bone {
  const found = bones.find((b) => b.name === name);
  if (!found) throw new Error(`no bone ${name}`);
  return found;
}

/**
 * A target rig where every non-root bone points along its own local +Y — the
 * property the rig a director gets actually has (17 of 17, worst 0.1°).
 *
 * Built with zero rotations and every child offset along +Y, so the claim is
 * true by construction and the detector has something it must find.
 */
const CONVENTIONAL_TARGET: BoneSpec[] = [
  { name: 't_root', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 't_spine', parent: 0, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  { name: 't_chest', parent: 1, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  { name: 't_neck', parent: 2, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  // The LEAF: mapped, and with no child of its own at all — exactly the shape
  // the hands, toe bases and head have on the target rig.
  { name: 't_head', parent: 3, position: [0, 0.2, 0], rotation: [0, 0, 0] },
];

/** The same rig with one bone turned off-axis: no convention any more. */
const UNCONVENTIONAL_TARGET: BoneSpec[] = CONVENTIONAL_TARGET.map((b) =>
  b.name === 't_neck' ? { ...b, position: [0.3, 0, 0] as [number, number, number] } : b,
);
// ⚠️ That one edit turns t_chest off-convention (its child now sits along +X),
// which is the whole point: ONE bone disagreeing is enough to refuse the rig.

/**
 * A source rig whose leaf DOES have children: one tail marked `End`, plus two
 * that point elsewhere — the head's jaw and eyes, in miniature.
 */
const SOURCE_WITH_TAIL: BoneSpec[] = [
  { name: 's_root', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
  { name: 's_spine', parent: 0, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  { name: 's_chest', parent: 1, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  { name: 's_neck', parent: 2, position: [0, 0.3, 0], rotation: [0, 0, 0] },
  { name: 's_head', parent: 3, position: [0, 0.2, 0], rotation: [0, 0, 0] },
  // The tail points UP AND FORWARD — a real disagreement with the target's +Y.
  { name: 's_headEnd', parent: 4, position: [0, 0.15, 0.15], rotation: [0, 0, 0] },
  // The decoys point straight forward. Averaging them in drags the answer.
  { name: 's_jaw', parent: 4, position: [0, 0, 0.2], rotation: [0, 0, 0] },
  { name: 's_eye', parent: 4, position: [0, 0, 0.25], rotation: [0, 0, 0] },
];

const MAP: Record<string, string> = {
  t_root: 's_root',
  t_spine: 's_spine',
  t_chest: 's_chest',
  t_neck: 's_neck',
  t_head: 's_head',
};

/** Where the target's leaf ends up pointing once its offset is applied. */
function leafDirectionAfter(
  target: readonly Bone[],
  offsets: Record<string, import('three').Matrix4>,
  leaf: string,
  axis: Vector3,
): Vector3 {
  const bone = byName(target, leaf);
  const bind = new Quaternion();
  bone.matrixWorld.decompose(new Vector3(), bind, new Vector3());
  // T_b = R · offset at the source's rest, with R = identity here; the bone's
  // own axis carried through it is where the bone points.
  const applied = new Quaternion().setFromRotationMatrix(offsets[leaf]);
  return axis.clone().applyQuaternion(applied).normalize();
}

/** The source leaf's tail direction, computed independently of the subject. */
function sourceTail(source: readonly Bone[]): Vector3 {
  const head = byName(source, 's_head');
  return worldPos(byName(source, 's_headEnd')).sub(worldPos(head)).normalize();
}

describe('#999 — the rig’s bone-axis convention', () => {
  it('is found on a rig that has one, and it is the axis the bones actually use', () => {
    const axis = boneAxisConvention(bonesOf(CONVENTIONAL_TARGET));
    expect(axis).not.toBeNull();
    expect(axis!.angleTo(new Vector3(0, 1, 0)) * DEG).toBeLessThan(0.5);
  });

  it('🔴 is REFUSED on a rig whose bones disagree — the losing alternative', () => {
    // One bone off-axis is enough. A detector that tolerated "most bones" would
    // pass here and would also pass the two vendor rigs that have no convention
    // at all, and it would then infer every leaf's direction from noise.
    expect(boneAxisConvention(bonesOf(UNCONVENTIONAL_TARGET))).toBeNull();
  });

  it('🔴 excludes the ROOT, which is the one thing that decides the answer', () => {
    // The ROOT points at its child SIDEWAYS while every other bone still points
    // along +Y — the exact shape measured on the live target rig, where counting
    // the root gives 17 of 18 with an 87° outlier and excluding it gives 17 of 17.
    //
    // A root is an anchor, not a limb: its "direction to its children" is the
    // direction to the whole body, which was never a bone axis. The alternative
    // to excluding it structurally is a threshold that tolerates one outlier —
    // and a threshold that tolerates one outlier also passes a rig with no
    // convention at all, which is the row above.
    const sidewaysRoot = CONVENTIONAL_TARGET.map((b) =>
      b.name === 't_spine' ? { ...b, position: [0.5, 0, 0] as [number, number, number] } : b,
    );
    // The fixture really does exhibit the property, or the row proves nothing:
    // with the root counted the rig has an outlier, and without it, none.
    const root = bonesOf(sidewaysRoot)[0];
    const child = (root.children as Bone[])[0];
    const rootDir = worldPos(child).sub(worldPos(root)).normalize();
    expect(rootDir.angleTo(new Vector3(0, 1, 0)) * DEG).toBeGreaterThan(45);

    const axis = boneAxisConvention(bonesOf(sidewaysRoot));
    expect(axis).not.toBeNull();
    expect(axis!.angleTo(new Vector3(0, 1, 0)) * DEG).toBeLessThan(0.5);
  });

  it('refuses a rig too small to have evidence of one', () => {
    // Two bones agreeing is a coincidence, and inferring a leaf's direction from
    // a coincidence is worse than leaving a gap a director can see.
    const tiny: BoneSpec[] = [
      { name: 't_root', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 't_leaf', parent: 0, position: [0, 0.3, 0], rotation: [0, 0, 0] },
    ];
    expect(boneAxisConvention(bonesOf(tiny))).toBeNull();
  });
});

describe('#999 — the leaf gets a direction', () => {
  it('points the leaf where the SOURCE’s tail points, and says it used the convention', () => {
    const target = bonesOf(CONVENTIONAL_TARGET);
    const source = bonesOf(SOURCE_WITH_TAIL);
    const out = alignedLocalOffsets(source, target, MAP, IDENTITY);

    expect(out.byConvention).toEqual(['t_head']);
    expect(out.absorbed).toContain('t_head');

    const want = sourceTail(source);
    const got = leafDirectionAfter(target, out.offsets, 't_head', new Vector3(0, 1, 0));
    expect(
      got.angleTo(want) * DEG,
      `the leaf points ${(got.angleTo(want) * DEG).toFixed(2)}° away from the source's tail`,
    ).toBeLessThan(0.5);
  });

  it('🔴 the `*End` child is the tail — averaging the children is measurably wrong', () => {
    // Independent of the subject: the End child and the mean of all three point
    // in genuinely different directions, so a rule change flips this row rather
    // than nudging it. On the live pair the same substitution costs 9.5° -> 28.2°
    // at the head, because a jaw and two eyes point FORWARD.
    const source = bonesOf(SOURCE_WITH_TAIL);
    const head = byName(source, 's_head');
    const mean = new Vector3();
    for (const n of ['s_headEnd', 's_jaw', 's_eye']) mean.add(worldPos(byName(source, n)));
    mean
      .multiplyScalar(1 / 3)
      .sub(worldPos(head))
      .normalize();
    const tail = sourceTail(source);
    expect(
      tail.angleTo(mean) * DEG,
      'the fixture no longer distinguishes the two rules, so the row below proves nothing',
    ).toBeGreaterThan(10);

    const out = alignedLocalOffsets(source, bonesOf(CONVENTIONAL_TARGET), MAP, IDENTITY);
    const got = leafDirectionAfter(
      bonesOf(CONVENTIONAL_TARGET),
      out.offsets,
      't_head',
      new Vector3(0, 1, 0),
    );
    expect(got.angleTo(tail) * DEG).toBeLessThan(0.5);
    expect(got.angleTo(mean) * DEG).toBeGreaterThan(10);
  });

  it('🔴 a rig with NO convention keeps the pre-#999 behaviour: no term, gap intact', () => {
    // The leaf must be in neither list and carry no correction, so a rig this
    // mechanism cannot speak for is left exactly as it was rather than guessed at.
    const target = bonesOf(UNCONVENTIONAL_TARGET);
    const out = alignedLocalOffsets(bonesOf(SOURCE_WITH_TAIL), target, MAP, IDENTITY);
    expect(out.byConvention).toEqual([]);
    expect(out.absorbed).not.toContain('t_head');
    expect(out.refused).not.toContain('t_head');
  });

  it('🔴 a bone with a mapped child uses ITS OWN direction, never the convention', () => {
    // The fallback must not become an override, and on a CONVENTIONAL rig the
    // only way to tell the two apart is a CHORD: leave `t_neck` out of the map
    // and BEND it, so `t_chest`'s mapped descendant (`t_head`) sits well off the
    // chest's own local +Y. The measured direction and the convention then give
    // different answers for a bone that has both, and precedence becomes visible.
    const bentNeck = CONVENTIONAL_TARGET.map((b) =>
      b.name === 't_neck' ? { ...b, rotation: [0, 0, Math.PI / 3] as [number, number, number] } : b,
    );
    const chordMap: Record<string, string> = {
      t_root: 's_root',
      t_spine: 's_spine',
      t_chest: 's_chest',
      t_head: 's_head',
    };
    const target = bonesOf(bentNeck);
    // The fixture exhibits the disagreement, or the row below is vacuous.
    const chest = byName(target, 't_chest');
    const bind = new Quaternion();
    chest.matrixWorld.decompose(new Vector3(), bind, new Vector3());
    const measured = worldPos(byName(target, 't_head')).sub(worldPos(chest)).normalize();
    const conventional = new Vector3(0, 1, 0).applyQuaternion(bind).normalize();
    expect(
      measured.angleTo(conventional) * DEG,
      'the chord no longer disagrees with the convention, so precedence is untestable here',
    ).toBeGreaterThan(15);

    const out = alignedLocalOffsets(bonesOf(SOURCE_WITH_TAIL), target, chordMap, IDENTITY);
    expect(out.byConvention).not.toContain('t_chest');
    expect(out.absorbed).toContain('t_chest');
    // And the offset it got is the one the MEASURED direction asks for: the
    // chest ends up pointing where the source's chest points, not along the axis
    // seventeen other bones happen to use.
    const applied = new Quaternion().setFromRotationMatrix(out.offsets['t_chest']);
    const source = bonesOf(SOURCE_WITH_TAIL);
    const sChest = byName(source, 's_chest');
    const want = worldPos(byName(source, 's_neck')).sub(worldPos(sChest)).normalize();
    const localMeasured = measured.clone().applyQuaternion(bind.clone().invert());
    expect(localMeasured.applyQuaternion(applied).angleTo(want) * DEG).toBeLessThan(0.5);
  });

  it('leaves a source leaf with no children of its own alone', () => {
    // Nothing to point at on either side. Neither absorbed nor claimed — the
    // honest answer, and the one case #999 cannot reach.
    const barrenSource = SOURCE_WITH_TAIL.filter(
      (b) => !['s_headEnd', 's_jaw', 's_eye'].includes(b.name),
    );
    const out = alignedLocalOffsets(
      bonesOf(barrenSource),
      bonesOf(CONVENTIONAL_TARGET),
      MAP,
      IDENTITY,
    );
    expect(out.byConvention).toEqual([]);
    expect(out.absorbed).not.toContain('t_head');
  });
});
