// #1557 — a project's template library: stored beside the graph, read back as saved, and a set
// of node types while the project is open.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../dag';
import { evaluate } from '../dag/evaluator';
import { getNodeType, isDefinedNodeType, registryEpoch } from '../dag/registry';
import type { DagState } from '../dag/state';
import type { Node, Op } from '../dag/types';
import { registerAllNodes } from '../../nodes/registerAll';
import { bundleToProject } from '../../app/sceneBundle';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildDefaultDagState } from './default';
import { composeProject, loadProject, saveProject } from './io';
import {
  EMPTY_LIBRARY,
  LibrarySchema,
  syncLibraryTypes,
  templateNodeType,
  type Library,
  type TemplateDefinition,
} from './library';
import { migrateNodes, migrateProjectFormat } from './migrations';
import { PROJECT_FORMAT_VERSION, ProjectSchema } from './schema';
import { useProjectStore } from './store';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  syncLibraryTypes(EMPTY_LIBRARY);
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
const LIB: Library = { templates: [SCALE] };

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

/** A graph holding one instance of `template.Scale`, its body copied in by hand, `k` = 0.25. */
function withInstance(): DagState {
  return apply(buildDefaultDagState(), [
    node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
    node('i_leaf', 'BodyInput', { input: 'k' }),
    node('i_two', 'Fit', { outMin: 2, outMax: 2 }),
    node('i_mul', 'Math', { op: 'mul' }),
    wire('i_leaf', 'i_mul', 'a'),
    wire('i_two', 'i_mul', 'b'),
    node('inst', 'template.Scale'),
    wire('kfit', 'inst', 'k'),
    wire('i_mul', 'inst', 'body'),
  ]);
}

describe('#1557 — the type a definition declares', () => {
  it('a socket and a named input per input, a body socket, and one output', () => {
    const def = templateNodeType(SCALE);
    expect(def.type).toBe('template.Scale');
    expect(def.inputs).toEqual({ k: NUM, body: { ...NUM, body: true } });
    expect(def.bodyInputs).toEqual({ k: NUM });
    expect(def.outputs).toEqual({ out: NUM });
    expect(def.stateful).toBeUndefined();
  });

  it('an instance evaluates to its body, reading its own inputs by name', () => {
    syncLibraryTypes(LIB);
    const s = withInstance();
    expect(evaluate(s, 'inst').value).toBe(0.5);
  });
});

describe('#1557 — what a library may hold', () => {
  const refused = (lib: unknown) => {
    const r = LibrarySchema.safeParse(lib);
    return r.success ? null : r.error.issues.map((i) => i.message).join(' | ');
  };
  it('takes a well-formed definition', () => {
    expect(refused(LIB)).toBeNull();
  });
  it('refuses a type outside the template namespace, which could shadow a built-in', () => {
    expect(refused({ templates: [{ ...SCALE, type: 'Solver' }] })).toMatch(/template\.<Name>/);
  });
  it('refuses an input named after the body socket', () => {
    expect(refused({ templates: [{ ...SCALE, inputs: { body: { type: 'Number' } } }] })).toMatch(
      /"body" is the socket the body hangs from/,
    );
  });
  it("refuses a body whose output names no node of it, or a node whose id isn't its key", () => {
    expect(
      refused({
        templates: [{ ...SCALE, body: { ...SCALE.body, out: { node: 'x', socket: 'out' } } }],
      }),
    ).toMatch(/names "x", which is not a node of the body/);
    expect(
      refused({
        templates: [
          {
            ...SCALE,
            body: {
              ...SCALE.body,
              nodes: { ...SCALE.body.nodes, two: { ...SCALE.body.nodes.two, id: 'deux' } },
            },
          },
        ],
      }),
    ).toMatch(/id is its key \("two"\), not "deux"/);
  });
  it('refuses two definitions of one type', () => {
    expect(refused({ templates: [SCALE, SCALE] })).toMatch(/two templates define "template.Scale"/);
  });
});

describe('#1557 — saved, read back, opened', () => {
  it('a project saved before templates opens with an empty library', () => {
    const v22 = {
      ...composeProject({ id: 'p', name: 'p', state: buildDefaultDagState() }),
      formatVersion: 22,
    } as Record<string, unknown>;
    delete v22.library;
    const migrated = ProjectSchema.parse(migrateProjectFormat(v22));
    expect(migrated.formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(migrated.library).toEqual(EMPTY_LIBRARY);
  });

  it('reads back exactly as saved, without its types registered: loading is a plain read', async () => {
    syncLibraryTypes(LIB);
    const s = withInstance();
    const storage = new MemoryStorage();
    await saveProject(storage, composeProject({ id: 'p', name: 'p', state: s, library: LIB }));
    syncLibraryTypes(EMPTY_LIBRARY);
    expect(getNodeType('template.Scale')).toBeUndefined();
    const loaded = await loadProject(storage, 'p');
    expect(loaded.library).toEqual(LIB);
    expect(loaded.state.nodes).toEqual(s.nodes);
    expect(getNodeType('template.Scale')).toBeUndefined();
  });

  it('opening the project defines its templates; opening another removes them', () => {
    const store = useProjectStore.getState();
    store.setCurrent(
      composeProject({ id: 'a', name: 'a', state: buildDefaultDagState(), library: LIB }),
    );
    expect(isDefinedNodeType('template.Scale')).toBe(true);
    expect(evaluate(withInstance(), 'inst').value).toBe(0.5);
    store.setCurrent(composeProject({ id: 'b', name: 'b', state: buildDefaultDagState() }));
    expect(getNodeType('template.Scale')).toBeUndefined();
    store.setCurrent(null);
    expect(getNodeType('template.Scale')).toBeUndefined();
  });

  it('opening the same library again defines nothing again, so no cache starts over', () => {
    syncLibraryTypes(LIB);
    const epoch = registryEpoch();
    syncLibraryTypes(JSON.parse(JSON.stringify(LIB)) as Library);
    expect(registryEpoch()).toBe(epoch);
    syncLibraryTypes({ templates: [{ ...SCALE, label: 'Scaled' }] });
    expect(registryEpoch()).toBeGreaterThan(epoch);
  });

  it("a template's body steps up the node ladder like the graph's own nodes", () => {
    const old = body('ch', 'KeyframeChannelNumber', {
      name: 'v',
      target: 'x',
      paramPath: 'p',
      keyframes: [],
    });
    const lib: Library = {
      templates: [{ ...SCALE, body: { ...SCALE.body, nodes: { ...SCALE.body.nodes, ch: old } } }],
    };
    const project = composeProject({
      id: 'p',
      name: 'p',
      state: buildDefaultDagState(),
      library: lib,
    });
    const migrated = migrateNodes(project);
    const ch = migrated.library.templates[0].body.nodes.ch;
    expect(ch.version).toBe(getNodeType('KeyframeChannelNumber')!.version);
    expect(ch.version).toBeGreaterThan(1);
    expect(ch.params).toHaveProperty('modifiers');
  });

  it('a .basher bundle carries the library, and one written before templates has none', () => {
    const project = composeProject({
      id: 'p',
      name: 'p',
      state: withInstanceUnregistered(),
      library: LIB,
    });
    const bundle = {
      formatVersion: project.formatVersion,
      id: 'p',
      name: 'p',
      state: project.state,
    };
    expect(bundleToProject({ ...bundle, library: LIB }, 'q', 1).library).toEqual(LIB);
    const plain = composeProject({ id: 'p', name: 'p', state: buildDefaultDagState() });
    expect(
      bundleToProject({ formatVersion: 22, id: 'p', name: 'p', state: plain.state }, 'q', 1)
        .library,
    ).toEqual(EMPTY_LIBRARY);
  });
});

function withInstanceUnregistered(): DagState {
  syncLibraryTypes(LIB);
  const s = withInstance();
  syncLibraryTypes(EMPTY_LIBRARY);
  return s;
}
