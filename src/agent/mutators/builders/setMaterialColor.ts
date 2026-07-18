// setMaterialColor Mutator — sets material.color on mesh-carrying nodes
// or color on light nodes. Preserves all other material properties.
//
// Spec: { targetSelectors, color } where color is a CSS hex string.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { resolveDataParamOwner } from '../../../app/resolveDataParamOwner';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const SetMaterialColorSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  color: z
    .string()
    .regex(HEX_RE, '#rrggbb hex required (CSS convention).')
    .describe('CSS hex color, e.g. "#ff0000".'),
});
export type SetMaterialColorSpec = z.infer<typeof SetMaterialColorSpec>;

export const setMaterialColorMutator: MutatorDefinition<SetMaterialColorSpec> = {
  name: 'mutator.setMaterialColor',
  description:
    'Set the color of one or more nodes. For meshes (BoxMesh, SphereMesh) ' +
    'this writes material.color. For lights (DirectionalLight, PointLight, etc.) ' +
    'this writes color directly. Preserves all other material/light properties.',
  spec: SetMaterialColorSpec,
  specExample: { targetSelectors: ['node_id'], color: '#ff0000' },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent', 'data'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
      // #365 Phase 5a — a split Object's material lives on the BoxData it points at, so resolve
      // the true material owner (self for a fused mesh, the data node for a split Object).
      const matOwner = resolveDataParamOwner(state, id, 'material');
      const hasColor =
        typeof (node.params as Record<string, unknown> | undefined)?.color === 'string';
      if (!matOwner && !hasColor) {
        return {
          ok: false,
          reason: `Target "${id}" (${node.type}) has no material.base.color or color param.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      // Material → the resolved owner (the BoxData for a split Object); light `color` → self.
      const matOwner = resolveDataParamOwner(state, id, 'material');
      if (matOwner) {
        ops.push({
          type: 'setParam',
          nodeId: matOwner,
          // v0.6 #2 (#178): the inline color now lives at material.base.color.
          paramPath: 'material.base.color',
          value: spec.color,
        });
      } else if (typeof (node.params as Record<string, unknown>).color === 'string') {
        ops.push({
          type: 'setParam',
          nodeId: id,
          paramPath: 'color',
          value: spec.color,
        });
      }
    }
    return ops;
  },
};
