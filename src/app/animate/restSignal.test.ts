// #960/#987 — what the bone-map header says about the two rests.
//
// The decision this file pins is a product decision, not arithmetic: when the
// roll is genuinely lost, a director is WARNED and told which side to fix. Not
// refused — the clip is otherwise usable, and Blender takes the same posture on
// the same class of thing (`rotlike_evaluate` transfers what it can and never
// consults the two rests). Not conditioned automatically — a rank-one rest has
// no second axis to recover the roll from (#854), and the conditioning lever
// lives in the exporter (#855).
//
// The rows below are built so that no constant answer satisfies them: every
// branch is present, and each one's LOSING alternative is present beside it.
import { describe, expect, it } from 'vitest';
import { boneMapView, restSignal } from './boneMapRows';
import type { GraphNodeLike } from './graphNodes';

type Vec3 = [number, number, number];
function bone(name: string, parent: number, position: Vec3) {
  return { name, parent, position, rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/** Points three ways: spine up, arms along X, toe along Z. */
const SOURCE = [
  bone('s_hips', -1, [0, 1, 0]),
  bone('s_spine', 0, [0, 0.2, 0]),
  bone('s_neck', 1, [0, 0.2, 0]),
  bone('s_head', 2, [0, 0.15, 0]),
  bone('s_shoulder', 1, [0.1, 0.1, 0]),
  bone('s_arm', 4, [0.2, 0, 0]),
  bone('s_hand', 5, [0.2, 0, 0]),
  bone('s_upleg', 0, [0.1, -0.05, 0]),
  bone('s_leg', 7, [0, -0.4, 0]),
  bone('s_foot', 8, [0, -0.4, 0]),
  bone('s_toe', 9, [0, 0, 0.15]),
];

/** The same rig yawed a quarter turn: (x,y,z) -> (z,y,-x). */
const yawed = (bs: typeof SOURCE) =>
  bs.map((b) => ({
    ...b,
    name: b.name.replace('s_', 't_'),
    position: [b.position[2], b.position[1], -b.position[0]] as Vec3,
  }));

/** Yawed, with the toe tilted 20° down: one bone of real anatomy to report. */
const TARGET_ALIGNED = yawed(SOURCE).map((b) =>
  b.name === 't_toe'
    ? { ...b, position: [0.15 * Math.cos(0.349), -0.15 * Math.sin(0.349), 0] as Vec3 }
    : b,
);

/** Every bone on one axis — no body frame to solve for. */
const flatten = (bs: typeof SOURCE) =>
  bs.map((b, i) => ({
    ...b,
    position: (i === 0 ? [0, 1, 0] : [Math.hypot(...b.position), 0, 0]) as Vec3,
  }));

/** Full rank on both sides, and no single heading reconciles them: the arms are
 *  turned 180° from the source's while the toe is left pointing exactly as the
 *  source's does. A half turn fixes one and breaks the other. */
const TARGET_CROSSED = yawed(SOURCE).map((b) =>
  b.name === 't_arm' || b.name === 't_hand'
    ? { ...b, position: [-0.2, 0, 0] as Vec3 }
    : b.name === 't_toe'
      ? { ...b, position: [0, 0, 0.15] as Vec3 }
      : b,
);

const FULL_MAP: Record<string, string> = Object.fromEntries(
  SOURCE.map((b) => [b.name, b.name.replace('s_', 't_')]),
);

function view(source: typeof SOURCE, target: typeof SOURCE, map = FULL_MAP) {
  const nodes = {
    srcRig: { id: 'srcRig', type: 'Skeleton', params: { bones: source }, inputs: {} },
    tgtRig: { id: 'tgtRig', type: 'Skeleton', params: { bones: target }, inputs: {} },
    clip: {
      id: 'clip',
      type: 'AnimationClip',
      params: { name: 'walk', duration: 1, keyframes: [{ bone: 0, time: 0 }] },
      inputs: { skeleton: { node: 'srcRig' } },
    },
    map1: { id: 'map1', type: 'BoneNameMap', params: { name: 'bridge', map }, inputs: {} },
    rt: {
      id: 'rt',
      type: 'RetargetClip',
      params: { name: 'retargeted' },
      inputs: {
        sourceClip: { node: 'clip' },
        boneMap: { node: 'map1' },
        skeleton: { node: 'tgtRig' },
      },
    },
  } as unknown as Record<string, GraphNodeLike>;
  const v = boneMapView(nodes, 'rt');
  if (!v) throw new Error('the fixture graph must produce a view');
  return v;
}

describe('#960 — what a director is told when the rests could not be reconciled', () => {
  it('#866 — says nothing when the leftover anatomy is ABSORBED, and marks the row as such', () => {
    // The toe is tilted 20° down, so the foot's rest disagrees with the source's
    // by 20°. Before #866 that was the header's "20° rest gap at s_foot"; now the
    // retarget folds it into the foot's offset, so there is nothing for a
    // director to act on — the row carries the fact, the header carries nothing.
    const v = view(SOURCE, TARGET_ALIGNED);
    expect(v.restReconciliation.kind).toBe('aligned');
    const foot = v.rows.find((r) => r.source === 's_foot');
    expect(foot?.restGapDeg ?? 0, 'the fixture must actually disagree at the foot').toBeGreaterThan(
      15,
    );
    expect(foot?.restGapAbsorbed, 'the aligned branch absorbs a gap it can').toBe(true);
    expect(v.worstRestGap, 'an absorbed gap is not what is left').toBeNull();
    expect(restSignal(v)).toBeNull();
  });

  it('#866 — names the bone whose gap could NOT be absorbed, and promises the transfer', () => {
    // A rig with many agreeing bones and one whose rest points the OPPOSITE way
    // from the source's. One reversed bone among eight would push the whole-rig
    // solve past its residual bound and refuse the pair; among forty it does not,
    // and the pair aligns with exactly that bone refused — the only reading on
    // the aligned branch that still needs saying.
    // SOURCE plus a 32-bone chain hanging off s_hand, each link along +X: bones
    // that agree with their yawed twins exactly, and enough of them that one
    // opposed toe cannot push the pair's RMS past the residual bound.
    const source = [...SOURCE];
    for (let i = 0; i < 32; i++) {
      source.push(bone(`s_f${i}`, i === 0 ? 6 : source.length - 1, [0.02, 0, 0]));
    }
    const target = yawed(source).map((b) =>
      b.name === 't_toe' ? { ...b, position: [-0.15, 0, 0] as Vec3 } : b,
    );
    const map = Object.fromEntries(source.map((b) => [b.name, b.name.replace('s_', 't_')]));
    const v = view(source, target, map);
    expect(v.restReconciliation.kind, 'forty agreeing bones must carry one opposed one').toBe(
      'aligned',
    );
    const foot = v.rows.find((r) => r.source === 's_foot');
    expect(foot?.restGapAbsorbed, 'an opposed bone is refused, not absorbed').toBe(false);
    expect(foot?.restGapDeg ?? 0).toBeGreaterThan(150);
    const signal = restSignal(v);
    expect(signal).not.toBeNull();
    expect(signal!.branch).toBe('aligned');
    expect(signal!.label).toContain('rest gap');
    expect(signal!.label).toContain('not absorbed');
    // The promise is only true HERE, and this row is what pins it to this branch.
    expect(signal!.detail).toContain('The motion transfers exactly');
  });

  it('says nothing when the two rests agree', () => {
    // The losing alternative for the row above: same branch, no anatomy left
    // over. A producer that always spoke would pass every other row in this file.
    expect(restSignal(view(SOURCE, yawed(SOURCE)))).toBeNull();
  });

  it('warns that the roll is gone when the CLIP has a flat rest, and says to regenerate it', () => {
    const v = view(flatten(SOURCE), yawed(SOURCE));
    expect(v.restReconciliation.kind).toBe('direction');
    const signal = restSignal(v);
    expect(signal).not.toBeNull();
    expect(signal!.branch).toBe('direction');
    expect(signal!.tone).toBe('warn');
    expect(signal!.label).toBe('roll not transferred');
    expect(signal!.detail).toContain("This clip's rest pose");
    expect(signal!.detail).toContain('Regenerate the clip');
    // 🔴 THE DEFECT THIS ROW EXISTS FOR (#987). The aligned branch's promise
    // must not appear here — it is the sentence a director was shown beside a
    // 92° reading on a clip that had just lost up to 153° of roll.
    expect(signal!.detail).not.toContain('transfers exactly');
  });

  it('names the CHARACTER instead when it is the bind that is flat', () => {
    const v = view(SOURCE, flatten(yawed(SOURCE)));
    const signal = restSignal(v);
    expect(signal!.detail).toContain("This character's bind pose");
    expect(signal!.detail).toContain('Re-import the character');
    // Supplied so the remedy is witnessed as a CHOICE: the row above hands the
    // same producer a flat clip and must get the other sentence.
    expect(signal!.detail).not.toContain('Regenerate the clip');
  });

  it('names both when neither rig can supply a body frame', () => {
    const signal = restSignal(view(flatten(SOURCE), flatten(yawed(SOURCE))));
    expect(signal!.detail).toContain("Neither this clip's rest nor this character's bind");
  });

  it('says the clip was authored for another body when two full-rank rests disagree', () => {
    const v = view(SOURCE, TARGET_CROSSED);
    expect(v.restReconciliation.kind).toBe('direction');
    const signal = restSignal(v);
    expect(signal!.label).toBe('roll not transferred');
    expect(signal!.detail).toContain('differently-built character');
    // NOT the flat-rest sentence: both of these rests span three dimensions, and
    // telling a director to regenerate a clip that is fine is a wrong remedy,
    // not merely a vague one.
    expect(signal!.detail).not.toContain('single axis');
  });

  it('keeps the per-bone angles off the direction branch, where they point the wrong way', () => {
    // #987, one column over. On the flat-rest pair eleven of seventeen mapped
    // rows clear the alarm threshold, and each one describes a disagreement
    // nobody reconciled rather than a residue nobody can remove — eleven
    // invitations to edit a map that is already correct.
    const flat = view(flatten(SOURCE), yawed(SOURCE));
    expect(flat.restReconciliation.kind).toBe('direction');
    expect(flat.rows.filter((r) => r.restGapDeg !== null)).toHaveLength(0);

    // The losing alternative: the aligned branch must still carry its angles on
    // the rows, or this suppression has quietly deleted the feature it is
    // protecting. Since #866 those angles are ABSORBED — carried as a fact about
    // the two anatomies, marked as such, and kept out of the header — so the
    // witness is the marked row, not a header entry.
    const aligned = view(SOURCE, TARGET_ALIGNED);
    const carried = aligned.rows.filter((r) => r.restGapDeg !== null);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.some((r) => r.restGapAbsorbed && (r.restGapDeg ?? 0) > 15)).toBe(true);
  });

  it('stays silent when the map does not reach the rigs, because the counts already shout', () => {
    // Deliberate silence, pinned so it cannot be quietly filled in later. One
    // mapped bone has no mapped descendant, so the solve sees no pairs at all —
    // and `drivenTargets` beside this badge is the number that says so in the
    // terms a director acts on.
    const v = view(SOURCE, yawed(SOURCE), { s_spine: 't_spine' });
    expect(v.restReconciliation.kind).toBe('direction');
    expect(restSignal(v)).toBeNull();
    // ...and the shouting is CHECKED, not assumed. The comment beside the
    // silence claims the driven count already carries this failure; a claim with
    // no reader is how a panel ends up saying nothing twice.
    expect(v.drivenTargets).toBe(1);
    expect(v.targetTotal).toBe(SOURCE.length);
  });
});
