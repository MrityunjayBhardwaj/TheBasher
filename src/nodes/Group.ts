// Group — aggregates a list of Mesh children into a single Mesh value. The
// scene tree (Wave C) walks Group/Transform to project the DAG hierarchy.
//
// REF: THESIS.md §12 (scene tree), §39.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { GroupValue, SceneChild } from './types';

export const GroupParams = z.object({}).passthrough();
export type GroupParams = z.infer<typeof GroupParams>;

export const GroupNode: NodeDefinition<GroupParams, GroupValue> = {
  type: 'Group',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GroupParams,
  inputs: { children: { type: 'Mesh', cardinality: 'list' } },
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(_params, inputs) {
    return {
      kind: 'Group',
      children: (inputs.children as SceneChild[] | undefined) ?? [],
    };
  },
};
