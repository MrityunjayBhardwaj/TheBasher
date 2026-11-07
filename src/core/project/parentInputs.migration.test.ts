// #1824 — v27 → v28: a child names its parent. The gate: every node is drawn exactly where it was
// drawn before the step, at every time sampled, for every example project and for fixtures covering
// each case the step handles, and the tree has the same parent → child relations.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { buildDefaultDagState } from './default';
import { EXAMPLE_PROJECT_IDS, buildExampleProject } from './examples';
import {
  PARENT_INPUTS_FORMAT,
  migrateChildrenToParentInputs,
  migrateProjectFormat,
} from './migrations';
import { PROJECT_FORMAT_VERSION } from './schema';
import { hierarchyEdgesOf } from '../../app/sceneHierarchy';
import { isInScene } from '../../app/sceneMembership';
import { resolveWorldTransform } from '../../app/resolveWorldTransform';
import { worldParentOf } from '../dag/worldChildren';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** An op, or a step written straight into the node table: what `connect` now refuses (a child
 *  with a parent input wired into a group's list) is what a saved v27 file holds. */
type Step = object | ((s: DagState) => DagState);
const run = (s: DagState, ops: Step[]) => {
  for (const op of ops) s = typeof op === 'function' ? op(s) : applyOp(s, op as never).next;
  return s;
};
const migrate = (s: DagState): DagState => {
  const out = migrateChildrenToParentInputs({
    formatVersion: PARENT_INPUTS_FORMAT - 1,
    state: s,
  }) as {
    formatVersion: number;
    state: DagState;
  };
  expect(out.formatVersion).toBe(PARENT_INPUTS_FORMAT);
  return out.state;
};
const TIMES = [0, 0.5, 1, 2];
const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** Every node's world at every sampled time, and its scene membership, keyed by id. */
function drawn(s: DagState): Map<string, { worlds: number[][]; inScene: boolean }> {
  const out = new Map<string, { worlds: number[][]; inScene: boolean }>();
  for (const id of Object.keys(s.nodes)) {
    const worlds: number[][] = [];
    for (const t of TIMES) {
      let w: number[] | null = null;
      try {
        w = resolveWorldTransform(s, id, ctxAt(t))?.matrix ?? null;
      } catch {
        w = null;
      }
      if (w) worlds.push(w);
    }
    out.set(id, { worlds, inScene: isInScene(s, id) });
  }
  return out;
}

/** The tree as a set of "parent>child" strings, order aside. */
const edges = (s: DagState) => new Set(hierarchyEdgesOf(s).map((e) => `${e.parent}>${e.child}`));

function expectSameDrawing(before: DagState, after: DagState): number {
  const a = drawn(before);
  const b = drawn(after);
  let compared = 0;
  for (const [id, was] of a) {
    const now = b.get(id)!;
    expect(now.inScene, `${id} in scene`).toBe(was.inScene);
    expect(now.worlds.length, `${id} worlds`).toBe(was.worlds.length);
    was.worlds.forEach((m, k) =>
      m.forEach((v, i) => expect(now.worlds[k][i], `${id} @${TIMES[k]}s [${i}]`).toBeCloseTo(v, 6)),
    );
    compared += was.worlds.length;
  }
  expect(edges(after)).toEqual(edges(before));
  return compared;
}

const group = (id: string, holder: string): Step[] => [
  {
    type: 'addNode',
    nodeId: id,
    nodeType: 'Group',
    params: { position: [1, 2, 0], rotation: [0, 30, 10] },
  },
  into(id, holder),
];
const unscene = (id: string) => ({
  type: 'disconnect',
  from: { node: id, socket: 'out' },
  to: { node: 'n_scene', socket: 'children' },
});
/** `child` wired into `holder`'s `children` list, as v27 wrote it. */
function into(child: string, holder: string): Step {
  return (s: DagState): DagState => {
    const h = s.nodes[holder];
    const prior = h.inputs.children;
    const list = Array.isArray(prior) ? prior : prior ? [prior] : [];
    return {
      ...s,
      nodes: {
        ...s.nodes,
        [holder]: {
          ...h,
          inputs: { ...h.inputs, children: [...list, { node: child, socket: 'out' }] },
        },
      },
    };
  };
}

describe('v27 → v28: a child names its parent (#1824)', () => {
  it('the format is the conversion’s, one step on from v27', () => {
    expect(PROJECT_FORMAT_VERSION).toBeGreaterThanOrEqual(PARENT_INPUTS_FORMAT);
    const out = migrateProjectFormat({
      formatVersion: PARENT_INPUTS_FORMAT - 1,
      state: { nodes: {} },
    }) as {
      formatVersion: number;
    };
    expect(out.formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });

  it('an Object, a Group and a Null in a group move onto their parent input, drawn where they were', () => {
    let s = run(buildDefaultDagState(), [
      ...group('G', 'n_scene'),
      ...group('G2', 'G'),
      unscene('n_box'),
      into('n_box', 'G'),
      { type: 'addNode', nodeId: 'N', nodeType: 'Null', params: { position: [0, 0, 3] } },
      into('N', 'G2'),
      {
        type: 'addNode',
        nodeId: 'k',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'rotation',
          target: 'G',
          paramPath: 'rotation',
          keyframes: [
            { time: 0, value: [0, 30, 10], easing: 'linear' },
            { time: 2, value: [0, 210, 10], easing: 'linear' },
          ],
        },
      },
    ]);
    s = run(s, [{ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [2, 0, 1] }]);
    const after = migrate(s);
    expect(worldParentOf(after, 'G2')).toBe('G');
    expect(worldParentOf(after, 'n_box')).toBe('G');
    expect(worldParentOf(after, 'N')).toBe('G2');
    expect(after.nodes.G.inputs.children).toBeUndefined();
    expect(after.nodes.G2.inputs.children).toBeUndefined();
    // The top of the tree stays on the scene's list.
    expect(after.nodes.n_scene.inputs.children).toContainEqual({ node: 'G', socket: 'out' });
    expect(worldParentOf(after, 'G')).toBeNull();
    expect(expectSameDrawing(s, after)).toBeGreaterThan(0);
  });

  it('an Object holding an Object converts the same way', () => {
    const s = run(buildDefaultDagState(), [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [1, 1, 0] },
      { type: 'setParam', nodeId: 'n_box', paramPath: 'scale', value: [2, 1, 1] },
      { type: 'addNode', nodeId: 'N', nodeType: 'Null', params: { position: [0, 1, 0] } },
      into('N', 'n_box'),
    ]);
    const after = migrate(s);
    expect(worldParentOf(after, 'N')).toBe('n_box');
    expectSameDrawing(s, after);
  });

  it('a child that cannot take a parent input stays wired in the list', () => {
    const s = run(buildDefaultDagState(), [
      ...group('G', 'n_scene'),
      { type: 'addNode', nodeId: 'N', nodeType: 'Null', params: {} },
      into('N', 'G'),
      { type: 'addNode', nodeId: 'T', nodeType: 'Transform', params: {} },
      into('T', 'G'),
    ]);
    const after = migrate(s);
    expect(after.nodes.G.inputs.children).toEqual([{ node: 'T', socket: 'out' }]);
    expect(worldParentOf(after, 'N')).toBe('G');
    expectSameDrawing(s, after);
  });

  it('a node in two lists keeps its second wire, so it is still drawn in both places, and says so', () => {
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    const s = run(buildDefaultDagState(), [
      ...group('A', 'n_scene'),
      ...group('B', 'n_scene'),
      { type: 'addNode', nodeId: 'N', nodeType: 'Null', params: { position: [0, 1, 0] } },
      into('N', 'A'),
      into('N', 'B'),
    ]);
    const after = migrate(s);
    expect(worldParentOf(after, 'N')).toBe('A');
    expect(after.nodes.B.inputs.children).toEqual([{ node: 'N', socket: 'out' }]);
    expect(edges(after)).toEqual(edges(s));
    expect(warn.mock.calls.flat().join(' ')).toMatch(/more than one parent.*\bN\b/);
  });

  it('a child already reading another object’s world is re-pointed at the one that drew it, and says so', () => {
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    const s = run(buildDefaultDagState(), [
      ...group('A', 'n_scene'),
      ...group('B', 'n_scene'),
      { type: 'addNode', nodeId: 'N', nodeType: 'Null', params: {} },
      into('N', 'A'),
    ]);
    // Written as a saved v27 file could hold it: the parent input wired by hand to another object.
    const raw = {
      ...s,
      nodes: {
        ...s.nodes,
        N: { ...s.nodes.N, inputs: { parent: { node: 'B', socket: 'world' } } },
      },
    };
    const after = migrate(raw);
    expect(worldParentOf(after, 'N')).toBe('A');
    expect(after.nodes.A.inputs.children).toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toMatch(/now reads the one that drew them: N/);
  });

  it('is idempotent: a converted graph converts to itself', () => {
    const s = run(buildDefaultDagState(), [
      ...group('G', 'n_scene'),
      unscene('n_box'),
      into('n_box', 'G'),
    ]);
    const once = migrate(s);
    expect(migrate(once).nodes).toEqual(once.nodes);
  });

  it.each(EXAMPLE_PROJECT_IDS)('example "%s" is drawn the same before and after', async (id) => {
    const s = (await buildExampleProject(id)).state;
    expectSameDrawing(s, migrate(s));
  });
});
