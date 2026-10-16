// #1557 D4 — a template instance is locked by default; inside an unlocked one, an edit is an edit
// of the template and reaches its definition and every other instance in the same commit.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { matchInstanceBody, syncTemplateTypes, templatesOf } from '../core/dag/templates';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { createFork } from '../agent/diff/forkedDag';
import { addTemplateInstance, collapseSelectionToTemplate } from './templates';

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket } }) as Op;
const set = (nodeId: string, paramPath: string, value: unknown): Op =>
  ({ type: 'setParam', nodeId, paramPath, value }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string) =>
  evaluate(s, id, { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } }).value;
const dag = () => useDagStore.getState().state;
const store = () => useDagStore.getState();

/** `kfit` (0.25) times `two` (2) in `mul`, read by a driver: `mul` + `two` collapse into Scale. */
const arithmetic = () =>
  apply(buildDefaultDagState(), [
    node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
    node('two', 'Fit', { outMin: 2, outMax: 2 }),
    node('mul', 'Math', { op: 'mul' }),
    wire('kfit', 'mul', 'a'),
    wire('two', 'mul', 'b'),
    node('drv', 'ParamDriver', {
      target: 'n_box_data',
      paramPath: 'material.base.metalness',
      blendMode: 'replace',
      order: 0,
    }),
    wire('mul', 'drv', 'in'),
  ]);

/** The node of `instance`'s body standing for the definition's `key`. */
const bodyNode = (instance: string, key: string) =>
  matchInstanceBody(dag(), instance, templatesOf(dag()).get('template.Scale')!.definition)!.get(
    key,
  )!;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  store().reset();
  syncTemplateTypes({ nodes: {} });
  store().hydrate(arithmetic());
  collapseSelectionToTemplate(['mul', 'two'], 'Scale');
  addTemplateInstance('template.Scale');
  store().dispatchAtomic(
    [node('k3', 'Fit', { outMin: 3, outMax: 3 }), wire('k3', 'n_scale_2', 'kfit')],
    'user',
    'wire the second instance',
  );
});

describe('#1557 D4 — a locked instance', () => {
  it('is how every instance starts', () => {
    expect(dag().nodes.n_scale_1.params).toMatchObject({ locked: true });
    expect(dag().nodes.n_scale_2.params).toMatchObject({ locked: true });
  });

  it('refuses an edit inside it, on each commit road, and the graph stays as it was', () => {
    const before = dag();
    const edit = set('two', 'outMax', 5);
    expect(() => store().dispatch(edit)).toThrow(/inside "n_scale_1".*locked; unlock it/);
    expect(() => store().dispatchBatch([edit])).toThrow(/locked/);
    expect(() => store().dispatchAtomic([edit])).toThrow(/locked/);
    expect(dag()).toBe(before);
  });

  it('refuses it in the agent preview too, before anything is accepted', () => {
    expect(() => createFork(dag(), [set('two', 'outMax', 5)])).toThrow(/locked; unlock it/);
  });

  it('can still be deleted with its body, and unlocked', () => {
    store().dispatchAtomic([set('n_scale_2', 'locked', false)]);
    expect(dag().nodes.n_scale_2.params).toMatchObject({ locked: false });
    const body = [
      ...matchInstanceBody(
        dag(),
        'n_scale_1',
        templatesOf(dag()).get('template.Scale')!.definition,
      )!.values(),
    ];
    store().dispatchAtomic([
      {
        type: 'disconnect',
        from: { node: 'n_scale_1', socket: 'out' },
        to: { node: 'drv', socket: 'in' },
      },
      { type: 'removeNode', nodeId: 'n_scale_1' },
      ...body.flatMap((id): Op[] => [
        ...Object.entries(dag().nodes[id].inputs).flatMap(([socket, ref]) =>
          (Array.isArray(ref) ? ref : [ref]).map(
            (r) => ({ type: 'disconnect', from: r, to: { node: id, socket } }) as Op,
          ),
        ),
      ]),
      ...body.map((id) => ({ type: 'removeNode', nodeId: id }) as Op),
    ]);
    expect(dag().nodes.n_scale_1).toBeUndefined();
  });
});

describe('#1557 D4 — an edit inside an unlocked instance is an edit of the template', () => {
  beforeEach(() => store().dispatchAtomic([set('n_scale_1', 'locked', false)]));

  it('reaches the definition and every other instance, locked or not, in one commit', () => {
    const depth = store().undoStack.length;
    store().dispatch(set('two', 'outMin', 5));
    store().dispatch(set('two', 'outMax', 5));
    const s = dag();
    expect(at(s, 'n_scale_1')).toBe(0.25 * 5);
    expect(at(s, 'n_scale_2')).toBe(3 * 5);
    const other = bodyNode('n_scale_2', 'two');
    expect(s.nodes[other].params).toMatchObject({ outMin: 5, outMax: 5 });
    const def = templatesOf(s).get('template.Scale')!.definition;
    expect(def.body.nodes.two.params).toMatchObject({ outMin: 5, outMax: 5 });
    expect(store().undoStack.length).toBe(depth + 2);
  });

  it('one undo takes the edit back everywhere, and redo brings it back everywhere', () => {
    store().dispatchAtomic([set('two', 'outMin', 7), set('two', 'outMax', 7)]);
    expect(at(dag(), 'n_scale_2')).toBe(21);
    store().undo();
    expect(at(dag(), 'n_scale_2')).toBe(6);
    expect(
      templatesOf(dag()).get('template.Scale')!.definition.body.nodes.two.params,
    ).toMatchObject({ outMin: 2, outMax: 2 });
    store().redo();
    expect(at(dag(), 'n_scale_2')).toBe(21);
  });

  it('undoing an edit after locking the instance again is not refused', () => {
    store().dispatchAtomic([set('two', 'outMin', 7), set('two', 'outMax', 7)]);
    store().dispatchAtomic([set('n_scale_1', 'locked', true)]);
    store().undo(); // the lock
    store().dispatchAtomic([set('n_scale_1', 'locked', true)]);
    expect(() => store().undo()).not.toThrow();
    store().undo();
    expect(at(dag(), 'n_scale_2')).toBe(6);
  });

  it('refuses a change to the body’s shape, naming the issue that will carry it', () => {
    expect(() =>
      store().dispatchAtomic([
        node('extra', 'Fit', { outMin: 1, outMax: 1 }),
        {
          type: 'connect',
          from: { node: 'extra', socket: 'out' },
          to: { node: 'mul', socket: 'b' },
        },
      ]),
    ).toThrow(/not supported yet.*#1665/);
  });

  it('refuses two instances giving the same node different values in one commit', () => {
    store().dispatchAtomic([set('n_scale_2', 'locked', false)]);
    expect(() =>
      store().dispatchAtomic([
        set('two', 'outMin', 4),
        set(bodyNode('n_scale_2', 'two'), 'outMin', 9),
      ]),
    ).toThrow(/edit the same node of template.Scale differently/);
  });

  it('shows the carried edit in the agent preview', () => {
    const { fork } = createFork(dag(), [set('two', 'outMin', 5), set('two', 'outMax', 5)]);
    expect(at(fork, 'n_scale_2')).toBe(15);
  });
});

describe('#1557 D4 — what the lock does not police', () => {
  it('an instance that has drifted from its definition is ordinary nodes, locked or not', () => {
    // A body changed some way the commit doors did not see (a file, an older version) no longer
    // matches its definition, and its nodes are its own.
    const k = bodyNode('n_scale_2', 'two');
    const mul = bodyNode('n_scale_2', 'mul');
    store().hydrate(
      apply(dag(), [
        { type: 'disconnect', from: { node: k, socket: 'out' }, to: { node: mul, socket: 'b' } },
      ] as Op[]),
    );
    expect(dag().nodes.n_scale_2.params).toMatchObject({ locked: true });
    expect(() => store().dispatch(set(mul, 'op', 'add'))).not.toThrow();
    expect(dag().nodes[bodyNode('n_scale_1', 'mul')].params).toMatchObject({ op: 'mul' });
  });
});
