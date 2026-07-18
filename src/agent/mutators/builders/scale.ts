// scale Mutator — multiplicative size factor on size-carrying nodes.
//
// Spec: { targetSelectors, factor } — multiplies each target's size
// (BoxMesh) or scale (lights, etc.) by `factor`. SphereMesh uses
// radius — also multiplied. Preserves position + rotation + material.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { resolveDataParamOwner } from '../../../app/resolveDataParamOwner';

const ScaleSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  /** Uniform scale (single factor) or per-axis scale [x,y,z]. */
  factor: z.union([
    z.number().positive(),
    z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  ]),
});
export type ScaleSpec = z.infer<typeof ScaleSpec>;

export const scaleMutator: MutatorDefinition<ScaleSpec> = {
  name: 'mutator.scale',
  description:
    'Scale one or more nodes by a uniform factor or per-axis [x,y,z]. ' +
    'Multiplies BoxMesh.size or SphereMesh.radius. Preserves position, rotation, material.',
  spec: ScaleSpec,
  specExample: { targetSelectors: ['node_id'], factor: 2 },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'material'],
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
      // #365 Phase 5a — a split Object's geometry `size` lives on the BoxData it points at, so
      // resolve the true size owner (self for a fused mesh, the data node for a split Object).
      const sizeOwner = resolveDataParamOwner(state, id, 'size');
      const hasRadius =
        typeof (node.params as Record<string, unknown> | undefined)?.radius === 'number';
      if (!sizeOwner && !hasRadius) {
        return {
          ok: false,
          reason: `Target "${id}" (${node.type}) has no scalable size/radius param.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    const factor: [number, number, number] = Array.isArray(spec.factor)
      ? spec.factor
      : [spec.factor, spec.factor, spec.factor];
    const uniformFactor =
      typeof spec.factor === 'number' ? spec.factor : (factor[0] + factor[1] + factor[2]) / 3;

    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      // Size → the resolved owner (the BoxData for a split Object); Sphere `radius` → self.
      const sizeOwner = resolveDataParamOwner(state, id, 'size');
      if (sizeOwner) {
        const size = (state.nodes[sizeOwner].params as Record<string, unknown>).size as [
          number,
          number,
          number,
        ];
        ops.push({
          type: 'setParam',
          nodeId: sizeOwner,
          paramPath: 'size',
          value: [size[0] * factor[0], size[1] * factor[1], size[2] * factor[2]],
        });
      } else if (typeof (node.params as Record<string, unknown>).radius === 'number') {
        ops.push({
          type: 'setParam',
          nodeId: id,
          paramPath: 'radius',
          value: ((node.params as Record<string, unknown>).radius as number) * uniformFactor,
        });
      }
    }
    return ops;
  },
};
