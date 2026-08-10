// #608 — the ONE place anything asks the graph "what render pass does this
// producer play?".
//
// The answer comes from the PRODUCER'S DECLARATION (`OutputDescriptor.role`), so
// it is available without evaluating the node. That is the whole point: locating
// the depth pass on a job used to require evaluating every attached pass and
// reading the tag off the resulting value, which meant a read-only question paid
// for a full evaluation and trusted a tag any node can emit.
//
// ⚠️ NOT to be confused with `ImageValue.passKind`. That is the VALUE's answer and
// it still governs renderer dispatch, output-path naming and the content hash.
// This is the GRAPH's answer. They agree on every producer registered today —
// which is exactly why a test that only sweeps the registry can prove nothing
// about the difference between them.
//
// REF: issue #608; `src/core/dag/types.ts` (`PassRole`, `OutputDescriptor.role`).

import { getNodeType } from '../../core/dag/registry';
import type { DagState } from '../../core/dag/state';
import type { NodeRef, NodeTypeId, PassRole, SocketId } from '../../core/dag/types';

/** The role declared on `type`'s `socket` output, or undefined when it declares none. */
export function passRoleOfType(type: NodeTypeId, socket: SocketId): PassRole | undefined {
  return getNodeType(type)?.outputs[socket]?.role;
}

/**
 * The role a binding's PRODUCER declares — the graph-side answer to "is this the
 * depth pass?". Undefined when the node is unknown, the socket is not an output of
 * it, or the producer declares no role (an imported clip, a workflow result).
 */
export function passRoleOf(state: DagState, ref: NodeRef): PassRole | undefined {
  const node = state.nodes[ref.node];
  return node ? passRoleOfType(node.type, ref.socket) : undefined;
}
