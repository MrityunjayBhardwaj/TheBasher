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
  it('reports the leftover anatomy on the aligned branch, and promises the transfer', () => {
    const v = view(SOURCE, TARGET_ALIGNED);
    expect(v.restReconciliation.kind).toBe('aligned');
    const signal = restSignal(v);
    expect(signal).not.toBeNull();
    expect(signal!.branch).toBe('aligned');
    expect(signal!.label).toContain('rest gap');
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

    // The losing alternative: the aligned branch must still name its bone, or
    // this suppression has quietly deleted the feature it is protecting.
    const aligned = view(SOURCE, TARGET_ALIGNED);
    expect(aligned.rows.filter((r) => r.restGapDeg !== null).length).toBeGreaterThan(0);
    expect(aligned.worstRestGap).not.toBeNull();
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
