// AnimationLayer — aggregates KeyframeChannels driving a single target.
//
// Wraps a SceneChild target and consumes a list of KeyframeChannel values
// via the named `animation` input socket. Holds the layer-level controls
// (weight, boneMask, mute, solo) that gate the channels' contribution.
//
// Wave C extension: the evaluator patches channel values into a
// deep-cloned target at the channel's paramPath. weight scales the patched
// value toward the target's static value (weight=1 = full channel, weight=0
// = static).
//
// P7.12 D-04 (shape B-lite, V24/H40): the channels are now function-of-time
// (`ch.sample(seconds)` — no pre-sampled `.value`), so a PURE evaluate (no
// `time` input) cannot patch a fixed clone. The patch moves INTO a
// `sampleTarget(seconds)` closure carried on the value; the renderer
// (`AnimationLayerR` in SceneFromDAG) calls it in a useFrame at the live time
// SNAPSHOT (never a time subscription — H48) and renders the patched clone
// declaratively. The read-side (`resolveEvaluatedTransform`) reads
// `sampleTarget(ctx.time.seconds)` so the gizmo/NPanel evaluated transform
// equals the render (H40 boundary-pair). One re-render/frame for this single
// authored node is the accepted cost (B-lite); the V24/H49 win is for the
// CHANNELS, which stay pure function-of-time regardless of how the layer
// renders. REF: PLAN 7.12 D-04 (A3, LOCKED B-lite); vyapti V24; hetvabhasa
// H48/H40.
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
import { overlayChannels } from './overlayChannels';

// `writeAt` (the one path-writer shared with overlayTransients, #149) was lifted
// into overlayChannels.ts (v0.7 unification, #196). Re-exported here so existing
// importers (`overlayTransients.ts`) keep their import path — no drift (H40).
export { writeAt } from './overlayChannels';

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
    const weight = params.weight;

    // P7.12 D-04 (shape B-lite): the patch moves into a function-of-time
    // closure. evaluate stays pure (no time read here); the renderer's useFrame
    // / the read-side resolver invoke sampleTarget(seconds) at their cadence.
    // The closure captures `active` + `target` + `weight` (all pure values).
    const sampleTarget = (seconds: number): SceneChild | null =>
      overlayChannels(target, active, weight, seconds);

    return {
      kind: 'AnimationLayer',
      name: params.name,
      active,
      weight,
      boneMask: params.boneMask,
      mute: params.mute,
      solo: params.solo,
      // The UN-PATCHED base target (D-04). Patching now happens via
      // sampleTarget(seconds) in the renderer / read-side resolver.
      target,
      sampleTarget,
    };
  },
};
