// #1550 — binding a named output (`scene`, `render`) to a node: the one question both doors ask,
// the agent's `mutator.setOutput` and any UI gesture. The op checks the same thing again
// (`applySetOutput`); this answers it before a plan is built, in words for a person, and picks
// the socket so neither door has to.

import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { OUTPUT_SOCKET_TYPES, type NodeId, type Op } from '../core/dag/types';
import { nodeDisplayName } from './sceneTreeWalk';

/** The `setOutput` that binds `name` to `nodeId`, or why it can't be. Already bound there is
 *  an empty list: a repeat is not an edit. */
export function setOutputOps(
  state: DagState,
  name: string,
  nodeId: NodeId,
): { ok: true; ops: Op[] } | { ok: false; reason: string } {
  const wants = OUTPUT_SOCKET_TYPES[name];
  if (wants === undefined) {
    return {
      ok: false,
      reason: `There is no output "${name}"; the outputs are ${Object.keys(OUTPUT_SOCKET_TYPES).join(' and ')}.`,
    };
  }
  const node = state.nodes[nodeId];
  if (!node) return { ok: false, reason: `There is no node "${nodeId}".` };
  const outputs = getNodeType(node.type)?.outputs ?? {};
  const socket = Object.keys(outputs).find((s) => outputs[s].type === wants);
  if (socket === undefined) {
    return {
      ok: false,
      reason: `${nodeDisplayName(state.nodes, nodeId)} is a ${node.type}, and the ${name} output takes a ${wants} node.`,
    };
  }
  const bound = state.outputs[name];
  if (bound?.node === nodeId && bound.socket === socket) return { ok: true, ops: [] };
  return { ok: true, ops: [{ type: 'setOutput', name, ref: { node: nodeId, socket } }] };
}
