// AnimationLayer — aggregates KeyframeChannels driving a single target.
//
// Wraps a SceneChild target and consumes a list of KeyframeChannel values
// via the named `animation` input socket. Holds the layer-level controls
// (weight, boneMask, mute, solo) that gate the channels' contribution.
//
// Wave A (this file) ships the data plumbing only: the evaluator filters
// channels by the mute gate and surfaces them in `active` — channel values
// are NOT yet applied to the wrapped target. Wave C wires the param patcher
// (paramPath → write into target.params) so the dopesheet drives the scene.
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
import type {
  AnimationLayerValue,
  KeyframeChannelValue,
  SceneChild,
} from './types';

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
  evaluate(params, inputs: ResolvedInputs) {
    const target = (inputs.target as SceneChild | undefined) ?? null;
    const channelInput = inputs.animation;
    const rawChannels: readonly KeyframeChannelValue[] = Array.isArray(channelInput)
      ? (channelInput as KeyframeChannelValue[])
      : channelInput
        ? [channelInput as KeyframeChannelValue]
        : [];

    // Wave A: mute is the only filter applied at evaluator time. solo and
    // boneMask are stored on the value; cross-layer solo resolution and
    // bone-mask gating land in Wave C alongside the param patcher.
    const active = params.mute ? [] : rawChannels;

    return {
      kind: 'AnimationLayer',
      name: params.name,
      active,
      weight: params.weight,
      boneMask: params.boneMask,
      mute: params.mute,
      solo: params.solo,
      target,
    };
  },
};
