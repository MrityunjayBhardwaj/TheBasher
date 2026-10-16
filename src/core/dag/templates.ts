// #1557 — templates: a sub-network saved once and used as many times as wanted.
//
// A template DEFINITION is a node type, as a Houdini digital asset's definition is
// (`hou.HDADefinition`: "A digital asset definition defines a node type"). It is stored IN THE
// GRAPH, as a `TemplateDefinition` node whose params hold it, the way a Blender node group is a
// data-block of the `.blend`. So making, changing and deleting a template are ordinary operations:
// one undo takes back a collapse, definition and all, and the agent's plans can make one. An
// INSTANCE is an ordinary node of the template's type, with a real copy of the definition's body
// behind its `body` socket (#1557 D1): the evaluator, delete, duplicate, the inspector and the
// agent all read real nodes, and a node can only belong to one sub-network. Exporting a template
// to a file of its own is #1660.
//
// What the type declares, worked out from the definition's interface alone (`templateNodeType`):
// - one Number/Vector3/… socket per input, and the same name as a named input of its body, so a
//   body-input leaf reading `k` reads whatever is wired into the instance's `k` (#1548, #1357);
// - a `body` socket of the output's type, which owns the instance's copy of the body;
// - one output, `out`: the body's value. An instance keeps no history of its own, so a Solver
//   inside one reads its inputs on every frame (#1645).
//
// Type names are namespaced `template.<Name>`. No built-in type has a dot in its name, so a
// template never shadows one, including a built-in added after the project was saved.
//
// WHICH TYPES ARE REGISTERED. The registry is one for the whole app, and the graph it serves
// changes. Two places keep them together:
// - `applyOp` defines a template's type the moment its definition node is added or changed
//   (`followDefinition`), so later operations in the same batch can add an instance of it;
// - the DAG store makes the registered template types exactly its graph's after every change,
//   undo and load included (`syncTemplateTypes`), which also removes the types of definitions
//   that are gone.
// An operation applied to a graph that never reaches the store (a dry run) can leave a type it
// defined registered until the store's next change.

import { z } from 'zod';
import { defineNodeType, isDefinedNodeType, undefineNodeType } from './registry';
import type { DagState } from './state';
import { NodeRefSchema, NodeSchema } from './types';
import type {
  InputBinding,
  InputDescriptor,
  Node,
  NodeDefinition,
  NodeId,
  NodeRef,
  Op,
  SocketTypeName,
} from './types';

export const TEMPLATE_TYPE_PREFIX = 'template.';
const TEMPLATE_TYPE = /^template\.[A-Za-z][A-Za-z0-9_]*$/;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The socket an instance's copy of the body hangs from. Not a name an input can take. */
export const TEMPLATE_BODY_SOCKET = 'body';

export const TemplateDefinitionSchema = z
  .object({
    /** The node type an instance has: `template.<Name>`. */
    type: z.string().regex(TEMPLATE_TYPE, 'a template type is named template.<Name>'),
    /** What a person reads in the node list. */
    label: z.string().min(1),
    /** Each input is a socket on the instance and a named input of its body. */
    inputs: z.record(z.string().regex(INPUT_NAME), z.object({ type: z.string().min(1) })),
    /** The type of the instance's output, and of its body. */
    output: z.object({ type: z.string().min(1) }),
    /** The body, its nodes keyed by a name local to the definition (each node's `id` is its
     *  key), and the node and socket whose value is the instance's output. */
    body: z.object({
      nodes: z.record(z.string().min(1), NodeSchema),
      out: NodeRefSchema,
    }),
  })
  .superRefine((def, ctx) => {
    if (TEMPLATE_BODY_SOCKET in def.inputs)
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', TEMPLATE_BODY_SOCKET],
        message: `"${TEMPLATE_BODY_SOCKET}" is the socket the body hangs from, so no input can take it`,
      });
    for (const [key, node] of Object.entries(def.body.nodes)) {
      if (node.id !== key)
        ctx.addIssue({
          code: 'custom',
          path: ['body', 'nodes', key, 'id'],
          message: `a body node's id is its key ("${key}"), not "${node.id}"`,
        });
    }
    if (!def.body.nodes[def.body.out.node])
      ctx.addIssue({
        code: 'custom',
        path: ['body', 'out', 'node'],
        message: `the body's output names "${def.body.out.node}", which is not a node of the body`,
      });
    // The body is what its output reads, and only that: an instance's copy is the closure behind
    // its `body` socket, so a node that feeds nothing would be copied and then belong to nothing,
    // and a wire to a node the body lacks would point out of every instance.
    const reached = new Set<string>();
    const stack = [def.body.out.node];
    while (stack.length) {
      const key = stack.pop()!;
      const node = def.body.nodes[key];
      if (!node || reached.has(key)) continue;
      reached.add(key);
      for (const [socket, binding] of Object.entries(node.inputs)) {
        for (const ref of Array.isArray(binding) ? binding : [binding]) {
          if (def.body.nodes[ref.node]) stack.push(ref.node);
          else
            ctx.addIssue({
              code: 'custom',
              path: ['body', 'nodes', key, 'inputs', socket],
              message: `"${key}" reads "${ref.node}", which is not a node of the body`,
            });
        }
      }
    }
    for (const key of Object.keys(def.body.nodes))
      if (def.body.nodes[def.body.out.node] && !reached.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['body', 'nodes', key],
          message: `"${key}" does not feed the body's output`,
        });
  });
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

/** The node type whose params hold a template's definition. */
export const TEMPLATE_DEFINITION_TYPE = 'TemplateDefinition';

/** A definition node's params: the definition, and whether to keep it in the saved file while
 *  no instance uses it (Blender's "fake user"). */
export const TemplateDefinitionParams = z.object({
  definition: TemplateDefinitionSchema,
  keep: z.boolean().default(false),
});
export type TemplateDefinitionParams = z.infer<typeof TemplateDefinitionParams>;

const definitionOf = (node: Node | undefined): TemplateDefinition | undefined =>
  node?.type === TEMPLATE_DEFINITION_TYPE
    ? (node.params as TemplateDefinitionParams | undefined)?.definition
    : undefined;

/** Every template `state` defines, by type, with the node that holds each. */
export function templatesOf(
  state: Pick<DagState, 'nodes'>,
): Map<string, { readonly node: NodeId; readonly definition: TemplateDefinition }> {
  const out = new Map<string, { node: NodeId; definition: TemplateDefinition }>();
  for (const node of Object.values(state.nodes)) {
    const definition = definitionOf(node);
    if (definition && !out.has(definition.type))
      out.set(definition.type, { node: node.id, definition });
  }
  return out;
}

/** An instance's params. `locked` (#1557 D4): its body follows the definition and cannot be
 *  edited in place; unlocked, an edit inside it is an edit of the template. */
export const TemplateInstanceParams = z.object({ locked: z.boolean().default(true) });

/** Whether an instance is locked. A node saved before the param existed reads as locked. */
export const isLocked = (node: Node): boolean =>
  (node.params as { locked?: unknown } | undefined)?.locked !== false;

const single = (type: string): InputDescriptor =>
  ({ type: type as SocketTypeName, cardinality: 'single' }) as InputDescriptor;

/** The node type a definition declares. */
export function templateNodeType(def: TemplateDefinition): NodeDefinition {
  const inputs: Record<string, InputDescriptor> = {};
  const bodyInputs: Record<string, InputDescriptor> = {};
  for (const [name, input] of Object.entries(def.inputs)) {
    inputs[name] = single(input.type);
    bodyInputs[name] = single(input.type);
  }
  inputs[TEMPLATE_BODY_SOCKET] = { ...single(def.output.type), body: true };
  return {
    type: def.type,
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: TemplateInstanceParams,
    inputs,
    outputs: { out: single(def.output.type) },
    bodyInputs,
    evaluate: (_params: unknown, values: Record<string, unknown>) => values[TEMPLATE_BODY_SOCKET],
  } as unknown as NodeDefinition;
}

/** What each template type was last defined from (its interface: what the type declares), so
 *  an unchanged one is not defined again: a redefinition moves the registry's epoch, and every
 *  cache worked out from types starts over (#1647). A change to the body alone defines nothing. */
const definedFrom = new Map<string, string>();
const interfaceOf = (def: TemplateDefinition) =>
  JSON.stringify({ type: def.type, inputs: def.inputs, output: def.output });

function define(def: TemplateDefinition): void {
  const key = interfaceOf(def);
  if (definedFrom.get(def.type) === key && isDefinedNodeType(def.type)) return;
  defineNodeType(templateNodeType(def));
  definedFrom.set(def.type, key);
}

/**
 * After an operation on `nodeId` in `next`: when it is a definition node, define its template's
 * type, and refuse (the reason) a second definition of a type another node already defines.
 */
export function followDefinition(next: Pick<DagState, 'nodes'>, nodeId: NodeId): string | null {
  const definition = definitionOf(next.nodes[nodeId]);
  if (!definition) return null;
  for (const node of Object.values(next.nodes)) {
    if (node.id !== nodeId && definitionOf(node)?.type === definition.type)
      return `"${node.id}" already defines ${definition.type}; a template has one definition`;
  }
  define(definition);
  return null;
}

/** Make the registered template types exactly the ones `state` defines. */
export function syncTemplateTypes(state: Pick<DagState, 'nodes'>): void {
  const wanted = templatesOf(state);
  for (const type of [...definedFrom.keys()]) {
    if (wanted.has(type)) continue;
    if (isDefinedNodeType(type)) undefineNodeType(type);
    definedFrom.delete(type);
  }
  for (const { definition } of wanted.values()) define(definition);
}

/** `state` without the definitions no instance uses and none asked to keep: what a save writes,
 *  as Blender drops a data-block with no users when it saves. */
export function withoutUnusedTemplates<S extends Pick<DagState, 'nodes'>>(state: S): S {
  const used = new Set(Object.values(state.nodes).map((n) => n.type));
  let nodes: Record<NodeId, Node> | null = null;
  for (const node of Object.values(state.nodes)) {
    const definition = definitionOf(node);
    if (!definition || used.has(definition.type)) continue;
    if ((node.params as TemplateDefinitionParams).keep === true) continue;
    nodes ??= { ...state.nodes };
    delete nodes[node.id];
  }
  return nodes ? { ...state, nodes } : state;
}

const refsOf = (binding: InputBinding | undefined): NodeRef[] =>
  Array.isArray(binding) ? binding : binding ? [binding] : [];

/**
 * Which node of `instanceId`'s body stands for each node of `def`'s body (definition key → node
 * id), found by walking both from the output socket by socket. Null when the body no longer has
 * the definition's shape: a wire, a node's type or the set of nodes differs.
 */
export function matchInstanceBody(
  state: Pick<DagState, 'nodes'>,
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

// ── Editing a template through an instance (#1557 D4) ──────────────────────────────────────

export type TemplateEdits = { readonly ops: Op[] } | { readonly refusal: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a committed change from `prev` to `next` does to the templates it edits, Houdini's way:
 * an edit inside a LOCKED instance is refused; a parameter edit inside an UNLOCKED one is an edit
 * of the template, so the operations returned apply it to the definition and to the node at the
 * same place in every other instance (`matchInstanceBody`). An edit that changes a body's shape
 * is refused for now (#1665).
 *
 * Asked by the commit doors (the DAG store's three dispatches, and the agent's preview), never by
 * undo, redo or a load: what a commit wrote together, undo takes back together, and a refusal
 * there would make undo disagree with the edit it undoes (the #1646 lesson).
 *
 * Only instances whose body matched their definition before the change are asked. A drifted
 * instance is ordinary nodes as far as its definition is concerned.
 */
export function templateEdits(
  prev: Pick<DagState, 'nodes'>,
  next: Pick<DagState, 'nodes'>,
): TemplateEdits {
  if (prev.nodes === next.nodes) return { ops: [] };
  const templates = templatesOf(prev);
  if (templates.size === 0) return { ops: [] };
  const changed = new Set<NodeId>();
  for (const id of new Set([...Object.keys(prev.nodes), ...Object.keys(next.nodes)]))
    if (prev.nodes[id] !== next.nodes[id]) changed.add(id);

  // type → definition key → the params the edit gave it, and which instance gave them.
  const edits = new Map<string, Map<string, { params: unknown; from: NodeId }>>();
  for (const instance of Object.values(prev.nodes)) {
    const template = templates.get(instance.type);
    const after = next.nodes[instance.id];
    if (!template || !after) continue; // not an instance, or removed with its body
    const def = template.definition;
    const before = matchInstanceBody(prev, instance.id, def);
    if (!before) continue;
    const touched = [...before].filter(([, id]) => changed.has(id));
    if (touched.length === 0) continue;
    const [, first] = touched[0];
    if (isLocked(after))
      return {
        refusal:
          `"${first}" is inside "${instance.id}", an instance of ${def.type} that is locked; ` +
          `unlock it to edit the template`,
      };
    const now = matchInstanceBody(next, instance.id, def);
    // The same nodes at the same places: a socket moved to a new node of the same type still
    // matches the definition's shape, with another node at that place.
    if (!now || [...before].some(([key, id]) => now.get(key) !== id))
      return {
        refusal:
          `adding, removing or rewiring nodes inside "${instance.id}" (${def.type}) is not ` +
          `supported yet, only parameter edits that reach every instance (#1665)`,
      };
    for (const [key, id] of touched) {
      const params = next.nodes[id].params;
      if (same(params, prev.nodes[id].params)) continue;
      const byKey = edits.get(def.type) ?? new Map();
      edits.set(def.type, byKey);
      const prior = byKey.get(key);
      if (prior && !same(prior.params, params))
        return {
          refusal:
            `"${prior.from}" and "${instance.id}" edit the same node of ${def.type} ` +
            `differently in one change`,
        };
      byKey.set(key, { params, from: instance.id });
    }
  }

  const ops: Op[] = [];
  for (const [type, byKey] of edits) {
    const { node: holder, definition } = templates.get(type)!;
    const nodes = { ...definition.body.nodes };
    for (const [key, { params }] of byKey) nodes[key] = { ...nodes[key], params } as Node;
    ops.push({
      type: 'setParam',
      nodeId: holder,
      paramPath: 'definition',
      value: { ...definition, body: { ...definition.body, nodes } },
    });
    for (const other of Object.values(next.nodes)) {
      if (other.type !== type) continue;
      const map = matchInstanceBody(next, other.id, definition);
      if (!map) continue;
      for (const [key, { params }] of byKey) {
        const id = map.get(key)!;
        const have = (next.nodes[id].params ?? {}) as Record<string, unknown>;
        for (const [path, value] of Object.entries(params as Record<string, unknown>))
          if (!same(have[path], value))
            ops.push({ type: 'setParam', nodeId: id, paramPath: path, value });
      }
    }
  }
  return { ops };
}
