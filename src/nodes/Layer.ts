// Layer — one element of a Composition (the Compositor's AE-style layer).
//
// Wraps a time-varying Image `source` (a MediaClip / scene-render / ComfyWorkflow /
// nested Composition) with composite params: trim (inPoint/outPoint), position on
// the comp timeline (startFrame), 2D transform, opacity, blend mode. `opacity` and
// the transform fields are keyframeable via free-floating V57 channels targeting
// this node (the twirl-down dopesheet rows).
//
// The effect stack is NOT stored here — effects are Image→Image operator nodes
// (V58) spliced onto the `source` edge (docs/COMPOSITOR-DESIGN.md §5), so the
// `source` we receive is already the top of any effect chain.
//
// evaluate is pure metadata: it forwards the (already-evaluated) source ImageValue
// plus the composite params as a LayerValue. The compositor re-evaluates the source
// at a time-shifted ctx for the actual frame (§4.4) — this node does not remap time.
//
// REF: docs/COMPOSITOR-DESIGN.md §4.2; vyapti V2 + V34 + V57; sibling: Composition.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { ImageValue, LayerBlendMode, LayerValue } from './types';

export const LAYER_BLEND_MODES = ['normal', 'add', 'multiply', 'screen'] as const;

const Vec2 = z.tuple([z.number(), z.number()]);

export const LayerParams = z.object({
  name: z.string().default('Layer'),
  /** Visibility (AE's eyeball). A disabled layer is skipped by the compositor. */
  enabled: z.boolean().default(true),
  /** Solo (AE): when any layer in a comp is solo, only solo layers composite. */
  solo: z.boolean().default(false),
  /** Lock: protects the layer from timeline edits (trim/slide/reorder). */
  locked: z.boolean().default(false),
  /** In-point on the comp timeline, in comp frames. */
  startFrame: z.number().int().default(0),
  /** Source-local trim, in source frames. outPoint -1 = "to source end". */
  inPoint: z.number().int().nonnegative().default(0),
  outPoint: z.number().int().default(-1),
  blendMode: z.enum(LAYER_BLEND_MODES).default('normal'),
  /** 0..1, keyframeable (paramPath 'opacity'). */
  opacity: z.number().min(0).max(1).default(1),
  transform: z
    .object({
      anchor: Vec2.default([0, 0]),
      position: Vec2.default([0, 0]),
      scale: Vec2.default([1, 1]),
      rotation: z.number().default(0),
    })
    .default({}),
});
export type LayerParams = z.infer<typeof LayerParams>;

export const LayerNode: NodeDefinition<LayerParams, LayerValue> = {
  type: 'Layer',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LayerParams,
  inputs: {
    source: { type: 'Image', cardinality: 'single' },
  },
  outputs: { out: { type: 'Layer', cardinality: 'single' } },
  inspectorSections: ['layout', 'animate'],
  evaluate(params, inputs: ResolvedInputs): LayerValue {
    const t = params.transform ?? {};
    return {
      kind: 'Layer',
      name: params.name,
      enabled: params.enabled ?? true,
      solo: params.solo ?? false,
      locked: params.locked ?? false,
      startFrame: params.startFrame ?? 0,
      inPoint: params.inPoint ?? 0,
      outPoint: params.outPoint ?? -1,
      blendMode: (params.blendMode ?? 'normal') as LayerBlendMode,
      opacity: params.opacity ?? 1,
      transform: {
        anchor: t.anchor ?? [0, 0],
        position: t.position ?? [0, 0],
        scale: t.scale ?? [1, 1],
        rotation: t.rotation ?? 0,
      },
      source: (inputs.source as ImageValue | undefined) ?? null,
    };
  },
};
