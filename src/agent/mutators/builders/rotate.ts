// rotate Mutator — additive rotation on selected mesh-like nodes.
//
// Spec: { targetSelectors, axis, deltaDeg } — rotates each target by
// `deltaDeg` degrees around `axis` (relative to existing rotation).
// Preserves position + scale + material. Closure walk: parent only —
// rotating a leaf doesn't affect its consumers' children, and the
// gate must stop a rotate-on-X from also touching X's siblings.
//
// Convention: rotation is in DEGREES per V12 / dcc-reference.md §1.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const RotateSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  axis: z.enum(['x', 'y', 'z']),
  deltaDeg: z.number(),
});
export type RotateSpec = z.infer<typeof RotateSpec>;

export const rotateMutator: MutatorDefinition<RotateSpec> = {
  name: 'mutator.rotate',
  description:
    'Rotate one or more nodes by a delta in degrees around a single axis. ' +
    'Adds the delta to the current rotation; preserves position, scale, material.',
  spec: RotateSpec,
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['position', 'scale', 'material', 'children'],
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
      if (!node) {
        return { ok: false, reason: `Target "${id}" not in DAG.` };
      }
      const params = node.params as Record<string, unknown> | undefined;
      const rot = params?.rotation;
      if (!Array.isArray(rot) || rot.length !== 3) {
        return {
          ok: false,
          reason: `Target "${id}" (${node.type}) does not carry a vec3 rotation param.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    const axisIdx = { x: 0, y: 1, z: 2 }[spec.axis];
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      const params = node.params as { rotation: [number, number, number] };
      const next: [number, number, number] = [...params.rotation];
      next[axisIdx] += spec.deltaDeg;
      ops.push({
        type: 'setParam',
        nodeId: id,
        paramPath: 'rotation',
        value: next,
      });
    }
    return ops;
  },
};
