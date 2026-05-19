// dag.inspect — read the DAG tree. No state mutation, zero side effects.
//
// The LLM uses this to understand the current scene before calling dag.exec.
// Returns structured JSON descriptions of nodes, outputs, and available types.
//
// REF: THESIS.md §6-10, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './types';
import { getNodeType, listNodeTypes } from '../../core/dag/registry';

export const dagInspectSchema = z.object({
  scope: z
    .enum(['all', 'node', 'output', 'types'])
    .default('all')
    .describe(
      'What to inspect: all (full DAG), node (specific node), output (scene outputs), types (available node types)',
    ),
  nodeId: z.string().optional().describe('Required when scope=node — the node ID to inspect'),
});

export type DagInspectArgs = z.infer<typeof dagInspectSchema>;

export const dagInspectTool: ToolDefinition<DagInspectArgs> = {
  name: 'dag.inspect',
  description:
    'Inspect the DAG (scene graph). Read-only. Returns structured JSON describing ' +
    'the current state of nodes, outputs, and available node types. ' +
    'Call this FIRST to understand what exists before modifying anything.',
  paramSchema: dagInspectSchema,
  handler(args: DagInspectArgs, ctx: ToolContext): { ops: []; text: string } {
    const { dagState } = ctx;

    switch (args.scope) {
      case 'all': {
        // Full DAG summary — nodes grouped by type with their inputs/outputs
        const nodeList = Object.entries(dagState.nodes).map(([id, n]) => {
          const def = getNodeType(n.type);
          const inputs = listInputs(n.inputs);
          return {
            id,
            type: n.type,
            params: n.params,
            inputs: inputs.length > 0 ? inputs : undefined,
            outputs: def ? Object.keys(def.outputs) : undefined,
          };
        });

        const text = JSON.stringify(
          {
            nodes: nodeList,
            outputs: dagState.outputs,
            nodeCount: nodeList.length,
          },
          null,
          2,
        );
        return { ops: [], text };
      }

      case 'node': {
        if (!args.nodeId) {
          return { ops: [], text: 'Error: scope=node requires a nodeId' };
        }
        const node = dagState.nodes[args.nodeId];
        if (!node) {
          return { ops: [], text: `Error: node "${args.nodeId}" not found` };
        }
        const def = getNodeType(node.type);
        const text = JSON.stringify(
          {
            id: node.id,
            type: node.type,
            params: node.params,
            inputs: listInputs(node.inputs),
            outputs: def ? Object.keys(def.outputs) : [],
          },
          null,
          2,
        );
        return { ops: [], text };
      }

      case 'output': {
        const text = JSON.stringify(
          {
            outputs: dagState.outputs,
          },
          null,
          2,
        );
        return { ops: [], text };
      }

      case 'types': {
        // List every registered node type with its param schema and I/O shape
        const types = listNodeTypes().map((typeId) => {
          const def = getNodeType(typeId);
          if (!def) return { type: typeId };
          return {
            type: typeId,
            params: summarizeZodSchema(def.paramSchema),
            inputs: def.inputs,
            outputs: def.outputs,
          };
        });
        const text = JSON.stringify({ types }, null, 2);
        return { ops: [], text };
      }

      default:
        return { ops: [], text: 'Error: unknown scope' };
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listInputs(inputs: Record<string, unknown>): Array<{ socket: string; from: string }> {
  const result: Array<{ socket: string; from: string }> = [];
  for (const [socket, binding] of Object.entries(inputs)) {
    if (Array.isArray(binding)) {
      for (const ref of binding) {
        result.push({ socket, from: `${ref.node}:${ref.socket}` });
      }
    } else if (binding && typeof binding === 'object' && 'node' in binding) {
      const ref = binding as { node: string; socket: string };
      result.push({ socket, from: `${ref.node}:${ref.socket}` });
    }
  }
  return result;
}

/**
 * Produce a compact JSON-schema-like summary of a zod schema.
 * Gives the LLM enough info to construct valid params for dag.exec.
 */
function summarizeZodSchema(schema: unknown): Record<string, unknown> {
  const def = (schema as Record<string, unknown>)?._def as Record<string, unknown> | undefined;
  if (!def) return {};

  const typeName = def.typeName as string;

  if (typeName === 'ZodObject') {
    const shapeFn = def.shape as (() => Record<string, unknown>) | undefined;
    const shape = shapeFn?.() ?? {};
    const props: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      props[key] = summarizeZodSchema(field);
    }
    return { type: 'object', properties: props };
  }

  if (typeName === 'ZodString') return { type: 'string' };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };

  if (typeName === 'ZodArray') {
    const innerType = def.type;
    return {
      type: 'array',
      items: innerType ? summarizeZodSchema(innerType) : { type: 'unknown' },
    };
  }

  if (typeName === 'ZodTuple') {
    // Handle z.tuple([...])
    const items = def.items as unknown[] | undefined;
    return {
      type: 'array',
      items: items?.map((i) => summarizeZodSchema(i)) ?? [],
    };
  }

  if (typeName === 'ZodEnum') {
    return { type: 'string', enum: def.values as string[] | undefined };
  }

  if (typeName === 'ZodDefault' || typeName === 'ZodOptional') {
    const inner = ((def.innerType ?? def.type) as unknown) ?? {};
    return summarizeZodSchema(inner);
  }

  if (typeName === 'ZodObject' || typeName === 'ZodRecord') {
    return { type: 'object' };
  }

  return { type: 'unknown' };
}
