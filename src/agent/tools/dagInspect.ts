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
import { referenceCycles, relationsOf, type NodeRelations } from '../../core/dag/idRefSweep';
import { brokenReferences } from '../../app/animatableParams';
import { readBaseParam } from '../../app/readBaseParam';
import type { DagState } from '../../core/dag/state';
import { paramsForAgent } from '../paramsForAgent';
import { sceneGraphOf } from '../../app/sceneGraph';

export const dagInspectSchema = z.object({
  scope: z
    .enum(['all', 'node', 'output', 'types', 'graph'])
    .default('all')
    .describe(
      'What to inspect: all (full DAG), node (specific node), output (scene outputs), types (available node types), graph (one level as the node view draws it)',
    ),
  nodeId: z.string().optional().describe('Required when scope=node — the node ID to inspect'),
  level: z
    .string()
    .optional()
    .describe('scope=graph: the sub-network owner to look inside; omit for the top level'),
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
    'and not what is rendered. It also lists consumers (what this node is wired into), ' +
    'nameFollowers (nodes whose name follows this one), and referenceCycles when the ' +
    'node sits on a loop of references. brokenReferences lists a channel or driver ' +
    'aimed at a node or a parameter path that does not exist: it animates nothing. ' +
    'scope=graph returns one level of the graph exactly as the node view draws it: its ' +
    'nodes with their flags, the wires and references between them, and which owners ' +
    'hold a sub-network to look inside (pass level).',
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
            // #1049 — a stored mesh is shown as its counts, never as its packed bytes.
            params: paramsForAgent(n.params),
            inputs: inputs.length > 0 ? inputs : undefined,
            outputs: def ? Object.keys(def.outputs) : undefined,
          };
        });

        const cycles = referenceCycles(dagState);
        const broken = brokenReferences(dagState);
        const text = JSON.stringify(
          {
            nodes: nodeList,
            outputs: dagState.outputs,
            nodeCount: nodeList.length,
            // #1553 — a loop of references is stored, not refused, so it is said here.
            referenceCycles: cycles.length > 0 ? cycles : undefined,
            // #1552 — and so is a reference aimed at a node or a parameter that is not there.
            brokenReferences: broken.length > 0 ? broken : undefined,
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
        // #1553 — every relationship comes from the one query delete and duplicate read too.
        const relations = relationsOf(dagState, node.id);
        const referencedBy = referencesInto(dagState, node.id, relations);
        const some = <T>(list: readonly T[]) => (list.length > 0 ? list : undefined);
        const text = JSON.stringify(
          {
            id: node.id,
            type: node.type,
            params: paramsForAgent(node.params),
            inputs: listInputs(node.inputs),
            outputs: def ? Object.keys(def.outputs) : [],
            consumers: some(relations.wiresOut.map((w) => ({ id: w.node, socket: w.socket }))),
            referencedBy: some(referencedBy),
            references: some(
              relations.refsOut.map((r) => ({ id: r.node, role: r.role, paramPath: r.path })),
            ),
            followsNameOf: relations.follows ?? undefined,
            nameFollowers: some(relations.followers),
            insideSubnetworkOf: some(relations.insideSubnetworkOf),
            subnetwork: some(relations.subnetwork),
            referenceCycles: some(relations.cycles),
            // #1552 — the broken references this node holds, or that are aimed at it.
            brokenReferences: some(
              brokenReferences(dagState).filter((b) => b.node === node.id || b.target === node.id),
            ),
          },
          null,
          2,
        );
        return { ops: [], text };
      }

      case 'graph': {
        // #1564 — the node view's own projection, everything shown: the agent and the view
        // read one graph, so they agree node for node and line for line.
        if (args.level && !dagState.nodes[args.level]) {
          return { ops: [], text: `Error: node "${args.level}" not found` };
        }
        const g = sceneGraphOf(dagState, {
          showHidden: true,
          showAnimation: true,
          level: args.level ?? null,
        });
        if (args.level && g.path[g.path.length - 1] !== args.level) {
          return { ops: [], text: `Error: node "${args.level}" holds no sub-network` };
        }
        const text = JSON.stringify(
          {
            level: args.level ?? null,
            path: g.path,
            nodes: g.nodes.map((n) => ({
              id: n.id,
              type: n.type,
              name: n.name !== n.id ? n.name : undefined,
              flags: n.flags.length ? n.flags : undefined,
              timeDependent: n.timeDependent || undefined,
              hidden: n.hidden || undefined,
              inside: n.inside || undefined,
              linesToOtherLevels: n.away || undefined,
              namedAfter: n.namedAfter ?? undefined,
            })),
            wires: g.wires
              .filter((w) => !w.ref)
              .map((w) => `${w.from}.${w.fromSocket} -> ${w.to}.${w.toSocket}`),
            references: g.wires
              .filter((w) => w.ref)
              .map((w) => `${w.from} -> ${w.to}.${w.toSocket}`),
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
 * Read off `relationsOf`, the one query for a node's relationships (#1553), so a node kind
 * appears here the moment it declares its refs, with no list of types to keep current.
 */
function referencesInto(
  state: DagState,
  nodeId: string,
  relations: NodeRelations,
): Array<{ id: string; type: string; role: 'subject' | 'argument'; paramPath?: string }> {
  // One row per referrer. A node naming this one twice (a driver whose target and source are
  // the same node) is listed once, as the sidecar it is.
  const roleOf = new Map<string, 'subject' | 'argument'>();
  for (const ref of relations.refsIn) {
    // A node that names itself is not its own referrer; the loop is in `referenceCycles`.
    if (ref.node === nodeId) continue;
    if (roleOf.get(ref.node) !== 'subject') roleOf.set(ref.node, ref.role);
  }
  const out: Array<{ id: string; type: string; role: 'subject' | 'argument'; paramPath?: string }> =
    [];
  for (const [id, role] of roleOf) {
    const node = state.nodes[id];
    // Which param it drives, when the node carries one. A sidecar that keeps its
    // channels elsewhere (an NLA Strip holds them inside its Action) simply omits it.
    const paramPath = readBaseParam(node, 'paramPath');
    out.push({
      id,
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
