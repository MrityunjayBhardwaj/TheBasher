// dag.inspect — read the DAG tree. No state mutation, zero side effects.
//
// The LLM uses this to understand the current scene before calling dag.exec.
// Returns structured JSON descriptions of nodes, outputs, and available types.
//
// REF: THESIS.md §6-10, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from './types';
import { getNodeType } from '../../core/dag/registry';
import { renderNodeCatalog } from '../nodeCatalog';
import { idRefsByRole } from '../../core/dag/idRefSweep';
import { readBaseParam } from '../../app/readBaseParam';
import type { DagState } from '../../core/dag/state';

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
    'Call this FIRST to understand what exists before modifying anything. ' +
    'scope=node also lists referencedBy: the nodes that name this one in a param ' +
    'rather than by a wire - animation channels, constraints, drivers. A param with ' +
    'a channel on it is driven at playback, so writing it changes the base value ' +
    'and not what is rendered.',
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
        const referencedBy = referencesInto(dagState, node.id);
        const text = JSON.stringify(
          {
            id: node.id,
            type: node.type,
            params: node.params,
            inputs: listInputs(node.inputs),
            outputs: def ? Object.keys(def.outputs) : [],
            referencedBy: referencedBy.length > 0 ? referencedBy : undefined,
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
        // The node vocabulary, as ONE projection of the registry (#1007) rather than
        // a description this file maintains beside it. The local summarizer that used
        // to live here knew eight zod constructors and printed `{type:'unknown'}` for
        // the rest — 34 param paths across 13 node types, including a seven-field
        // subtree lost six times over, with nothing in the output saying so. It also
        // ran to 120,813 B, which is why no agent road ever carried this answer.
        return { ops: [], text: renderNodeCatalog() };
      }

      default:
        return { ops: [], text: 'Error: unknown scope' };
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The nodes that NAME `nodeId` in a param rather than reaching it by a wire (#1018).
 *
 * An edge lives on its consumer, so asking about a node already shows what feeds it.
 * An id-reference lives on the REFERRER, so asking about the referent showed nothing
 * at all - a model about to edit an animated param was never told a channel drives it.
 *
 * The direction is the declaration's and travels with each entry:
 *   'subject'  - a sidecar OWNED BY this node (a channel, a constraint, a driver). Its
 *                effect reaches the scene through this node's own resolution, so this
 *                node is downstream of it.
 *   'argument' - a node that merely READS this one, which is an input like a wire.
 * Flattening the two into one "related" list would invert half of them.
 *
 * Read off `NodeDefinition.idRefs` through the shared walker, so a node kind appears
 * here the moment it declares its refs, with no list of types to keep current.
 */
function referencesInto(
  state: DagState,
  nodeId: string,
): Array<{ id: string; type: string; role: 'subject' | 'argument'; paramPath?: string }> {
  const out: Array<{ id: string; type: string; role: 'subject' | 'argument'; paramPath?: string }> =
    [];
  for (const node of Object.values(state.nodes)) {
    if (node.id === nodeId) continue;
    const refs = idRefsByRole(node);
    const role = refs.subject.includes(nodeId)
      ? ('subject' as const)
      : refs.argument.includes(nodeId)
        ? ('argument' as const)
        : null;
    if (!role) continue;
    // Which param it drives, when the node carries one. A sidecar that keeps its
    // channels elsewhere (an NLA Strip holds them inside its Action) simply omits it.
    const paramPath = readBaseParam(node, 'paramPath');
    out.push({
      id: node.id,
      type: node.type,
      role,
      ...(typeof paramPath === 'string' && paramPath ? { paramPath } : {}),
    });
  }
  return out;
}

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
