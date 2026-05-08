// translate Mutator — additive position delta in meters.
//
// Spec: { targetSelectors, delta } — adds `delta` to each target's
// position. Preserves rotation + scale + material. Closure: parent only.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';

const TranslateSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  delta: z.tuple([z.number(), z.number(), z.number()]),
});
export type TranslateSpec = z.infer<typeof TranslateSpec>;

export const translateMutator: MutatorDefinition<TranslateSpec> = {
  name: 'mutator.translate',
  description:
    'Translate one or more nodes by a delta in meters. ' +
    'Adds the delta to the current position; preserves rotation, scale, material.',
  spec: TranslateSpec,
  specExample: { targetSelectors: ['node_id'], delta: [1, 0, 0] },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['rotation', 'scale', 'material', 'children'],
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
      const pos = params?.position;
      if (!Array.isArray(pos) || pos.length !== 3) {
        return {
          ok: false,
          reason: `Target "${id}" (${node.type}) does not carry a vec3 position param.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      const params = node.params as { position: [number, number, number] };
      const next: [number, number, number] = [
        params.position[0] + spec.delta[0],
        params.position[1] + spec.delta[1],
        params.position[2] + spec.delta[2],
      ];
      ops.push({
        type: 'setParam',
        nodeId: id,
        paramPath: 'position',
        value: next,
      });
    }
    return ops;
  },
};
