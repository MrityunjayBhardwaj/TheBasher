// dag.exec — execute batch Ops on the DAG.
//
// The raw mutation surface: addNode, connect, disconnect, setParam. The Ops are
// validated, applied to the forked DAG, and proposed to the user as a diff.
//
// Use dag.inspect first to understand the current state, then construct
// the appropriate Ops.
//
// #335 — removeNode is REFUSED here, with a redirect to mutator.deleteNode. A raw
// removeNode is never the right delete: on anything wired it throws "still consumed
// by", which ends the turn before the model sees it; and when the model does write
// the disconnects first, the delete lands but leaves the Object's data half behind
// (measured: n_light_data survives). Delete has one authority, `buildDeleteNodesOps`
// — the outliner, the Delete key and mutator.deleteNode share it (#424).
//
// REF: THESIS.md §50, App. B, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import {
  OpAddNodeSchema,
  OpConnectSchema,
  OpDisconnectSchema,
  OpRemoveNodeSchema,
  OpSetParamSchema,
} from '../../core/dag/types';

// #334 — the ops dag.exec takes, which is also the schema every request advertises.
// It was the full OpSchema union (nine variants, ~3.9 KB on every round) while the
// description names four. setMeta, setHidden and the spare-param ops are not part of
// the raw surface; the op layer still has them for the app and the mutators.
// removeNode stays: it is refused in the handler below, and that refusal carries the
// redirect to mutator.deleteNode. Dropped from the union, a raw delete would fail
// validation with a generic error instead.
const DagExecOpSchema = z.discriminatedUnion('type', [
  OpAddNodeSchema,
  OpRemoveNodeSchema,
  OpConnectSchema,
  OpDisconnectSchema,
  OpSetParamSchema,
]);

const OpBatchSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Human-readable description of what this batch does (becomes the undo entry title)'),
  ops: z
    .array(DagExecOpSchema)
    .min(1, 'At least one Op is required')
    .describe(
      'Array of Ops to execute in order. Supported: addNode, connect, disconnect, setParam. ' +
        'To delete nodes use mutator.deleteNode via agent.proposePlan.',
    ),
});

export type DagExecArgs = z.infer<typeof OpBatchSchema>;

export const dagExecTool: ToolDefinition<DagExecArgs> = {
  name: 'dag.exec',
  description:
    'Execute batch Ops on the DAG — add, connect, disconnect, or set params on any node. ' +
    'Deleting is not a raw op: use agent.proposePlan with mutator.deleteNode. The Ops are ' +
    'validated and proposed as a diff for the user to accept or reject. Use dag.inspect first ' +
    'to understand the DAG state.',
  paramSchema: OpBatchSchema,
  handler(args: DagExecArgs, _ctx: ToolContext): ToolResult {
    const removed = args.ops.flatMap((op) => (op.type === 'removeNode' ? [op.nodeId] : []));
    if (removed.length > 0) {
      // The whole batch is refused, not just the removeNode: the ops around a delete
      // usually depend on it, and half a batch is a plan nobody wrote.
      return { ops: [], text: rawDeleteRedirect(removed) };
    }
    return {
      ops: args.ops,
      text: `Proposed ${args.ops.length} Op(s): ${args.description}`,
    };
  },
};

/**
 * The refusal a raw removeNode gets: a redirect, not a wall. It names the call to make
 * instead, with the ids already filled in, so the model can recover in the same turn.
 */
function rawDeleteRedirect(nodeIds: readonly string[]): string {
  const spec = JSON.stringify({
    mutator: 'mutator.deleteNode',
    intent: 'delete',
    spec: { targetSelectors: [...new Set(nodeIds)] },
  });
  return (
    'ERROR: dag.exec does not delete nodes, so nothing in this batch was proposed. ' +
    'Delete with agent.proposePlan(' +
    spec +
    ') — it disconnects every consumer and removes the node together with its data half. ' +
    'Resend any other ops from this batch in their own dag.exec call.'
  );
}
