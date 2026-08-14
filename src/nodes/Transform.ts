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
  inputs: { target: { type: 'SceneObject', cardinality: 'single' } },
  // #396 — the spine of the SCENE-lane wrapper chain. Same concept as the data lane's,
  // one type up: what the tree walk descends through to reach the wrapped object.
  chain: {
    input: 'target',
    // The scene lane: the spine carries a SceneObject, which has no components, so
    // nothing is resolvable against it.
    scope: { kind: 'unscoped', why: 'no-component-domain' },
    // DECLARED, not accidental. This wrapper has nothing to bypass, and saying so is
    // what tells 'declared and set false' apart from 'never declared at all'.
    bypass: { kind: 'none' },
    // Not a member of any offered stack — see OperatorSection.
    section: 'none',
  },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'constraint', 'driver'],
  home: {
    position: 'transform',
    rotation: 'transform',
    scale: 'transform',
  },
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
