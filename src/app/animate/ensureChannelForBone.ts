// Mint a bone's channel at the moment something authors on it (#889).
//
// ─────────────────────────────────────────────────────────────────────────
// THE COPY THAT SHOULD NEVER HAVE BEEN MADE
// ─────────────────────────────────────────────────────────────────────────
// Two files call the baked band a copy-on-write edit layer — "once a bone is
// edited, its track lives here, not in the clip" (resolveGltfChildTransform.ts).
// `bakeClipOntoRig` then emitted a channel for every bone on the skeleton.
// Copy-on-write in the documentation, copy-always in the implementation: in
// `Robot-Walk.basher`, 46 channels for 23 bones and not one authored by anybody.
//
// Every one of those is a duplicate that can go stale. The staleness was never a
// missing check — it was a copy nothing justified. #888 made the read band serve
// a channel-less bone from the clip, which is what lets the copy stop being made
// at all.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THE BONE, NOT THE CHANNEL ID
// ─────────────────────────────────────────────────────────────────────────
// A channel id is `hashId('gltfChannel', assetRef, childName, component)` — one
// way. An authoring op holding only that id has nothing to mint FROM: it cannot
// recover which asset or which bone the id stands for.
//
// It does not need to. The bone's own `GltfChild` node carries both halves —
// `assetRef` and `childName` — and one exists per child from import. So an
// authoring op names the BONE and the component, and the channel id is derived
// here. That is what makes "an authoring op with no channel to write to"
// unrepresentable rather than merely handled: there is no way to ask for an edit
// without also saying what would be minted.
//
// ─────────────────────────────────────────────────────────────────────────
// SEEDING IS THE LOAD-BEARING PART
// ─────────────────────────────────────────────────────────────────────────
// An edit means *take this motion and change it*, not *start from nothing*. A
// channel minted empty would drop the bone to its base pose the instant a
// director touched it — the motion would visibly vanish on the first keyframe,
// which reads as a broken edit rather than as a missing seed.
//
// So the mint carries the clip's own track for that bone. The bake does not
// disappear; it becomes per-bone, and happens at the moment something justifies
// it.
//
// Invariants honoured:
//   - V8: app-layer, no `src/viewport/` imports beyond the shared unit helper.
//   - V22: no Date.now / Math.random — ids are content-addressed and the ops are
//     a pure function of the graph.
//
// REF: src/app/animate/boundClipsForAsset.ts (the one edge walk);
//      src/agent/mutators/builders/bakeChannelOps.ts (the op shape + skip);
//      src/agent/mutators/builders/bakeClipOntoRig.ts (the units, at length);
//      issues #889, #888, #877.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import {
  bakeChannelOpsForBone,
  type BakedComponent,
  type BakedKey,
} from '../../agent/mutators/builders/bakeChannelOps';
import { gltfChannelDagId } from '../../core/import/gltfImportChain';
import type { AnimationClipParams } from '../../nodes/AnimationClip';
import { boneIndexOf, boundClipsForAsset } from './boundClipsForAsset';
// The radians→degrees boundary. THE SAME helper `bakeClipOntoRig` and the read
// band convert with: a seed that skipped it would scale every bone rotation by
// π/180, which renders as a character standing still while its root position
// travels — the exact defect #843 records.
import { radVec3ToDeg } from '../../viewport/rotation';

/** What minting decided. `ops` is empty when the channel already existed — the
 *  caller appends it either way and never branches on which happened. */
export interface EnsuredChannel {
  readonly channelId: string;
  readonly ops: readonly Op[];
}

/** The `assetRef` + `childName` a bone node carries, or null when `boneId` is
 *  not a `GltfChild`. Both are written at import (`gltfImportChain`), so a bone
 *  that exists always has them. */
function boneAddress(
  state: DagState,
  boneId: string,
): { assetRef: string; childName: string } | null {
  const node = state.nodes[boneId];
  if (!node || node.type !== 'GltfChild') return null;
  const p = node.params as { assetRef?: unknown; childName?: unknown } | undefined;
  if (typeof p?.assetRef !== 'string' || p.assetRef.length === 0) return null;
  if (typeof p?.childName !== 'string' || p.childName.length === 0) return null;
  return { assetRef: p.assetRef, childName: p.childName };
}

/**
 * The bone's own base pose for one component, as a single key.
 *
 * THE FALLBACK SEED, AND IT IS NOT COSMETIC. A channel with zero keyframes is
 * not "absent" — measured, `buildVec3Sampler` on an empty channel returns
 * `[0, 0, 0]` at every time, and the band's filter does not skip it. So minting
 * an empty channel would make the bone PRESENT at the origin with no rotation:
 * the resolver reads presence rather than value, so the base pose underneath is
 * suppressed and the bone snaps to zero the instant it is first touched.
 *
 * One key at the bone's current base samples to exactly what the bone already
 * rendered, so minting changes nothing visible — which is the whole point of
 * copy-on-write. `GltfChild` stores rotation in DEGREES already (the import
 * seeds it through `radVec3ToDeg`), the same unit this band is in, so nothing is
 * converted here.
 */
function seedKeysFromBase(state: DagState, boneId: string, component: BakedComponent): BakedKey[] {
  const p = state.nodes[boneId]?.params as Record<string, unknown> | undefined;
  const raw = p?.[component];
  if (!Array.isArray(raw) || raw.length !== 3) return [];
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
  return [{ time: 0, value: raw as unknown as [number, number, number] }];
}

/**
 * The clip's own track for one bone and one component, in the channel's units.
 *
 * Returns `[]` when no bound clip carries the bone — not a failure, just nothing
 * to copy. The caller falls back to the base pose rather than to emptiness.
 */
function seedKeysFromClip(
  state: DagState,
  assetRef: string,
  childName: string,
  component: BakedComponent,
): BakedKey[] {
  // Scale is never seeded: `AnimationClipParams.keyframes` carries no scale, and
  // the read band omits it for the same reason. Claiming the component would
  // SUPPRESS the asset's own scale track underneath it, because the resolver
  // reads presence rather than value.
  if (component === 'scale') return [];

  for (const clip of boundClipsForAsset(state.nodes, assetRef)) {
    const index = boneIndexOf(clip, childName);
    if (index === null) continue;
    const keyframes = (clip.params as Partial<AnimationClipParams>).keyframes ?? [];
    const mine = keyframes.filter((k) => k.bone === index);
    if (mine.length === 0) continue;
    // Sorted by time so the minted channel's keys are ordered the way the node's
    // own sampler expects, rather than in whatever order the clip stored them.
    const sorted = mine.slice().sort((a, b) => a.time - b.time);
    return sorted.map((k) => ({
      time: k.time,
      value: component === 'rotation' ? radVec3ToDeg(k.rotation) : k.position,
    }));
  }
  return [];
}

/**
 * The channel for `boneId`'s `component`, minting it from the clip if it does
 * not exist yet.
 *
 * Every channel-authoring mutator calls this instead of requiring a channel to
 * already be there. The rule is deliberately "any authoring op mints", with no
 * per-mutator judgement about whether this particular edit is "real" enough: a
 * `setChannelExtend` or an added modifier aimed at a bone with no channel is an
 * authoring intent that happens to carry no values of its own, and it still has
 * to have somewhere to land.
 *
 * Returns null only when `boneId` is not a glTF bone at all — a caller that
 * passed something else, which is a spec error rather than a graph state, and
 * should surface as a refusal rather than as a silent no-op.
 */
export function ensureChannelForBone(
  state: DagState,
  boneId: string,
  component: BakedComponent,
): EnsuredChannel | null {
  const address = boneAddress(state, boneId);
  if (!address) return null;
  const { assetRef, childName } = address;

  const channelId = gltfChannelDagId(assetRef, childName, component);
  // A FAST PATH, not the guarantee. The bone has been edited before, so its
  // track is already the authority and there is no reason to read a clip we are
  // not going to use.
  //
  // The guarantee that an existing channel is never overwritten lives in
  // `bakeChannelOpsForBone`, which skips a component whose node is already in
  // state. Deleting this line changes nothing observable — measured, by deleting
  // it and watching the suite stay green — so it must not be described as the
  // thing that keeps a director's edit safe. Re-seeding would replace an edit
  // with the clip, which is the precise opposite of what this band is for, and
  // the row that proves it cannot be proved here.
  if (state.nodes[channelId]) return { channelId, ops: [] };

  // Clip first, base second. Never empty: an empty channel is present-and-zero,
  // not absent, so it would suppress the pose underneath it.
  const fromClip = seedKeysFromClip(state, assetRef, childName, component);
  const keys = fromClip.length > 0 ? fromClip : seedKeysFromBase(state, boneId, component);
  // `bakeChannelOpsForBone` owns the node shape — the dual `target`/`childName`
  // key, the param names, and the same skip-if-present guard. Going through it
  // rather than emitting an addNode here means a minted channel and a baked one
  // are the same node, which is what lets the rest of the system stay unable to
  // tell them apart.
  const ops = bakeChannelOpsForBone({
    assetRef,
    childName,
    byComponent: { [component]: keys } as Partial<Record<BakedComponent, readonly BakedKey[]>>,
    state,
  });
  return { channelId, ops };
}
