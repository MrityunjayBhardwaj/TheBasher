// What to store in a pose layer so the bone ends up where the director put it (#1337).
//
// The bone gizmo hands back the bone as it should be DRAWN: its local transform after every layer
// has blended. A layer stores what it blends in, so writing the drawn value straight into an
// additive layer, or one at weight 0.5, gives a different pose once the blend runs: the bone jumps
// away from the hand that placed it. Blender solves backwards through the blend before it keys
// (`BKE_animsys_nla_remap_keyframe_values`, `blenkernel/intern/anim_sys.cc:3662`): it removes each
// upper strip, top down, to find what the tweaked strip must output, then solves that strip's own
// blend against the stack below. A full-influence replace strip above makes it unsolvable.
//
// This does the same over a pose layer chain, with the blends the layers actually play
// (`foldChannelValue`, at the clamped weight):
//
//   override, weight w:  position/scale  B = L + (v − L)·w      rotation  B = slerp(L, v, w)
//   additive, weight w:  position        B = L + v·w            rotation  B = L ⊗ v^w
//                        scale           B = L · v^w
//
// solved for L (an upper layer: what arrives under it) or for v (the edited layer). Override at
// weight 1 is the identity for the edited layer and the unsolvable case above it, as in Blender.
//
// REF: src/nodes/PoseLayer.ts (the blend this inverts); src/nodes/foldChannel.ts (the fold);
//      src/app/BoneGizmo.tsx (the caller); issue #1337.

import { evaluate, type EvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import {
  memberRotationSampler,
  memberVec3At,
  playedChannels,
  poseLayerWeightOf,
  type PoseLayerParams,
} from '../../nodes/PoseLayer';
import { normalize, qmul, qpow } from '../../nodes/quatMath';
import type { BonePose, PosedSkeletonValue, Quat, Vec3 } from '../../nodes/types';
import type { GraphNodeLike } from './graphNodes';
import { poseLayerChain } from './poseChain';
import type { PoseComponent } from './poseTargetForBone';

/** A component's value: a vec3 for position and scale, a unit quaternion for rotation. */
export type ComponentValue = Vec3 | Quat;

export type Inverted =
  | { readonly ok: true; readonly value: ComponentValue }
  | { readonly ok: false; readonly reason: string };

const FRAME_0 = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;
const EPS = 1e-9;
const clamp01 = (w: number) => (w < 0 ? 0 : w > 1 ? 1 : w);
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** A pose wire end: the node and the socket a layer's or an Object's `pose` input reads. */
export interface PoseFeed {
  readonly node: string;
  readonly socket?: string;
}

/**
 * `bone`'s local pose as it arrives along `feed` at `seconds` — what a layer fed by it sees under
 * itself — or undefined when nothing arrives or the arriving skeleton lacks the bone.
 */
export function poseArriving(
  state: DagState,
  feed: PoseFeed,
  bone: string,
  seconds: number,
  cache?: EvaluatorCache,
): BonePose | undefined {
  const incoming = evaluate(state, feed.node, { cache, ctx: FRAME_0, socket: feed.socket ?? 'out' })
    .value as PosedSkeletonValue | undefined;
  const index = incoming?.skeleton.bones.findIndex((b) => b.name === bone) ?? -1;
  return index >= 0 ? incoming!.sample(seconds)[index] : undefined;
}

/** A layer's contribution to one bone component at `seconds`, or null when it leaves it alone. */
function contributionOf(
  params: PoseLayerParams,
  bone: string,
  component: PoseComponent,
  seconds: number,
): { value: ComponentValue; weight: number; additive: boolean } | null {
  if (params.mute) return null;
  const member = params.members.find((m) => m.bone === bone);
  if (!member) return null;
  const played = playedChannels(params.channels);
  const value =
    component === 'rotation'
      ? (memberRotationSampler(member, played)?.(seconds) ?? null)
      : memberVec3At(member, params.channels, component, seconds);
  if (value === null) return null;
  const weight = clamp01(poseLayerWeightOf(params)(seconds));
  if (!(weight > 0)) return null;
  return { value, weight, additive: params.mode === 'additive' };
}

/** What arrives under a layer, given what leaves it (`out`) and what it blends in. */
function lowerFrom(
  out: ComponentValue,
  c: { value: ComponentValue; weight: number; additive: boolean },
  component: PoseComponent,
): ComponentValue | null {
  const w = c.weight;
  if (component === 'rotation') {
    const u = c.value as Quat;
    const o = out as Quat;
    // additive: o = L ⊗ u^w  ⇒  L = o ⊗ (u^w)⁻¹
    if (c.additive) return normalize(qmul(o, conj(qpow(u, w))));
    // override: o = slerp(L, u, w) = slerp(u, L, 1 − w)  ⇒  L = u ⊗ (u⁻¹ ⊗ o)^(1/(1 − w))
    if (w >= 1 - EPS) return null;
    return normalize(qmul(u, qpow(qmul(conj(u), o), 1 / (1 - w))));
  }
  const u = c.value as Vec3;
  const o = out as Vec3;
  if (c.additive) {
    if (component === 'scale') {
      return o.map((x, i) => x / Math.pow(u[i], w)) as unknown as Vec3;
    }
    return o.map((x, i) => x - u[i] * w) as unknown as Vec3;
  }
  if (w >= 1 - EPS) return null;
  return o.map((x, i) => (x - u[i] * w) / (1 - w)) as unknown as Vec3;
}

/** What a layer must blend in so that, over `lower`, it gives `out`. */
function stripFrom(
  out: ComponentValue,
  lower: ComponentValue,
  weight: number,
  additive: boolean,
  component: PoseComponent,
): ComponentValue | null {
  const w = weight;
  if (component === 'rotation') {
    const o = out as Quat;
    const l = lower as Quat;
    const delta = qmul(conj(l), o);
    // additive: o = L ⊗ v^w  ⇒  v = (L⁻¹ ⊗ o)^(1/w);  override: o = slerp(L, v, w) = L ⊗ (L⁻¹ ⊗ v)^w
    return additive ? normalize(qpow(delta, 1 / w)) : normalize(qmul(l, qpow(delta, 1 / w)));
  }
  const o = out as Vec3;
  const l = lower as Vec3;
  if (additive && component === 'scale') {
    if (l.some((x) => Math.abs(x) < EPS)) return null;
    return o.map((x, i) => Math.pow(x / l[i], 1 / w)) as unknown as Vec3;
  }
  if (additive) return o.map((x, i) => (x - l[i]) / w) as unknown as Vec3;
  return o.map((x, i) => (x - l[i] * (1 - w)) / w) as unknown as Vec3;
}

/**
 * The value to store for `component` of `bone` in `layerId` so the armature Object `objectId` draws
 * the bone's local `drawn` at `seconds`. Refused, with the reason, when no value can: a layer above
 * fully overrides the component, or the layer itself is muted or at weight 0.
 */
export function layerValueForDrawn(
  state: DagState,
  objectId: string,
  layerId: string,
  bone: string,
  component: PoseComponent,
  drawn: ComponentValue,
  seconds: number,
  cache?: EvaluatorCache,
): Inverted {
  const nodes = state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
  const { layers } = poseLayerChain(nodes, objectId);
  const at = layers.indexOf(layerId);
  if (at < 0) return { ok: false, reason: `"${layerId}" is not in this armature's pose layers.` };
  if (layers.some((id) => (state.nodes[id].params as PoseLayerParams).solo)) {
    return {
      ok: false,
      reason: 'a pose layer is soloed: turn solo off to key a pose that shows the whole stack.',
    };
  }

  // Remove each layer above, top down: what the edited layer must output.
  let out: ComponentValue = drawn;
  for (const id of layers.slice(0, at)) {
    const params = state.nodes[id].params as PoseLayerParams;
    const c = contributionOf(params, bone, component, seconds);
    if (!c) continue;
    const lower = lowerFrom(out, c, component);
    if (lower === null) {
      return {
        ok: false,
        reason: `the layer "${params.name}" above overrides ${bone}'s ${component} at full weight, so nothing keyed below it shows; key it there.`,
      };
    }
    out = lower;
  }

  const params = state.nodes[layerId].params as PoseLayerParams;
  if (params.mute) {
    return {
      ok: false,
      reason: `the layer "${params.name}" is muted, so nothing keyed in it shows.`,
    };
  }
  const weight = clamp01(poseLayerWeightOf(params)(seconds));
  if (!(weight > 0)) {
    return {
      ok: false,
      reason: `the layer "${params.name}" has no weight here, so nothing keyed in it shows.`,
    };
  }
  if (params.mode === 'override' && weight >= 1 - EPS) return { ok: true, value: out };

  // What arrives under the edited layer, for this bone, at this time.
  const feed = state.nodes[layerId].inputs?.pose as PoseFeed | undefined;
  if (!feed) return { ok: true, value: out };
  const lowerPose = poseArriving(state, feed, bone, seconds, cache);
  if (!lowerPose) return { ok: true, value: out };
  const lower: ComponentValue =
    component === 'rotation'
      ? lowerPose.quaternion
      : component === 'position'
        ? lowerPose.position
        : lowerPose.scale;
  const value = stripFrom(out, lower, weight, params.mode === 'additive', component);
  if (value === null) {
    return {
      ok: false,
      reason: `${bone}'s ${component} arrives at zero, so no scale over it reaches this pose.`,
    };
  }
  return { ok: true, value };
}
