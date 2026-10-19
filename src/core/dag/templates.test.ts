// #1557 — a template's definition is a node of the graph, and a node type while it is there.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from './index';
import { evaluate } from './evaluator';
import { getNodeType, registryEpoch } from './registry';
import type { DagState } from './state';
import { useDagStore } from './store';
import {
  TEMPLATE_DEFINITION_TYPE,
  TemplateDefinitionSchema,
  syncTemplateTypes,
  templateNodeType,
  templatesOf,
  withoutUnusedTemplates,
  type TemplateDefinition,
} from './templates';
import type { Node, Op } from './types';
import { registerAllNodes } from '../../nodes/registerAll';
import { bundleToProject } from '../../app/sceneBundle';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildDefaultDagState } from '../project/default';
import { composeProject, loadProject, saveProject } from '../project/io';
import { migrateNodes } from '../project/migrations';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  useDagStore.getState().reset();
  syncTemplateTypes({ nodes: {} });
});

const NUM = { type: 'Number', cardinality: 'single' };
const body = (id: string, type: string, params: unknown, inputs: Node['inputs'] = {}): Node => ({
  id,
  type,
  version: 1,
  params,
  inputs,
});

/** `template.Scale`: out = k × 2, the 2 a Fit inside the body, `k` read by name. */
const SCALE: TemplateDefinition = {
  type: 'template.Scale',
  label: 'Scale',
  inputs: { k: { type: 'Number' } },
  output: { type: 'Number' },
  body: {
    nodes: {
      leaf: body('leaf', 'BodyInput', { input: 'k', slot: 0 }),
      two: body('two', 'Fit', { outMin: 2, outMax: 2 }),
      mul: body(
        'mul',
        'Math',
        { op: 'mul' },
        { a: { node: 'leaf', socket: 'out' }, b: { node: 'two', socket: 'out' } },
      ),
    },
    out: { node: 'mul', socket: 'out' },
  },
};

const node = (nodeId: string, nodeType: string, params: unknown = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const define = (def: TemplateDefinition = SCALE, id = 'tpl_scale', keep = false): Op =>
  node(id, TEMPLATE_DEFINITION_TYPE, { definition: def, keep });

/** The definition, and one instance of it with its body copied in by hand, `k` = 0.25. */
const INSTANCE_OPS: Op[] = [
  define(),
  node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
  node('i_leaf', 'BodyInput', { input: 'k' }),
  node('i_two', 'Fit', { outMin: 2, outMax: 2 }),
  node('i_mul', 'Math', { op: 'mul' }),
  wire('i_leaf', 'i_mul', 'a'),
  wire('i_two', 'i_mul', 'b'),
  node('inst', 'template.Scale'),
  wire('kfit', 'inst', 'k'),
  wire('i_mul', 'inst', 'body'),
];
const withInstance = () => apply(buildDefaultDagState(), INSTANCE_OPS);

describe('#1557 — the type a definition declares', () => {
  it('a socket and a named input per input, a body socket, and one output', () => {
    const def = templateNodeType(SCALE);
    expect(def.type).toBe('template.Scale');
    expect(def.inputs).toEqual({ k: { ...NUM, owns: 'always' }, body: { ...NUM, body: true } });
    expect(def.bodyInputs).toEqual({ k: NUM });
    expect(def.outputs).toEqual({ out: NUM });
    expect(def.stateful).toBeUndefined();
  });

  it('adding the definition node defines the type, so the same batch can add an instance', () => {
    const s = withInstance();
    expect(getNodeType('template.Scale')).toBeDefined();
    expect(evaluate(s, 'inst').value).toBe(0.5);
    expect(templatesOf(s).get('template.Scale')?.node).toBe('tpl_scale');
  });

  it('a second definition of one type is refused', () => {
    const s = apply(buildDefaultDagState(), [define()]);
    expect(() => applyOp(s, define(SCALE, 'tpl_other'))).toThrow(
      /"tpl_scale" already defines template.Scale; a template has one definition/,
    );
  });
});

describe('#1557 — what a definition may hold', () => {
  const refused = (def: unknown) => {
    const r = TemplateDefinitionSchema.safeParse(def);
    return r.success ? null : r.error.issues.map((i) => i.message).join(' | ');
  };
  it('takes a well-formed definition', () => {
    expect(refused(SCALE)).toBeNull();
  });
  it('refuses a type outside the template namespace, which could shadow a built-in', () => {
    expect(refused({ ...SCALE, type: 'Solver' })).toMatch(/template\.<Name>/);
  });
  it('refuses an input named after the body socket', () => {
    expect(refused({ ...SCALE, inputs: { body: { type: 'Number' } } })).toMatch(
      /"body" is the socket the body hangs from/,
    );
  });
  it("refuses a body whose output names no node of it, or a node whose id isn't its key", () => {
    expect(
      refused({ ...SCALE, body: { ...SCALE.body, out: { node: 'x', socket: 'out' } } }),
    ).toMatch(/names "x", which is not a node of the body/);
    const renamed = { ...SCALE.body.nodes.two, id: 'deux' };
    expect(
      refused({ ...SCALE, body: { ...SCALE.body, nodes: { ...SCALE.body.nodes, two: renamed } } }),
    ).toMatch(/id is its key \("two"\), not "deux"/);
  });
  it('refuses a body node that does not feed the output, and a wire to a node the body lacks', () => {
    const lone = body('lone', 'Fit', {});
    expect(
      refused({ ...SCALE, body: { ...SCALE.body, nodes: { ...SCALE.body.nodes, lone } } }),
    ).toMatch(/"lone" does not feed the body's output/);
    const stray = body('mul', 'Math', { op: 'mul' }, { a: { node: 'gone', socket: 'out' } });
    expect(
      refused({ ...SCALE, body: { ...SCALE.body, nodes: { ...SCALE.body.nodes, mul: stray } } }),
    ).toMatch(/"mul" reads "gone", which is not a node of the body/);
  });
});

describe('#1557 — the registered types follow the graph in the store', () => {
  it('a dispatch defines the type, an undo removes it, a redo brings it back', () => {
    const store = useDagStore.getState();
    store.hydrate(buildDefaultDagState());
    store.dispatchAtomic(INSTANCE_OPS, 'user', 'add');
    expect(evaluate(useDagStore.getState().state, 'inst').value).toBe(0.5);
    useDagStore.getState().undo();
    expect(getNodeType('template.Scale')).toBeUndefined();
    useDagStore.getState().redo();
    expect(evaluate(useDagStore.getState().state, 'inst').value).toBe(0.5);
  });

  it('loading another graph removes the types of the first', () => {
    useDagStore.getState().hydrate(withInstance());
    expect(getNodeType('template.Scale')).toBeDefined();
    useDagStore.getState().hydrate(buildDefaultDagState());
    expect(getNodeType('template.Scale')).toBeUndefined();
  });

  it('a change to the body alone defines nothing again, so no cache starts over', () => {
    syncTemplateTypes(withInstance());
    const epoch = registryEpoch();
    const two = { ...SCALE.body.nodes.two, params: { outMin: 3, outMax: 3 } };
    const bodyOnly = { ...SCALE, body: { ...SCALE.body, nodes: { ...SCALE.body.nodes, two } } };
    syncTemplateTypes(apply(buildDefaultDagState(), [define(bodyOnly)]));
    expect(registryEpoch()).toBe(epoch);
    syncTemplateTypes(apply(buildDefaultDagState(), [define({ ...SCALE, inputs: {} })]));
    expect(registryEpoch()).toBeGreaterThan(epoch);
  });
});

describe('#1557 — saved and read back', () => {
  it('reads back exactly as saved, without its types registered: loading is a plain read', async () => {
    const s = withInstance();
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state: s }));
    syncTemplateTypes({ nodes: {} });
    expect(getNodeType('template.Scale')).toBeUndefined();
    const loaded = await loadProject(storage, 'p');
    expect(loaded.state.nodes).toEqual(s.nodes);
    useDagStore.getState().hydrate(loaded.state);
    expect(evaluate(useDagStore.getState().state, 'inst').value).toBe(0.5);
  });

  it('a template no instance uses is not saved, unless it is kept', () => {
    const unused = apply(buildDefaultDagState(), [define()]);
    expect(withoutUnusedTemplates(unused).nodes.tpl_scale).toBeUndefined();
    expect(
      composeProject({ id: 'p', name: 'p', state: unused }).state.nodes.tpl_scale,
    ).toBeUndefined();
    const kept = apply(buildDefaultDagState(), [define(SCALE, 'tpl_scale', true)]);
    expect(withoutUnusedTemplates(kept)).toBe(kept);
    const used = withInstance();
    expect(withoutUnusedTemplates(used)).toBe(used);
  });

  it("a template's body steps up the node ladder like the graph's own nodes", () => {
    const old = body('ch', 'KeyframeChannelNumber', {
      name: 'v',
      target: 'x',
      paramPath: 'p',
      keyframes: [],
    });
    // A saved body node at an old version: the ladder, not the op's schema, is what moves it.
    const s = withInstance();
    const holder = s.nodes.tpl_scale;
    const params = holder.params as { definition: TemplateDefinition; keep: boolean };
    const raw: DagState = {
      ...s,
      nodes: {
        ...s.nodes,
        tpl_scale: {
          ...holder,
          params: {
            ...params,
            definition: {
              ...params.definition,
              body: {
                ...params.definition.body,
                nodes: { ...params.definition.body.nodes, ch: old },
              },
            },
          },
        },
      },
    };
    syncTemplateTypes({ nodes: {} });
    const migrated = migrateNodes(composeProject({ id: 'p', name: 'p', state: raw }));
    const def = (migrated.state.nodes.tpl_scale.params as { definition: TemplateDefinition })
      .definition;
    expect(def.body.nodes.ch.version).toBe(getNodeType('KeyframeChannelNumber')!.version);
    expect(def.body.nodes.ch.version).toBeGreaterThan(1);
    expect(def.body.nodes.ch.params).toHaveProperty('modifiers');
    expect(migrated.state.nodes.inst).toEqual(s.nodes.inst);
  });

  it('a .basher bundle carries its templates in its graph', () => {
    const s = withInstance();
    syncTemplateTypes({ nodes: {} });
    const project = composeProject({ id: 'p', name: 'p', state: s });
    const opened = bundleToProject(
      { formatVersion: project.formatVersion, id: 'p', name: 'p', state: project.state },
      'q',
      1,
    );
    expect(opened.state.nodes).toEqual(s.nodes);
  });
});
