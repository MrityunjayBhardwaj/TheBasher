// What the director sees when they open a retarget's bone map (#921).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT A COMPONENT'S BODY
// ─────────────────────────────────────────────────────────────────────────
// #901 made the bone map a real node, so the agent and the graph can correct a
// mis-mapped bone and the render follows. A director could not: a record param
// falls past every arm of the inspector's row dispatcher. This module is the
// answer to "what should the panel draw?", kept pure so the answer is testable
// without mounting anything — the component below it decides only where pixels go.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A ROW IS DERIVED AND ITS PROVENANCE IS NOT STORED
// ─────────────────────────────────────────────────────────────────────────
// A row's `origin` says whether a pairing is what the auto-map proposed or what a
// person decided. The tempting version stores that flag when the user edits. It
// would be wrong within one session: re-running auto-map, loading an older
// project, or an agent writing the map all produce entries with no flag, and a
// stored flag then describes history rather than the file. So provenance is
// DERIVED by comparing each entry against what `chooseBoneNameMap` proposes for
// these two rigs right now. An entry that matches the proposal reads `preset`; one
// that differs reads `edited`. It self-corrects, needs no schema, and cannot rot.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THERE IS NO PER-ROW ENABLE TOGGLE
// ─────────────────────────────────────────────────────────────────────────
// The reference addon (RigCopy, MIT — ref/sources/rigcopy) gives every row an
// enable checkbox, and it is right to: a Blender addon's list is the only place
// the pairing is stored, so deleting a row destroys the target name. Here the map
// is graph data with full undo, so remove IS disable and undo brings it back. A
// separate `disabled` set would be a SECOND answer to "is this bone mapped?",
// which the retarget math would then have to consult or silently contradict.
// One answer, in one place.
//
// REF: ref/architecture/bone-mapping-ui.html (the design + the reference audit);
//      src/core/import/chooseBoneNameMap.ts (the proposal this compares against);
//      src/app/animate/retargetFromNodes.ts (the shared operand walk);
//      src/core/import/boneNameMaps.ts:138 (why a human must be able to overrule);
//      issues #921, #901.

import { chooseBoneNameMap } from '../../core/import/chooseBoneNameMap';
import { specToThreeSkeleton } from '../../core/import/threeAdapter';
import {
  solveRestAlignment,
  restDirectionDisagreement,
  alignedLocalOffsets,
} from '../../core/import/restAlignment';
import type { RestReconciliation } from '../../core/import/restAlignment';
import { BONE_NAME_MAP_PRESETS } from '../../core/import/boneNameMaps';
import { edgeTarget, type GraphNodeLike } from './graphNodes';
import { retargetOperandsFromNodes } from './retargetFromNodes';
import type { BoneSpec } from '../../nodes/types';

/** Why this pairing reads the way it does. Derived, never stored. */
export type BoneMapRowOrigin = 'preset' | 'edited';

export type BoneMapRowState =
  /** Mapped onto a bone the target rig carries. */
  | 'mapped'
  /** This source bone has no entry — its motion reaches nothing. */
  | 'unmapped'
  /** Mapped onto a name the target rig does NOT carry — the entry drives nothing.
   *  Distinct from `unmapped` because the fix is different: an unmapped bone needs
   *  a decision, a dangling one needs a correction. */
  | 'dangling'
  /** The entry's SOURCE bone is not in the source rig, so no keyframe ever addresses
   *  it — the row drives nothing however valid its target looks.
   *
   *  Its own state because self-review caught it reading as an ordinary `mapped` row:
   *  a map carried over from another clip would show a healthy pairing AND be counted
   *  in target coverage, overstating the one number the panel leads with. */
  | 'orphan';

export interface BoneMapRow {
  /** A bone of the SOURCE rig. Read-only: the clip's vocabulary is a fact. */
  readonly source: string;
  /** The target name this source is sent to, or null when there is no entry. */
  readonly target: string | null;
  readonly state: BoneMapRowState;
  readonly origin: BoneMapRowOrigin;
  /**
   * How far apart the two rigs point THIS bone at rest, in degrees, after the
   * whole-rig rotation — or null when the pairing has no rest direction to
   * compare (a chain end, or a row that drives nothing).
   *
   * WHY A MAPPING PANEL CARRIES AN ANGLE. A pairing can be perfectly correct and
   * still not look right, and this is the reason: no rotation transfer removes a
   * rest-direction disagreement — Blender's does not either, which is why its
   * answer is to match the rests or add IK. Measured on the pair a director gets
   * today, the feet disagree by 18.3° and the arms by 0.0°, and until now the
   * panel showed both as an identical healthy green row. `null` is not zero.
   */
  readonly restGapDeg: number | null;
  /**
   * Whether the retarget's per-bone direction term ABSORBS that gap (#866). On
   * the aligned branch every bone with a mapped child is absorbed unless its two
   * rests are nearly opposite; an absorbed gap is information about the two
   * anatomies, not a defect to act on, and it must never be coloured as one.
   * False on the direction branch and for a refused bone, where the gap stays.
   */
  readonly restGapAbsorbed: boolean;
}

export interface BoneMapView {
  /** The `BoneNameMap` node a write goes to. */
  readonly mapNodeId: string;
  readonly rows: readonly BoneMapRow[];
  /** The target rig's joint names, in rig order — the picker's options. FULL names:
   *  this is what a write stores, and it is never the elided form. */
  readonly targetBoneNames: readonly string[];
  /** A prefix EVERY target name shares, safe to hide in the picker's labels.
   *
   *  Measured need: in a ~300px inspector, `mixamorig_LeftLeg` and
   *  `mixamorig_LeftUpLeg` both render as `mixamorig_L…`, which is the reference
   *  addon's unreadable list reproduced one column over. The prefix is the redundant
   *  half and the tail is the discriminating one, so the prefix is what gives way.
   *  Empty when the rig's names share nothing worth hiding. */
  readonly targetPrefix: string;
  /** The same, for the SOURCE column. A Mixamo-authored clip makes every row read
   *  `mixamorig_…` and truncate — the identical defect, one column to the left. */
  readonly sourcePrefix: string;
  /** Distinct target bones actually driven. The number that predicts a frozen limb. */
  readonly drivenTargets: number;
  readonly targetTotal: number;
  readonly unmappedCount: number;
  /** Unmapped bones the PROPOSAL could map — the actionable subset of
   *  `unmappedCount`, and the only one worth alarming a director with (#923). */
  readonly gapCount: number;
  readonly danglingCount: number;
  /** What the auto-map proposes for these two rigs, for the header and the button. */
  /**
   * The mapped pairing whose two rests point furthest apart AND whose gap the
   * retarget could not absorb, or null when nothing is left. What a director
   * should look at FIRST when the motion is right and the pose still is not.
   * Since #866 the aligned branch absorbs a rest gap per bone, so on that branch
   * this names only a bone whose two rests are nearly opposite (refused).
   */
  readonly worstRestGap: {
    readonly source: string;
    readonly target: string;
    readonly deg: number;
  } | null;
  /**
   * Whether the two rests were reconciled by a whole-rig rotation, and if not,
   * why not.
   *
   * 🔴 READ THIS BEFORE `worstRestGap`. It decides which quantity that angle IS.
   * On `aligned` it is what the whole-rig rotation left behind — and since #866
   * the retarget absorbs that per bone, so a row's angle is information about
   * the two anatomies (`restGapAbsorbed`) unless the bone was refused. On
   * `direction` no rotation was applied, so the same number is the RAW
   * disagreement between two rests nobody reconciled, and on that branch the
   * roll about every bone is gone as well (#960, #987).
   */
  readonly restReconciliation: RestReconciliation;
  readonly proposalLabel: string | null;
  /** OTHER retargets reading this same map node. Editing here changes them too. */
  readonly sharedWith: readonly string[];
}

/**
 * The naming-convention prefix MOST of these bones carry, or '' when there is none.
 *
 * Not the prefix they ALL share, and that distinction was measured rather than
 * reasoned: the first version took the universal prefix and returned '' on a real
 * Tripo rig, because one bone is called `Root` while the other 22 are `mixamorig_*`.
 * A single bone outside the convention defeated the whole elision — and every rig has
 * that bone. So the prefix is taken from the convention (the text up to and including
 * the last separator) and adopted when at least half the names follow it. Names that
 * do not follow it simply render whole, which is exactly right: `Root` is short.
 */
export function sharedPrefix(names: readonly string[]): string {
  if (names.length < 2) return '';
  const counts = new Map<string, number>();
  for (const n of names) {
    const cut = Math.max(n.lastIndexOf('_'), n.lastIndexOf(':'), n.lastIndexOf('.'));
    if (cut < 3) continue; // too short to be a convention rather than a coincidence
    const p = n.slice(0, cut + 1);
    // Never a prefix that would leave a name with nothing to show.
    if (p.length >= n.length) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [p, n] of counts) {
    // Longest wins a tie, so `mixamorig_` beats a shorter accidental prefix.
    if (n > bestN || (n === bestN && p.length > best.length)) {
      best = p;
      bestN = n;
    }
  }
  return bestN * 2 >= names.length ? best : '';
}

/**
 * `chooseBoneNameMap` scores every registered candidate over both name sets, and it
 * runs on every render of this panel. The inspector subscribes to the whole node
 * table, whose ref flips on EVERY dispatch, so dragging any unrelated param in the
 * project re-derives this once per pointer move — the exact cost the sibling resolver
 * in `retargetFromNodes.ts` memoizes against, and which self-review caught me not
 * carrying across when I extracted the walk from it.
 *
 * Keyed on the identity of the two BONE ARRAYS, which are stable objects: a glTF rig
 * is a cached projection of the captured skin, and a `Skeleton` node's array is
 * replaced only when its bones are edited. So this recomputes exactly when a rig
 * changes and is free otherwise.
 */
const proposalMemo = new WeakMap<
  object,
  WeakMap<object, { map: Readonly<Record<string, string>>; label: string | null }>
>();

function proposedMapCached(
  sourceBones: object,
  targetBones: object,
  sourceNames: readonly string[],
  targetNames: readonly string[],
): { map: Readonly<Record<string, string>>; label: string | null } {
  const hit = proposalMemo.get(sourceBones)?.get(targetBones);
  if (hit) return hit;
  const answer = proposedMap(sourceNames, targetNames);
  let inner = proposalMemo.get(sourceBones);
  if (!inner) proposalMemo.set(sourceBones, (inner = new WeakMap()));
  inner.set(targetBones, answer);
  return answer;
}

/**
 * When a rest disagreement is worth SAYING, and when it is worth shouting.
 *
 * 🔴 OURS, not borrowed. The reference addon (RigCopy, MIT — ref/sources/rigcopy)
 * has no per-row diagnostic of any kind, and Blender core has no retargeter to
 * copy a convention from, so there is nothing here to inherit and a citation
 * would be decoration.
 *
 * Read off the one pair a director actually has, where the ends of the range are
 * known by looking: the arms disagree by 0.0° and look right, the shoulders by
 * 8.8° and read as a slightly different build rather than as a fault, and the
 * feet by 18.3° — which is the pair that gets called broken. So the alarm sits
 * between the two ends that are known, and the quieter line low enough that a
 * bone on its way to being wrong is visible before a director has to ask.
 *
 * Not a perceptual threshold and not claimed as one; two measured points and the
 * decision that follows from them.
 */
export const REST_GAP_MENTION_DEG = 5;
export const REST_GAP_ALARM_DEG = 15;

/** The gaps and the branch that decides what they MEAN, memoised together.
 *
 *  Together on purpose (#987). The same call returns two different quantities
 *  depending on the branch — the residue LEFT BY the whole-rig rotation when one
 *  was solved, the RAW disagreement when none was — and a cache that kept only
 *  the numbers forced every reader to re-derive the branch to know which it was
 *  holding. The panel then described one as the other. */
interface RestReport {
  readonly gaps: Map<string, number>;
  readonly reconciliation: RestReconciliation;
  /** Target bones whose gap the aligned offsets absorb — reported by the same
   *  builder the retarget runs, never re-derived here (#866). */
  readonly absorbed: ReadonlySet<string>;
}

const gapMemo = new WeakMap<object, WeakMap<object, WeakMap<object, RestReport>>>();

/**
 * Per-bone rest disagreement for these two rigs under this map, memoised on all
 * three — the map belongs in the key because a director editing a pairing
 * changes the answer, and a cache that ignored it would show the old rig's
 * numbers beside the new pairing.
 */
function restGapsCached(
  sourceBones: readonly BoneSpec[],
  targetBones: readonly BoneSpec[],
  map: Readonly<Record<string, string | null>>,
): RestReport {
  const a = sourceBones as unknown as object;
  const b = targetBones as unknown as object;
  const c = map as unknown as object;
  const hit = gapMemo.get(a)?.get(b)?.get(c);
  if (hit) return hit;

  // The report is keyed by TARGET bone, so the map is inverted here. Two source
  // bones pointing at one target collapse, which is what the retarget does with
  // them too.
  const targetToSource: Record<string, string> = {};
  for (const [source, target] of Object.entries(map)) {
    if (typeof target === 'string' && target !== '') targetToSource[target] = source;
  }
  const source = specToThreeSkeleton(sourceBones).bones;
  const target = specToThreeSkeleton(targetBones).bones;
  const solved = solveRestAlignment(source, target, targetToSource);
  const answer: RestReport = {
    gaps: restDirectionDisagreement(
      source,
      target,
      targetToSource,
      solved.kind === 'aligned' ? solved.rotation : undefined,
    ),
    reconciliation: solved,
    absorbed:
      solved.kind === 'aligned'
        ? new Set(alignedLocalOffsets(source, target, targetToSource, solved.rotation).absorbed)
        : new Set(),
  };

  let outer = gapMemo.get(a);
  if (!outer) gapMemo.set(a, (outer = new WeakMap()));
  let inner = outer.get(b);
  if (!inner) outer.set(b, (inner = new WeakMap()));
  inner.set(c, answer);
  return answer;
}

/** The proposal `chooseBoneNameMap` makes for these two rigs, as a flat record. */
function proposedMap(
  sourceNames: readonly string[],
  targetNames: readonly string[],
): { map: Readonly<Record<string, string>>; label: string | null } {
  const choice = chooseBoneNameMap(sourceNames, targetNames);
  if (!choice) return { map: {}, label: null };
  if (choice.customMap) return { map: choice.customMap, label: choice.label };
  const preset = BONE_NAME_MAP_PRESETS.find((p) => p.id === choice.presetId);
  return { map: preset?.map ?? {}, label: choice.label };
}

/**
 * Rows sort by what needs attention, not by name.
 *
 * A 78-row alphabetical list buries the one wrong pairing, which is the reference
 * addon's failure restated as an ordering problem. Unresolved first (dangling
 * before unmapped — a dangling entry is a mistake, an unmapped bone may be a
 * deliberate omission), then edited, then preset. Within a group the SOURCE RIG's
 * own order is kept: bone order is parentage order, so hips stay above knees.
 */
const GROUP_RANK: Record<string, number> = {
  dangling: 0,
  orphan: 1,
  unmapped: 2,
  'mapped-edited': 3,
  'mapped-preset': 4,
};

function rank(row: BoneMapRow): number {
  if (row.state === 'mapped') return GROUP_RANK[`mapped-${row.origin}`];
  return GROUP_RANK[row.state];
}

/**
 * Everything the bone-map editor draws for one `RetargetClip`, or null when the
 * node is not one, has no map node wired, or has no rigs on either side.
 *
 * Null is the honest answer for a half-wired retarget: there is nothing to author
 * yet, and an empty table would read as "this rig has no bones" rather than as
 * "this graph is not finished".
 */
export function boneMapView(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  retargetNodeId: string,
): BoneMapView | null {
  const node = nodes[retargetNodeId];
  const operands = retargetOperandsFromNodes(nodes, node);
  if (!operands) return null;

  const { sourceBones, targetBones, map, mapNodeId } = operands;
  if (!mapNodeId || !map) return null;
  if (!sourceBones || sourceBones.length === 0) return null;
  if (!targetBones || targetBones.length === 0) return null;

  const sourceNames = sourceBones.map((b) => b.name);
  const targetNames = targetBones.map((b) => b.name);
  const targetSet = new Set(targetNames);
  const proposal = proposedMapCached(
    sourceBones as unknown as object,
    targetBones as unknown as object,
    sourceNames,
    targetNames,
  );

  // Every source bone gets a row, plus any map key the source rig does not carry.
  // The second half matters: a map written for a different clip leaves entries
  // whose source bone is absent, and dropping them from the list would hide the
  // reason a "mapped" count does not match what moves.
  const seen = new Set(sourceNames);
  const orphanKeys = Object.keys(map).filter((k) => !seen.has(k));

  // "No target" has four spellings — an absent key, `null`, `''`, and a name the
  // target rig does not carry — and they all mean the same thing to a director.
  // Collapsing them is what lets DECLINING be compared like any other answer
  // (#923). Without it, `undefined === null` is false, so a bone the preset
  // deliberately skips read as EDITED: the panel accused a director of removing a
  // mapping that was never offered, on every one of SOMA's fingers, jaw and eyes.
  const declared = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v !== '' && targetSet.has(v) ? v : null;

  const rest = restGapsCached(sourceBones, targetBones, map);
  // 🔴 PER-BONE ANGLES ONLY ON THE ALIGNED BRANCH (#987).
  //
  // The same call returns two different quantities. On `aligned` an angle is
  // what the whole-rig rotation LEFT — irreducible anatomy, and naming the bone
  // is the entire point, because two bones carry it and fifteen do not. On
  // `direction` no rotation was applied, so every angle is a raw disagreement
  // between two rests nobody reconciled: measured on the flat-rest pair, ELEVEN
  // of seventeen mapped rows clear the alarm threshold. That is the column of
  // numbers on every row this design exists to avoid, and it points the wrong
  // way — it invites eleven map edits when the fault is one property of the clip
  // and the remedy is a whole-clip one. The header says that, once.
  const gaps: Map<string, number> = rest.reconciliation.kind === 'aligned' ? rest.gaps : new Map();

  const rows: BoneMapRow[] = [...sourceNames, ...orphanKeys].map((source) => {
    const target = Object.prototype.hasOwnProperty.call(map, source) ? map[source] : null;
    // Two entries match when they give the same ANSWER, including when both
    // decline. Comparing the raw values as well would add no case: if they are
    // equal then their normalisations are equal by construction.
    const origin: BoneMapRowOrigin =
      declared(proposal.map[source]) === declared(target) ? 'preset' : 'edited';
    if (target === null || target === '') {
      return {
        source,
        target: null,
        state: 'unmapped',
        origin,
        restGapDeg: null,
        restGapAbsorbed: false,
      };
    }
    // Only a row that DRIVES something gets an angle. An orphan's source bone is
    // not in the rig and a dangling row's target is not either, so neither has a
    // rest direction to disagree about — and a number beside them would read as
    // a measurement of a pairing that does not exist.
    if (!seen.has(source)) {
      return { source, target, state: 'orphan', origin, restGapDeg: null, restGapAbsorbed: false };
    }
    const mapped = targetSet.has(target);
    return {
      source,
      target,
      state: mapped ? 'mapped' : 'dangling',
      origin,
      restGapDeg: mapped ? (gaps.get(target) ?? null) : null,
      restGapAbsorbed: mapped && rest.absorbed.has(target),
    };
  });

  const ordered = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
    .map((x) => x.row);

  // ONLY `mapped`. An `orphan` names a real target bone but no keyframe addresses its
  // source, and a `dangling` names no real bone at all; counting either inflates the
  // one number a director reads to predict a frozen limb.
  const driven = new Set(rows.filter((r) => r.state === 'mapped').map((r) => r.target as string));

  return {
    mapNodeId,
    rows: ordered,
    targetBoneNames: targetNames,
    targetPrefix: sharedPrefix(targetNames),
    // Over the SOURCE RIG's names, not over the rows: rows also carry orphan map keys
    // from another rig, and letting a foreign vocabulary vote decides the convention
    // of a rig it does not belong to.
    sourcePrefix: sharedPrefix(sourceNames),
    drivenTargets: driven.size,
    targetTotal: targetNames.length,
    unmappedCount: rows.filter((r) => r.state === 'unmapped').length,
    // #923 — the number that is allowed to SHOUT. An unmapped bone the proposal
    // also declines is the preset working as designed (SOMA's fingers, jaw, eyes
    // and end-effectors have no counterpart, `boneNameMaps.ts`); an unmapped bone
    // the proposal CAN map is a real gap someone should look at. A healthy bind
    // read 56 unmapped, which taught a director to ignore the one widget that has
    // to shout when a bone really is missing. The full list is unchanged — only
    // the headline is narrowed.
    gapCount: rows.filter((r) => r.state === 'unmapped' && r.origin === 'edited').length,
    danglingCount: rows.filter((r) => r.state === 'dangling').length,
    // The worst pairing, not an average of them: seventeen bones are plenty to
    // average two bad ones away with, and it is the two that a director sees.
    // Over what is LEFT after the retarget's own correction (#866): an absorbed
    // gap is not a thing a director can act on, so it does not compete here.
    worstRestGap: rows.reduce<BoneMapView['worstRestGap']>((worst, r) => {
      if (r.restGapDeg === null || r.target === null || r.restGapAbsorbed) return worst;
      if (worst !== null && worst.deg >= r.restGapDeg) return worst;
      return { source: r.source, target: r.target, deg: r.restGapDeg };
    }, null),
    restReconciliation: rest.reconciliation,
    proposalLabel: proposal.label,
    sharedWith: Object.keys(nodes)
      .filter(
        (id) =>
          id !== retargetNodeId &&
          nodes[id]?.type === 'RetargetClip' &&
          edgeTarget(nodes[id], 'boneMap') === mapNodeId,
      )
      .sort(),
  };
}

/**
 * The whole `map` record after one row edit — `null` target removes the entry.
 *
 * WHOLE RECORD, NEVER A SUBPATH, and this is measured rather than preferred.
 * `setAtPath` (core/dag/ops.ts:44) splits a param path on '.' unconditionally, so
 * a `setParam(map.spine.001, …)` would write a nested object where the schema wants
 * a string and throw. Rigify-style source rigs carry exactly those names. Writing
 * the whole record is immune to any bone name, is the only shape that can express a
 * REMOVAL, and costs one small object per edit.
 */
/**
 * `name` with `prefix` removed — but ONLY when it actually carries it.
 *
 * The unguarded `slice(prefix.length)` is a real defect and this is the guard for it:
 * a rig's odd bone out (`Root` among 22 `mixamorig_*`) does not carry the convention,
 * so slicing ten characters off it renders an EMPTY label in the picker. The prefix is
 * adopted by a majority precisely so the minority can exist; they must render whole.
 */
/**
 * What the bone-map header says about the two rests, or null when there is
 * nothing to say.
 *
 * ONE producer for both branches, and that is the point (#987). The two are
 * different sentences about different quantities, and the previous arrangement
 * — a threshold restated in JSX over a number whose meaning depended on a branch
 * the panel could not see — printed the ALIGNED branch's promise on the branch
 * where it is false: "the motion transfers exactly" beside a 92° reading on a
 * clip that had just lost up to 153° of roll.
 *
 * The decision this encodes (#960): WARN, never refuse, and name the side.
 *
 *   Not refuse — the clip is otherwise usable. `soma-walk.bvh` retargets to 713
 *   keyframe tracks of correct swing; only the twist is gone. Blender takes the
 *   same posture on the same class of thing: `rotlike_evaluate` transfers what
 *   it can and never consults the two rests, leaving the remedy to the user
 *   (constraint.cc:2049, see ref/GROUND_TRUTH_BLENDER_BONE_SPACES.md).
 *
 *   Not condition automatically — there is nothing to condition WITH. A rank-one
 *   rest has no second axis to recover the roll from, not even the shoulder
 *   line, which is degenerate on exactly these rests (#854). The conditioning
 *   lever lives in the exporter, not here (#855).
 *
 *   So: warn, attributably. A flat CLIP is regenerated, a flat CHARACTER is
 *   re-imported, and two full-rank rests that disagree mean this clip was
 *   authored for a differently-built body. Those are three different actions,
 *   which is why the refusal carries a side and not just a fact.
 */
export interface RestSignal {
  readonly tone: 'quiet' | 'warn';
  readonly label: string;
  readonly detail: string;
  /** For the test id, so a spec can tell the two branches apart by name. */
  readonly branch: 'aligned' | 'direction';
}

export function restSignal(view: BoneMapView): RestSignal | null {
  const rest = view.restReconciliation;
  if (rest.kind === 'aligned') {
    // Only what the retarget could NOT absorb reaches the header (#866). A gap
    // on a bone whose rests are nearly opposite keeps its bind and the
    // disagreement stays; every other gap is folded into that bone's offset.
    const worst = view.worstRestGap;
    if (!worst || worst.deg < REST_GAP_MENTION_DEG) return null;
    return {
      branch: 'aligned',
      tone: worst.deg >= REST_GAP_ALARM_DEG ? 'warn' : 'quiet',
      label: `${worst.deg.toFixed(0)}° rest gap at ${elidePrefix(worst.source, view.sourcePrefix)}, not absorbed`,
      detail:
        `${worst.source} → ${worst.target}: the two rigs point this bone nearly opposite ways ` +
        `(${worst.deg.toFixed(0)}° apart after the whole-rig turn), so the per-bone correction ` +
        `refused it and this offset stays. The motion transfers exactly; every other bone's ` +
        `rest difference is absorbed. Condition the clip to a T-pose, or accept it.`,
    };
  }

  // The LOUD failure needs nothing from here. With fewer than four mapped pairs
  // almost nothing transfers at all, and the driven/unmapped counts beside this
  // badge already say so in the terms a director acts on. A second widget firing
  // on the same fault is how a panel teaches people to stop reading it (#923).
  if (rest.reason.kind === 'too-few-pairs') return null;

  // One sentence, shared, because it is the same loss on both arms — only the
  // cause and the remedy differ.
  const lost =
    'Bone directions were matched instead, so the swing transfers and the twist about each ' +
    'bone is lost — up to 153° on a clip like this.';

  if (rest.reason.kind === 'flat-rest') {
    const cause =
      rest.reason.side === 'source'
        ? "This clip's rest pose lays every bone on a single axis, so it can say which way each " +
          'bone points but not how it is rolled.'
        : rest.reason.side === 'target'
          ? "This character's bind pose lays every bone on a single axis, so it can say which " +
            'way each bone points but not how it is rolled.'
          : "Neither this clip's rest nor this character's bind spans more than one axis, so " +
            'neither can say how a bone is rolled.';
    const remedy =
      rest.reason.side === 'target'
        ? 'Re-import the character from a source whose bind is a real pose.'
        : 'Regenerate the clip with a T-pose rest, or accept the loss.';
    return {
      branch: 'direction',
      tone: 'warn',
      label: 'roll not transferred',
      detail: `${cause} ${lost} ${remedy}`,
    };
  }

  return {
    branch: 'direction',
    tone: 'warn',
    label: 'roll not transferred',
    detail:
      `The clip's rest and the character's bind are ${rest.reason.before.toFixed(0)}° apart, and ` +
      `no single turn brings them closer than ${rest.reason.after.toFixed(0)}°. ${lost} This clip ` +
      `was authored for a differently-built character.`,
  };
}

export function elidePrefix(name: string, prefix: string): string {
  return prefix && name.startsWith(prefix) && name.length > prefix.length
    ? name.slice(prefix.length)
    : name;
}

export function mapWithRow(
  map: Readonly<Record<string, string>>,
  source: string,
  target: string | null,
): Record<string, string> {
  const next: Record<string, string> = { ...map };
  if (target === null || target === '') delete next[source];
  else next[source] = target;
  return next;
}
