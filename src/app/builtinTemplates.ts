// #1559 — the templates Basher ships: Lag and Spring, as Solver presets.
//
// A built-in template is defined in code, the way a node type is, and copied into a project the
// first time it is used, the way Houdini embeds an asset's definition in the scene file: from
// then on it is an ordinary `TemplateDefinition` node of that project (#1557), saved with it and
// taken back by undo. Nothing is installed anywhere else.
//
// Each definition is made the way a director would make one: its network is built in a scratch
// graph and collapsed by `planCollapseToTemplate`, which works out its inputs, leaves and output.
// So the presets are exactly the networks the stateful nodes compute:
// - Lag: `prev + (input − prev)·clamp(factor, 0, 1)`, the Lag node's own step (`lagStep`), seeded
//   from the input at its start frame. Each instance holds its factor (0.2 to start, as a Lag
//   node), its controller and start frame, and an `in` read when it names no controller.
// - Spring: the network `buildSpringOps` has always written (`springBodyOps`), with stiffness
//   and damping read through `Vec3Math.s` so each instance holds its own (0.12 / 0.14).
//
// REF: src/app/templates.ts (`planCollapseToTemplate`, `planTemplateInstance`);
//      src/nodes/valueMath.ts (`lagStep`); src/app/solverBind.ts (`springBodyOps`); #1559.

import { applyOps } from '../core/dag/ops';
import { emptyDagState, type DagState } from '../core/dag/state';
import { templatesOf, type TemplateDefinition } from '../core/dag/templates';
import type { NodeId, Op } from '../core/dag/types';
import { springBodyOps } from './solverBind';
import { planCollapseToTemplate, planTemplateInstance } from './templates';

export const BUILTIN_TEMPLATES = ['Lag', 'Spring'] as const;
export type BuiltinTemplate = (typeof BUILTIN_TEMPLATES)[number];

/** The Lag node's default factor (`LagParams`), and the spring's feel (`solverBind.ts`). */
const LAG_FACTOR = 0.2;
const SPRING_STIFFNESS = 0.12;
const SPRING_DAMPING = 0.14;

const add = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op => ({
  type: 'connect',
  from: { node: from, socket: fromSocket },
  to: { node: to, socket },
});

/** A controller to trail, and the constants that become inputs named after them. */
const CONTROLLER: Op = add('controller', 'Null');

function collapsed(ops: Op[], body: string[], name: string): TemplateDefinition {
  const scratch = applyOps(emptyDagState(), ops).next;
  const plan = planCollapseToTemplate(scratch, body, name, 'preset');
  if (!plan.ok) throw new Error(`the built-in ${name} template could not be made: ${plan.reason}`);
  return plan.definition;
}

function lagDefinition(): TemplateDefinition {
  const def = collapsed(
    [
      CONTROLLER,
      add('factor', 'Fit', { outMin: LAG_FACTOR, outMax: LAG_FACTOR }),
      add('prev', 'BodyInput', { input: 'prev' }),
      add('input', 'BodyInput', { input: 'input' }),
      add('k', 'Clamp', { min: 0, max: 1 }),
      wire('factor', 'k', 'in'),
      add('gap', 'Math', { op: 'sub' }),
      wire('input', 'gap', 'a'),
      wire('prev', 'gap', 'b'),
      add('step', 'Math', { op: 'mul' }),
      wire('gap', 'step', 'a'),
      wire('k', 'step', 'b'),
      add('next', 'Math', { op: 'add' }),
      wire('prev', 'next', 'a'),
      wire('step', 'next', 'b'),
      add('solver', 'Solver', {
        seedFrame: 0,
        sourceTransform: { node: 'controller', channel: 'tx' },
      }),
      wire('next', 'solver', 'body'),
      add('reader', 'Math'),
      wire('solver', 'reader', 'a'),
    ],
    ['solver', 'next', 'step', 'gap', 'k', 'prev', 'input'],
    'Lag',
  );
  return {
    ...def,
    inputs: {
      ...def.inputs,
      factor: { type: 'Number', default: LAG_FACTOR },
      // A Lag's own `in`: what it trails when it names no controller.
      in: { type: 'Number', default: 0 },
    },
  };
}

function springDefinition(): TemplateDefinition {
  const def = collapsed(
    [
      CONTROLLER,
      add('stiffness', 'Fit', { outMin: SPRING_STIFFNESS, outMax: SPRING_STIFFNESS }),
      add('damping', 'Fit', { outMin: SPRING_DAMPING, outMax: SPRING_DAMPING }),
      ...springBodyOps({
        controllerId: 'controller',
        stiffness: SPRING_STIFFNESS,
        damping: SPRING_DAMPING,
        seedFrame: 0,
        idFor: (key) => key,
      }),
      wire('stiffness', 'ke', 's'),
      wire('damping', 'cv', 's'),
      add('reader', 'VecBreak3'),
      wire('solver', 'reader', 'v', 'outVec'),
    ],
    ['solver', 'np', 'nv', 'acc', 'cv', 'ke', 'e', 'pv', 'pp', 'in'],
    'Spring',
  );
  return {
    ...def,
    inputs: {
      ...def.inputs,
      stiffness: { type: 'Number', default: SPRING_STIFFNESS },
      damping: { type: 'Number', default: SPRING_DAMPING },
    },
  };
}

const made = new Map<BuiltinTemplate, TemplateDefinition>();
/** The definition of a built-in template. */
export function builtinDefinition(name: BuiltinTemplate): TemplateDefinition {
  let def = made.get(name);
  if (!def) {
    def = name === 'Lag' ? lagDefinition() : springDefinition();
    made.set(name, def);
  }
  return def;
}

const shapeOf = (d: TemplateDefinition) =>
  JSON.stringify({ type: d.type, inputs: d.inputs, output: d.output, body: d.body });

export type PlacedBuiltin =
  | { readonly ok: true; readonly ops: Op[]; readonly definition: TemplateDefinition }
  | { readonly ok: false; readonly reason: string };

/**
 * An instance of the built-in `name`, `instanceId`, holding `params` (its controller, start
 * frame and values), with the definition copied into the project first when it is not there.
 * Refused when the project holds a template of that type that is not the built-in one.
 */
export function placeBuiltin(
  state: DagState,
  name: BuiltinTemplate,
  instanceId: NodeId,
  params: Record<string, unknown> = {},
): PlacedBuiltin {
  const definition = builtinDefinition(name);
  const held = templatesOf(state).get(definition.type);
  if (held && shapeOf(held.definition) !== shapeOf(definition))
    return {
      ok: false,
      reason: `this project has its own ${definition.type}, which is not the built-in ${name}`,
    };
  const ops: Op[] = [];
  if (!held) {
    let holder = `tpl_${name}`;
    for (let n = 2; state.nodes[holder] || holder.startsWith(`${instanceId}_`); n++)
      holder = `tpl_${name}_${n}`;
    ops.push({
      type: 'addNode',
      nodeId: holder,
      nodeType: 'TemplateDefinition',
      params: { definition, keep: false },
    });
  }
  // The instance's body ids are `${instanceId}_…`, so they never take the holder's.
  ops.push(...planTemplateInstance(state, definition, instanceId, params));
  return { ok: true, ops, definition };
}
