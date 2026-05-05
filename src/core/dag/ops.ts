// Op dispatcher — the ONLY mutation path on the DAG (V1, THESIS.md §50).
//
// Each op:
//   1. validates against current state (zod-checked at the entry, semantic
//      checks here).
//   2. computes its inverse from pre-state, so undo replays exact prior values.
//   3. applies the forward op atomically — partial mid-op state is never
//      observable.
//
// `applyOp` is pure: (state, op) → { next, inverse }. The store consumes this.
//
// REF: THESIS.md §9 (five primitives), §50, App. B; krama K2 (op dispatch
// lifecycle).

import { requireNodeType } from './registry';
import type { DagState } from './state';
import { getNode, hasNode, wouldCreateCycle } from './state';
import type { InputBinding, Node, NodeRef, Op } from './types';
import { OpSchema } from './types';

export class OpError extends Error {
  constructor(
    message: string,
    readonly op: Op,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export function validateOp(op: unknown): Op {
  const parsed = OpSchema.safeParse(op);
  if (!parsed.success) {
    throw new Error(`Invalid op: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Path access helpers (dot-paths only in v0.5; brackets land with array params)
// ---------------------------------------------------------------------------

function splitPath(path: string): string[] {
  if (path === '') return [];
  return path.split('.');
}

function getAtPath(obj: unknown, path: string): unknown {
  const parts = splitPath(path);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setAtPath(obj: unknown, path: string, value: unknown): unknown {
  const parts = splitPath(path);
  if (parts.length === 0) return value;
  // Clone-on-write down the path so we don't mutate the prior state object.
  const root: Record<string, unknown> =
    obj && typeof obj === 'object' ? { ...(obj as Record<string, unknown>) } : {};
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = cur[key];
    const cloned: Record<string, unknown> =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {};
    cur[key] = cloned;
    cur = cloned;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

// ---------------------------------------------------------------------------
// Op apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
  next: DagState;
  inverse: Op;
}

export function applyOp(state: DagState, op: Op): ApplyResult {
  switch (op.type) {
    case 'addNode':
      return applyAddNode(state, op);
    case 'removeNode':
      return applyRemoveNode(state, op);
    case 'connect':
      return applyConnect(state, op);
    case 'disconnect':
      return applyDisconnect(state, op);
    case 'setParam':
      return applySetParam(state, op);
  }
}

function applyAddNode(state: DagState, op: Extract<Op, { type: 'addNode' }>): ApplyResult {
  if (hasNode(state, op.nodeId)) {
    throw new OpError(`addNode: id already exists: ${op.nodeId}`, op);
  }
  const def = requireNodeType(op.nodeType);
  const paramsParsed = def.paramSchema.safeParse(op.params);
  if (!paramsParsed.success) {
    throw new OpError(
      `addNode: params failed schema for ${op.nodeType}: ${paramsParsed.error.message}`,
      op,
    );
  }
  const node: Node = {
    id: op.nodeId,
    type: op.nodeType,
    version: def.version,
    params: paramsParsed.data,
    inputs: op.inputs ?? {},
  };
  const next: DagState = {
    ...state,
    nodes: { ...state.nodes, [op.nodeId]: node },
  };
  const inverse: Op = { type: 'removeNode', nodeId: op.nodeId };
  return { next, inverse };
}

function applyRemoveNode(state: DagState, op: Extract<Op, { type: 'removeNode' }>): ApplyResult {
  const node = getNode(state, op.nodeId);
  // Refuse if any other node still consumes this one — caller must disconnect
  // first. This keeps undo composable: removeNode does not silently dangle.
  for (const consumer of Object.values(state.nodes)) {
    for (const binding of Object.values(consumer.inputs)) {
      const refs = Array.isArray(binding) ? binding : [binding];
      if (refs.some((r) => r.node === op.nodeId)) {
        throw new OpError(`removeNode: ${op.nodeId} is still consumed by ${consumer.id}`, op);
      }
    }
  }
  // Also fail if it's a named output socket — caller must rewire outputs first.
  for (const [name, ref] of Object.entries(state.outputs)) {
    if (ref.node === op.nodeId) {
      throw new OpError(`removeNode: ${op.nodeId} is bound as output '${name}'`, op);
    }
  }
  const { [op.nodeId]: _removed, ...rest } = state.nodes;
  void _removed;
  const next: DagState = { ...state, nodes: rest };
  const inverse: Op = {
    type: 'addNode',
    nodeId: node.id,
    nodeType: node.type,
    params: node.params,
    inputs: node.inputs,
  };
  return { next, inverse };
}

function applyConnect(state: DagState, op: Extract<Op, { type: 'connect' }>): ApplyResult {
  const consumer = getNode(state, op.to.node);
  const producer = getNode(state, op.from.node);
  const consumerDef = requireNodeType(consumer.type);
  const producerDef = requireNodeType(producer.type);

  const inputDesc = consumerDef.inputs[op.to.socket];
  if (!inputDesc) {
    throw new OpError(`connect: ${consumer.type} has no input socket '${op.to.socket}'`, op);
  }
  const outputDesc = producerDef.outputs[op.from.socket];
  if (!outputDesc) {
    throw new OpError(`connect: ${producer.type} has no output socket '${op.from.socket}'`, op);
  }
  if (inputDesc.type !== outputDesc.type) {
    throw new OpError(
      `connect: type mismatch ${producer.type}.${op.from.socket}:${outputDesc.type} → ${consumer.type}.${op.to.socket}:${inputDesc.type}`,
      op,
    );
  }
  if (wouldCreateCycle(state, op.from.node, op.to.node)) {
    throw new OpError(`connect: would create a cycle (${op.from.node} → ${op.to.node})`, op);
  }

  const ref: NodeRef = { node: op.from.node, socket: op.from.socket };
  const prior = consumer.inputs[op.to.socket];
  let nextBinding: InputBinding;
  let inverse: Op;

  if (inputDesc.cardinality === 'list') {
    const list = Array.isArray(prior) ? [...prior, ref] : prior ? [prior, ref] : [ref];
    nextBinding = list;
    inverse = { type: 'disconnect', from: ref, to: op.to };
  } else {
    nextBinding = ref;
    if (prior && !Array.isArray(prior)) {
      // Disconnect the old single binding as part of the inverse so undo
      // restores it. We model this as a follow-up connect in the inverse.
      inverse = { type: 'connect', from: prior, to: op.to };
    } else {
      inverse = { type: 'disconnect', from: ref, to: op.to };
    }
  }

  const nextNode: Node = {
    ...consumer,
    inputs: { ...consumer.inputs, [op.to.socket]: nextBinding },
  };
  const next: DagState = {
    ...state,
    nodes: { ...state.nodes, [consumer.id]: nextNode },
  };
  return { next, inverse };
}

function applyDisconnect(state: DagState, op: Extract<Op, { type: 'disconnect' }>): ApplyResult {
  const consumer = getNode(state, op.to.node);
  const def = requireNodeType(consumer.type);
  const inputDesc = def.inputs[op.to.socket];
  if (!inputDesc) {
    throw new OpError(`disconnect: ${consumer.type} has no input socket '${op.to.socket}'`, op);
  }
  const prior = consumer.inputs[op.to.socket];
  if (prior === undefined) {
    throw new OpError(`disconnect: nothing connected at ${consumer.id}.${op.to.socket}`, op);
  }
  const inputs = { ...consumer.inputs };
  if (Array.isArray(prior)) {
    const idx = prior.findIndex((r) => r.node === op.from.node && r.socket === op.from.socket);
    if (idx === -1) {
      throw new OpError(
        `disconnect: ${op.from.node}.${op.from.socket} not bound at ${consumer.id}.${op.to.socket}`,
        op,
      );
    }
    const nextList = [...prior.slice(0, idx), ...prior.slice(idx + 1)];
    if (nextList.length === 0) {
      delete inputs[op.to.socket];
    } else {
      inputs[op.to.socket] = nextList;
    }
  } else {
    if (prior.node !== op.from.node || prior.socket !== op.from.socket) {
      throw new OpError(
        `disconnect: bound producer is ${prior.node}.${prior.socket}, not ${op.from.node}.${op.from.socket}`,
        op,
      );
    }
    delete inputs[op.to.socket];
  }
  const nextNode: Node = { ...consumer, inputs };
  const next: DagState = {
    ...state,
    nodes: { ...state.nodes, [consumer.id]: nextNode },
  };
  const inverse: Op = { type: 'connect', from: op.from, to: op.to };
  return { next, inverse };
}

function applySetParam(state: DagState, op: Extract<Op, { type: 'setParam' }>): ApplyResult {
  const node = getNode(state, op.nodeId);
  const def = requireNodeType(node.type);
  const prior = getAtPath(node.params, op.paramPath);
  const nextParams = setAtPath(node.params, op.paramPath, op.value);
  // Re-validate the whole params object — cheap for v0.5 schemas, and the
  // only sound way to honor cross-field constraints.
  const parsed = def.paramSchema.safeParse(nextParams);
  if (!parsed.success) {
    throw new OpError(
      `setParam: params failed schema for ${node.type}: ${parsed.error.message}`,
      op,
    );
  }
  const nextNode: Node = { ...node, params: parsed.data };
  const next: DagState = {
    ...state,
    nodes: { ...state.nodes, [node.id]: nextNode },
  };
  const inverse: Op = {
    type: 'setParam',
    nodeId: op.nodeId,
    paramPath: op.paramPath,
    value: prior,
  };
  return { next, inverse };
}
