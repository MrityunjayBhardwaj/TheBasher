// wiredParam — a setting a wire has taken over (#1811).
//
// Some nodes hold a value both ways, as Blender's sockets do: a setting, and an input socket of the
// same name that wins when something is wired into it (Mix's `factor`). The stored setting is then
// not the value the node uses, so a surface that shows it as the value is showing the wrong number.

import type { DagState } from '../core/dag/state';
import { getNodeType } from '../core/dag/registry';
import { inputAvailable } from '../core/dag/socketAvailability';
import type { NodeRef } from '../core/dag/types';

/** The node wired into the socket `paramPath` shares a name with; null when the setting is the value. */
export function paramWiredFrom(state: DagState, nodeId: string, paramPath: string): string | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  const def = getNodeType(node.type);
  if (!def?.inputs[paramPath] || !inputAvailable(def, node.params, paramPath)) return null;
  const ref = node.inputs[paramPath] as NodeRef | undefined;
  return ref?.node && state.nodes[ref.node] ? ref.node : null;
}
