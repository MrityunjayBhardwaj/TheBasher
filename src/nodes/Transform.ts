// Transform — wraps a child Mesh with a position/rotation/scale offset.
// The gizmo (P1, Wave D) writes through `setParam` Ops on this node's params.
//
// Evaluator outputs a `TransformValue` carrying the resolved child. The
// viewport applies the transform on the THREE side. Keeping the transform
// in the data preserves determinism (V2): two runs with identical params
// produce identical TransformValue trees.
//
// REF: THESIS.md §39, §53 (live-drag mode), vyapti V2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { SceneChild, TransformValue } from './types';

export const TransformParams = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
});
export type TransformParams = z.infer<typeof TransformParams>;

export const TransformNode: NodeDefinition<TransformParams, TransformValue> = {
  type: 'Transform',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TransformParams,
  inputs: { target: { type: 'Mesh', cardinality: 'single' } },
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  evaluate(params, inputs) {
    return {
      kind: 'Transform',
      position: params.position,
      rotation: params.rotation,
      scale: params.scale,
      child: (inputs.target as SceneChild | undefined) ?? null,
    };
  },
};
