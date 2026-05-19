// dag.exec — execute batch Ops on the DAG.
//
// The universal mutation surface. Every DAG operation (addNode, removeNode,
// connect, disconnect, setParam) goes through this tool. The Ops are
// validated, applied to the forked DAG, and proposed to the user as a diff.
//
// Use dag.inspect first to understand the current state, then construct
// the appropriate Ops.
//
// REF: THESIS.md §50, App. B, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { OpSchema } from '../../core/dag/types';

const OpBatchSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('Human-readable description of what this batch does (becomes the undo entry title)'),
  ops: z
    .array(OpSchema)
    .min(1, 'At least one Op is required')
    .describe(
      'Array of Ops to execute in order. Supported: addNode, removeNode, connect, disconnect, setParam.',
    ),
});

export type DagExecArgs = z.infer<typeof OpBatchSchema>;

export const dagExecTool: ToolDefinition<DagExecArgs> = {
  name: 'dag.exec',
  description:
    'Execute batch Ops on the DAG. This is the universal mutation tool — it can add, remove, ' +
    'connect, disconnect, or set params on any node. The Ops are validated and proposed as a diff ' +
    'for the user to accept or reject. Use dag.inspect first to understand the DAG state.',
  paramSchema: OpBatchSchema,
  handler(args: DagExecArgs, _ctx: ToolContext): ToolResult {
    return {
      ops: args.ops,
      text: `Proposed ${args.ops.length} Op(s): ${args.description}`,
    };
  },
};
