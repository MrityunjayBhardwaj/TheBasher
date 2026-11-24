// #1715 — the sockets a node INSTANCE has: its type's declared `inputs`/`outputs`, plus the ones
// its params give it (`NodeDefinition.instanceSockets`, e.g. a ComfyUI workflow node's markers).
//
// Every reader that needs the sockets a given node really has asks here: `connect` and
// `disconnect`, the evaluator's arrival (`takes`, conversion), the output type a wire carries,
// the Nodes view, the agent's inspect. A reader that only looks for a structural flag (body,
// world, chain, …) may keep reading the type, because a socket from params never carries one.
//
// The merge is cached per params object. Params are replaced whole on every edit, so a new file
// is a new params object and a new answer, and the same params give the same descriptor
// objects, which keeps the per-descriptor caches downstream (`conversionsInto`) warm.

import type { InputDescriptor, NodeDefinition, OutputDescriptor, SocketId } from './types';

interface Merged {
  readonly inputs: Readonly<Record<SocketId, InputDescriptor>>;
  readonly outputs: Readonly<Record<SocketId, OutputDescriptor>>;
}

const merged = new WeakMap<NodeDefinition, WeakMap<object, Merged>>();

function merge(def: NodeDefinition, params: unknown): Merged {
  const own = def.instanceSockets!(params);
  // The type's declared sockets win a name clash: they are what every flag reader sees.
  return {
    inputs: { ...own.inputs, ...def.inputs },
    outputs: { ...own.outputs, ...def.outputs },
  };
}

function socketsOf(def: NodeDefinition, params: unknown): Merged {
  if (!def.instanceSockets) return def;
  if (params === null || typeof params !== 'object') return merge(def, params);
  let byParams = merged.get(def);
  if (!byParams) {
    byParams = new WeakMap();
    merged.set(def, byParams);
  }
  let known = byParams.get(params);
  if (!known) {
    known = merge(def, params);
    byParams.set(params, known);
  }
  return known;
}

/** The input sockets of a `def` node holding `params`. */
export function inputsOfNode(
  def: NodeDefinition,
  params: unknown,
): Readonly<Record<SocketId, InputDescriptor>> {
  return socketsOf(def, params).inputs;
}

/** The output sockets of a `def` node holding `params`. */
export function outputsOfNode(
  def: NodeDefinition,
  params: unknown,
): Readonly<Record<SocketId, OutputDescriptor>> {
  return socketsOf(def, params).outputs;
}

/**
 * Whether a wire on input `socket` is on a socket this node has now. Only a node whose sockets
 * come from its params can lose one; for every other type this is true, as it always was (a
 * binding on an undeclared socket of a fixed type is a different question, answered by `connect`).
 */
export function inputExists(def: NodeDefinition, params: unknown, socket: string): boolean {
  if (!def.instanceSockets) return true;
  return Object.prototype.hasOwnProperty.call(inputsOfNode(def, params), socket);
}

/** {@link inputExists} for an output. */
export function outputExists(def: NodeDefinition, params: unknown, socket: string): boolean {
  if (!def.instanceSockets) return true;
  return Object.prototype.hasOwnProperty.call(outputsOfNode(def, params), socket);
}

/**
 * The inputs a node holds a wire on that its params no longer give (its workflow file changed):
 * kept, read as unconnected, and shown as broken by every surface that draws or lists the node.
 * Empty for a type whose sockets do not come from its params.
 */
export function brokenInputsOf(
  def: NodeDefinition,
  node: { params?: unknown; inputs: Readonly<Record<string, unknown>> },
): string[] {
  if (!def.instanceSockets) return [];
  const has = inputsOfNode(def, node.params);
  return Object.keys(node.inputs).filter(
    (s) => !Object.prototype.hasOwnProperty.call(has, s) && node.inputs[s] !== undefined,
  );
}
