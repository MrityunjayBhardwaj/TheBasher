// Group — aggregates a list of Mesh children into a single Mesh value. The
// scene tree (Wave C) walks Group/Transform to project the DAG hierarchy.
//
// REF: THESIS.md §12 (scene tree), §39.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { GroupValue, SceneObject } from './types';

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

// #222 — a Group is transformable as a unit, like Blender's parent/Empty: it
// carries its own position/rotation/scale. `pivot` is the LOCAL point the
// rotation/scale happen around (so an imported model rotates about its own
// bounding-box centre, not the world origin); the renderer applies
// Translate(position)·R·S·Translate(-pivot), and the import bakes
// position = pivot = the model centre so the content stays put while the gizmo
// sits at the centre. ALL FOUR default to identity / [0,0,0], so a pre-#222
// Group (params `{}`) hydrates to a bare, in-place group — byte-identical
// render, now additionally movable (V10/H14 — additive, no schema bump).
export const GroupParams = z
  .object({
    position: Vec3.default([0, 0, 0]),
    rotation: Vec3.default([0, 0, 0]),
    scale: Vec3.default([1, 1, 1]),
    pivot: Vec3.default([0, 0, 0]),
  })
  .passthrough();
export type GroupParams = z.infer<typeof GroupParams>;

export const GroupNode: NodeDefinition<GroupParams, GroupValue> = {
  type: 'Group',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GroupParams,
  inputs: { children: { type: 'SceneObject', cardinality: 'list' } },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  inspectorSections: ['transform', 'layout'],
  evaluate(params, inputs) {
    // V10/H14 layer-2 guard: an OLD saved Group (pre-#222, version 1, params `{}`)
    // is NOT re-parsed through the zod schema on load (migrateOneNode runs only
    // versioned `migrations[]`, and Group's version is unchanged), so the zod
    // `.default` does NOT fill these. Default here at the evaluator so a legacy
    // Group evaluates to identity instead of surfacing `undefined` to the renderer.
    return {
      kind: 'Group',
      position: params.position ?? [0, 0, 0],
      rotation: params.rotation ?? [0, 0, 0],
      scale: params.scale ?? [1, 1, 1],
      pivot: params.pivot ?? [0, 0, 0],
      children: (inputs.children as SceneObject[] | undefined) ?? [],
    };
  },
};
