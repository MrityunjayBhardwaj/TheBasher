// #1557 D6 — a template's inputs are params of each instance too: an input whose socket is
// unwired reads the instance's own value, and a wire overrides it (Houdini's promoted parameter).

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import {
  TemplateDefinitionSchema,
  syncTemplateTypes,
  templateInstanceParams,
  templatesOf,
} from '../core/dag/templates';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { composeProject, loadProject, saveProject } from '../core/project/io';
import { MemoryStorage } from '../core/storage/MemoryStorage';
import { registerAllNodes } from '../nodes/registerAll';
import { validatePlan } from '../agent/mutators/validate';
import { addTemplateInstanceMutator } from '../agent/mutators/builders/templates';
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

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  store().reset();
  syncTemplateTypes({ nodes: {} });
  store().hydrate(arithmetic());
  collapseSelectionToTemplate(['mul', 'two'], 'Scale');
  addTemplateInstance('template.Scale'); // n_scale_2, its `kfit` unwired
});

describe('#1557 D6 — an input is a value of the instance while its socket is unwired', () => {
  it('each instance holds a value per Number input, 0 to start', () => {
    expect(dag().nodes.n_scale_2.params).toEqual({ locked: true, kfit: 0 });
    expect(at(dag(), 'n_scale_2')).toBe(0);
  });

  it('an unwired input reads the instance’s value, and each instance its own', () => {
    addTemplateInstance('template.Scale'); // n_scale_3
    store().dispatchAtomic([set('n_scale_2', 'kfit', 4), set('n_scale_3', 'kfit', 10)]);
    expect(at(dag(), 'n_scale_2')).toBe(8);
    expect(at(dag(), 'n_scale_3')).toBe(20);
    expect(at(dag(), 'n_scale_1')).toBe(0.5); // wired: the wire, not its value
  });

  it('a wire overrides the value, and unwiring gives the value back', () => {
    store().dispatchAtomic([set('n_scale_2', 'kfit', 4)]);
    store().dispatchAtomic([
      node('k3', 'Fit', { outMin: 3, outMax: 3 }),
      wire('k3', 'n_scale_2', 'kfit'),
    ]);
    expect(at(dag(), 'n_scale_2')).toBe(6);
    store().dispatchAtomic([
      {
        type: 'disconnect',
        from: { node: 'k3', socket: 'out' },
        to: { node: 'n_scale_2', socket: 'kfit' },
      },
    ]);
    expect(at(dag(), 'n_scale_2')).toBe(8);
  });

  it('a value is set on a LOCKED instance: it is the instance’s, not its body’s', () => {
    expect(dag().nodes.n_scale_2.params).toMatchObject({ locked: true });
    expect(() => store().dispatch(set('n_scale_2', 'kfit', 5))).not.toThrow();
    // …and it is not carried to the other instances or the definition.
    expect(dag().nodes.n_scale_1.params).toMatchObject({ kfit: 0 });
  });

  it('saved and opened again, each instance keeps its value', async () => {
    store().dispatchAtomic([set('n_scale_2', 'kfit', 4)]);
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state: dag() }));
    store().hydrate(buildDefaultDagState());
    store().hydrate((await loadProject(storage, 'p')).state);
    expect(at(dag(), 'n_scale_2')).toBe(8);
  });

  it('an instance saved before inputs had values reads as it did', () => {
    const old = dag();
    const bare = {
      ...old,
      nodes: { ...old.nodes, n_scale_2: { ...old.nodes.n_scale_2, params: {} } },
    };
    store().hydrate(bare);
    expect(at(dag(), 'n_scale_2')).toBe(0);
  });

  it('a Vector3 input has an [x, y, z] value; a pose input has none', () => {
    const def = templatesOf(dag()).get('template.Scale')!.definition;
    const t = getNodeType(def.type)!;
    expect(t.paramSchema.parse({})).toEqual({ locked: true, kfit: 0 });
    const vec = TemplateDefinitionSchema.parse({
      ...def,
      type: 'template.V',
      inputs: { p: { type: 'Vector3' }, pose: { type: 'PosedSkeleton' } },
      body: {
        nodes: { o: { id: 'o', type: 'Fit', version: 1, params: {}, inputs: {} } },
        out: { node: 'o', socket: 'out' },
      },
    });
    expect(templateInstanceParams(vec).parse({})).toEqual({ locked: true, p: [0, 0, 0] });
  });

  it('no input can be named `locked`', () => {
    const def = templatesOf(dag()).get('template.Scale')!.definition;
    expect(
      TemplateDefinitionSchema.safeParse({ ...def, inputs: { locked: { type: 'Number' } } })
        .success,
    ).toBe(false);
  });
});

describe('#1557 D6 — the agent gives an unwired input its value', () => {
  const plan = (spec: unknown) =>
    validatePlan(
      addTemplateInstanceMutator,
      addTemplateInstanceMutator.spec.parse(spec),
      dag(),
      't',
    );

  it('adds an instance holding the value', () => {
    const r = plan({ template: 'Scale', values: { kfit: 3 } });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    store().dispatchAtomic(r.ops);
    expect(at(dag(), 'n_scale_3')).toBe(6);
  });

  it('refuses a value of the wrong shape, for an input it lacks, or beside a wire', () => {
    const wrong = plan({ template: 'Scale', values: { kfit: [1, 2, 3] } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('"kfit" is a Number: Expected number');
    const none = plan({ template: 'Scale', values: { k: 1 } });
    expect(none.ok).toBe(false);
    const both = plan({ template: 'Scale', values: { kfit: 1 }, inputs: { kfit: 'kfit' } });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.reason).toContain('the wire would win');
  });
});
