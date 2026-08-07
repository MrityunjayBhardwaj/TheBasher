// setMaterialColor Mutator — sets material.color on mesh-carrying nodes
// or color on light nodes. Preserves all other material properties.
//
// Spec: { targetSelectors, color } where color is a CSS hex string.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { resolveColorWriteTarget } from '../../../app/resolveColorWriteTarget';

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
      // #365 Phase 5a / #394 / #592 — both colour roads reach through the split, and both are
      // asked by ONE resolver so the offer here and the write below cannot answer differently.
      // The mesh road goes per FIELD through the projection (a material operator can force
      // `color` over the data node); the light road reaches `data` for a split light's flat
      // `color`. Asking for that raw on the handed node is what #592 was.
      if (!resolveColorWriteTarget(state, id)) {
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
      // The SAME question the precondition asked, so a target that passed the gate cannot
      // silently emit nothing here. The path comes WITH the owner: an IR node stores colour
      // at material.base.color (v0.6 #2, #178), an override operator the flat scalar
      // `color`, and a light's LightData the flat `color` too.
      const target = resolveColorWriteTarget(state, id);
      if (!target) continue;
      ops.push({
        type: 'setParam',
        nodeId: target.nodeId,
        paramPath: target.paramPath,
        value: spec.color,
      });
    }
    return ops;
  },
};
