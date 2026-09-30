// channelAddress — how an authoring op names the channel it writes to (#889).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THERE IS MORE THAN ONE FORM, AND WHY THAT IS NOT A FALLBACK
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
// The forms are an XOR, not a primary with a fallback. A fallback would be
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
//   bone      — RETIRED with the clone road (#1053). It addressed a clone-road glTF
//               bone's TRS component by its parts and minted the channel on first
//               edit. A clone-road import the loader keeps is not drawn and stays
//               exactly as saved, so nothing may author on it: its saved bone
//               channels are refused by id (below), and there is no form to mint one.
//   layer     — #1215: a bone's curve inside a `PoseLayer`, where a native
//               character's keys live ({layerId, bone, component}). Not a
//               node: found by the channel's own `bone` + `component` fields,
//               written by rewriting the layer's whole channel list. Keying a
//               curve that is not there creates it (and the bone's membership);
//               removing its last key removes it — Blender's F-curve rules.
//
// 🔑 A SAVED BONE CHANNEL IS REFUSED BY ID. `resolveChannelAddress` refuses a
// `channelId` that names a clone-road bone's channel (#889 slice 3 made that the rule
// while the bone form existed; #1053 keeps the refusal and changes its reason). Such a
// channel belongs to an import the loader kept on the old imported-file structure,
// which is not drawn and converts on a later load, so an edit to it would change a
// thing nobody can see and that the conversion must find as it was saved.
//
// REF: src/agent/mutators/types.ts:113 (buildClosureSpec takes no state);
//      src/agent/mutators/validate.ts:117-136,170-186 (fresh addNode then
//      setParam in one plan is supported by gates 1 and 3);
//      issues #889, #877.

import { z } from 'zod';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import {
  PoseLayerChannelSchema,
  poseLayerChannelOf,
  type PoseLayerChannel,
  type PoseLayerMember,
  type PoseLayerParams,
} from '../../../nodes/PoseLayer';
import { SkeletonParams } from '../../../nodes/Skeleton';

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
  'Address the channel by exactly one of: `channelId` (one that already exists and is NOT a ' +
  'glTF bone\u2019s); `layer` = {layerId, bone, component} for a bone\u2019s keys in a ' +
  'PoseLayer (component position|rotation|quaternion|scale|weight; the curve and the bone\u2019s ' +
  'membership are created when absent).';

/** The same contract for a SUBTRACTIVE op, which addresses without ever minting. */
export const CHANNEL_ADDRESS_DOC_NO_MINT =
  'Address the channel by exactly one of: `channelId` (one that already exists and is NOT a ' +
  'glTF bone\u2019s); `layer` = {layerId, bone, component} for a bone\u2019s keys in a ' +
  'PoseLayer (removing its last key removes the curve, as Blender does).';

/** The TRS components a clone-road bone's channel was minted for. */
const BONE_COMPONENTS = ['position', 'rotation', 'scale'] as const;
type BoneComponent = (typeof BONE_COMPONENTS)[number];

/** A clone-road bone's channel, named by the parts its id was hashed from. */
export interface BoneChannelKey {
  readonly assetRef: string;
  readonly childName: string;
  readonly component: BoneComponent;
}

/**
 * #1215 — the layer form: a bone's keys where they live, inside a `PoseLayer` (design D-A, K2). The
 * channel is found by its `bone` and `component` FIELDS, never by a path (bone names keep Blender's
 * spelling, dots included), and a write rewrites the layer's whole channel list.
 */
export const LAYER_CHANNEL_COMPONENTS = [
  'position',
  'rotation',
  'quaternion',
  'scale',
  'weight',
] as const satisfies readonly PoseLayerChannel['component'][];
export const LayerChannelAddress = z.object({
  layerId: z.string().min(1),
  /** The bone, in the skeleton's spelling. Unused for `weight`. */
  bone: z.string().default(''),
  component: z.enum(LAYER_CHANNEL_COMPONENTS),
});
export type LayerChannelAddress = z.infer<typeof LayerChannelAddress>;

/** Spread into an authoring spec's `z.object({...})`. Pair with
 *  `superRefineChannelAddress` — the fields are optional individually and the
 *  XOR is what makes exactly one of them mandatory. */
export const CHANNEL_ADDRESS_FIELDS = {
  channelId: z.string().min(1).optional(),
  layer: LayerChannelAddress.optional(),
};

/** The addressed part of any authoring spec. */
export interface ChannelAddressed {
  readonly channelId?: string;
  readonly layer?: LayerChannelAddress;
}

/**
 * The XOR. Pass as the body of the spec's `.superRefine(...)`.
 *
 * Both forms present is a caller that has not decided which thing it is naming;
 * neither is a caller that has named nothing. Both are spec errors, and saying
 * so at the schema keeps every mutator's `preconditions` free of the question.
 */
export function superRefineChannelAddress(spec: ChannelAddressed, ctx: z.RefinementCtx): void {
  const has = (spec.channelId !== undefined ? 1 : 0) + (spec.layer !== undefined ? 1 : 0);
  if (has === 1) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      has === 0
        ? 'provide exactly one of `channelId` or `layer` ({layerId, bone, component}).'
        : 'provide ONE of `channelId` or `layer` — the two name the same thing two ways.',
  });
}

/** The closure roots for either form — a PURE function of the spec. */
export function channelRootSelectors(spec: ChannelAddressed): NodeId[] {
  if (spec.layer) return [spec.layer.layerId];
  return spec.channelId ? [spec.channelId] : [];
}

/** A channel's type and params as a channel node would carry them: what a tool reads before it
 *  writes. */
export interface ChannelView {
  readonly type: string;
  readonly params: Record<string, unknown>;
}

/**
 * What the address resolved to. `view` is the channel as it stands (a layer's curve not keyed yet
 * reads as an empty one); `write` turns field changes into the ops that make them wherever the
 * channel LIVES (its own node, or its entry in a layer's list). `channelId` names it in a reason.
 */
export type ResolvedChannel =
  | {
      readonly ok: true;
      readonly channelId: string;
      readonly view: ChannelView;
      readonly write: (fields: Readonly<Record<string, unknown>>) => Op[];
    }
  | { readonly ok: false; readonly reason: string };

/** The channel node type a layer channel's component is sampled as. */
const LAYER_CHANNEL_TYPE: Record<LayerChannelAddress['component'], string> = {
  position: 'KeyframeChannelVec3',
  rotation: 'KeyframeChannelVec3',
  scale: 'KeyframeChannelVec3',
  quaternion: 'KeyframeChannelQuat',
  weight: 'KeyframeChannelNumber',
};

/** A write to a channel node: one setParam per field. */
function nodeWrite(channelId: string) {
  return (fields: Readonly<Record<string, unknown>>): Op[] =>
    Object.entries(fields).map(([paramPath, value]) => ({
      type: 'setParam' as const,
      nodeId: channelId,
      paramPath,
      value,
    }));
}

/**
 * #1254 — the bone names of the skeleton a pose layer poses: down the chain (each consumer reading the
 * layer's `out` on its `pose` input) to the armature Object, then its `data` Skeleton. Null when the
 * layer feeds no armature Object — the names cannot be known, which is not the same as "not there".
 */
function layerSkeletonBones(state: DagState, layerId: string): string[] | null {
  let at = layerId;
  const limit = Object.keys(state.nodes).length;
  for (let hops = 0; hops <= limit; hops++) {
    const next = Object.values(state.nodes).find(
      (n) => (n.inputs?.pose as { node?: string } | undefined)?.node === at,
    );
    if (!next) return null;
    if (next.type === 'Object') {
      const data = (next.inputs?.data as { node?: string } | undefined)?.node;
      const skeleton = data ? state.nodes[data] : undefined;
      if (skeleton?.type !== 'Skeleton') return null;
      const parsed = SkeletonParams.safeParse(skeleton.params ?? {});
      return parsed.success ? parsed.data.bones.map((b) => b.name) : null;
    }
    if (next.type !== 'PoseLayer') return null;
    at = next.id;
  }
  return null;
}

/**
 * #1215 — a bone's channel inside a pose layer. Keying a curve that is not there creates it (and the
 * bone's membership, in the mode the component implies), as Blender's key insert creates an F-curve
 * in the action; a curve left with no keys is removed, as Blender's key delete removes an emptied
 * F-curve. A rotation curve must be the member's mode's: the layer would ignore the other one.
 */
function resolveLayerChannel(
  state: DagState,
  address: LayerChannelAddress,
  mint: boolean,
): ResolvedChannel {
  const { layerId, component } = address;
  const bone = component === 'weight' ? '' : address.bone;
  const node = state.nodes[layerId];
  if (!node || node.type !== 'PoseLayer') {
    return { ok: false, reason: `"${layerId}" is not a pose layer.` };
  }
  const label = component === 'weight' ? `${layerId} weight` : `${layerId} ${bone} ${component}`;
  const params = node.params as PoseLayerParams;
  const members = params.members ?? [];
  const channels = params.channels ?? [];
  let member: PoseLayerMember | undefined;
  if (component !== 'weight') {
    if (bone.length === 0) return { ok: false, reason: `name the bone whose ${component} to key.` };
    member = members.find((m) => m.bone === bone);
    const mode = member?.rotationMode;
    if (member && component === 'rotation' && mode === 'quaternion') {
      return {
        ok: false,
        reason: `"${bone}" is keyed as a quaternion in "${layerId}": address component "quaternion".`,
      };
    }
    if (member && component === 'quaternion' && mode !== 'quaternion') {
      return {
        ok: false,
        reason: `"${bone}" is keyed in ${mode} euler in "${layerId}": address component "rotation".`,
      };
    }
  }
  const existing = poseLayerChannelOf(channels, bone, component);
  if (!existing && !mint) {
    return { ok: false, reason: `${label} has no keys; there is nothing to remove.` };
  }
  const entry: PoseLayerChannel =
    existing ?? PoseLayerChannelSchema.parse({ bone, component, keyframes: [] });
  const spec: Record<string, unknown> = { ...entry };
  delete spec.bone;
  delete spec.component;
  const addMember: PoseLayerMember | null =
    component !== 'weight' && !member
      ? { bone, rotationMode: component === 'quaternion' ? 'quaternion' : 'XYZ' }
      : null;
  // #1254 — a new member must name a bone of the skeleton this layer poses (Blender's key insert on a
  // pose bone that does not exist resolves no path and creates nothing).
  if (addMember) {
    const bones = layerSkeletonBones(state, layerId);
    if (bones === null) {
      return {
        ok: false,
        reason: `cannot tell which skeleton "${layerId}" poses (it feeds no armature Object), so "${bone}" cannot be checked.`,
      };
    }
    if (!bones.includes(bone)) {
      return {
        ok: false,
        reason: `the skeleton "${layerId}" poses has no bone "${bone}" (it has ${bones.length}: ${bones.slice(0, 8).join(', ')}${bones.length > 8 ? ', …' : ''}).`,
      };
    }
  }
  return {
    ok: true,
    channelId: label,
    view: { type: LAYER_CHANNEL_TYPE[component], params: spec },
    write: (fields) => {
      const next = PoseLayerChannelSchema.parse({ ...entry, ...fields, bone, component });
      const emptied = Array.isArray(next.keyframes) && next.keyframes.length === 0;
      const at = existing ? channels.indexOf(existing) : -1;
      const list = [...channels];
      if (at >= 0) {
        if (emptied) list.splice(at, 1);
        else list[at] = next;
      } else if (!emptied) list.push(next);
      const ops: Op[] = [{ type: 'setParam', nodeId: layerId, paramPath: 'channels', value: list }];
      if (addMember && !emptied) {
        ops.push({
          type: 'setParam',
          nodeId: layerId,
          paramPath: 'members',
          value: [...members, addMember],
        });
      }
      return ops;
    },
  };
}

/**
 * Resolve an address to the channel the ops will write to.
 *
 * `mint: false` addresses without creating — for a SUBTRACTIVE op, where there
 * being nothing to write to is not a missing channel but an absent edit (a layer's
 * curve that has no keys).
 */
export function resolveChannelAddress(
  state: DagState,
  spec: ChannelAddressed,
  opts: { readonly mint: boolean },
): ResolvedChannel {
  if (spec.layer) return resolveLayerChannel(state, spec.layer, opts.mint);
  const channelId = spec.channelId;
  if (channelId === undefined) {
    // Unreachable through the schema (the XOR above). Stated rather than
    // asserted so a direct caller that skipped `safeParse` gets a reason.
    return { ok: false, reason: 'no channel address: provide `channelId` or `layer`.' };
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
        `channelId "${channelId}" is bone "${asBone.childName}"'s ${asBone.component} channel in ` +
        `"${asBone.assetRef}", which was saved on the old imported-file structure and is not ` +
        'drawn. It stays as saved until a later load converts it, so it cannot be edited.',
    };
  }
  return {
    ok: true,
    channelId,
    view: { type: node.type, params: (node.params ?? {}) as Record<string, unknown> },
    write: nodeWrite(channelId),
  };
}

/**
 * The clone-road bone a channel belongs to, or null when it is not a bone's channel.
 *
 * Reads the dual key the clone road's bake wrote on every bone channel it minted
 * (`assetRef` + `childName` + a TRS `paramPath`). Answerable from the node alone,
 * which is all `resolveChannelAddress` has.
 */
export function boneKeyOf(node: {
  readonly type: string;
  readonly params?: unknown;
}): BoneChannelKey | null {
  if (node.type !== 'KeyframeChannelVec3') return null;
  const p = node.params as
    | { assetRef?: unknown; childName?: unknown; paramPath?: unknown }
    | undefined;
  if (typeof p?.assetRef !== 'string' || p.assetRef.length === 0) return null;
  if (typeof p?.childName !== 'string' || p.childName.length === 0) return null;
  if (!BONE_COMPONENTS.includes(p.paramPath as BoneComponent)) return null;
  return { assetRef: p.assetRef, childName: p.childName, component: p.paramPath as BoneComponent };
}
