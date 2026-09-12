// Where a minted channel's keys CAME FROM, and whether that is still true (#1001).
//
// ─────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS ANSWERS
// ─────────────────────────────────────────────────────────────────────────
// A director edits a bone, so `ensureChannelForBone` mints a channel for it and
// seeds it from the clip currently driving the rig. Later the clip is re-cooked
// — a dragged curve, an edited prompt, a new seed — which #902/#935 made an
// ordinary gesture rather than a rare one.
//
// Precedence is manual ⊳ baked ⊳ clip, per component, on PRESENCE. So after the
// re-cook every bone the director HAD touched keeps the old motion from the
// seed, and every bone they had NOT touched follows the new clip. One character,
// two motions, and nothing says so. It is worse than a uniformly stale copy: the
// stale bones are exactly the ones the director cared enough to edit.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS CANNOT BE DERIVED FROM THE KEYS, WHICH IS THE WHOLE DIFFICULTY
// ─────────────────────────────────────────────────────────────────────────
// The cheap fix is to re-seed the bone and see whether the channel's keys still
// match. It does not work, and the reason is worth writing down before someone
// tries it. A channel whose keys differ from the clip's is in one of two states:
//
//   1. the clip changed underneath it   — STALE, a defect
//   2. the director edited it           — AUTHORED, the entire point of the band
//
// Those are opposite meanings and no comparison of the keys can separate them.
// A check built on "do the keys still match" reports every deliberate edit as a
// defect — the alarm-on-a-healthy-bind failure (#923) that already taught a
// director once to ignore a widget.
//
// ⇒ The provenance is RECORDED AT THE MINT, never reconstructed later. The
// channel carries the clip it was seeded from and a hash of the track it copied.
// Staleness is then "that hash is not what the clip says today", which says
// nothing whatever about whether the keys were subsequently edited. A director
// can rewrite every key in the channel and it stays `current`; the clip can move
// by one frame and it reads `stale` even if the keys were never touched.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 ONE SEEDING FUNCTION, CONSULTED TWICE — THE LOAD-BEARING PART
// ─────────────────────────────────────────────────────────────────────────
// The hash recorded at the mint and the hash recomputed at the read MUST come
// from the same walk of the clip. `seedKeysFromClip` therefore lives HERE, and
// the mint imports it rather than owning it: it picks a clip out of several, it
// filters by bone index, it sorts, and it converts rotation from RADIANS to
// DEGREES. A second spelling of any one of those — a different clip chosen on a
// tie, an unsorted array, a forgotten conversion — makes the two hashes disagree
// for a channel nobody touched, so every channel reads `stale` forever and the
// signal is worth exactly nothing. That is the two-spellings-of-one-question
// failure this codebase has now measured three times.
//
// REF: src/app/animate/ensureChannelForBone.ts (the mint that records it);
//      src/app/animate/boundClipsForAsset.ts (the one edge walk);
//      src/app/asset/bakeGeneratedClip.ts (the SAME shape one hop up — a sink
//        clip's `sourceHash` against its producer's request);
//      issues #1001, #877, #889, #902, #935.

import { hashValue } from '../../core/dag/hash';
import type { DagState } from '../../core/dag/state';
import type { BakedComponent, BakedKey } from '../../agent/mutators/builders/bakeChannelOps';
import { BAKED_COMPONENTS } from '../../agent/mutators/builders/bakeChannelOps';
import { gltfChannelDagId } from '../../core/import/gltfImportChain';
import type { AnimationClipParams } from '../../nodes/AnimationClip';
import { boneIndexOf, boundClipsForAsset, type BoundClip } from './boundClipsForAsset';
import { radVec3ToDeg } from '../../viewport/rotation';
import { clipLoopOf, type ClipLoop } from '../../nodes/clipLoop';

/** The keys copied from the bound clip, which clip supplied them, and whether
 *  that clip REPEATS.
 *
 *  Returned together on purpose (#913): the keys and the time domain are two
 *  halves of one answer, and a caller that could take the first without the
 *  second is a caller that can mint a copy which stops where its source wraps. */
export interface ClipSeed {
  readonly keys: BakedKey[];
  /** How the source clip extends (#930) — carried, not collapsed to a boolean,
   *  so a clip cycling IN PLACE mints a channel that also cycles in place. */
  readonly loop: ClipLoop;
  /** The clip these keys came from, or `''` when no bound clip carries the bone.
   *
   *  `''` rather than null so the recorded provenance is a string either way and
   *  the absent-field case below stays the ONLY way to say "not recorded". */
  readonly clipId: string;
}

/**
 * The clip's own track for one bone and one component, in the channel's units.
 *
 * Returns no keys when no bound clip carries the bone — not a failure, just
 * nothing to copy. The mint falls back to the base pose rather than to emptiness.
 */
export function seedKeysFromClip(
  state: DagState,
  assetRef: string,
  childName: string,
  component: BakedComponent,
): ClipSeed {
  return seedFromIndexed(
    indexClipsByBone(boundClipsForAsset(state.nodes, assetRef)),
    childName,
    component,
  );
}

/** One bound clip with its keyframes already bucketed by bone index. */
interface IndexedClip {
  readonly clipId: string;
  readonly loop: ClipLoop;
  readonly jointKeys: readonly string[];
  /** bone index → that bone's keyframes, SORTED BY TIME. */
  readonly byBone: ReadonlyMap<number, AnimationClipParams['keyframes']>;
}

/**
 * Bucket each clip's keyframes by bone, once.
 *
 * 🔴 A COST SHAPE, MEASURED, NOT A GUESS. Asking a clip for one bone's track by
 * filtering the whole keyframe array is O(all keys) per question, and
 * `channelSeedRows` asks it once per bone per component. On a 78-bone rig with a
 * 109-frame clip — the pair a director actually gets — that is 234 sweeps of
 * 8500 keyframes, and `motionCookOffer` sits on a render path. Measured before
 * this: 3.6 ms per call with 20 edited bones, against the 2.2 ms the warning on
 * `hasStaleGenerations` already calls too expensive to leave unmemoised.
 *
 * The sort happens HERE rather than at the point of use, so it is paid once per
 * bone instead of once per question about that bone.
 */
const BONE_INDEX_MEMO = new WeakMap<
  object,
  ReadonlyMap<number, AnimationClipParams['keyframes']>
>();

function indexClipsByBone(clips: readonly BoundClip[]): IndexedClip[] {
  return clips.map((clip) => {
    const keyframes = (clip.params as Partial<AnimationClipParams>).keyframes ?? [];
    // MEMOISED ON THE KEYFRAME ARRAY'S IDENTITY, which is exactly the right key:
    // a re-cook writes a NEW array (params are replaced, never mutated in place),
    // so the entry falls out of use the moment the clip it describes stops
    // existing — the invalidation is the data model rather than a rule anyone
    // has to remember. A clip whose params are rebuilt per call (a `RetargetClip`
    // resolved from its inputs) simply misses; a miss costs what this cost
    // before, and can never be WRONG.
    const cached = BONE_INDEX_MEMO.get(keyframes);
    if (cached) {
      return {
        clipId: clip.clipId,
        loop: clipLoopOf((clip.params as Partial<AnimationClipParams>).loop),
        jointKeys: clip.jointKeys,
        byBone: cached,
      };
    }
    const byBone = new Map<number, AnimationClipParams['keyframes']>();
    for (const k of keyframes) {
      const bucket = byBone.get(k.bone);
      if (bucket) bucket.push(k);
      else byBone.set(k.bone, [k]);
    }
    // Sorted by time so the minted channel's keys are ordered the way the node's
    // own sampler expects, rather than in whatever order the clip stored them.
    for (const bucket of byBone.values()) bucket.sort((a, b) => a.time - b.time);
    BONE_INDEX_MEMO.set(keyframes, byBone);
    return {
      clipId: clip.clipId,
      // Normalised through the ONE helper rather than with a local fallback:
      // five readers each spelling their own default, all disagreeing with the
      // schema, is the defect #930 records.
      loop: clipLoopOf((clip.params as Partial<AnimationClipParams>).loop),
      jointKeys: clip.jointKeys,
      byBone,
    };
  });
}

/**
 * The clip's own track for one bone and one component, in the channel's units.
 *
 * 🔴 THE ONE PLACE that picks a clip out of several, resolves the bone index,
 * and converts rotation from RADIANS to DEGREES. Both the mint and the
 * staleness read reach it — the mint through the wrapper above, the read after
 * indexing once — so the hash recorded at the copy and the hash recomputed later
 * cannot come from two different walks.
 *
 * Returns no keys when no bound clip carries the bone — not a failure, just
 * nothing to copy. The mint falls back to the base pose rather than to emptiness.
 */
function seedFromIndexed(
  indexed: readonly IndexedClip[],
  childName: string,
  component: BakedComponent,
): ClipSeed {
  // Scale is never seeded: `AnimationClipParams.keyframes` carries no scale, and
  // the read band omits it for the same reason. Claiming the component would
  // SUPPRESS the asset's own scale track underneath it, because the resolver
  // reads presence rather than value.
  if (component === 'scale') return { keys: [], loop: 'hold', clipId: '' };

  for (const clip of indexed) {
    const index = boneIndexOf(clip, childName);
    if (index === null) continue;
    const mine = clip.byBone.get(index);
    if (!mine || mine.length === 0) continue;
    return seedFromTrack(mine, component, clip);
  }
  return { keys: [], loop: 'hold', clipId: '' };
}

const TRACK_SEED_MEMO = new WeakMap<object, Map<string, ClipSeed>>();

/**
 * One bone's track, converted into the channel's units.
 *
 * MEMOISED ON THE BUCKET'S IDENTITY, which `indexClipsByBone` keeps stable for
 * as long as the clip's keyframes are the same array. Measured: without it, the
 * staleness read re-converts and re-hashes every edited bone's 109 keys on every
 * render, and 20 edited bones cost 2.0 ms — the figure `hasStaleGenerations`
 * already calls too expensive for a path a drag runs.
 *
 * Keyed by component AND by the clip, because the same bucket answers a
 * different question for each: rotation converts and position does not, and the
 * answer names which clip supplied it.
 */
function seedFromTrack(
  track: AnimationClipParams['keyframes'],
  component: BakedComponent,
  clip: IndexedClip,
): ClipSeed {
  const key = `${component}|${clip.loop}|${clip.clipId}`;
  let per = TRACK_SEED_MEMO.get(track);
  const hit = per?.get(key);
  if (hit) return hit;
  const seed: ClipSeed = {
    keys: track.map((k) => ({
      time: k.time,
      value: component === 'rotation' ? radVec3ToDeg(k.rotation) : k.position,
    })),
    loop: clip.loop,
    clipId: clip.clipId,
  };
  if (!per) {
    per = new Map();
    TRACK_SEED_MEMO.set(track, per);
  }
  per.set(key, seed);
  return seed;
}

/**
 * The recorded revision of a seeded track.
 *
 * Hashed over the KEYS the clip offered for this one bone and component, not
 * over the clip. A clip-wide hash would move whenever any OTHER bone's track
 * changed, so re-cooking a walk would report every edited bone stale including
 * the ones whose motion is byte-identical — a false alarm on a path where the
 * true positives are few and precious.
 *
 * The empty track hashes like any other, which is what lets a channel seeded
 * from NO clip (the base-pose fallback) be recorded rather than special-cased:
 * if a clip later arrives carrying that bone, its hash differs from the empty
 * one and the row reads `stale`, correctly — the keys demonstrably predate the
 * clip now driving its neighbours.
 */
const HASH_MEMO = new WeakMap<object, string>();

export function seedTrackHash(keys: readonly BakedKey[]): string {
  // Memoised on the array's identity too, for the same measured reason as the
  // conversion above and with the same self-invalidation: a re-cook produces a
  // new track, so a new array, so a miss. A caller handing in a freshly built
  // array — the mint, once per edit — simply misses, which costs what this cost
  // before and can never be wrong.
  const hit = HASH_MEMO.get(keys);
  if (hit !== undefined) return hit;
  const out = hashValue(keys.map((k) => [k.time, k.value]));
  HASH_MEMO.set(keys, out);
  return out;
}

/** The provenance params a mint stamps onto one channel. Both or neither. */
export interface SeedProvenance {
  readonly sourceClipId: string;
  readonly sourceHash: string;
}

/** What a seed consultation should be recorded as. */
export function provenanceOf(seed: ClipSeed): SeedProvenance {
  return { sourceClipId: seed.clipId, sourceHash: seedTrackHash(seed.keys) };
}

/**
 * Whether a channel's seed still describes the clip driving its bone.
 *
 * `unknown` is NOT `current`, and the distinction is the reason this is a
 * three-state read rather than a boolean. A channel minted before #1001 — every
 * one in every project saved until now — records nothing, and a boolean would
 * have to call it either clean (vouching for a copy nobody can vouch for) or
 * stale (alarming on every bone of every existing project). Neither is true, so
 * neither is said.
 */
export type SeedState = 'current' | 'stale' | 'unknown';

export interface ChannelSeedRow {
  readonly channelId: string;
  readonly childName: string;
  readonly component: BakedComponent;
  readonly state: SeedState;
  /** The clip the channel was seeded FROM: a node id, `''` for "no clip carried
   *  this bone at the mint", or null when nothing was recorded. */
  readonly seededFrom: string | null;
  /** The clip carrying this bone NOW, or `''` when none does. */
  readonly clipNow: string;
}

/** Minimal node shape this read needs — params only, never `evaluate`. */
interface ChannelNodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/**
 * Every minted channel on `assetRef`'s rig, with whether its seed is still the
 * motion its neighbours are playing.
 *
 * Rows rather than a count, for the reason `clipBakeStates` gives one hop up: a
 * bare "3 stale" cannot say WHICH bones froze, and which bones froze is the
 * whole of what a director needs in order to act.
 *
 * Addressed by content-addressed id rather than by scanning for channels that
 * happen to carry an `assetRef`: `gltfChannelDagId` is the one way a minted
 * channel is named, so asking for the id is asking the same question the
 * renderer's enumerator asks, and a channel this read can see is a channel that
 * drives a bone.
 *
 * Pure over params — no `evaluate` — so it can be falsified without a store and
 * so it stays usable on raw saved JSON, the same constraint `boundClipsForAsset`
 * carries and for the same reason.
 */
export function channelSeedRows(state: DagState, assetRef: string): ChannelSeedRow[] {
  const rows: ChannelSeedRow[] = [];
  // The bones to ask about are the ones some bound clip can address — the rig's
  // own joint spine. A channel for a bone no clip carries has nothing it could
  // be stale against, and asking would only produce rows nobody can act on.
  const bound = boundClipsForAsset(state.nodes, assetRef);
  const childNames = new Set<string>();
  for (const clip of bound) {
    for (const name of clip.jointKeys) childNames.add(name);
  }

  // WHICH CHANNELS EXIST, BEFORE ANY KEYFRAME IS TOUCHED. In the ordinary
  // project nobody has edited a bone, so this list is empty and the whole read
  // costs one node-table walk and a few hundred id lookups. Indexing the clip
  // first would put the cost of a defect nobody has onto every project — and
  // this sits on a render path.
  const present: { channelId: string; childName: string; component: BakedComponent }[] = [];
  for (const childName of [...childNames].sort()) {
    for (const component of BAKED_COMPONENTS) {
      const channelId = gltfChannelDagId(assetRef, childName, component);
      const node = state.nodes[channelId] as ChannelNodeLike | undefined;
      if (!node || node.type !== 'KeyframeChannelVec3') continue;
      present.push({ channelId, childName, component });
    }
  }
  if (present.length === 0) return rows;

  const clips = indexClipsByBone(bound);
  for (const { channelId, childName, component } of present) {
    const node = state.nodes[channelId] as ChannelNodeLike;
    const p = node.params as { sourceClipId?: unknown; sourceHash?: unknown };
    const now = seedFromIndexed(clips, childName, component);
    // ABSENT, not empty. A recorded `''` clip id means "seeded from no clip",
    // which is a fact; an absent `sourceHash` means the mint predates the
    // field, which is the absence of one.
    if (typeof p.sourceHash !== 'string') {
      rows.push({
        channelId,
        childName,
        component,
        state: 'unknown',
        seededFrom: null,
        clipNow: now.clipId,
      });
      continue;
    }
    rows.push({
      channelId,
      childName,
      component,
      state: p.sourceHash === seedTrackHash(now.keys) ? 'current' : 'stale',
      seededFrom: typeof p.sourceClipId === 'string' ? p.sourceClipId : '',
      clipNow: now.clipId,
    });
  }
  return rows;
}

/** How many of a rig's minted channels are behind the clip now driving it. */
export function staleSeedCount(state: DagState, assetRef: string): number {
  return channelSeedRows(state, assetRef).filter((r) => r.state === 'stale').length;
}

/**
 * The distinct BONES with at least one stale component, sorted.
 *
 * What a surface should say, because a director edited a BONE — they never chose
 * "the rotation channel of the left forearm". Counting components would report
 * two for one bone whose position and rotation were both seeded, which reads as
 * twice as much damage as there is.
 */
export function staleSeedBones(state: DagState, assetRef: string): string[] {
  const names = new Set<string>();
  for (const row of channelSeedRows(state, assetRef)) {
    if (row.state === 'stale') names.add(row.childName);
  }
  return [...names].sort();
}
