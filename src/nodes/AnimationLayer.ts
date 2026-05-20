// AnimationLayer — aggregates KeyframeChannels driving a single target.
//
// Wraps a SceneChild target and consumes a list of KeyframeChannel values
// via the named `animation` input socket. Holds the layer-level controls
// (weight, boneMask, mute, solo) that gate the channels' contribution.
//
// Wave C extension: the evaluator now patches channel values into a
// deep-cloned target at the channel's paramPath. The renderer (SceneFromDAG)
// reads the patched target unchanged — no special-case path. weight scales
// the patched value toward the target's static value (weight=1 = full
// channel, weight=0 = static).
//
// Why a wrapper instead of an animation socket on every target node? Two
// reasons: (1) keeps target node types unchanged so adding a channel can't
// regress existing renderers; (2) places mute/solo + bone-group preset
// affordances at one cataloguable boundary (B8 — Mutator surface) instead
// of scattering them across every animated type.
//
// Closure note (H22): the 'animation' edge kind walks via the input socket
// of the same name. A closure rooted on AnimationLayer with
// followedEdges:['animation'] reaches its channels but NOT another layer's
// channels — per-kind BFS isolation holds. Wave B Mutators must compute
// multi-root closure specs (target + wrapping layer) so both ends are
// covered when the channel drives a wrapped node.
//
// REF: THESIS §42, project_p3_plan, dharana B8, hetvabhasa H22, vyapti V2.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { AnimationLayerValue, KeyframeChannelValue, SceneChild } from './types';

export const AnimationLayerParams = z.object({
  name: z.string().default('Layer'),
  weight: z.number().min(0).max(1).default(1),
  boneMask: z.array(z.string()).default([]),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
});
export type AnimationLayerParams = z.infer<typeof AnimationLayerParams>;

export const AnimationLayerNode: NodeDefinition<AnimationLayerParams, AnimationLayerValue> = {
  type: 'AnimationLayer',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AnimationLayerParams,
  inputs: {
    /** The wrapped SceneChild — typed broad as 'Mesh' so any of the union
     *  variants pass through (Transform, Group, BoxMesh, Character, …). */
    target: { type: 'Mesh', cardinality: 'single' },
    /** Channels driving the target — the named edge for closure walks
     *  with kind 'animation'. */
    animation: { type: 'KeyframeChannel', cardinality: 'list' },
  },
  // Output socket type 'Mesh' — AnimationLayer is transparent in scene
  // composition, mirroring Transform's Mesh→Mesh wrap. The 'AnimationLayer'
  // SocketTypeName is reserved for future layer-mixer nodes.
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['animate'],
  // TODO(post-7.5): TransformClipValue composition. The patchTarget
  // dispatch below switches on KeyframeChannel.valueType today; a
  // future seam adds a TransformClip branch that overlays per-target
  // TRS onto the cloned scene before channel patches apply. See
  // PLAN.md Wave E5 + RESEARCH Q4 — implementation deferred to the
  // glTF-child gizmo follow-up (#91).
  evaluate(params, inputs: ResolvedInputs) {
    const target = (inputs.target as SceneChild | undefined) ?? null;
    const channelInput = inputs.animation;
    const rawChannels: readonly KeyframeChannelValue[] = Array.isArray(channelInput)
      ? (channelInput as KeyframeChannelValue[])
      : channelInput
        ? [channelInput as KeyframeChannelValue]
        : [];

    // mute zeroes contribution at the layer level. solo and cross-layer solo
    // resolution belong above this evaluator (a future SceneAnimation
    // aggregator that knows about all layers) — at the single-layer level
    // mute is the only gate that needs to fire.
    const active = params.mute ? [] : rawChannels;

    // Patch channel values into a deep-cloned target. Channels apply
    // last-write-wins; weight blends toward the original at <1 (so a 0.5
    // weight gives a half-strength channel, 0 gives the static target).
    const patched = patchTarget(target, active, params.weight);

    return {
      kind: 'AnimationLayer',
      name: params.name,
      active,
      weight: params.weight,
      boneMask: params.boneMask,
      mute: params.mute,
      solo: params.solo,
      target: patched,
    };
  },
};

/**
 * Apply each channel's (paramPath, value) onto a deep-cloned copy of target.
 * - Returns target unchanged when active is empty (avoids the clone cost).
 * - paramPath supports dot notation for nested fields (e.g. 'material.color').
 *   Empty paramPath is treated as a no-op — channels carry it as a sentinel.
 * - weight blends each scalar / vector toward the target's static value.
 *   String / quat values pass through at weight≥0.5; <0.5 falls back to
 *   target. (Quat blending requires slerp toward static; deferred —
 *   single-layer use cases don't need partial weights.)
 */
function patchTarget(
  target: SceneChild | null,
  active: readonly KeyframeChannelValue[],
  weight: number,
): SceneChild | null {
  if (!target) return null;
  if (active.length === 0) return target;
  const clone = JSON.parse(JSON.stringify(target)) as Record<string, unknown>;
  for (const ch of active) {
    if (!ch.paramPath) continue;
    const original = readAt(clone, ch.paramPath);
    const blended = blend(original, ch.value, ch.valueType, weight);
    writeAt(clone, ch.paramPath, blended);
  }
  return clone as unknown as SceneChild;
}

function readAt(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const key of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function writeAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop();
  if (last == null) return;
  let cur: Record<string, unknown> = obj;
  for (const key of parts) {
    const nxt = cur[key];
    if (nxt == null || typeof nxt !== 'object') return;
    cur = nxt as Record<string, unknown>;
  }
  cur[last] = value;
}

function blend(
  original: unknown,
  channelValue: unknown,
  valueType: KeyframeChannelValue['valueType'],
  weight: number,
): unknown {
  const w = Math.max(0, Math.min(1, weight));
  if (w >= 1) return channelValue;
  if (w <= 0) return original ?? channelValue;
  if (valueType === 'number' && typeof original === 'number' && typeof channelValue === 'number') {
    return original + (channelValue - original) * w;
  }
  if (
    valueType === 'vec3' &&
    Array.isArray(original) &&
    original.length === 3 &&
    Array.isArray(channelValue) &&
    channelValue.length === 3
  ) {
    return [
      (original[0] as number) + ((channelValue[0] as number) - (original[0] as number)) * w,
      (original[1] as number) + ((channelValue[1] as number) - (original[1] as number)) * w,
      (original[2] as number) + ((channelValue[2] as number) - (original[2] as number)) * w,
    ];
  }
  // quat / color / unknown: snap at the half-weight mark. Smooth blending
  // for these types needs slerp / HSL-lerp; defer until weight<1 is a real
  // authoring need.
  return w >= 0.5 ? channelValue : (original ?? channelValue);
}
