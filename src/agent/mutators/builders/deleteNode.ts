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
import type { Op } from '../../../core/dag/types';
import { buildDeleteNodesOps } from '../../../app/sceneNodeActions';

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
  specExample: { targetSelectors: ['node_id'] },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: [],
    lossy: [
      { kind: 'delete', reason: 'Deletes the targets and their incoming/outgoing connections.' },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // 'parent'   — consumers whose inputs we disconnect.
    // 'children' — a Group OWNS its children and takes them with it (#431).
    // 'data'     — a split Object OWNS its data node (#365).
    // 'id-ref'   — the edge-less half: the channels/constraints/drivers/strips
    //              swept with their subject, and the survivors whose refs we clear
    //              (#421). No edge kind can reach these, so without it gate 3
    //              rejects this mutator's OWN ops.
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent', 'children', 'data', 'id-ref'],
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
    // #424 — DELEGATE to the one shared authority instead of reimplementing.
    // This builder used to be a second, independent answer to "delete a node": it
    // emitted disconnects + removeNode and nothing else, so deleting a cube through
    // the agent left its data half and its channels behind, while deleting the SAME
    // cube through the outliner was clean. Two builders answering one question drift
    // by construction — that divergence was the actual bug, more than any single
    // orphan it produced. The outliner and the Delete key already share this builder
    // (#227); the agent now makes three callers, one implementation.
    return buildDeleteNodesOps(state, spec.targetSelectors);
  },
};
