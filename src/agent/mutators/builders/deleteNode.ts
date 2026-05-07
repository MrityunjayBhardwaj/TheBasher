// deleteNode Mutator — disconnect every edge that consumes the target,
// then removeNode. removeNode in Basher's Op layer requires zero
// consumers before it succeeds (`ops.ts:140` — preserves invertibility);
// without explicit disconnects the op throws.
//
// Spec: { targetSelectors } — deletes each target.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op, NodeId } from '../../../core/dag/types';

const DeleteNodeSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
});
export type DeleteNodeSpec = z.infer<typeof DeleteNodeSpec>;

export const deleteNodeMutator: MutatorDefinition<DeleteNodeSpec> = {
  name: 'mutator.deleteNode',
  description:
    'Delete one or more nodes. Auto-disconnects every consumer edge first ' +
    '(removeNode requires zero consumers). Atomic — Cmd+Z reverts everything.',
  spec: DeleteNodeSpec,
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: [],
    lossy: [
      { kind: 'delete', reason: 'Deletes the targets and their incoming/outgoing connections.' },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // parent edge so consumers (whose inputs we'll disconnect) are
    // inside the closure — gate 3 needs them there.
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      if (!state.nodes[id]) {
        return { ok: false, reason: `Target "${id}" not in DAG.` };
      }
    }
    // Refuse to delete project-output anchors. removeNode would also
    // reject (they're bound as outputs[name]) — fail at gate 4 with a
    // clearer message than the runtime exception.
    for (const id of spec.targetSelectors) {
      for (const [name, ref] of Object.entries(state.outputs)) {
        if ((ref as { node: string }).node === id) {
          return {
            ok: false,
            reason: `Cannot delete "${id}" — it is bound as project output "${name}".`,
          };
        }
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const targets = new Set<NodeId>(spec.targetSelectors);
    const ops: Op[] = [];

    // Disconnects: every consumer edge into a target.
    for (const consumer of Object.values(state.nodes)) {
      for (const [socket, binding] of Object.entries(consumer.inputs)) {
        const refs = Array.isArray(binding) ? binding : [binding];
        for (const ref of refs) {
          if (!targets.has(ref.node)) continue;
          ops.push({
            type: 'disconnect',
            from: { node: ref.node, socket: ref.socket },
            to: { node: consumer.id, socket },
          });
        }
      }
    }

    // Then removeNode for each target.
    for (const id of spec.targetSelectors) {
      ops.push({ type: 'removeNode', nodeId: id });
    }

    return ops;
  },
};
