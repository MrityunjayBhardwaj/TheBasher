// setMaterialColor Mutator — sets material.color on mesh-carrying nodes
// or color on light nodes. Preserves all other material properties.
//
// Spec: { targetSelectors, color } where color is a CSS hex string.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { resolveExposedTarget } from '../../../app/exposeParams';
import { MATERIAL_FIELD_IR_PATH } from '../../../app/resolveMaterialFieldOwner';

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
    'Set the color of one or more nodes. For meshes (cubes, spheres) ' +
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
      // #394 S3c — and PER FIELD, because a material operator in the stack can force `color`
      // over whatever the data node or the linked Material node says. Asking per param ROOT
      // there writes a masked layer and reports success (PLAN-2 §5).
      // #394 P5 — asked through the PROJECTION, which is the same answer the inspector's rows
      // and the channel road get. The agent is the caller this query exists for: it names an
      // aggregate and holds no row, so it is the one road where ownership still has to be
      // resolved rather than carried.
      const matOwner = resolveExposedTarget(state, id, MATERIAL_FIELD_IR_PATH.color);
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
      // Material → the resolved per-field owner (the BoxData for a split Object, the linked
      // Material node, or the topmost operator that forces `color`); light `color` → self.
      const matOwner = resolveExposedTarget(state, id, MATERIAL_FIELD_IR_PATH.color);
      if (matOwner) {
        ops.push({
          type: 'setParam',
          nodeId: matOwner.nodeId,
          // The path comes WITH the owner: an IR node stores this at material.base.color
          // (v0.6 #2, #178), an override operator stores the flat scalar `color`.
          paramPath: matOwner.paramPath,
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
