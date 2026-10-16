// #1557 — templates inside a project: a sub-network saved once and used as many times as wanted.
//
// A template is a reusable sub-network, the way a Houdini digital asset is a reusable subnet: its
// definition is a `TemplateDefinition` node in the graph and a node type while it is there
// (`core/dag/templates.ts`), and each INSTANCE is a node of that type with a real copy of the body
// behind its `body` socket (#1557 D1). Exporting a template to a file of its own is #1660.
//
// Three things here, each a plan of ordinary operations, so one undo takes it back and the agent
// can make it:
//
// - `planCollapseToTemplate`, Houdini's collapse-to-subnet then create-asset in one step. The
//   selected nodes become the body. Each wire coming in from outside becomes an input of the
//   template, read inside by a body-input leaf, and the one output the outside reads becomes the
//   template's output. The selection is not copied: its nodes stay where they are, with their
//   ids, as the body of the first instance, so anything that names one of them still finds it.
// - `planTemplateInstance`, a second (third, …) instance: a fresh copy of the body.
// - `matchInstanceBody`, which node of an instance stands for which node of its definition.
//   Nothing is stored for this. An instance's body has its definition's shape, so walking both
//   from the output, socket by socket, pairs them; a body that no longer has that shape has
//   drifted from its definition, and the walk says so (null).

import { getNodeType } from '../core/dag/registry';
import { useDagStore } from '../core/dag/store';
import { producedTypeOf } from '../core/dag/socketConversion';
import { subnetworkOf } from '../core/dag/subnetworks';
import type { DagState } from '../core/dag/state';
import type { InputBinding, Node, NodeId, NodeRef, Op } from '../core/dag/types';
import {
  TEMPLATE_BODY_SOCKET,
  TEMPLATE_DEFINITION_TYPE,
  TEMPLATE_TYPE_PREFIX,
  templatesOf,
  type TemplateDefinition,
} from '../core/dag/templates';

/** The body-input leaf that reads an input of each type a template can take. */
const LEAF_FOR_TYPE: Readonly<Record<string, string>> = {
  Number: 'BodyInput',
  Vector3: 'BodyInputVec',
  PosedSkeleton: 'BodyInputPose',
};

export type CollapsePlan =
  | { readonly ok: true; readonly definition: TemplateDefinition; readonly ops: Op[] }
  | { readonly ok: false; readonly reason: string };

/** A leaf reading `input`, with every other param at its default. */
const leafParams = (type: string, input: string): unknown =>
  getNodeType(LEAF_FOR_TYPE[type])!.paramSchema.parse({ input });

const refsOf = (binding: InputBinding | undefined): NodeRef[] =>
  Array.isArray(binding) ? binding : binding ? [binding] : [];
const refKey = (r: NodeRef) => `${r.node}\u0000${r.socket}`;

/** `name` as a template name: letters, digits and `_`, starting with a letter. */
function asName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : fallback;
}

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

/**
 * Collapse `selection` into a template named `name` (`template.<Name>`), and make the selection
 * its first instance, `instanceId`. Refused, with the reason, when the selection has no single
 * output, when something in it cannot reach that output, when a wire coming in carries a type no
 * body-input leaf reads, or when a sub-network in it is fed from outside it.
 */
export function planCollapseToTemplate(
  state: DagState,
  selection: readonly NodeId[],
  name: string,
  instanceId: NodeId,
): CollapsePlan {
  const inside = new Set(selection.filter((id) => state.nodes[id]));
  if (inside.size === 0) return { ok: false, reason: 'nothing is selected' };
  const typeName = `${TEMPLATE_TYPE_PREFIX}${asName(name, 'Template')}`;
  if (templatesOf(state).has(typeName))
    return { ok: false, reason: `a template "${typeName}" already exists in this project` };
  if (state.nodes[instanceId]) return { ok: false, reason: `"${instanceId}" is already a node` };

  // What the outside reads: exactly one output.
  const outsideReads: { consumer: NodeId; socket: string; ref: NodeRef }[] = [];
  for (const node of Object.values(state.nodes)) {
    if (inside.has(node.id)) continue;
    for (const [socket, binding] of Object.entries(node.inputs))
      for (const ref of refsOf(binding))
        if (inside.has(ref.node)) outsideReads.push({ consumer: node.id, socket, ref });
  }
  const outputs = [...new Map(outsideReads.map((r) => [refKey(r.ref), r.ref])).values()];
  if (outputs.length === 0)
    return {
      ok: false,
      reason: 'nothing outside the selection reads it, so it has no output to give',
    };
  if (outputs.length > 1)
    return {
      ok: false,
      reason:
        `the outside reads ${outputs.length} outputs of the selection ` +
        `(${outputs.map((r) => `"${r.node}" ${r.socket}`).join(', ')}); a template has one`,
    };
  const out = outputs[0];
  const outType = producedTypeOf(state, out);
  if (!outType) return { ok: false, reason: `"${out.node}" has no output "${out.socket}"` };

  // Every selected node feeds that output; anything else would be left outside the instance.
  const feeding = new Set<NodeId>();
  const stack = [out.node];
  while (stack.length) {
    const id = stack.pop()!;
    if (feeding.has(id) || !inside.has(id)) continue;
    feeding.add(id);
    for (const binding of Object.values(state.nodes[id].inputs))
      for (const ref of refsOf(binding)) stack.push(ref.node);
  }
  const stray = [...inside].filter((id) => !feeding.has(id));
  if (stray.length)
    return {
      ok: false,
      reason: `${stray.map((id) => `"${id}"`).join(', ')} ${stray.length === 1 ? 'does' : 'do'} not feed the output "${out.node}"`,
    };

  // The wires coming in become inputs: one per producer, named after it.
  const inputs: Record<string, { type: string }> = {};
  const inputOf = new Map<string, string>();
  const names = new Set<string>([TEMPLATE_BODY_SOCKET]);
  const entering: { consumer: NodeId; socket: string; ref: NodeRef; index: number }[] = [];
  for (const id of inside) {
    const node = state.nodes[id];
    for (const [socket, binding] of Object.entries(node.inputs)) {
      refsOf(binding).forEach((ref, index) => {
        if (!inside.has(ref.node)) entering.push({ consumer: id, socket, ref, index });
      });
    }
  }
  // A sub-network in the selection may be cut at the selection's edge: what it read from the
  // nodes left out, it then reads through a template input, the value it had. Only a body-input
  // leaf left out would change: it would no longer sit inside the owner it reads.
  for (const id of inside) {
    const leftOut = [...subnetworkOf(state, id)].find(
      (n) => !inside.has(n) && getNodeType(state.nodes[n]?.type ?? '')?.bodyInputLeaf === true,
    );
    if (leftOut !== undefined)
      return {
        ok: false,
        reason:
          `"${leftOut}" reads the inputs of "${id}" and is not selected; ` +
          `select it too, or leave "${id}" out`,
      };
  }
  for (const e of entering) {
    const key = refKey(e.ref);
    if (inputOf.has(key)) continue;
    const type = producedTypeOf(state, e.ref);
    if (!type || !LEAF_FOR_TYPE[type])
      return {
        ok: false,
        reason:
          `"${e.ref.node}" feeds the selection a ${type ?? 'value of unknown type'}, and a ` +
          `template input can be a ${Object.keys(LEAF_FOR_TYPE).join(', a ')}`,
      };
    const producer = state.nodes[e.ref.node];
    const input = unique(asName(producer.meta?.name ?? producer.id, 'input'), names);
    inputOf.set(key, input);
    inputs[input] = { type };
  }

  // The plan: a leaf per input, wired where its producer was; the instance over the body; the
  // outside rewired from the body's output to the instance's.
  const ops: Op[] = [];
  const leafOf = new Map<string, NodeId>();
  const taken = new Set(Object.keys(state.nodes));
  taken.add(instanceId);
  for (const [key, input] of inputOf) {
    const leaf = unique(`${instanceId}_in_${input}`, taken);
    leafOf.set(key, leaf);
    const type = inputs[input].type;
    ops.push({
      type: 'addNode',
      nodeId: leaf,
      nodeType: LEAF_FOR_TYPE[type],
      params: leafParams(type, input),
    });
  }
  for (const e of entering) {
    const to = { node: e.consumer, socket: e.socket };
    const leaf = { node: leafOf.get(refKey(e.ref))!, socket: 'out' };
    ops.push({ type: 'disconnect', from: e.ref, to });
    const list =
      getNodeType(state.nodes[e.consumer].type)?.inputs[e.socket]?.cardinality === 'list';
    ops.push({ type: 'connect', from: leaf, to, ...(list ? { index: e.index } : {}) });
  }
  const instanceInputs: Record<string, NodeRef> = { [TEMPLATE_BODY_SOCKET]: out };
  for (const [key, input] of inputOf) {
    const ref = entering.find((e) => refKey(e.ref) === key)!.ref;
    instanceInputs[input] = ref;
  }
  ops.push({
    type: 'addNode',
    nodeId: instanceId,
    nodeType: typeName,
    params: {},
    inputs: instanceInputs,
  });
  for (const r of outsideReads) {
    const to = { node: r.consumer, socket: r.socket };
    const index = refsOf(state.nodes[r.consumer].inputs[r.socket]).findIndex(
      (x) => refKey(x) === refKey(r.ref),
    );
    const list =
      getNodeType(state.nodes[r.consumer].type)?.inputs[r.socket]?.cardinality === 'list';
    ops.push({ type: 'disconnect', from: r.ref, to });
    ops.push({
      type: 'connect',
      from: { node: instanceId, socket: 'out' },
      to,
      ...(list ? { index } : {}),
    });
  }

  // The definition: the body as it will stand, each node keyed by its id in this first instance.
  const bodyNodes: Record<string, Node> = {};
  for (const id of inside) {
    const node = state.nodes[id];
    const rewired: Record<string, InputBinding> = {};
    for (const [socket, binding] of Object.entries(node.inputs)) {
      const map = (ref: NodeRef): NodeRef =>
        inside.has(ref.node) ? ref : { node: leafOf.get(refKey(ref))!, socket: 'out' };
      rewired[socket] = Array.isArray(binding) ? binding.map(map) : map(binding);
    }
    bodyNodes[id] = {
      id,
      type: node.type,
      version: node.version,
      params: node.params,
      inputs: rewired,
    };
  }
  for (const [key, input] of inputOf) {
    const leaf = leafOf.get(key)!;
    bodyNodes[leaf] = {
      id: leaf,
      type: LEAF_FOR_TYPE[inputs[input].type],
      version: getNodeType(LEAF_FOR_TYPE[inputs[input].type])!.version,
      params: leafParams(inputs[input].type, input),
      inputs: {},
    };
  }
  const definition: TemplateDefinition = JSON.parse(
    JSON.stringify({
      type: typeName,
      label: name,
      inputs,
      output: { type: outType },
      body: { nodes: bodyNodes, out },
    }),
  );
  // The definition first: its node defines the type the instance is added as.
  const holder = unique(`tpl_${asName(name, 'Template')}`, new Set(Object.keys(state.nodes)));
  ops.unshift({
    type: 'addNode',
    nodeId: holder,
    nodeType: TEMPLATE_DEFINITION_TYPE,
    params: { definition, keep: false },
  });
  return { ok: true, definition, ops };
}

/** A new instance of `def`, `instanceId`, with a fresh copy of its body. Its inputs are left for
 *  the caller to wire. */
export function planTemplateInstance(
  state: DagState,
  def: TemplateDefinition,
  instanceId: NodeId,
): Op[] {
  const taken = new Set(Object.keys(state.nodes));
  if (taken.has(instanceId)) throw new Error(`"${instanceId}" is already a node`);
  taken.add(instanceId);
  const idOf = new Map<string, NodeId>();
  for (const key of Object.keys(def.body.nodes))
    idOf.set(key, unique(`${instanceId}_${key}`, taken));
  const map = (ref: NodeRef): NodeRef => ({ node: idOf.get(ref.node)!, socket: ref.socket });
  const ops: Op[] = [];
  // Producers before consumers, so every wire an `addNode` carries names a node that exists.
  const added = new Set<string>();
  const add = (key: string) => {
    if (added.has(key)) return;
    added.add(key);
    const node = def.body.nodes[key];
    for (const binding of Object.values(node.inputs))
      for (const ref of refsOf(binding)) add(ref.node);
    const inputs: Record<string, InputBinding> = {};
    for (const [socket, binding] of Object.entries(node.inputs))
      inputs[socket] = Array.isArray(binding) ? binding.map(map) : map(binding);
    ops.push({
      type: 'addNode',
      nodeId: idOf.get(key)!,
      nodeType: node.type,
      params: JSON.parse(JSON.stringify(node.params ?? {})),
      inputs,
    });
  };
  for (const key of Object.keys(def.body.nodes)) add(key);
  ops.push({
    type: 'addNode',
    nodeId: instanceId,
    nodeType: def.type,
    params: {},
    inputs: { [TEMPLATE_BODY_SOCKET]: map(def.body.out) },
  });
  return ops;
}

/**
 * Which node of `instanceId`'s body stands for each node of `def`'s body (definition key → node
 * id), found by walking both from the output socket by socket. Null when the body no longer has
 * the definition's shape: a wire, a node's type or the set of nodes differs.
 */
export function matchInstanceBody(
  state: DagState,
  instanceId: NodeId,
  def: TemplateDefinition,
): Map<string, NodeId> | null {
  const instance = state.nodes[instanceId];
  const root = instance?.inputs[TEMPLATE_BODY_SOCKET];
  if (!instance || instance.type !== def.type || !root || Array.isArray(root)) return null;
  if (root.socket !== def.body.out.socket) return null;
  const match = new Map<string, NodeId>();
  const claimed = new Set<NodeId>();
  const pair = (key: string, id: NodeId): boolean => {
    const known = match.get(key);
    if (known !== undefined) return known === id;
    if (claimed.has(id)) return false;
    const want = def.body.nodes[key];
    const have = state.nodes[id];
    if (!want || !have || want.type !== have.type) return false;
    match.set(key, id);
    claimed.add(id);
    const sockets = new Set([...Object.keys(want.inputs), ...Object.keys(have.inputs)]);
    for (const socket of sockets) {
      const a = refsOf(want.inputs[socket]);
      const b = refsOf(have.inputs[socket]);
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].socket !== b[i].socket || !pair(a[i].node, b[i].node)) return false;
      }
    }
    return true;
  };
  if (!pair(def.body.out.node, root.node)) return null;
  return match.size === Object.keys(def.body.nodes).length ? match : null;
}

// ── The two actions ─────────────────────────────────────────────────────────────────────────

/** An id for a new instance of `type`, free in `state`. */
function instanceIdFor(state: DagState, type: string): NodeId {
  const base = `n_${type.slice(TEMPLATE_TYPE_PREFIX.length).toLowerCase()}`;
  let n = 1;
  while (state.nodes[`${base}_${n}`]) n++;
  return `${base}_${n}`;
}

export type TemplateActionResult =
  | { readonly ok: true; readonly type: string; readonly instance: NodeId }
  | { readonly ok: false; readonly reason: string };

/** Collapse the selected nodes into a new template, the selection becoming its first
 *  instance. One undo takes it all back, the definition included. */
export function collapseSelectionToTemplate(
  selection: readonly NodeId[],
  name: string,
): TemplateActionResult {
  const state = useDagStore.getState().state;
  const instance = instanceIdFor(state, `${TEMPLATE_TYPE_PREFIX}${asName(name, 'Template')}`);
  const plan = planCollapseToTemplate(state, selection, name, instance);
  if (!plan.ok) return plan;
  try {
    useDagStore
      .getState()
      .dispatchAtomic(plan.ops, 'user', `collapse into ${plan.definition.label}`);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true, type: plan.definition.type, instance };
}

/** Add an instance of the graph's template `type`. */
export function addTemplateInstance(type: string): TemplateActionResult {
  const state = useDagStore.getState().state;
  const def = templatesOf(state).get(type)?.definition;
  if (!def) return { ok: false, reason: `this project has no template "${type}"` };
  const instance = instanceIdFor(state, type);
  try {
    useDagStore
      .getState()
      .dispatchAtomic(planTemplateInstance(state, def, instance), 'user', `add ${def.label}`);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true, type, instance };
}
