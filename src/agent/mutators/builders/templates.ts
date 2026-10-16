// Templates — the agent's doors to a project's templates (#1557).
//
// Two mutators over the planners in `src/app/templates.ts`, the same plans the app's own actions
// dispatch, so a template the agent makes is the one a director would have made:
//
// - `mutator.graph.collapseToTemplate`: the selected nodes become a template's body and stay where
//   they are as its first instance (Houdini: collapse to a subnet, then create a digital asset
//   from it). The wires coming in become the template's inputs.
// - `mutator.graph.addTemplateInstance`: one more instance, a fresh copy of the body, with its
//   inputs and its output wired where the spec says.
//
// A template's definition is a `TemplateDefinition` node, so both are ordinary operations: one
// undo takes either back, the definition included.
//
// REF: src/app/templates.ts; src/core/dag/templates.ts; issue #1557.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeRef, Op } from '../../../core/dag/types';
import { getNodeType } from '../../../core/dag/registry';
import { templatesOf, type TemplateDefinition } from '../../../core/dag/templates';
import {
  instanceIdFor,
  planCollapseToTemplate,
  planTemplateInstance,
  templateTypeFor,
  templateTypeNamed,
} from '../../../app/templates';

// ── Collapse ────────────────────────────────────────────────────────────────────────────────

const CollapseToTemplateSpec = z.object({
  /** The nodes that become the template's body. */
  nodes: z.array(z.string().min(1)).min(1),
  /** The template's name; its node type is `template.<name>`. */
  name: z.string().min(1),
  /** The first instance's id; defaults to `n_<name>_1`. */
  instanceId: z.string().min(1).optional(),
});
export type CollapseToTemplateSpec = z.infer<typeof CollapseToTemplateSpec>;

const collapsePlan = (spec: CollapseToTemplateSpec, state: DagState) =>
  planCollapseToTemplate(
    state,
    spec.nodes,
    spec.name,
    spec.instanceId ?? instanceIdFor(state, templateTypeFor(spec.name)),
  );

export const collapseToTemplateMutator: MutatorDefinition<CollapseToTemplateSpec> = {
  name: 'mutator.graph.collapseToTemplate',
  // The first sentence is the picker payload, so it ends before a CAPITAL (see `poseBone`).
  description:
    'Collapse nodes into a reusable template, the nodes staying in place as its first instance. ' +
    'The nodes must give the outside exactly one output, and every one of them must feed it. ' +
    'Each wire coming in from outside becomes an input of the template (Number, Vector3 or ' +
    'PosedSkeleton), named after the node it comes from, and the instance reads it there. ' +
    'Add more instances with mutator.graph.addTemplateInstance. Instances are locked: their ' +
    "body cannot be edited. Set an instance's `locked` param to false (dag.exec setParam) and a " +
    'param edit inside it changes the template, its definition and every instance at once.',
  spec: CollapseToTemplateSpec,
  specExample: { nodes: ['node_id'], name: 'Lag' },
  contract: {
    // One hop consumer-side: the nodes reading the selection's output are rewired to the instance.
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    // What the selection computed, the instance computes; nothing else changes.
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: spec.nodes, followedEdges: ['parent'], maxDepth: 1 };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.nodes)
      if (!state.nodes[id]) return { ok: false, reason: `"${id}" is not a node of the graph` };
    const plan = collapsePlan(spec, state);
    return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
  },
  build(spec, _closure, state): Op[] {
    const plan = collapsePlan(spec, state);
    if (!plan.ok) throw new Error(plan.reason);
    return plan.ops;
  },
  advisories(spec, _closure, state) {
    const plan = collapsePlan(spec, state);
    if (!plan.ok) return [];
    const inputs = Object.entries(plan.definition.inputs).map(([n, i]) => `${n} (${i.type})`);
    const instance = plan.ops.find(
      (op) => op.type === 'addNode' && op.nodeType === plan.definition.type,
    ) as Extract<Op, { type: 'addNode' }>;
    return [
      `${plan.definition.type}: ${inputs.length ? `inputs ${inputs.join(', ')}` : 'no inputs'}, ` +
        `output ${plan.definition.output.type}; first instance "${instance.nodeId}"`,
    ];
  },
};

// ── Another instance ────────────────────────────────────────────────────────────────────────

const SocketRef = z.union([
  z.string().min(1),
  z.object({ node: z.string().min(1), socket: z.string().min(1).default('out') }),
]);
const refOf = (r: z.infer<typeof SocketRef>): NodeRef =>
  typeof r === 'string' ? { node: r, socket: 'out' } : r;

const AddTemplateInstanceSpec = z.object({
  /** The template: its type (`template.Lag`), its name (`Lag`) or its label. */
  template: z.string().min(1),
  /** What each input of the template reads: a node id (its `out`) or `{ node, socket }`. */
  inputs: z.record(z.string().min(1), SocketRef).optional(),
  /** Where the instance's output goes: the input socket of a node. */
  outputTo: z.object({ node: z.string().min(1), socket: z.string().min(1) }).optional(),
  /** The instance's id; defaults to `n_<name>_<n>`. */
  instanceId: z.string().min(1).optional(),
});
export type AddTemplateInstanceSpec = z.infer<typeof AddTemplateInstanceSpec>;

type Resolved =
  | { ok: true; def: TemplateDefinition; instance: string }
  | { ok: false; reason: string };

function resolve(spec: AddTemplateInstanceSpec, state: DagState): Resolved {
  const type = templateTypeNamed(state, spec.template);
  if (!type) {
    const known = [...templatesOf(state).keys()];
    return {
      ok: false,
      reason:
        `this project has no template "${spec.template}"` +
        (known.length ? ` (it has ${known.join(', ')})` : ' (it has none)'),
    };
  }
  const def = templatesOf(state).get(type)!.definition;
  const instance = spec.instanceId ?? instanceIdFor(state, type);
  if (state.nodes[instance]) return { ok: false, reason: `"${instance}" is already a node` };
  for (const [name, r] of Object.entries(spec.inputs ?? {})) {
    if (!def.inputs[name])
      return {
        ok: false,
        reason:
          `${type} has no input "${name}"` +
          ` (its inputs: ${Object.keys(def.inputs).join(', ') || 'none'})`,
      };
    const from = refOf(r);
    if (!state.nodes[from.node]) return { ok: false, reason: `"${from.node}" is not a node` };
  }
  if (spec.outputTo) {
    const consumer = state.nodes[spec.outputTo.node];
    if (!consumer) return { ok: false, reason: `"${spec.outputTo.node}" is not a node` };
    if (!getNodeType(consumer.type)?.inputs[spec.outputTo.socket])
      return {
        ok: false,
        reason: `"${spec.outputTo.node}" (${consumer.type}) has no input "${spec.outputTo.socket}"`,
      };
  }
  return { ok: true, def, instance };
}

export const addTemplateInstanceMutator: MutatorDefinition<AddTemplateInstanceSpec> = {
  name: 'mutator.graph.addTemplateInstance',
  description:
    "Add an instance of one of the project's templates, a fresh copy of its body. " +
    'Wire its inputs with `inputs` (input name → node id, or { node, socket }) and its output ' +
    'with `outputTo` (a node and one of its input sockets). The templates a project has are its ' +
    'TemplateDefinition nodes; make one with mutator.graph.collapseToTemplate.',
  spec: AddTemplateInstanceSpec,
  specExample: { template: 'Lag', inputs: { input: 'node_id' } },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    // Everything already in the graph stays as it was, except the one input `outputTo` names.
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
    lossy: [
      {
        kind: 'replaced-input',
        reason: '`outputTo` on a single input replaces what that input read',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Every op lands on a node the plan adds, except the connect into `outputTo`.
    return { rootSelectors: spec.outputTo ? [spec.outputTo.node] : [], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const r = resolve(spec, state);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  },
  build(spec, _closure, state): Op[] {
    const r = resolve(spec, state);
    if (!r.ok) throw new Error(r.reason);
    const ops = planTemplateInstance(state, r.def, r.instance);
    for (const [name, from] of Object.entries(spec.inputs ?? {}))
      ops.push({ type: 'connect', from: refOf(from), to: { node: r.instance, socket: name } });
    if (spec.outputTo)
      ops.push({ type: 'connect', from: { node: r.instance, socket: 'out' }, to: spec.outputTo });
    return ops;
  },
  advisories(spec, _closure, state) {
    const r = resolve(spec, state);
    if (!r.ok) return [];
    const unwired = Object.keys(r.def.inputs).filter((n) => !spec.inputs?.[n]);
    const notes = [`instance "${r.instance}" of ${r.def.type}`];
    if (unwired.length)
      notes.push(`inputs left unwired, read as their defaults: ${unwired.join(', ')}`);
    if (!spec.outputTo) notes.push('its output is read by nothing yet');
    return notes;
  },
};
