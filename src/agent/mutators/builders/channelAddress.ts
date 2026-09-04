// channelAddress — how an authoring op names the channel it writes to (#889).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO FORMS, AND WHY THAT IS NOT A FALLBACK
// ─────────────────────────────────────────────────────────────────────────
// Every channel-authoring mutator was addressed by `channelId` alone, and
// refused when the node was absent. That worked for exactly one reason: an
// eager bake materialised a channel for every bone, so no authoring op ever had
// to mint. Remove the guarantee — which is the whole of copy-on-write — and the
// address fails at the moment it is needed, because a bone's channel id is
// `hashId('gltfChannel', assetRef, childName, component)` and a hash cannot be
// taken apart to recover what would have to be created.
//
// So a bone is addressed by the parts instead: `{assetRef, childName,
// component}`. Not `{boneId, component}` — `buildClosureSpec(spec)` is handed
// NO state (types.ts:113), and a bone's node id is itself a hash, so from the
// bone id alone the closure cannot name the channel it is about to write. The
// parts make BOTH ids pure functions of the spec. This is not a new invention:
// `bakeGltfChannel` has carried exactly this spec shape since Wave D for
// exactly this reason.
//
// The two forms are an XOR, not a primary with a fallback. A fallback would be
// worse than it looks: it fails only for a bone with NO channel, which under
// copy-on-write is the common case, so a caller that forgot it would be green
// everywhere except where it matters.
//
// ─────────────────────────────────────────────────────────────────────────
// WHICH FORM ADDRESSES WHAT
// ─────────────────────────────────────────────────────────────────────────
//   channelId — a channel that already exists and is not a bone's: an object's
//               `position` channel from `addChannel`, a camera `fov` channel, a
//               video-layer channel. The id addresses something that EXISTS,
//               which is all an id can ever do.
//   bone      — a glTF bone's TRS component. May or may not have a channel yet;
//               that is the caller's business, not the caller's problem.
//
// 🔑 AND THE SPLIT IS ENFORCED, NOT DOCUMENTED (#889 slice 3). `resolveChannelAddress`
// REFUSES a `channelId` that names a bone's channel. Without that, "address a bone
// by its parts" is a convention, and a convention is kept by whoever noticed it:
// the id form works perfectly for a bone that HAS been edited, so a call site
// written against one is green in every test that ran after an edit and silently
// wrong on the 22 bones of 23 that nobody has touched. The refusal turns a
// condition a caller must remember into one it cannot get wrong — and it names
// the bone, so the fix is mechanical.
//
// This became enforceable only once nothing needed the old road: the three UI
// surfaces that addressed an already-existing bone channel by id (the NPanel
// diamond's delete, and both Auto-Key chokepoints) now take the bone form on
// BOTH sides of their "does it have a channel yet" branch, which collapses that
// branch rather than duplicating it.
//
// REF: src/app/animate/ensureChannelForBone.ts (the mint + the seed);
//      src/agent/mutators/builders/bakeGltfChannel.ts (the same spec shape);
//      src/agent/mutators/types.ts:113 (buildClosureSpec takes no state);
//      src/agent/mutators/validate.ts:117-136,170-186 (fresh addNode then
//      setParam in one plan is supported by gates 1 and 3);
//      issues #889, #877.

import { z } from 'zod';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { gltfChannelDagId, gltfChildDagId } from '../../../core/import/gltfImportChain';
import { ensureChannelForBone } from '../../../app/animate/ensureChannelForBone';
import { BAKED_COMPONENTS, type BakedComponent } from './bakeChannelOps';

/**
 * The agent-facing address contract, WORD FOR WORD, for every authoring mutator's
 * `description`.
 *
 * It is a shared constant because the model never sees the schema — `listMutators`
 * returns name + first sentence, `getMutator` the description + contract, and the
 * spec argument is a free-form object composed by copying `specExample`. So the
 * description IS the contract, and `specExample` is a SINGLE object that cannot
 * show two addressing forms at once. Six copies of a paragraph that must say the
 * same thing is six chances for one of them to keep saying the old thing after the
 * rule changes — which for this surface is silent in both directions: the mutator
 * still works, typechecking still passes, and only the caller is misinformed.
 */
export const CHANNEL_ADDRESS_DOC =
  'Address the channel EITHER by `channelId` (one that already exists and is NOT a ' +
  'glTF bone\u2019s) OR by `bone` = {assetRef, childName, component} for a glTF bone, ' +
  'which mints that bone\u2019s channel, seeded from the clip, when it has none yet. ' +
  'Exactly one of the two. A bone MUST use the bone form: `channelId` is REFUSED for a ' +
  'bone\u2019s channel even when that channel already exists, because an id can only name ' +
  'something that exists and under copy-on-write most bones have no channel.';

/** The same contract for a SUBTRACTIVE op, which addresses without ever minting. */
export const CHANNEL_ADDRESS_DOC_NO_MINT =
  'Address the channel EITHER by `channelId` (one that already exists and is NOT a ' +
  'glTF bone\u2019s) OR by `bone` = {assetRef, childName, component} for a glTF bone. ' +
  'Exactly one of the two, and a bone MUST use the bone form \u2014 `channelId` is REFUSED ' +
  'for a bone\u2019s channel. The bone form never mints: a bone with no channel follows the ' +
  'clip and has no edit to remove, so it is refused rather than handed an empty channel.';

/** The bone form: the parts a channel id is hashed FROM, so both the bone's id
 *  and the channel's id are pure functions of the spec. */
export const BoneChannelAddress = z.object({
  assetRef: z.string().min(1),
  childName: z.string().min(1),
  component: z.enum(BAKED_COMPONENTS as unknown as [BakedComponent, ...BakedComponent[]]),
});
export type BoneChannelAddress = z.infer<typeof BoneChannelAddress>;

/** Spread into an authoring spec's `z.object({...})`. Pair with
 *  `superRefineChannelAddress` — the fields are optional individually and the
 *  XOR is what makes exactly one of them mandatory. */
export const CHANNEL_ADDRESS_FIELDS = {
  channelId: z.string().min(1).optional(),
  bone: BoneChannelAddress.optional(),
};

/** The addressed part of any authoring spec. */
export interface ChannelAddressed {
  readonly channelId?: string;
  readonly bone?: BoneChannelAddress;
}

/**
 * The XOR. Pass as the body of the spec's `.superRefine(...)`.
 *
 * Both forms present is a caller that has not decided which thing it is naming;
 * neither is a caller that has named nothing. Both are spec errors, and saying
 * so at the schema keeps every mutator's `preconditions` free of the question.
 */
export function superRefineChannelAddress(spec: ChannelAddressed, ctx: z.RefinementCtx): void {
  const has = (spec.channelId !== undefined ? 1 : 0) + (spec.bone !== undefined ? 1 : 0);
  if (has === 1) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      has === 0
        ? 'provide exactly one of `channelId` or `bone` ({assetRef, childName, component}).'
        : 'provide `channelId` OR `bone`, not both — they name the same thing two ways.',
  });
}

/**
 * The closure roots for either form — a PURE function of the spec, which is the
 * whole reason the bone form carries the parts rather than the bone's node id.
 *
 * The bone form declares BOTH ids. The channel's id is declared even when no
 * such node exists yet: a root that resolves to nothing contributes nothing to
 * the closure, and when the channel DOES exist the write has to be inside it
 * (gate 3). Declaring it unconditionally is what makes the mint and the
 * already-minted case take the same road.
 */
export function channelRootSelectors(spec: ChannelAddressed): NodeId[] {
  if (spec.bone) {
    const { assetRef, childName, component } = spec.bone;
    return [gltfChildDagId(assetRef, childName), gltfChannelDagId(assetRef, childName, component)];
  }
  return spec.channelId ? [spec.channelId] : [];
}

/** What the address resolved to. `mintOps` is empty whenever the channel was
 *  already there — the caller prepends it either way and never branches. */
export type ResolvedChannel =
  | { readonly ok: true; readonly channelId: string; readonly mintOps: readonly Op[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve an address to the channel id the ops will write to, minting the
 * channel when the bone form names one that does not exist yet.
 *
 * `mint: false` addresses without creating — for a SUBTRACTIVE op, where there
 * being nothing to write to is not a missing channel but an absent edit. See
 * `removeKeyframes`, which carries the reasoning at length.
 */
export function resolveChannelAddress(
  state: DagState,
  spec: ChannelAddressed,
  opts: { readonly mint: boolean },
): ResolvedChannel {
  if (spec.bone) {
    const { assetRef, childName, component } = spec.bone;
    const boneId = gltfChildDagId(assetRef, childName);
    if (!state.nodes[boneId]) {
      return { ok: false, reason: `bone "${childName}" is not a child of asset "${assetRef}".` };
    }
    const channelId = gltfChannelDagId(assetRef, childName, component);
    if (state.nodes[channelId]) return { ok: true, channelId, mintOps: [] };
    if (!opts.mint) {
      // The reason names the STATE, not the missing node. Under copy-on-write
      // "no channel" is the normal, healthy condition of every bone nobody has
      // edited — 22 of 23 on a humanoid — so "not in DAG" would report health
      // as a fault.
      return {
        ok: false,
        reason: `bone "${childName}" has no authored ${component} channel — it follows the clip; there is nothing to remove.`,
      };
    }
    const ensured = ensureChannelForBone(state, boneId, component);
    if (!ensured) {
      return { ok: false, reason: `node "${boneId}" is not a glTF bone.` };
    }
    return { ok: true, channelId: ensured.channelId, mintOps: ensured.ops };
  }

  const channelId = spec.channelId;
  if (channelId === undefined) {
    // Unreachable through the schema (the XOR above). Stated rather than
    // asserted so a direct caller that skipped `safeParse` gets a reason.
    return { ok: false, reason: 'no channel address: provide `channelId` or `bone`.' };
  }
  const node = state.nodes[channelId];
  if (!node) {
    return { ok: false, reason: `channelId "${channelId}" not in DAG.` };
  }
  const asBone = boneKeyOf(node);
  if (asBone) {
    return {
      ok: false,
      reason:
        `channelId "${channelId}" is bone "${asBone.childName}"'s ${asBone.component} channel — ` +
        'address a bone by its parts: `bone: {assetRef, childName, component}`. An id can only ' +
        'name a channel that already exists, and under copy-on-write most bones have none.',
    };
  }
  return { ok: true, channelId, mintOps: [] };
}

/**
 * The bone a channel belongs to, or null when it is not a bone's channel.
 *
 * Reads the dual key `bakeChannelOpsForBone` writes and the renderer's
 * enumerator matches on. Deliberately NOT the `nodeNameMap` membership test
 * `bakedGltfChannels` uses: that answers "does this channel belong to THIS
 * asset", which needs the asset in hand, and the question here is the weaker
 * "is this a bone's channel at all" — answerable from the node alone, which is
 * all `resolveChannelAddress` has.
 */
function boneKeyOf(node: {
  readonly type: string;
  readonly params?: unknown;
}): { childName: string; component: string } | null {
  if (node.type !== 'KeyframeChannelVec3') return null;
  const p = node.params as
    | { assetRef?: unknown; childName?: unknown; paramPath?: unknown }
    | undefined;
  if (typeof p?.assetRef !== 'string' || p.assetRef.length === 0) return null;
  if (typeof p?.childName !== 'string' || p.childName.length === 0) return null;
  if (typeof p?.paramPath !== 'string') return null;
  return { childName: p.childName, component: p.paramPath };
}

/**
 * The channel's type and params as they will be when the ops land — from live
 * state when it is already there, from the mint op when it is about to be.
 *
 * Every authoring mutator reads the channel before it writes: its `type` for
 * the value-shape gate, its `keyframes` / `modifiers` / `axisExtend` to merge
 * into. On the mint road that node is not in `state` yet, and reading `state`
 * anyway is the mistake this exists to make impossible — it would silently see
 * an absent channel and author onto emptiness, discarding the seed the mint
 * just took from the clip. The seed is the whole point of copy-on-write: an
 * edit means take this motion and change it.
 */
export function channelViewAfterMint(
  state: DagState,
  channelId: string,
  mintOps: readonly Op[],
): { readonly type: string; readonly params: Record<string, unknown> } | null {
  const live = state.nodes[channelId];
  if (live) return { type: live.type, params: (live.params ?? {}) as Record<string, unknown> };
  for (const op of mintOps) {
    if (op.type !== 'addNode' || op.nodeId !== channelId) continue;
    return {
      type: op.nodeType,
      params: (op.params ?? {}) as Record<string, unknown>,
    };
  }
  return null;
}
