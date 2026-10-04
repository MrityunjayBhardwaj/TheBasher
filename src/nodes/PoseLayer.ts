// PoseLayer — a layer that edits the pose wire (#1240, step 3 of "Bones as Channels", #1214).
//
//   RetargetClip.posed / AnimationClip.pose / Skeleton.pose ──→ PoseLayer ──→ PoseLayer … ──→ Object.pose
//
// On a skeleton's rest pose (`Skeleton.pose`), an override layer is the BASE layer: the character's
// own motion as keys, an imported file's among them (#1211).
//
// Wire in, wire out. The layer holds the bones it touches (its MEMBERS) and their keys, and folds
// them onto the incoming pose by its MODE and WEIGHT. A bone that is not a member passes through.
// It absorbed `PoseOverride` (one bone, static values, no keys), retired in #1243.
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
import type {
  BonePose,
  ChannelBlendMode,
  PosedSkeletonValue,
  Quat,
  Vec3,
  WireClipInfo,
} from './types';
import { nameParam } from './paramWidget';
import { EULER_ORDERS, eulerFromQuat, quatFromEuler, type EulerOrder } from './bonePose';
import { foldChannelValue } from './foldChannel';
import { KeyframeChannelVec3Node, KeyframeChannelVec3Params } from './KeyframeChannelVec3';
import { KeyframeChannelQuatParams } from './KeyframeChannelQuat';
import { resolveExtend, sampleQuatKeyframesExtended, type QuatKey } from './keyframeInterp';
import { KeyframeChannelNumberNode, KeyframeChannelNumberParams } from './KeyframeChannelNumber';
import { layerSampleTimes, layeredWireRange, type LayerBlend } from './wireSampleTimes';

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
 *  the param path (the component is a field instead), the clone road's provenance, and `solo`: an
 *  F-curve has a mute and no solo in Blender, and solo here belongs to the LAYER (#1241, #1215). */
const NOT_ON_A_LAYER = {
  target: true,
  paramPath: true,
  solo: true,
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
  KeyframeChannelQuatParams.omit({ target: true, paramPath: true, solo: true }).extend({
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
  KeyframeChannelNumberParams.omit({ target: true, paramPath: true, solo: true }).extend({
    bone: z.string().default(''),
    component: z.literal('weight'),
  }),
]);
export type PoseLayerChannel = z.infer<typeof PoseLayerChannelSchema>;

/** A bone this layer touches, by name, with its rotation mode and optional static values. */
export const PoseLayerMemberSchema = z.object({
  bone: z.string(),
  rotationMode: z.enum(POSE_ROTATION_MODES).default('XYZ'),
  /**
   * #1242 — how an euler member's rotation curve is read between keys (decision D-E). `axis` (or
   * absent): each axis on its own, as Blender's euler modes and Maya's Independent Euler. `quaternion`:
   * the keys, written as euler, are turned into quaternions and slerped between — Maya's Synchronized
   * Quaternion. A vec3 key holds all three axes at one time, so the keys are synchronized already.
   * Ignored in quaternion mode.
   */
  eulerInterp: z.enum(['axis', 'quaternion']).optional(),
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

/**
 * #1242 — an euler key curve read as quaternions: each key's triple becomes the rotation it means, and
 * the curve slerps between them (Maya's Synchronized Quaternion: slerp for linear keys, cubic for
 * spline keys; a constant key holds). Extend and Cycles carry over by their TIME rule, the only half
 * that reaches a rotation.
 */
function synchronizedSampler(
  channel: PoseLayerChannel,
  toQuat: (deg: Vec3) => Quat,
): (seconds: number) => Quat {
  const vec = channel as Extract<PoseLayerChannel, { component: 'rotation' }>;
  const keys: QuatKey[] = [...vec.keyframes]
    .sort((a, b) => a.time - b.time)
    .map((k) => ({
      time: k.time,
      value: toQuat(k.value as Vec3),
      easing: k.easing === 'linear' ? 'linear' : k.easing === 'constant' ? 'constant' : 'cubic',
    }));
  const { before, after } = resolveExtend(vec.extendBefore, vec.extendAfter, vec.modifiers);
  return (seconds) => sampleQuatKeyframesExtended(keys, seconds, before, after);
}

const BLEND: Record<PoseLayerMode, ChannelBlendMode> = { override: 'replace', additive: 'combine' };
const DEG = Math.PI / 180;

/**
 * #1215 — the curves the layer plays: all but the muted ones. A muted curve is not evaluated, so the
 * component falls back to the member's static value, else to what arrives from below — Blender skips
 * an F-curve flagged `FCURVE_MUTED` when it evaluates an action (`anim_sys.cc:341`, `:768`). Editing
 * still finds a muted curve (`poseLayerChannelOf` over the whole list); only playing skips it.
 */
export function playedChannels(channels: readonly PoseLayerChannel[]): PoseLayerChannel[] {
  return channels.filter((c) => c.mute !== true);
}

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

  const quaternion = memberRotationSampler(member, channels);
  return { index, position, quaternion, scale };
}

/**
 * #1215 — an euler member's rotation at `seconds`, in degrees in its own order, as the layer plays it:
 * the keyed curve in the member's mode (read synchronized when the member says so), else its static
 * value, else null. Null too for a quaternion member, whose rotation is not written in degrees. What a
 * field showing this bone's rotation shows, so the value on screen is the value played (H40).
 */
export function memberEulerDegreesAt(
  member: PoseLayerMember,
  channels: readonly PoseLayerChannel[],
  seconds: number,
): Vec3 | null {
  if (member.rotationMode === 'quaternion') return null;
  const order: EulerOrder = member.rotationMode;
  const keys = poseLayerChannelOf(playedChannels(channels), member.bone, 'rotation');
  if (keys && member.eulerInterp === 'quaternion') {
    const toQuat = (deg: Vec3): Quat =>
      quatFromEuler([deg[0] * DEG, deg[1] * DEG, deg[2] * DEG], order);
    const r = eulerFromQuat(synchronizedSampler(keys, toQuat)(seconds), order);
    return [r[0] / DEG, r[1] / DEG, r[2] / DEG];
  }
  if (keys) return vec3Sampler(keys)(seconds);
  return member.rotation ? (member.rotation as Vec3) : null;
}

/**
 * A member's rotation over time, as the layer reads it: its keyed curve in the member's mode (a curve
 * for another mode ignored), else its static value, else null (the member leaves rotation alone).
 * Exported for the mode change (#1242), which must read the member exactly as the layer does.
 * `channels` is whatever the caller reads: the layer passes the curves it plays (`playedChannels`);
 * the mode change passes every curve, so a muted curve's keys convert as keys, not as its static value.
 */
export function memberRotationSampler(
  member: PoseLayerMember,
  channels: readonly PoseLayerChannel[],
): ((seconds: number) => Quat) | null {
  const keyed = (component: PoseLayerChannel['component']) =>
    poseLayerChannelOf(channels, member.bone, component);
  if (member.rotationMode === 'quaternion') {
    const keys = keyed('quaternion');
    if (keys) return quatSampler(keys as Extract<PoseLayerChannel, { component: 'quaternion' }>);
    const q = member.quaternion as Quat | undefined;
    return q ? () => q : null;
  }
  const order: EulerOrder = member.rotationMode;
  const toQuat = (deg: Vec3): Quat =>
    quatFromEuler([deg[0] * DEG, deg[1] * DEG, deg[2] * DEG], order);
  const keys = keyed('rotation');
  if (keys && member.eulerInterp === 'quaternion') return synchronizedSampler(keys, toQuat);
  if (keys) {
    const degrees = vec3Sampler(keys);
    return (seconds) => toQuat(degrees(seconds));
  }
  if (member.rotation) {
    const q = toQuat(member.rotation as Vec3);
    return () => q;
  }
  return null;
}

/** The layer's weight over time: its `weight` channel when keyed, else the static weight. */
function weightOf(
  params: PoseLayerParams,
  played: readonly PoseLayerChannel[],
): (seconds: number) => number {
  const keys = poseLayerChannelOf(played, '', 'weight');
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

/**
 * #1457 — how this layer's blend reads for sampling (`LayerBlend`): nothing for a layer with no
 * members or an override at full static weight; everywhere for an override at a weight that is not 1
 * or is keyed; for an additive layer, the span its played rotation curves are keyed over.
 */
function layerBlendOf(params: PoseLayerParams): LayerBlend {
  if (params.members.length === 0) return { kind: 'none' };
  const played = playedChannels(params.channels);
  if (params.mode === 'override') {
    const weightKeyed = poseLayerChannelOf(played, '', 'weight') !== undefined;
    return weightKeyed || (params.weight > 0 && params.weight < 1)
      ? { kind: 'everywhere' }
      : { kind: 'none' };
  }
  let start = Infinity;
  let end = -Infinity;
  for (const c of played) {
    if (c.component !== 'rotation' && c.component !== 'quaternion') continue;
    for (const k of c.keyframes) {
      start = Math.min(start, k.time);
      end = Math.max(end, k.time);
    }
  }
  return end > start ? { kind: 'while', start, end } : { kind: 'none' };
}

/**
 * #1225 — the range a base layer's keys cover, from the earliest key to the latest, and #1456 — the
 * times that read every pose the layer holds: every key, and the fills each segment's interpolation
 * needs (`layerSampleTimes`). The weight's keys are not motion and do not count. Nothing when the
 * keys span no time.
 */
export function poseLayerClipInfo(
  channels: readonly PoseLayerChannel[],
  members: readonly PoseLayerMember[],
): WireClipInfo | undefined {
  // #1211 — memoised by the channel and member lists' identity: a base layer holding a whole file's
  // motion walks every key here (walk.bvh: 9,600, measured 12.9 µs of an 18.3 µs evaluation), and
  // the lists are the same arrays for as long as the layer's params are unchanged. The members are
  // part of the key because a member's rotation mode decides which curve is read and how.
  const known = CLIP_INFO.get(channels);
  if (known && known.members === members) return known.info;
  const info = computeClipInfo(channels, members);
  CLIP_INFO.set(channels, { members, info });
  return info;
}

const CLIP_INFO = new WeakMap<
  readonly PoseLayerChannel[],
  { members: readonly PoseLayerMember[]; info: WireClipInfo | undefined }
>();

function computeClipInfo(
  channels: readonly PoseLayerChannel[],
  members: readonly PoseLayerMember[],
): WireClipInfo | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const c of channels) {
    if (c.component === 'weight') continue;
    for (const k of c.keyframes) {
      if (k.time < start) start = k.time;
      if (k.time > end) end = k.time;
    }
  }
  if (!(end > start)) return undefined;
  return { start, end, times: layerSampleTimes(channels, members, start, end) };
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
            ...(incoming.clip ? { clip: incoming.clip } : {}),
          };
    }

    // #1211 — the BASE layer: an override layer reading a skeleton's rest pose holds the character's
    // own motion (an imported file's keys, or a hand-keyed one), as a clip did. It names its own
    // output as the wire's source, so a soloed layer above plays over that motion, not over rest.
    // The same rule `poseLayerChain` uses to find the base a bind mutes.
    const isBase =
      params.mode === 'override' &&
      incoming.rest === true &&
      incoming.source === undefined &&
      !params.solo;

    const blend = BLEND[params.mode];
    let built: { members: ResolvedMember[]; weight: (seconds: number) => number } | null = null;
    const build = () => {
      if (built) return built;
      const played = playedChannels(params.channels);
      const indexOf = new Map(upstream.skeleton.bones.map((b, i) => [b.name, i]));
      const members: ResolvedMember[] = [];
      for (const member of params.members) {
        const index = indexOf.get(member.bone);
        if (index !== undefined) members.push(resolveMember(member, played, index));
      }
      built = { members, weight: weightOf(params, played) };
      return built;
    };

    // #1225 — the base layer's keys ARE the character's motion, so they give the wire its range.
    // #1457 — any other layer passes the incoming range through and adds, inside it, its own keys'
    // times and every frame where its blend of two moving poses is not a slerp (`layeredWireRange`).
    const keyed = poseLayerClipInfo(params.channels, params.members);
    // A base layer is named after the file's animation (Blender's action name), so its range is too.
    const range = isBase
      ? keyed && { ...keyed, name: params.name }
      : layeredWireRange(incoming.clip, keyed, layerBlendOf(params));
    const value: { -readonly [K in keyof PosedSkeletonValue]: PosedSkeletonValue[K] } = {
      kind: 'PosedSkeleton',
      skeleton: upstream.skeleton,
      source,
      ...(range ? { clip: range } : {}),
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
    if (isBase) value.source = value;
    return value;
  },
};
