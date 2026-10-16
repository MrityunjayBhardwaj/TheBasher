// #1557 — the agent's doors to templates: collapse nodes into one, add more instances of it.
//
// Every row runs the real five gates (`validatePlan`), and the accepted plans go through the diff
// store under the mutator's own closure, then land in the DAG store the way an accepted turn does.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../../../core/dag';
import { evaluate } from '../../../core/dag/evaluator';
import type { DagState } from '../../../core/dag/state';
import { useDagStore } from '../../../core/dag/store';
import { syncTemplateTypes, templatesOf } from '../../../core/dag/templates';
import type { Op } from '../../../core/dag/types';
import { buildDefaultDagState } from '../../../core/project/default';
import { registerAllNodes } from '../../../nodes/registerAll';
import { useDiffStore } from '../../diff';
import { paramsForAgent } from '../../paramsForAgent';
import { dagInspectTool } from '../../tools/dagInspect';
import type { MutatorDefinition, MutatorValidationResult } from '../types';
import { validatePlan } from '../validate';
import { addTemplateInstanceMutator, collapseToTemplateMutator } from './templates';

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string, frame = 0) =>
  evaluate(s, id, { ctx: { time: { frame, seconds: frame / 60, normalized: 0 } } }).value;
const dag = () => useDagStore.getState().state;

/** A Solver stepping `prev + (input − prev)·k` after a swept Null, `k` from `kfit` (0.25). */
const solverLag = () =>
  apply(buildDefaultDagState(), [
    node('nul', 'Null', { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    wire('nul', 'n_scene', 'children'),
    node('n_tx', 'KeyframeChannelVec3', {
      name: 'position',
      target: 'nul',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 0.5, value: [6, 0, 0], easing: 'linear' },
        { time: 1, value: [-3, 0, 0], easing: 'linear' },
      ],
    }),
    node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
    node('prev', 'BodyInput', { input: 'prev' }),
    node('inp', 'BodyInput', { input: 'input' }),
    node('sub', 'Math', { op: 'sub' }),
    wire('inp', 'sub', 'a'),
    wire('prev', 'sub', 'b'),
    node('mul', 'Math', { op: 'mul' }),
    wire('sub', 'mul', 'a'),
    wire('kfit', 'mul', 'b'),
    node('add', 'Math', { op: 'add' }),
    wire('prev', 'add', 'a'),
    wire('mul', 'add', 'b'),
    node('sol', 'Solver', { seedFrame: 0, sourceTransform: { node: 'nul', channel: 'tx' } }),
    wire('add', 'sol', 'body'),
    node('drv', 'ParamDriver', {
      target: 'n_box',
      paramPath: 'material.metalness',
      blendMode: 'replace',
      order: 0,
    }),
    wire('sol', 'drv', 'in'),
  ]);
const LAG_BODY = ['sol', 'add', 'mul', 'sub', 'prev', 'inp'];
const FRAMES = [0, 1, 7, 15, 30, 31, 45, 60];

function plan<S>(m: MutatorDefinition<S>, spec: unknown): MutatorValidationResult {
  return validatePlan(m, m.spec.parse(spec), dag(), 'test');
}

/** Accept `spec`'s plan as a turn does: proposed under the mutator's closure, then dispatched. */
function accept<S>(m: MutatorDefinition<S>, spec: unknown): MutatorValidationResult {
  const r = plan(m, spec);
  if (!r.ok) return r;
  useDiffStore.getState().reset();
  const closure = m.buildClosureSpec(m.spec.parse(spec));
  useDiffStore.getState().propose(dag(), r.ops, 'test', undefined, closure);
  useDagStore.getState().dispatchAtomic(r.ops, 'agent', m.name);
  return r;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  syncTemplateTypes({ nodes: {} });
  useDagStore.getState().hydrate(solverLag());
});

describe('#1557 — mutator.graph.collapseToTemplate', () => {
  it('collapses a Solver and its body into a template whose first instance lags as it did', () => {
    const before = FRAMES.map((f) => (at(dag(), 'sol', f) as { out: number }).out);
    const r = accept(collapseToTemplateMutator, { nodes: LAG_BODY, name: 'Lag' });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join('\n')).toContain(
      'template.Lag: inputs kfit (Number), sourceTransform (TransformSource), output Number',
    );
    expect(r.warnings.join('\n')).toContain('first instance "n_lag_1"');
    const s = dag();
    expect(s.nodes.drv.inputs.in).toEqual({ node: 'n_lag_1', socket: 'out' });
    expect(FRAMES.map((f) => at(s, 'n_lag_1', f))).toEqual(before);
  });

  it('one undo takes the collapse back, the definition with it', () => {
    const before = JSON.stringify(Object.keys(dag().nodes).sort());
    accept(collapseToTemplateMutator, { nodes: LAG_BODY, name: 'Lag' });
    expect(templatesOf(dag()).has('template.Lag')).toBe(true);
    useDagStore.getState().undo();
    expect(JSON.stringify(Object.keys(dag().nodes).sort())).toBe(before);
    expect(templatesOf(dag()).size).toBe(0);
  });

  it('refuses at the precondition gate, with the planner reason, what cannot be collapsed', () => {
    const r = plan(collapseToTemplateMutator, { nodes: ['sub', 'prev'], name: 'Half' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.label).toBe('precondition');
    expect(r.reason).toContain('the outside reads 2 outputs of the selection');
    const missing = plan(collapseToTemplateMutator, { nodes: ['nope'], name: 'X' });
    expect(missing.ok).toBe(false);
  });
});

describe('#1557 — mutator.graph.addTemplateInstance', () => {
  beforeEach(() => {
    accept(collapseToTemplateMutator, { nodes: LAG_BODY, name: 'Lag' });
  });

  it('adds a fresh copy, its input and output wired as the spec says', () => {
    useDagStore.getState().dispatchAtomic(
      [
        node('k1', 'Fit', { outMin: 1, outMax: 1 }),
        node('drv2', 'ParamDriver', {
          target: 'n_box',
          paramPath: 'material.roughness',
          blendMode: 'replace',
          order: 0,
        }),
      ],
      'user',
      'setup',
    );
    const r = accept(addTemplateInstanceMutator, {
      template: 'Lag',
      inputs: { kfit: 'k1' },
      outputTo: { node: 'drv2', socket: 'in' },
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    const s = dag();
    expect(s.nodes.n_lag_2.type).toBe('template.Lag');
    expect(s.nodes.n_lag_2.inputs.kfit).toEqual({ node: 'k1', socket: 'out' });
    expect(s.nodes.drv2.inputs.in).toEqual({ node: 'n_lag_2', socket: 'out' });
    // k = 1 follows the swept Null exactly; k = 0.25 lags behind it.
    const sweep = FRAMES.map((f) => at(s, 'n_lag_2', f));
    const lag = FRAMES.map((f) => at(s, 'n_lag_1', f));
    expect(sweep[3]).not.toBeCloseTo(lag[3] as number, 3);
  });

  it('says which inputs are left unwired and that nothing reads its output', () => {
    const r = plan(addTemplateInstanceMutator, { template: 'template.Lag' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain(
      "inputs left unwired, read as the instance's values (0 unless set): kfit",
    );
    expect(r.warnings).toContain('its output is read by nothing yet');
  });

  it('refuses a template the project lacks, naming the ones it has, and an input it lacks', () => {
    const r = plan(addTemplateInstanceMutator, { template: 'Spring' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('(it has template.Lag)');
    const bad = plan(addTemplateInstanceMutator, { template: 'Lag', inputs: { k: 'kfit' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.reason).toContain('has no input "k" (its inputs: kfit, sourceTransform)');
  });
});

describe('#1557 — the agent reads a definition by its interface', () => {
  it('shows a definition without its body nodes, and dag.inspect stays small', () => {
    accept(collapseToTemplateMutator, { nodes: LAG_BODY, name: 'Lag' });
    const holder = templatesOf(dag()).get('template.Lag')!.node;
    const params = dag().nodes[holder].params as { definition: unknown };
    const shown = paramsForAgent(params) as { definition: Record<string, unknown> };
    expect(shown.definition).toEqual({
      type: 'template.Lag',
      label: 'Lag',
      inputs: { kfit: { type: 'Number' }, sourceTransform: { type: 'TransformSource' } },
      output: { type: 'Number' },
      body: {
        nodes: 7,
        nodeTypes: { Solver: 1, Math: 3, BodyInput: 3 },
        out: { node: 'sol', socket: 'out' },
      },
    });
    expect(JSON.stringify(shown).length).toBeLessThan(JSON.stringify(params).length / 3);
    const text = dagInspectTool.handler({ scope: 'node', nodeId: holder }, {
      dagState: dag(),
    } as never);
    expect((text as { text: string }).text).not.toContain('seedFrame');
  });
});
