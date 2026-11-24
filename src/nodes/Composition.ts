// Composition — the Compositor's "comp": a layer stack plus canvas settings (size / fps /
// duration / background). The director's sequence and canvas in one node
// (docs/COMPOSITOR-DESIGN.md §4.1).
//
// #1879 — `in` is the TOP of the layer stack: a chain of Layers (and any Image→Image step placed
// between them) on the Image lane, each reading everything below it. The back layer's `below` is
// unwired. Before, `layers` was a list the comp walked bottom→top itself; how the stack is stored
// is now known in one place, `src/app/video/videoLayers.ts`, which every reader and writer uses.
//
// evaluate is pure metadata: it forwards the top-of-stack image handle + canvas settings as a
// CompositionValue. Per-frame pixel compositing happens at the viewer/runtime by walking the
// chain (mirrors Scene→renderer; V2/V3 keep the evaluator pure).
//
// REF: docs/COMPOSITOR-DESIGN.md §4.1 / §6; vyapti V2 + V34 + V78; sibling: Layer, MediaClip.

import { z } from 'zod';
import { colorParam } from './paramWidget';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CompositionValue, ImageValue } from './types';
import { nameParam } from './paramWidget';

export const CompositionParams = z.object({
  name: nameParam('Composition'),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  fps: z.number().positive().default(30),
  /** Comp length in frames. */
  durationFrames: z.number().int().positive().default(150),
  /** Solid background colour (hex) under all layers. */
  background: colorParam('#000000'),
});
export type CompositionParams = z.infer<typeof CompositionParams>;

export const CompositionNode: NodeDefinition<CompositionParams, CompositionValue> = {
  type: 'Composition',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CompositionParams,
  // The comp is a version of the stack it shows (#1814's rule), so a stack view continues
  // into the layers underneath it.
  mainInput: 'in',
  inputs: {
    in: { type: 'Image', cardinality: 'single' },
  },
  outputs: { out: { type: 'Composition', cardinality: 'single' } },
  inspectorSections: ['layout'],
  home: {
    name: 'layout',
  },
  evaluate(params, inputs: ResolvedInputs): CompositionValue {
    return {
      kind: 'Composition',
      name: params.name,
      width: params.width ?? 1280,
      height: params.height ?? 720,
      fps: params.fps ?? 30,
      durationFrames: params.durationFrames ?? 150,
      background: params.background ?? '#000000',
      image: (inputs.in as ImageValue | undefined) ?? null,
    };
  },
};
