// Composition — the Compositor's "comp": an ordered stack of Layers plus canvas
// settings (size / fps / duration / background). The director's sequence and
// canvas in one node (docs/COMPOSITOR-DESIGN.md §4.1).
//
// `layers` is a LIST input: index 0 = BACK, last = FRONT — the compositor walks
// bottom→top. A Layer whose `source` is another Composition gives nesting
// (pre-comps) — that's the sequencing mechanism; no separate NLE container.
//
// evaluate is pure metadata: it forwards the resolved LayerValues + canvas
// settings as a CompositionValue. Per-frame pixel compositing happens at the
// viewer/runtime (mirrors Scene→renderer; V2/V3 keep the evaluator pure).
//
// REF: docs/COMPOSITOR-DESIGN.md §4.1 / §6; vyapti V2 + V34 + V78 (one socket,
//      discriminate on value.kind); sibling: Layer, MediaClip.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CompositionValue, LayerValue } from './types';

export const CompositionParams = z.object({
  name: z.string().default('Composition'),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  fps: z.number().positive().default(30),
  /** Comp length in frames. */
  durationFrames: z.number().int().positive().default(150),
  /** Solid background colour (hex) under all layers. */
  background: z.string().default('#000000'),
});
export type CompositionParams = z.infer<typeof CompositionParams>;

export const CompositionNode: NodeDefinition<CompositionParams, CompositionValue> = {
  type: 'Composition',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CompositionParams,
  inputs: {
    layers: { type: 'Layer', cardinality: 'list' },
  },
  outputs: { out: { type: 'Composition', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): CompositionValue {
    const layers = (inputs.layers as LayerValue[] | undefined) ?? [];
    return {
      kind: 'Composition',
      name: params.name,
      width: params.width ?? 1280,
      height: params.height ?? 720,
      fps: params.fps ?? 30,
      durationFrames: params.durationFrames ?? 150,
      background: params.background ?? '#000000',
      layers,
    };
  },
};
