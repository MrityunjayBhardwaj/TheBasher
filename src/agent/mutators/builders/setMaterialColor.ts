// setMaterialColor Mutator — sets material.color on mesh-carrying nodes
// or color on light nodes. Preserves all other material properties.
//
// Spec: { targetSelectors, color } where color is a CSS hex string.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

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
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
      const params = node.params as Record<string, unknown> | undefined;
      const hasMaterial = params?.material && typeof params.material === 'object';
      const hasColor = typeof params?.color === 'string';
      if (!hasMaterial && !hasColor) {
        return {
          ok: false,
          reason: `Target "${id}" (${node.type}) has no material.color or color param.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      const params = node.params as Record<string, unknown>;
      if (params.material && typeof params.material === 'object') {
        ops.push({
          type: 'setParam',
          nodeId: id,
          paramPath: 'material.color',
          value: spec.color,
        });
      } else if (typeof params.color === 'string') {
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
