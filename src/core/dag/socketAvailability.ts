// #1801 — which of a node's sockets exist in its current mode, and so which wires are live.
//
// A socket declares `available: { param, in }` when it exists only in some modes (types.ts,
// `SocketAvailability`). Everything that asks "is this socket there?" or "does this wire count?"
// asks here, so the rule lives in one place:
//
//   - the evaluator reads a wire that is not live as if it were not there (Blender keeps such a
//     link and marks it invalid, `node_tree_update.cc:1419-1425`);
//   - `connect` refuses to make one;
//   - pickers that offer a node's outputs offer only the available ones.
//
// A socket with no `available` is always available. A param that is missing reads as its
// schema default, which is what a node saved before the param existed holds once parsed.

import type { NodeDefinition, SocketAvailability } from './types';

const defaults = new WeakMap<NodeDefinition, Record<string, unknown> | null>();

/** The params an empty node of `def` parses to, once per type; null when the schema needs more. */
function defaultsOf(def: NodeDefinition): Record<string, unknown> | null {
  let known = defaults.get(def);
  if (known === undefined) {
    const parsed = def.paramSchema.safeParse({});
    known = parsed.success ? (parsed.data as Record<string, unknown>) : null;
    defaults.set(def, known);
  }
  return known;
}

/** The mode param's value: what the node holds, or the schema default when it holds none (a node
 *  saved before the param existed is loaded without it). */
function modeOf(def: NodeDefinition, rule: SocketAvailability, params: unknown): unknown {
  const value = (params as Record<string, unknown> | undefined)?.[rule.param];
  return value !== undefined ? value : defaultsOf(def)?.[rule.param];
}

function holds(
  def: NodeDefinition,
  rule: SocketAvailability | undefined,
  params: unknown,
): boolean {
  if (!rule) return true;
  const value = modeOf(def, rule, params);
  return typeof value === 'string' && rule.in.includes(value);
}

/** Whether input `socket` of a `def` node with these `params` is available. */
export function inputAvailable(def: NodeDefinition, params: unknown, socket: string): boolean {
  return holds(def, def.inputs[socket]?.available, params);
}

/** Whether output `socket` of a `def` node with these `params` is available. */
export function outputAvailable(def: NodeDefinition, params: unknown, socket: string): boolean {
  return holds(def, def.outputs[socket]?.available, params);
}

/** Why a socket is not available, for a refusal: which param, and the values that would make it. */
export function whyUnavailable(
  def: NodeDefinition,
  rule: SocketAvailability,
  params: unknown,
): string {
  const now = modeOf(def, rule, params);
  return `it exists only while ${rule.param} is ${rule.in.join(' or ')} (it is ${String(now)})`;
}
