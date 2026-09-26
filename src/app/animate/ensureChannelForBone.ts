// Mint a bone's channel at the moment something authors on it (#889).
//
// ─────────────────────────────────────────────────────────────────────────
// THE COPY THAT SHOULD NEVER HAVE BEEN MADE
// ─────────────────────────────────────────────────────────────────────────
// Two files call the baked band a copy-on-write edit layer — "once a bone is
// edited, its track lives here, not in the clip" (resolveGltfChildTransform.ts).
// `bakeClipOntoRig` then emitted a channel for every bone on the skeleton (it
// was deleted in #889 slice 3, once this file replaced it).
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
// THE SEED IS THE BONE'S OWN BASE POSE
// ─────────────────────────────────────────────────────────────────────────
// This mint used to carry a clip's track too: a motion bound onto a clone rig
// seeded the channel from that `AnimationClip`, so an edit changed the motion
// rather than starting over. That road retired with the clone road's character
// half (#1053) — a native character's keys are written into its pose layers,
// not here — so the seed is the child's base pose. That is what an unanimated
// child was already showing. A child the file's OWN clip drives (a
// `TransformClip`) reaches here too and is seeded from its base pose, dropping
// that clip's track for the component: #1277.
//
// Invariants honoured:
//   - V8: app-layer, no `src/viewport/` imports.
//   - V22: no Date.now / Math.random — ids are content-addressed and the ops are
//     a pure function of the graph.
//
// REF: src/agent/mutators/builders/bakeChannelOps.ts (the op shape + skip);
//      src/app/bakedGltfChannels.ts (the read band a channel-less bone falls to);
//      issues #889, #888, #877, #843.

import type { DagState } from '../../core/dag/state';
import { importedChildOf } from '../importedChild';
import type { Op } from '../../core/dag/types';
import {
  bakeChannelOpsForBone,
  type BakedComponent,
  type BakedKey,
} from '../../agent/mutators/builders/bakeChannelOps';
import { gltfChannelDagId } from '../../core/import/gltfImportChain';

/** What minting decided. `ops` is empty when the channel already existed — the
 *  caller appends it either way and never branches on which happened. */
export interface EnsuredChannel {
  readonly channelId: string;
  readonly ops: readonly Op[];
}

/** The `assetRef` + `childName` a bone carries, or null when `boneId` is not an imported
 *  child. Both are written at import (`gltfImportChain`), so a bone that exists always has
 *  them — #389 moved them onto the child's data half, which the seam hops to. */
function boneAddress(
  state: DagState,
  boneId: string,
): { assetRef: string; childName: string } | null {
  const child = importedChildOf(state.nodes, boneId);
  if (!child) return null;
  // The seam admits an empty `childName` (a name is a name), and this road cannot: the
  // channels it mints are ADDRESSED by that name, so an empty one would mint a channel
  // the renderer's enumerator can never match back to a bone.
  if (child.assetRef.length === 0 || child.childName.length === 0) return null;
  return { assetRef: child.assetRef, childName: child.childName };
}

/**
 * The bone's own base pose for one component, as a single key.
 *
 * NOT COSMETIC. A channel with zero keyframes is
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
 * The channel for `boneId`'s `component`, minting it from the bone's base pose if
 * it does not exist yet.
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
  // A FAST PATH, not the guarantee. The guarantee that an existing channel is
  // never overwritten lives in `bakeChannelOpsForBone`, which skips a component
  // whose node is already in state. Deleting this line changes nothing
  // observable — measured, by deleting it and watching the suite stay green — so
  // it must not be described as the thing that keeps a director's edit safe.
  if (state.nodes[channelId]) return { channelId, ops: [] };

  // Never empty: an empty channel is present-and-zero, not absent, so it would
  // suppress the pose underneath it. A single key holds — no time domain to claim.
  //
  // `bakeChannelOpsForBone` owns the node shape — the dual `target`/`childName`
  // key, the param names, and the same skip-if-present guard. Going through it
  // rather than emitting an addNode here means a minted channel and a baked one
  // are the same node, which is what lets the rest of the system stay unable to
  // tell them apart.
  const ops = bakeChannelOpsForBone({
    assetRef,
    childName,
    byComponent: { [component]: seedKeysFromBase(state, boneId, component) } as Partial<
      Record<BakedComponent, readonly BakedKey[]>
    >,
    state,
  });
  return { channelId, ops };
}
