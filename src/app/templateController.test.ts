// #1559 — each instance of a template names the controller a stateful node inside trails (the
// Solver's own `sourceTransform`, held by the instance), so two instances of one Lag-like template
// can trail two controllers. Houdini: an asset's promoted node-path parameter.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { getNodeType } from '../core/dag/registry';
import { syncTemplateTypes, templatesOf } from '../core/dag/templates';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { validatePlan } from '../agent/mutators/validate';
import { addTemplateInstanceMutator } from '../agent/mutators/builders/templates';
import { driverParamDeps, driverSubscriptionNodesForTarget } from './paramDrivers';
import { buildDeleteNodesOps } from './sceneNodeActions';
import {
  collapseSelectionToTemplate,
  planCollapseToTemplate,
  planTemplateInstance,
} from './templates';

const FPS = 60;
const FRAMES = [0, 1, 7, 15, 30, 31, 45, 60];
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string, frame: number) => {
  const v = evaluate(s, id, {
    ctx: { time: { frame, seconds: frame / FPS, normalized: 0 } },
  }).value;
  return typeof v === 'object' && v !== null && 'out' in v ? (v as { out: number }).out : v;
};
const dag = () => useDagStore.getState().state;
const store = () => useDagStore.getState();

/** A Null `id` swept along x by a channel: 0 → `peak` at 0.5 s → −`peak`/2 at 1 s. */
const swept = (id: string, peak: number): Op[] => [
  node(id, 'Null', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
  wire(id, 'n_scene', 'children'),
  node(`${id}_tx`, 'KeyframeChannelVec3', {
    name: 'position',
    target: id,
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 0.5, value: [peak, 0, 0], easing: 'linear' },
      { time: 1, value: [-peak / 2, 0, 0], easing: 'linear' },
    ],
  }),
];

/** `prev + (input − prev)·0.25`, a Solver `sol` trailing `nul`.tx, read by a driver. */
const lagBody = (prefix: string, controller: string): Op[] => [
  node(`${prefix}k`, 'Fit', { outMin: 0.25, outMax: 0.25 }),
  node(`${prefix}prev`, 'BodyInput', { input: 'prev' }),
  node(`${prefix}inp`, 'BodyInput', { input: 'input' }),
  node(`${prefix}sub`, 'Math', { op: 'sub' }),
  wire(`${prefix}inp`, `${prefix}sub`, 'a'),
  wire(`${prefix}prev`, `${prefix}sub`, 'b'),
  node(`${prefix}mul`, 'Math', { op: 'mul' }),
  wire(`${prefix}sub`, `${prefix}mul`, 'a'),
  wire(`${prefix}k`, `${prefix}mul`, 'b'),
  node(`${prefix}add`, 'Math', { op: 'add' }),
  wire(`${prefix}prev`, `${prefix}add`, 'a'),
  wire(`${prefix}mul`, `${prefix}add`, 'b'),
  node(`${prefix}sol`, 'Solver', {
    seedFrame: 0,
    sourceTransform: { node: controller, channel: 'tx' },
  }),
  wire(`${prefix}add`, `${prefix}sol`, 'body'),
];
const BODY = ['sol', 'add', 'mul', 'sub', 'prev', 'inp', 'k'];
const driver = (id: string, from: string, path: string): Op[] => [
  node(id, 'ParamDriver', {
    target: 'n_box_data',
    paramPath: path,
    blendMode: 'replace',
    order: 0,
  }),
  wire(from, id, 'in'),
];

/** Two controllers, a Lag on the first, and a plain Solver on the second to compare with. */
const scene = () =>
  apply(buildDefaultDagState(), [
    ...swept('nul', 6),
    ...swept('nul2', 2),
    ...lagBody('', 'nul'),
    ...driver('drv', 'sol', 'material.base.metalness'),
    ...lagBody('ref_', 'nul2'),
  ]);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  store().reset();
  syncTemplateTypes({ nodes: {} });
  store().hydrate(scene());
});

describe('#1559 — a collapse moves the controller onto the instance', () => {
  it('the instance holds it, the body does not, and the first instance lags as before', () => {
    const before = FRAMES.map((f) => at(dag(), 'sol', f));
    expect(collapseSelectionToTemplate(BODY, 'Lag').ok).toBe(true);
    const s = dag();
    expect(s.nodes.n_lag_1.params).toMatchObject({
      sourceTransform: { node: 'nul', channel: 'tx' },
    });
    expect((s.nodes.sol.params as { sourceTransform?: unknown }).sourceTransform).toBeUndefined();
    const def = templatesOf(s).get('template.Lag')!.definition;
    expect(def.inputs.sourceTransform).toEqual({ type: 'TransformSource' });
    expect(def.body.nodes.sol.params).not.toHaveProperty('sourceTransform');
    expect(FRAMES.map((f) => at(s, 'n_lag_1', f))).toEqual(before);
  });

  it('two stateful nodes trailing different controllers are refused', () => {
    const r = planCollapseToTemplate(dag(), [...BODY, ...BODY.map((k) => `ref_${k}`)], 'Two', 'x');
    expect(r.ok).toBe(false);
  });
});

describe('#1559 — two instances, two controllers', () => {
  beforeEach(() => {
    collapseSelectionToTemplate(BODY, 'Lag');
  });

  it('a second instance trailing another controller lags exactly as a Solver on it does', () => {
    const r = validatePlan(
      addTemplateInstanceMutator,
      addTemplateInstanceMutator.spec.parse({
        template: 'Lag',
        values: { sourceTransform: { node: 'nul2', channel: 'tx' } },
      }),
      dag(),
      't',
    );
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    store().dispatchAtomic(r.ops);
    const s = dag();
    const two = FRAMES.map((f) => at(s, 'n_lag_2', f));
    expect(two).toEqual(FRAMES.map((f) => at(s, 'ref_sol', f)));
    expect(new Set(two).size).toBeGreaterThan(3);
    expect(two).not.toEqual(FRAMES.map((f) => at(s, 'n_lag_1', f)));
  });

  it('without a controller of its own an instance is told so, and reads 0', () => {
    const r = validatePlan(
      addTemplateInstanceMutator,
      addTemplateInstanceMutator.spec.parse({ template: 'Lag' }),
      dag(),
      't',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('it trails no controller until sourceTransform is set');
    store().dispatchAtomic(r.ops);
    expect(FRAMES.map((f) => at(dag(), 'n_lag_2', f))).toEqual(FRAMES.map(() => 0));
  });

  it('a controller of the wrong shape is refused with the Solver param’s own reason', () => {
    const bad = validatePlan(
      addTemplateInstanceMutator,
      addTemplateInstanceMutator.spec.parse({
        template: 'Lag',
        values: { sourceTransform: 'nul2' },
      }),
      dag(),
      't',
    );
    expect(bad.ok).toBe(false);
  });

  it('what already reads a controller off a node reads it off the instance', () => {
    store().dispatchAtomic([
      {
        type: 'setParam',
        nodeId: 'n_lag_1',
        paramPath: 'sourceTransform',
        value: { node: 'nul2', channel: 'tx' },
      },
    ]);
    const s = dag();
    expect(driverParamDeps(s.nodes).n_lag_1).toEqual(['nul2']); // the cycle guard
    expect(driverSubscriptionNodesForTarget(s.nodes, 'n_box_data').map((n) => n.id)).toContain(
      'nul2',
    );
    expect(getNodeType('template.Lag')!.idRefs).toEqual([
      { path: 'sourceTransform.node', shape: 'nested', role: 'argument' },
    ]);
  });

  it('deleting the controller clears the instance’s reference, and the instance stays', () => {
    store().dispatchAtomic(buildDeleteNodesOps(dag(), ['nul']), 'user', 'delete');
    const s = dag();
    expect(s.nodes.nul).toBeUndefined();
    expect(s.nodes.n_lag_1).toBeDefined();
    expect(
      (s.nodes.n_lag_1.params as { sourceTransform?: { node?: string } }).sourceTransform?.node ??
        '',
    ).not.toBe('nul');
  });
});

describe('#1559 — the instance holds the replay’s start frame and the Lag’s `in`', () => {
  beforeEach(() => {
    collapseSelectionToTemplate(BODY, 'Lag');
  });

  it('a collapse lifts the start frame, and the instance’s is the one the replay reads', () => {
    expect(dag().nodes.n_lag_1.params).toMatchObject({ seedFrame: 0 });
    store().dispatchAtomic([
      { type: 'setParam', nodeId: 'n_lag_1', paramPath: 'seedFrame', value: 15 },
      {
        type: 'setParam',
        nodeId: 'n_lag_1',
        paramPath: 'sourceTransform',
        value: { node: 'nul2', channel: 'tx' },
      },
      { type: 'setParam', nodeId: 'ref_sol', paramPath: 'seedFrame', value: 15 },
    ]);
    const s = dag();
    expect(FRAMES.map((f) => at(s, 'n_lag_1', f))).toEqual(FRAMES.map((f) => at(s, 'ref_sol', f)));
    // …and it is not the body Solver's own, which still says 0.
    expect((s.nodes.sol.params as { seedFrame: number }).seedFrame).toBe(0);
  });

  it('with no controller, a Solver inside reads the instance’s `in`: wired, else its value', () => {
    const lag = templatesOf(dag()).get('template.Lag')!.definition;
    const { sourceTransform: _drop, ...rest } = lag.inputs;
    void _drop;
    const definition = {
      ...lag,
      type: 'template.LagIn',
      label: 'LagIn',
      inputs: { ...rest, in: { type: 'Number' } },
    };
    store().dispatchAtomic([
      {
        type: 'addNode',
        nodeId: 'tpl_in',
        nodeType: 'TemplateDefinition',
        params: { definition, keep: false },
      },
    ]);
    store().dispatchAtomic(planTemplateInstance(dag(), definition, 'li', { in: 5 }));
    expect(FRAMES.map((f) => at(dag(), 'li', f))).toEqual(FRAMES.map(() => 5));
    store().dispatchAtomic([
      node('three', 'Fit', { outMin: 3, outMax: 3 }),
      wire('three', 'li', 'in'),
    ]);
    expect(FRAMES.map((f) => at(dag(), 'li', f))).toEqual(FRAMES.map(() => 3));
  });
});
