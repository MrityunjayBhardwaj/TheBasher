// #1557 — a sub-network collapsed into a template, instanced again, saved and opened again.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, applyOps } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { subnetworkOf, subnetworkViolations } from '../core/dag/subnetworks';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { composeProject, loadProject, saveProject } from '../core/project/io';
import { getNodeType } from '../core/dag/registry';
import {
  TemplateDefinitionSchema,
  syncTemplateTypes,
  templatesOf,
  type TemplateDefinition,
} from '../core/dag/templates';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { registerAllNodes } from '../nodes/registerAll';
import {
  addTemplateInstance,
  collapseSelectionToTemplate,
  matchInstanceBody,
  planCollapseToTemplate,
} from './templates';

const FPS = 60;
const FRAMES = [0, 1, 7, 15, 30, 31, 45, 60];

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string, frame = 0) =>
  evaluate(s, id, { ctx: { time: { frame, seconds: frame / FPS, normalized: 0 } } }).value;
const dag = () => useDagStore.getState().state;
// A node's inputs are compared by socket, not by the order their keys were written in: undoing a
// rewire puts a socket's key back last, which changes nothing a reader sees.
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
        )
      : v;
const stable = (s: DagState) => JSON.stringify(sorted(s.nodes));

/** `kfit` (0.25) and `two` (2) multiplied by `mul`, read by a driver on the box. */
const arithmetic = () =>
  apply(buildDefaultDagState(), [
    node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
    node('two', 'Fit', { outMin: 2, outMax: 2 }),
    node('mul', 'Math', { op: 'mul' }),
    wire('kfit', 'mul', 'a'),
    wire('two', 'mul', 'b'),
    node('drv', 'ParamDriver', {
      target: 'n_box',
      paramPath: 'material.metalness',
      blendMode: 'replace',
      order: 0,
    }),
    wire('mul', 'drv', 'in'),
  ]);

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

/** Open `state` in the DAG store. */
const open = (state: DagState) => useDagStore.getState().hydrate(state);
/** The definition of `type` the open graph holds. */
const definitionOf = (type: string): TemplateDefinition => templatesOf(dag()).get(type)!.definition;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  syncTemplateTypes({ nodes: {} });
});

describe('#1557 — collapsing a selection into a template', () => {
  it('the selection becomes the first instance and computes what it computed', () => {
    open(arithmetic());
    const before = at(dag(), 'mul');
    expect(before).toBe(0.5);
    const r = collapseSelectionToTemplate(['mul', 'two'], 'Scale');
    expect(r).toEqual({ ok: true, type: 'template.Scale', instance: 'n_scale_1' });
    const s = dag();
    expect(s.nodes.drv.inputs.in).toEqual({ node: 'n_scale_1', socket: 'out' });
    expect(s.nodes.n_scale_1.inputs.kfit).toEqual({ node: 'kfit', socket: 'out' });
    expect(at(s, 'n_scale_1')).toBe(before);
    // The selected nodes kept their ids, and are now the instance's body.
    expect([...subnetworkOf(s, 'n_scale_1')].sort()).toEqual(['mul', 'n_scale_1_in_kfit', 'two']);
    expect(subnetworkViolations(s)).toEqual([]);
    const def = definitionOf('template.Scale');
    expect(TemplateDefinitionSchema.safeParse(def).success).toBe(true);
    expect(def.inputs).toEqual({ kfit: { type: 'Number' } });
    expect(def.output).toEqual({ type: 'Number' });
  });

  it('one undo puts the graph back exactly, and takes the template with it', () => {
    open(arithmetic());
    const before = stable(dag());
    collapseSelectionToTemplate(['mul', 'two'], 'Scale');
    expect(stable(dag())).not.toBe(before);
    expect(getNodeType('template.Scale')).toBeDefined();
    useDagStore.getState().undo();
    expect(stable(dag())).toBe(before);
    expect(templatesOf(dag()).size).toBe(0);
    expect(getNodeType('template.Scale')).toBeUndefined();
  });

  it('a Solver and its body collapse into a template that lags exactly as the Solver did', () => {
    open(solverLag());
    const before = FRAMES.map((f) => (at(dag(), 'sol', f) as { out: number }).out);
    expect(new Set(before).size).toBeGreaterThan(3);
    const r = collapseSelectionToTemplate(LAG_BODY, 'Lag');
    expect(r.ok).toBe(true);
    const s = dag();
    // `k` came in from outside the Solver's step, and is now the template's input (#1645).
    expect(s.nodes.n_lag_1.inputs.kfit).toEqual({ node: 'kfit', socket: 'out' });
    expect(FRAMES.map((f) => at(s, 'n_lag_1', f))).toEqual(before);
  });

  it('a second instance is a fresh copy of the body, with inputs of its own', () => {
    open(arithmetic());
    collapseSelectionToTemplate(['mul', 'two'], 'Scale');
    const r = addTemplateInstance('template.Scale');
    expect(r).toEqual({ ok: true, type: 'template.Scale', instance: 'n_scale_2' });
    useDagStore
      .getState()
      .dispatchAtomic(
        [node('k3', 'Fit', { outMin: 3, outMax: 3 }), wire('k3', 'n_scale_2', 'kfit')],
        'user',
        'wire',
      );
    const s = dag();
    expect(at(s, 'n_scale_1')).toBe(0.5);
    expect(at(s, 'n_scale_2')).toBe(6);
    const one = subnetworkOf(s, 'n_scale_1');
    const two = subnetworkOf(s, 'n_scale_2');
    expect([...one].filter((id) => two.has(id))).toEqual([]);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('each instance is matched to its definition, node for node, and a drifted one is not', () => {
    open(arithmetic());
    collapseSelectionToTemplate(['mul', 'two'], 'Scale');
    addTemplateInstance('template.Scale');
    const def = definitionOf(dag().nodes.n_scale_1?.type ?? dag().nodes.n_diff_1.type);
    const first = matchInstanceBody(dag(), 'n_scale_1', def);
    expect(first && Object.fromEntries(first)).toEqual({
      mul: 'mul',
      two: 'two',
      n_scale_1_in_kfit: 'n_scale_1_in_kfit',
    });
    const second = matchInstanceBody(dag(), 'n_scale_2', def);
    expect(second && [...second.values()].sort()).toEqual(
      ['n_scale_2_mul', 'n_scale_2_n_scale_1_in_kfit', 'n_scale_2_two'].sort(),
    );
    // Swap the two inputs of the copy's Math node: same nodes, other shape.
    const drifted = applyOps(dag(), [
      {
        type: 'connect',
        from: { node: 'n_scale_2_two', socket: 'out' },
        to: { node: 'n_scale_2_mul', socket: 'a' },
      },
      {
        type: 'connect',
        from: { node: 'n_scale_2_n_scale_1_in_kfit', socket: 'out' },
        to: { node: 'n_scale_2_mul', socket: 'b' },
      },
    ]).next;
    expect(matchInstanceBody(drifted, 'n_scale_2', def)).toBeNull();
    expect(matchInstanceBody(drifted, 'n_scale_1', def)).not.toBeNull();
  });

  it('a wire moved to another output of the same node is drift too', () => {
    // `x − y` of a vector: swapping which output feeds which side keeps every node and type.
    open(
      apply(buildDefaultDagState(), [
        node('v', 'MakeVec3'),
        node('br', 'VecBreak3'),
        wire('v', 'br', 'v'),
        node('d', 'Math', { op: 'sub' }),
        wire('br', 'd', 'a', 'x'),
        wire('br', 'd', 'b', 'y'),
        node('c', 'Clamp'),
        wire('d', 'c', 'in'),
      ]),
    );
    expect(collapseSelectionToTemplate(['br', 'd'], 'Diff').ok).toBe(true);
    const def = definitionOf(dag().nodes.n_scale_1?.type ?? dag().nodes.n_diff_1.type);
    expect(matchInstanceBody(dag(), 'n_diff_1', def)).not.toBeNull();
    const swapped = applyOps(dag(), [
      { type: 'connect', from: { node: 'br', socket: 'y' }, to: { node: 'd', socket: 'a' } },
      { type: 'connect', from: { node: 'br', socket: 'x' }, to: { node: 'd', socket: 'b' } },
    ]).next;
    expect(matchInstanceBody(swapped, 'n_diff_1', def)).toBeNull();
  });

  it('saved and opened again, both instances compute the same', async () => {
    open(arithmetic());
    collapseSelectionToTemplate(['mul', 'two'], 'Scale');
    addTemplateInstance('template.Scale');
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state: dag() }));
    open(buildDefaultDagState());
    expect(getNodeType('template.Scale')).toBeUndefined(); // gone with the graph that defined it
    const loaded = await loadProject(storage, 'p');
    open(loaded.state);
    expect(at(dag(), 'n_scale_1')).toBe(0.5);
    expect(at(dag(), 'n_scale_2')).toBe(0); // its `kfit` is not wired, so its leaf reads 0
  });
});

describe('#1557 — what cannot be collapsed, and why', () => {
  const plan = (s: DagState, sel: string[]) => planCollapseToTemplate(s, sel, 'T', 'n_t_1');
  const reason = (s: DagState, sel: string[]) => {
    const r = plan(s, sel);
    return r.ok ? null : r.reason;
  };
  it('nothing outside reads the selection', () => {
    const s = apply(buildDefaultDagState(), [node('a', 'Fit')]);
    expect(reason(s, ['a'])).toMatch(/nothing outside the selection reads it/);
  });
  it('the outside reads two of its outputs', () => {
    const s = apply(arithmetic(), [node('c', 'Clamp'), wire('two', 'c', 'in')]);
    expect(reason(s, ['mul', 'two'])).toMatch(/reads 2 outputs of the selection/);
  });
  it('a selected node feeds nothing the output reads', () => {
    const s = apply(arithmetic(), [node('lone', 'Fit')]);
    expect(reason(s, ['mul', 'two', 'lone'])).toMatch(/"lone" does not feed the output "mul"/);
  });
  it('a wire coming in carries a type no template input can be', () => {
    const s = apply(buildDefaultDagState(), [
      node('nul', 'Null', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
      node('grp', 'Group'),
      wire('nul', 'grp', 'children'),
      wire('grp', 'n_scene', 'children'),
    ]);
    expect(reason(s, ['grp'])).toMatch(/"nul" feeds the selection a SceneObject/);
  });
  it('a body input of a selected sub-network is left out', () => {
    expect(reason(solverLag(), ['sol', 'add'])).toMatch(
      /"(prev|inp)" reads the inputs of "sol" and is not selected/,
    );
  });
  it('a name already taken is refused, and the graph is left as it was', () => {
    open(arithmetic());
    expect(collapseSelectionToTemplate(['two'], 'T').ok).toBe(true);
    const before = dag();
    expect(collapseSelectionToTemplate(['kfit'], 'T')).toEqual({
      ok: false,
      reason: 'a template "template.T" already exists in this project',
    });
    expect(dag()).toBe(before);
  });
});
