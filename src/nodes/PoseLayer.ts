// PoseLayer — a layer that edits the pose wire (#1240, step 3 of "Bones as Channels", #1214).
//
//   RetargetClip.posed / AnimationClip.pose ──→ PoseLayer ──→ PoseLayer … ──→ Object.pose
//
// Wire in, wire out. The layer holds the bones it touches (its MEMBERS) and their keys, and folds
// them onto the incoming pose by its MODE and WEIGHT. A bone that is not a member passes through.
// It absorbs `PoseOverride` (one bone, static values, no keys), which retires in #1243.
//
// ── WHAT IT CORRESPONDS TO ──────────────────────────────────────────────────────────────────────
//
// Houdini APEX: an animation layer, additive or override, with a keyable weight, mute and solo, and
// per-parameter membership (`kinefx-animationlayers.txt:34-40, 55-59, 93, 104-114`); layer stacks
// chain across nodes (`:94-101`). Blender: an NLA track holding an action — keys are F-curves on
// `pose.bones["name"]` paths, each bone with its own rotation mode (`armature.cc:2368-2390`).
//
// ── THE FOLD ────────────────────────────────────────────────────────────────────────────────────
//
// Each member component folds onto the incoming bone through the fold core's `foldChannelValue`:
// override = its `replace` blend, additive = its `combine` blend (add for position, multiply for
// scale, `lower ⊗ value^w` for rotation), at the layer's weight. Nothing here re-implements a blend.
//
// ── KEYS ────────────────────────────────────────────────────────────────────────────────────────
//
// Inside the layer's own params (design decision D-A = K2: one node per layer, as Blender's action
// holds F-curves and APEX's clip holds channel primitives). Each channel carries its `bone` and
// `component` as FIELDS and is found by them — never by its place in the list or by a dotted path,
// because the write path splits on dots and bone names keep Blender's spelling (`Bone.001`). A
// channel is the channel schema itself, minus the bound target and the clone road's provenance
// fields, and it is sampled by that channel node's own `evaluate`: one sampler for every key.
//
// A keyed component outranks the member's static value. A rotation curve that does not match the
// member's mode is ignored, as Blender ignores the curves of other rotation modes (`armature.cc`).
// The WEIGHT keys too: a channel with component `weight` (its `bone` is unused). A keyed param on
// an upstream node cannot reach through an edge — overlays apply to Objects at render — so the
// weight's keys live where the rest do.
//
// ── COST ────────────────────────────────────────────────────────────────────────────────────────
//
// `evaluate` runs once per graph change and builds nothing; the samplers are built on the first
// `sample` and reused for every frame after (the rule #1237 set for clips).
//
// REF: design ref/architecture/bone-channels-design.html (v7, step 3, D-A, D-E); src/nodes/foldChannel.ts
//      (`foldChannelValue`); src/nodes/bonePose.ts (`quatFromEuler`); issues #1240, #1214, #1233.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { BonePose, ChannelBlendMode, PosedSkeletonValue, Quat, Vec3 } from './types';
import { nameParam } from './paramWidget';
import { EULER_ORDERS, quatFromEuler, type EulerOrder } from './bonePose';
import { foldChannelValue } from './foldChannel';
import { KeyframeChannelVec3Node, KeyframeChannelVec3Params } from './KeyframeChannelVec3';
import { KeyframeChannelQuatParams } from './KeyframeChannelQuat';
import { sampleQuatKeyframesExtended, type QuatKey } from './keyframeInterp';
import { KeyframeChannelNumberNode, KeyframeChannelNumberParams } from './KeyframeChannelNumber';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** The extend rules a quaternion key curve takes here: the ones that fold time. */
const QUAT_EXTENDS = ['hold', 'cycle', 'mirror'] as const;

/** A member's rotation mode: an euler order as Blender names it, or quaternion (decision D-E). */
export const POSE_ROTATION_MODES = [...EULER_ORDERS, 'quaternion'] as const;
export type PoseRotationMode = (typeof POSE_ROTATION_MODES)[number];

export const POSE_LAYER_MODES = ['override', 'additive'] as const;
export type PoseLayerMode = (typeof POSE_LAYER_MODES)[number];

/** The fields a channel spec never carries here: the bound target (the bone is a field instead),
 *  the param path (the component is a field instead), and the clone road's provenance. */
const NOT_ON_A_LAYER = {
  target: true,
  paramPath: true,
  childName: true,
  assetRef: true,
  sourceClipId: true,
  sourceHash: true,
} as const;

/** A key channel inside the layer: the channel schema, found by `bone` + `component`. */
export const PoseLayerChannelSchema = z.discriminatedUnion('component', [
  KeyframeChannelVec3Params.omit(NOT_ON_A_LAYER).extend({
    bone: z.string(),
    component: z.literal('position'),
  }),
  /** Euler degrees in the member's order; read only when the member is in an euler mode. */
  KeyframeChannelVec3Params.omit(NOT_ON_A_LAYER).extend({
    bone: z.string(),
    component: z.literal('rotation'),
  }),
  /**
   * Read only when the member is in quaternion mode. Extends only by the rules a rotation honours
   * (`sampleQuatKeyframesExtended`): hold, cycle, mirror. Not on the quaternion channel node itself,
   * whose inspector would then offer slope (which holds on a rotation) and the whole F-modifier stack.
   * Optional: absent is hold, the plain sampler's clamp.
   */
  KeyframeChannelQuatParams.omit({ target: true, paramPath: true }).extend({
    bone: z.string(),
    component: z.literal('quaternion'),
    extendBefore: z.enum(QUAT_EXTENDS).optional(),
    extendAfter: z.enum(QUAT_EXTENDS).optional(),
  }),
  KeyframeChannelVec3Params.omit(NOT_ON_A_LAYER).extend({
    bone: z.string(),
    component: z.literal('scale'),
  }),
  /** The layer's weight over time; `bone` is unused. */
  KeyframeChannelNumberParams.omit({ target: true, paramPath: true }).extend({
    bone: z.string().default(''),
    component: z.literal('weight'),
  }),
]);
export type PoseLayerChannel = z.infer<typeof PoseLayerChannelSchema>;

/** A bone this layer touches, by name, with its rotation mode and optional static values. */
export const PoseLayerMemberSchema = z.object({
  bone: z.string(),
  rotationMode: z.enum(POSE_ROTATION_MODES).default('XYZ'),
  position: Vec3Schema.optional(),
  /** Euler degrees in the member's order (euler modes only). */
  rotation: Vec3Schema.optional(),
  /** xyzw (quaternion mode only). */
  quaternion: QuatSchema.optional(),
  scale: Vec3Schema.optional(),
});
export type PoseLayerMember = z.infer<typeof PoseLayerMemberSchema>;

export const PoseLayerParams = z.object({
  name: nameParam('pose-layer'),
  mode: z.enum(POSE_LAYER_MODES).default('override'),
  weight: z.number().min(0).max(1).default(1),
  mute: z.boolean().default(false),
  /**
   * #1241 — play this layer alone over the source pose, as an APEX layer solos: every layer that is
   * not soloed is silent while one is. Several soloed layers play together, in chain order.
   */
  solo: z.boolean().default(false),
  members: z.array(PoseLayerMemberSchema).default([]),
  channels: z.array(PoseLayerChannelSchema).default([]),
});
export type PoseLayerParams = z.infer<typeof PoseLayerParams>;

const EMPTY_POSE: PosedSkeletonValue = {
  kind: 'PosedSkeleton',
  skeleton: { kind: 'Skeleton', bones: [] },
  sample: () => [],
};

/** A quaternion curve's ends: only the TIME half of an extend rule reaches a rotation. */
function quatSampler(
  channel: Extract<PoseLayerChannel, { component: 'quaternion' }>,
): (seconds: number) => Quat {
  const sorted = [...channel.keyframes].sort((a, b) => a.time - b.time) as readonly QuatKey[];
  const before = channel.extendBefore ?? 'hold';
  const after = channel.extendAfter ?? 'hold';
  return (seconds) => sampleQuatKeyframesExtended(sorted, seconds, before, after);
}

const BLEND: Record<PoseLayerMode, ChannelBlendMode> = { override: 'replace', additive: 'combine' };
const DEG = Math.PI / 180;

/** The channel for `bone` + `component`, found by its fields. */
export function poseLayerChannelOf(
  channels: readonly PoseLayerChannel[],
  bone: string,
  component: PoseLayerChannel['component'],
): PoseLayerChannel | undefined {
  return channels.find(
    (c) => c.component === component && (component === 'weight' || c.bone === bone),
  );
}

type At = (seconds: number) => unknown;

/** A layer channel as the channel schema it is: without the two fields that find it. */
function channelSpecOf(channel: PoseLayerChannel): Record<string, unknown> {
  const spec: Record<string, unknown> = { ...channel };
  delete spec.bone;
  delete spec.component;
  return spec;
}

/** A vec3 channel's sampler, built by the vec3 channel node's own evaluate. */
function vec3Sampler(channel: PoseLayerChannel): (seconds: number) => Vec3 {
  const spec = channelSpecOf(channel);
  const value = KeyframeChannelVec3Node.evaluate(
    KeyframeChannelVec3Params.parse(spec),
    {},
    { time: { frame: 0, seconds: 0, normalized: 0 } },
  );
  return value.sample as (seconds: number) => Vec3;
}

/** One member, resolved against the incoming rig: its bone's index and a getter per component. */
interface ResolvedMember {
  readonly index: number;
  readonly position: At | null;
  readonly quaternion: At | null;
  readonly scale: At | null;
}

function resolveMember(
  member: PoseLayerMember,
  channels: readonly PoseLayerChannel[],
  index: number,
): ResolvedMember {
  const keyed = (component: PoseLayerChannel['component']) =>
    poseLayerChannelOf(channels, member.bone, component);
  const constant =
    (v: unknown): At =>
    () =>
      v;

  const positionKeys = keyed('position');
  const position = positionKeys
    ? vec3Sampler(positionKeys)
    : member.position
      ? constant(member.position)
      : null;

  const scaleKeys = keyed('scale');
  const scale = scaleKeys ? vec3Sampler(scaleKeys) : member.scale ? constant(member.scale) : null;

  let quaternion: At | null;
  if (member.rotationMode === 'quaternion') {
    const keys = keyed('quaternion');
    quaternion = keys
      ? quatSampler(keys as Extract<PoseLayerChannel, { component: 'quaternion' }>)
      : member.quaternion
        ? constant(member.quaternion as Quat)
        : null;
  } else {
    const order: EulerOrder = member.rotationMode;
    const keys = keyed('rotation');
    const toQuat = (deg: Vec3): Quat =>
      quatFromEuler([deg[0] * DEG, deg[1] * DEG, deg[2] * DEG], order);
    if (keys) {
      const degrees = vec3Sampler(keys);
      quaternion = (seconds) => toQuat(degrees(seconds));
    } else if (member.rotation) {
      const q = toQuat(member.rotation as Vec3);
      quaternion = () => q;
    } else {
      quaternion = null;
    }
  }
  return { index, position, quaternion, scale };
}

/** The layer's weight over time: its `weight` channel when keyed, else the static weight. */
function weightOf(params: PoseLayerParams): (seconds: number) => number {
  const keys = poseLayerChannelOf(params.channels, '', 'weight');
  if (!keys) return () => params.weight;
  const spec = channelSpecOf(keys);
  const value = KeyframeChannelNumberNode.evaluate(
    KeyframeChannelNumberParams.parse(spec),
    {},
    { time: { frame: 0, seconds: 0, normalized: 0 } },
  );
  return value.sample as (seconds: number) => number;
}

/**
 * The members that name no bone of `skeleton`, in member order. A layer never drops a member without
 * saying so: an unmatched member does nothing, and this is the count a surface reports, zero included.
 */
export function poseLayerUnmatchedMembers(
  params: Pick<PoseLayerParams, 'members'>,
  skeleton: PosedSkeletonValue['skeleton'],
): string[] {
  const names = new Set(skeleton.bones.map((b) => b.name));
  return params.members.filter((m) => !names.has(m.bone)).map((m) => m.bone);
}

export const PoseLayerNode: NodeDefinition<PoseLayerParams, PosedSkeletonValue> = {
  type: 'PoseLayer',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PoseLayerParams,
  inputs: { pose: { type: 'PosedSkeleton', cardinality: 'single' } },
  outputs: { out: { type: 'PosedSkeleton', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): PosedSkeletonValue {
    const incoming = inputs.pose as PosedSkeletonValue | undefined;
    if (!incoming) return EMPTY_POSE;
    // Muted, touching nothing, or silenced by a soloed layer below: hand the incoming pose back BY
    // REFERENCE, so a layer that does nothing cannot perturb a downstream identity check and costs
    // nothing to leave in a graph.
    if (params.mute) return incoming;
    if (incoming.soloed === true && !params.solo) return incoming;

    // #1241 — the pose the chain's layers started from, carried on the wire. A soloed layer applies
    // onto it, unless a soloed layer below already did (then it builds on that one, so two soloed
    // layers play together).
    const source = incoming.source ?? incoming;
    const upstream = params.solo && incoming.soloed !== true ? source : incoming;
    if (params.members.length === 0) {
      // Touching nothing. Soloed, it still silences every other layer: the source plays alone.
      return upstream === incoming
        ? incoming
        : {
            kind: 'PosedSkeleton',
            skeleton: source.skeleton,
            sample: source.sample,
            source,
            soloed: true,
          };
    }

    const blend = BLEND[params.mode];
    let built: { members: ResolvedMember[]; weight: (seconds: number) => number } | null = null;
    const build = () => {
      if (built) return built;
      const indexOf = new Map(upstream.skeleton.bones.map((b, i) => [b.name, i]));
      const members: ResolvedMember[] = [];
      for (const member of params.members) {
        const index = indexOf.get(member.bone);
        if (index !== undefined) members.push(resolveMember(member, params.channels, index));
      }
      built = { members, weight: weightOf(params) };
      return built;
    };

    return {
      kind: 'PosedSkeleton',
      skeleton: upstream.skeleton,
      source,
      ...(params.solo || incoming.soloed === true ? { soloed: true } : {}),
      sample: (seconds: number): readonly BonePose[] => {
        const base = upstream.sample(seconds);
        const { members, weight } = build();
        const influence = weight(seconds);
        if (!(influence > 0) || members.length === 0) return base;
        // Copy-on-write: only member bones get a new entry.
        const out = base.slice();
        for (const m of members) {
          const at = out[m.index];
          if (at === undefined) continue;
          const fold = (lower: unknown, value: unknown, type: 'vec3' | 'quat', path: string) =>
            foldChannelValue(lower, [{ value, mode: blend, influence }], type, path);
          out[m.index] = {
            name: at.name,
            position: m.position
              ? (fold(at.position, m.position(seconds), 'vec3', 'position') as Vec3)
              : at.position,
            quaternion: m.quaternion
              ? (fold(at.quaternion, m.quaternion(seconds), 'quat', 'rotation') as Quat)
              : at.quaternion,
            scale: m.scale ? (fold(at.scale, m.scale(seconds), 'vec3', 'scale') as Vec3) : at.scale,
          };
        }
        return out;
      },
    };
  },
};
