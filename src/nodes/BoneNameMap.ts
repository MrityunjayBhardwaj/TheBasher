// BoneNameMap — pure data node. Holds a record mapping source bone
// names to target bone names; consumed by mutator.animation.retarget
// (and any future bone-name resolver).
//
// V0.5 ships this as a node (not just a Mutator-spec field) because:
//   - Multiple retargets may share the same map (Mixamo → glTF used
//     across many imports). One node, many consumers — DAG-shaped reuse.
//   - Edits to the map (the user fixes a bone-name typo) re-trigger
//     downstream re-evaluation via the existing cache-key path (V2).
//   - Future bone-name editor UI binds to a single node, not to N
//     scattered Mutator specs.
//
// REF: THESIS §42.1 (P3.1); project_p31_plan.md;
//      dharana B7 (sister boundary class — exact-match name resolution
//      at the rig level vs natural-language at the agent level).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoneNameMapValue } from './types';

export const BoneNameMapParams = z.object({
  name: z.string().default('Mixamo to glTF'),
  /** Plain record — keys are source names, values are target names. */
  map: z.record(z.string(), z.string()).default({}),
});
export type BoneNameMapParams = z.infer<typeof BoneNameMapParams>;

export const BoneNameMapNode: NodeDefinition<BoneNameMapParams, BoneNameMapValue> = {
  type: 'BoneNameMap',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BoneNameMapParams,
  inputs: {},
  outputs: { out: { type: 'BoneNameMap', cardinality: 'single' } },
  evaluate(params) {
    return {
      kind: 'BoneNameMap',
      name: params.name,
      map: params.map,
    };
  },
};
