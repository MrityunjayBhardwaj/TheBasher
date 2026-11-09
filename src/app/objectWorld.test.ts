// #1810 — a child takes its parent as an input, so its world transform is a value on a wire.
//
// The proof: for a nested hierarchy at several times, the `world` output of each object, in the
// graph wired the new way (each `children` edge turned into a parent input), equals what
// `resolveWorldTransform` gives for the same object in the graph wired today.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { applyOps } from '../core/dag/ops';
import {
  __setEvalPerfHook,
  createEvaluatorCache,
  evaluate,
  type EvaluatorCache,
} from '../core/dag/evaluator';
import type { NodeRef } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCamera } from '../test-utils/splitCamera';
import { makeSplitCube } from '../test-utils/splitCube';
import { childEdges, resolveWorldTransform } from './resolveWorldTransform';
import { childIdsOf, parentIdOf } from './sceneHierarchy';
import { buildParentToOps } from './keepPlaceReparent';
import { sceneDrawOf } from './sceneMembership';
import type { SceneChild } from '../nodes/types';
import { useTransientEditStore } from './stores/transientEditStore';
import { clockedCtx } from './subjectClock';

beforeAll(() => registerAllNodes());
afterEach(() => {
  useTransientEditStore.getState().clearAll();
  __setEvalPerfHook(null);
});

const run = (s: DagState, op: object) => applyOp(s, op as never).next;
const keys = (a: unknown, b: unknown) => [
  { time: 0, value: a, easing: 'linear' },
  { time: 2, value: b, easing: 'linear' },
];
const SCENE = { node: 'n_scene', socket: 'children' };

/** `child` appended to `grp`'s `children` list, written into the node table as v27 wrote it. */
function inGrp(s: DagState, child: string): DagState {
  const grp = s.nodes.grp;
  const prior = (grp.inputs.children ?? []) as NodeRef[];
  return {
    ...s,
    nodes: {
      ...s.nodes,
      grp: {
        ...grp,
        inputs: { ...grp.inputs, children: [...prior, { node: child, socket: 'out' }] },
      },
    },
  };
}

/** A Group tilted and turned by a key, rotating about an off-centre pivot, holds a keyed cube, an
 *  Object that itself holds a Null, and a camera; a plain cube sits at the top level. */
function rig(): DagState {
  let s = buildDefaultDagState();
  s = run(s, {
    type: 'addNode',
    nodeId: 'grp',
    nodeType: 'Group',
    params: { position: [1, 2, 0], rotation: [40, 0, 25], pivot: [0.5, 0, -0.25] },
  });
  s = run(s, { type: 'connect', from: { node: 'grp', socket: 'out' }, to: SCENE });
  s = run(s, {
    type: 'addNode',
    nodeId: 'k_grp',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'rotation',
      target: 'grp',
      paramPath: 'rotation',
      keyframes: keys([40, 0, 25], [40, 90, 25]),
    },
  });
  // #1824 — the group's children wired into its list, as a v27 file holds them (`connect` now
  // refuses that wire), so `rewired` below has a wired graph to turn into parent inputs.
  s = inGrp(makeSplitCube(s, { objectId: 'box', position: [0, 1, 2] }).state, 'box');
  s = run(s, {
    type: 'addNode',
    nodeId: 'k_box',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'box',
      paramPath: 'position',
      keyframes: keys([0, 1, 2], [3, -1, 0]),
    },
  });
  s = makeSplitCube(s, {
    objectId: 'holder',
    position: [-1, 0, 1],
    rotation: [0, 30, 0],
    scale: [2, 1, 1],
  }).state;
  s = inGrp(s, 'holder');
  s = run(s, {
    type: 'addNode',
    nodeId: 'nul',
    nodeType: 'Null',
    params: { position: [0.5, 0.5, 0], rotation: [10, 0, 0] },
  });
  s = run(s, {
    type: 'connect',
    from: { node: 'holder', socket: 'world' },
    to: { node: 'nul', socket: 'parent' },
  });
  // #1823 — hung by its parent input, so the scene lists it: parenting is not membership.
  s = run(s, { type: 'connect', from: { node: 'nul', socket: 'out' }, to: SCENE });
  s = inGrp(makeSplitCamera(s, { objectId: 'cam', position: [0, 0, 4] }).state, 'cam');
  // A camera is drawn unscaled and turned by its own rotation, whatever its typed scale says.
  s = run(s, { type: 'setParam', nodeId: 'cam', paramPath: 'scale', value: [2, 3, 2] });
  s = run(s, { type: 'setParam', nodeId: 'cam', paramPath: 'rotation', value: [-15, 20, 0] });
  s = makeSplitCube(s, { objectId: 'top', position: [-2, 0, 1], connectTo: SCENE }).state;
  return s;
}

const OBJECTS = ['grp', 'box', 'holder', 'nul', 'cam', 'top'] as const;
const HOLDERS = ['grp', 'holder'] as const;

/** Today's graph wired the new way: each `children` edge of a holder becomes the holder's world
 *  into the child's parent input. The children leave the scene's reach; their worlds do not.
 *
 *  Every edge is cut before any parent wire is made. `connect` refuses a loop between NODES, and a
 *  holder can still depend on its child through another of its children (a skinned mesh reads the
 *  armature beside it), so wiring the parents edge by edge would be refused half way. */
function rewired(base: DagState, holders: readonly string[] = HOLDERS): DagState {
  let s = base;
  const edges = holders.flatMap((holder) =>
    ((s.nodes[holder].inputs.children ?? []) as NodeRef[]).map((kid) => ({ holder, kid })),
  );
  for (const { holder, kid } of edges)
    s = run(s, { type: 'disconnect', from: kid, to: { node: holder, socket: 'children' } });
  for (const { holder, kid } of edges)
    s = run(s, {
      type: 'connect',
      from: { node: holder, socket: 'world' },
      to: { node: kid.node, socket: 'parent' },
    });
  // #1823 — as the v28 conversion does: a child moved onto its parent input joins the scene's own
  // list, since a holder's wire carried it into the scene and a parent input does not.
  for (const op of membershipOf(
    s,
    edges.map((e) => e.kid.node),
  ))
    s = run(s, op);
  return s;
}

/** The connects that list each of `ids` in the scene's `children`, those not listed already. */
function membershipOf(s: DagState, ids: readonly string[]): object[] {
  const listed = new Set(((s.nodes.n_scene.inputs.children ?? []) as NodeRef[]).map((r) => r.node));
  return [...new Set(ids)]
    .filter((id) => !listed.has(id))
    .map((id) => ({ type: 'connect', from: { node: id, socket: 'out' }, to: SCENE }));
}

const worldOf = (s: DagState, id: string, t: number, cache?: EvaluatorCache) =>
  evaluate(s, id, { ctx: clockedCtx(t, t), socket: 'world', cache }).value as number[];
const todayOf = (s: DagState, id: string, t: number) => {
  const w = resolveWorldTransform(s, id, clockedCtx(t, t));
  if (!w) throw new Error(`no world today for ${id}`);
  return w.matrix;
};
const diff = (a: readonly number[], b: readonly number[]) =>
  a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

const TIMES = [0, 17 / 60, 1, 119 / 60];

describe('#1810 — the world on the wire is the world drawn today', () => {
  for (const t of TIMES)
    it(`every object at t=${t.toFixed(3)} s`, () => {
      const base = rig();
      const wired = rewired(base);
      for (const id of OBJECTS)
        expect(diff(worldOf(wired, id, t), todayOf(base, id, t)), id).toBeLessThan(1e-12);
    });

  it('a held edit on a nested object moves its world, as it moves the drawn one', () => {
    const base = rig();
    const wired = rewired(base);
    useTransientEditStore.getState().set('nul', 'position', [4, 4, 4]);
    expect(diff(worldOf(wired, 'nul', 1), todayOf(base, 'nul', 1))).toBeLessThan(1e-12);
    const held = worldOf(wired, 'nul', 1);
    useTransientEditStore.getState().clearAll();
    expect(diff(held, worldOf(wired, 'nul', 1))).toBeGreaterThan(0.1);
  });

  it('CONTROL: the parent wire is what carries the hierarchy, and the keys really move it', () => {
    const base = rig();
    const wired = rewired(base);
    const cut = run(wired, {
      type: 'disconnect',
      from: { node: 'holder', socket: 'world' },
      to: { node: 'nul', socket: 'parent' },
    });
    expect(diff(worldOf(cut, 'nul', 1), todayOf(base, 'nul', 1))).toBeGreaterThan(0.1);
    expect(diff(worldOf(wired, 'box', 0), worldOf(wired, 'box', 1))).toBeGreaterThan(0.1);
    expect(diff(worldOf(wired, 'nul', 0), worldOf(wired, 'nul', 1))).toBeGreaterThan(0.1);
  });
});

describe('#1810 — an object parented to a bone hangs from the bone on the wire too', () => {
  // The #1210 fixture: Blender 5.1.1 stands a prop parented to keyed `Bone1` at these origins.
  const BLENDER = [
    { seconds: 0, origin: [1.8, 2.35, -0.2] },
    { seconds: 0.5, origin: [0.97803, 2.26368, -0.2] },
    { seconds: 1, origin: [0.43033, 1.64473, -0.2] },
  ] as const;

  async function imported(): Promise<{ state: DagState; propId: string }> {
    const bytes = readFileSync('public/assets/skinned-bar-bone-prop.glb');
    let state = buildDefaultDagState();
    const result = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/skinned-bar-bone-prop.glb',
      sceneNodeId: state.outputs.scene!.node,
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    for (const op of result.ops) state = applyOp(state, op).next;
    const propId = Object.values(state.nodes).find((n) => n.meta?.name === 'Prop')!.id;
    return { state, propId };
  }

  it.each(BLENDER)('at $seconds s, equal to today and to Blender', async ({ seconds, origin }) => {
    const { state, propId } = await imported();
    const holders = Object.values(state.nodes)
      .filter(
        (n) =>
          n.type !== 'Scene' && ((n.inputs.children as NodeRef[] | undefined) ?? []).length > 0,
      )
      .map((n) => n.id);
    const wired = rewired(state, holders);
    const ctx = { time: { frame: seconds * 24, seconds, normalized: 0 } };
    const world = evaluate(wired, propId, { ctx, socket: 'world' }).value as number[];
    expect(diff(world, resolveWorldTransform(state, propId, ctx)!.matrix)).toBeLessThan(1e-12);
    world.slice(12, 15).forEach((c, k) => expect(c, `axis ${k}`).toBeCloseTo(origin[k], 4));
  });
});

describe('#1824 — a parent draws what hangs from it', () => {
  // The parent gathers every node whose parent input reads its world (`gathersChildren`), so the
  // graph wired the new way draws exactly what the graph wired today draws.
  const sceneOf = (s: DagState, t: number) =>
    evaluate(s, s.outputs.scene!.node, { ctx: clockedCtx(t, t) }).value;

  it('the scene evaluates to the same value, wired either way', () => {
    const base = rig();
    const wired = rewired(base);
    expect(wired.nodes.grp.inputs.children ?? []).toEqual([]);
    for (const t of [0, 1]) expect(sceneOf(wired, t)).toEqual(sceneOf(base, t));
  });

  it('the drawn world, the world on the wire and the tree agree, wired either way', () => {
    const base = rig();
    const wired = rewired(base);
    for (const t of TIMES)
      for (const id of OBJECTS) {
        expect(diff(todayOf(wired, id, t), todayOf(base, id, t)), id).toBeLessThan(1e-12);
        expect(diff(worldOf(wired, id, t), todayOf(wired, id, t)), id).toBeLessThan(1e-12);
      }
    for (const id of OBJECTS) {
      expect(childIdsOf(wired, id), id).toEqual(childIdsOf(base, id));
      expect(parentIdOf(wired, id), id).toBe(parentIdOf(base, id));
      const value = (s: DagState) => evaluate(s, id, { ctx: clockedCtx(1, 1) }).value as SceneChild;
      expect(
        childEdges(wired, id, value(wired)).map((e) => e.id),
        id,
      ).toEqual(childEdges(base, id, value(base)).map((e) => e.id));
    }
  });

  it('rewired in ONE batch, as the app dispatches it, the parent still gathers its children', () => {
    // A batch writes one copy of the node record in place, and `connect` indexes who hangs from
    // whom part way through it. Observed in the app: the index taken mid-batch was read back for
    // the finished graph, so the children drew nowhere.
    const base = rig();
    const edges = HOLDERS.flatMap((holder) =>
      ((base.nodes[holder].inputs.children ?? []) as NodeRef[]).map((kid) => ({ holder, kid })),
    );
    const { next } = applyOps(base, [
      ...edges.map(({ holder, kid }) => ({
        type: 'disconnect',
        from: kid,
        to: { node: holder, socket: 'children' },
      })),
      ...edges.map(({ holder, kid }) => ({
        type: 'connect',
        from: { node: holder, socket: 'world' },
        to: { node: kid.node, socket: 'parent' },
      })),
      ...membershipOf(
        base,
        edges.map((e) => e.kid.node),
      ),
    ] as never);
    expect(childIdsOf(next, 'grp')).toEqual(childIdsOf(base, 'grp'));
    expect(sceneOf(next, 1)).toEqual(sceneOf(base, 1));
  });

  // #1823 — cut from its parent, a member is no longer drawn under the group: it stands at the top
  // of the scene at its own transform (it used to vanish, when parenting was what listed it).
  it('CONTROL: without the gathering, a rewired child leaves its group for the top', () => {
    const wired = rewired(rig());
    const cut = run(wired, {
      type: 'disconnect',
      from: { node: 'grp', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    expect(childIdsOf(cut, 'grp')).not.toContain('box');
    expect(diff(todayOf(cut, 'box', 1), worldOf(cut, 'box', 1))).toBeLessThan(1e-12);
    expect(diff(todayOf(cut, 'box', 1), todayOf(wired, 'box', 1))).toBeGreaterThan(0.1);
    expect(sceneOf(cut, 1)).not.toEqual(sceneOf(wired, 1));
  });

  it('a moved child follows its new parent, and every reader says so', () => {
    let s = rewired(rig());
    s = run(s, {
      type: 'disconnect',
      from: { node: 'grp', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    // Cut loose, its world is its own transform: the factor the new parent multiplies.
    const own = worldOf(s, 'box', 1);
    s = run(s, {
      type: 'connect',
      from: { node: 'top', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    const product = multiply(worldOf(s, 'top', 1), own);
    expect(diff(worldOf(s, 'box', 1), product)).toBeLessThan(1e-12);
    expect(diff(todayOf(s, 'box', 1), product)).toBeLessThan(1e-12);
    expect(parentIdOf(s, 'box')).toBe('top');
  });

  // #1824 — an object can no longer hang in a `children` list: it names its parent through its
  // own parent input, and the list refuses the wire. Cut from its parent, it reads its own
  // transform as its world: the world output follows the parent input and nothing else.
  it('an object cannot hang in `children`; with no parent input it reads its own transform', () => {
    const cut = run(rewired(rig()), {
      type: 'disconnect',
      from: { node: 'grp', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    expect(() =>
      run(cut, {
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'grp', socket: 'children' },
      }),
    ).toThrow('connect: "box" names its parent through its own "parent" input');
    const own = worldOf(cut, 'box', 1);
    expect(diff(own, worldOf(rewired(rig()), 'box', 1))).toBeGreaterThan(0.1); // grp is not applied
    expect(own[12]).toBeCloseTo(1.5, 12); // the key, halfway from 0 to 3
  });

  it('a child has one parent: a parent input is refused while a children list holds it', () => {
    // #1824 — `connect` no longer writes such a list, but a converted file keeps a second list's
    // wire (the v28 conversion's "more than one parent" case), so the graph is written by hand.
    const cut = run(rewired(rig()), {
      type: 'disconnect',
      from: { node: 'grp', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    const listed: DagState = {
      ...cut,
      nodes: {
        ...cut.nodes,
        grp: {
          ...cut.nodes.grp,
          inputs: { ...cut.nodes.grp.inputs, children: [{ node: 'box', socket: 'out' }] },
        },
      },
    };
    expect(() =>
      run(listed, {
        type: 'connect',
        from: { node: 'top', socket: 'world' },
        to: { node: 'box', socket: 'parent' },
      }),
    ).toThrow(
      'connect: "box" already hangs from "grp" through its children list; a child has one parent',
    );
  });

  it('a child has one parent: a children list refuses a node that has a parent input', () => {
    const wired = rewired(rig());
    expect(() =>
      run(wired, {
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'holder', socket: 'children' },
      }),
    ).toThrow(
      'connect: "box" names its parent through its own "parent" input; connect "holder".world to "box".parent',
    );
  });

  it('a value that reads its own parent is a loop; a world read by a sibling is not', () => {
    const wired = rewired(rig());
    // grp gathers box, so box's value reading grp's value would read itself. #1824 — grp has a
    // parent input, so it cannot be wired into box's list at all; a Transform of grp (no parent
    // input) can, and closes the loop.
    expect(() =>
      run(wired, {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'box', socket: 'children' },
      }),
    ).toThrow('connect: "grp" names its parent through its own "parent" input');
    const wrapped = run(
      run(wired, { type: 'addNode', nodeId: 'xf', nodeType: 'Transform', params: {} }),
      {
        type: 'connect',
        from: { node: 'grp', socket: 'out' },
        to: { node: 'xf', socket: 'target' },
      },
    );
    expect(() =>
      run(wrapped, {
        type: 'connect',
        from: { node: 'xf', socket: 'out' },
        to: { node: 'box', socket: 'children' },
      }),
    ).toThrow('connect: would create a cycle');
    // A world is not a value: wiring one child's world into a sibling's parent input is fine.
    const moved = run(
      run(wired, {
        type: 'disconnect',
        from: { node: 'grp', socket: 'world' },
        to: { node: 'cam', socket: 'parent' },
      }),
      {
        type: 'connect',
        from: { node: 'box', socket: 'world' },
        to: { node: 'cam', socket: 'parent' },
      },
    );
    expect(parentIdOf(moved, 'cam')).toBe('box');
  });
});

describe('#1810 — cycles are refused by name', () => {
  it('connect refuses an object parented to its own descendant', () => {
    const wired = rewired(rig());
    expect(() =>
      run(wired, {
        type: 'connect',
        from: { node: 'nul', socket: 'world' },
        to: { node: 'grp', socket: 'parent' },
      }),
    ).toThrow('connect: would create a cycle (nul → grp)');
  });

  it('a parent loop written into the file throws, naming an object on it, and never hangs', () => {
    const wired = rewired(rig());
    const grp = wired.nodes.grp;
    const forged: DagState = {
      ...wired,
      nodes: {
        ...wired.nodes,
        grp: { ...grp, inputs: { ...grp.inputs, parent: { node: 'nul', socket: 'world' } } },
      },
    };
    expect(() => worldOf(forged, 'box', 0)).toThrow(/cycle detected at (grp|holder|nul)/);
  });
});

describe('#1810 — what the world costs and what re-cooks', () => {
  it("one object's world never evaluates the scene", () => {
    const wired = rewired(rig());
    let cooks = 0;
    __setEvalPerfHook(() => cooks++);
    worldOf(wired, 'nul', 1);
    // No node's value is cooked: each world is its own params folded with its own channels.
    expect(cooks).toBe(0);
  });

  it("the parent input never reaches the object's own value: a moving parent re-cooks no child", () => {
    const wired = rewired(rig());
    const cache = createEvaluatorCache();
    const misses = (t: number) => {
      let n = 0;
      __setEvalPerfHook((_ms, hit) => {
        if (!hit) n++;
      });
      evaluate(wired, 'nul', { ctx: clockedCtx(t, t), cache });
      __setEvalPerfHook(null);
      return n;
    };
    misses(0);
    // grp turns between these frames, and holder's world with it; nul's value does not move.
    expect([misses(0.5), misses(1)]).toEqual([0, 0]);
  });

  it('a key edit reaches the world through a shared cache (the key sees what the fold read)', () => {
    let wired = rewired(rig());
    const cache = createEvaluatorCache();
    // A consumer of the world, so a stale world would be served from the cache downstream.
    wired = run(wired, {
      type: 'addNode',
      nodeId: 'sep',
      nodeType: 'SeparateTransform',
      params: {},
    });
    wired = run(wired, {
      type: 'connect',
      from: { node: 'nul', socket: 'world' },
      to: { node: 'sep', socket: 'transform' },
    });
    const at = (s: DagState) =>
      evaluate(s, 'sep', { ctx: clockedCtx(1, 1), socket: 'translation', cache }).value as number[];
    const before = at(wired);
    const edited = run(wired, {
      type: 'setParam',
      nodeId: 'k_grp',
      paramPath: 'keyframes',
      value: keys([40, 0, 25], [40, 180, 25]),
    });
    const after = at(edited);
    const fresh = evaluate(edited, 'sep', { ctx: clockedCtx(1, 1), socket: 'translation' })
      .value as number[];
    expect(diff(after, fresh)).toBe(0);
    expect(diff(before, after)).toBeGreaterThan(0.1);
  });

  it('a still object keeps its downstream cached across frames; only what moves re-cooks', () => {
    let wired = rewired(rig());
    for (const id of ['top', 'box'])
      wired = run(wired, {
        type: 'addNode',
        nodeId: `sep_${id}`,
        nodeType: 'SeparateTransform',
        params: {},
      });
    for (const id of ['top', 'box'])
      wired = run(wired, {
        type: 'connect',
        from: { node: id, socket: 'world' },
        to: { node: `sep_${id}`, socket: 'transform' },
      });
    const cache = createEvaluatorCache();
    const cook = (id: string, t: number) => {
      let misses = 0;
      __setEvalPerfHook((_ms, hit) => {
        if (!hit) misses++;
      });
      evaluate(wired, `sep_${id}`, { ctx: clockedCtx(t, t), cache });
      __setEvalPerfHook(null);
      return misses;
    };
    cook('top', 0);
    cook('box', 0);
    // `top` has no keys: later frames hit. `box` is keyed: each new frame cooks its consumer.
    expect([cook('top', 0.5), cook('top', 1)]).toEqual([0, 0]);
    expect([cook('box', 0.5), cook('box', 1)]).toEqual([1, 1]);
  });
});

// #1838 — a wrapper takes its child by a wire and has no world output, so the parent input cannot
// carry what it does. The world reads through it, as `resolveWorldTransform` always has.
describe('an object a Transform holds', () => {
  const wrapped = (extra: (s: DagState) => DagState = (s) => s) => {
    let s = makeSplitCube(buildDefaultDagState(), { objectId: 'kid', position: [1, 0, 0] }).state;
    s = run(s, {
      type: 'addNode',
      nodeId: 'tf',
      nodeType: 'Transform',
      params: { position: [2, 0, 0], rotation: [0, 90, 0] },
    });
    s = run(s, {
      type: 'connect',
      from: { node: 'kid', socket: 'out' },
      to: { node: 'tf', socket: 'target' },
    });
    s = run(s, { type: 'connect', from: { node: 'tf', socket: 'out' }, to: SCENE });
    return extra(s);
  };
  const worldOf = (s: DagState, id: string, t = 0) =>
    evaluate(s, id, { socket: 'world', ctx: clockedCtx(t, t) }).value as number[];

  it('reads the world it is drawn in', () => {
    const s = wrapped();
    const drawn = resolveWorldTransform(s, 'kid', clockedCtx(0, 0))!.matrix;
    const world = worldOf(s, 'kid');
    // The Transform turned [1,0,0] by 90 degrees about Y and moved it to x=2: a real offset.
    expect(world[12]).toBeCloseTo(2, 5);
    expect(world[14]).toBeCloseTo(-1, 5);
    for (let i = 0; i < 16; i++) expect(world[i]).toBeCloseTo(drawn[i], 5);
  });

  it('moves with a key on the Transform', () => {
    const s = wrapped((g) =>
      run(g, {
        type: 'addNode',
        nodeId: 'tf_key',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: 'tf',
          paramPath: 'position',
          keyframes: keys([2, 0, 0], [2, 8, 0]),
        },
      }),
    );
    expect(worldOf(s, 'kid', 2)[13]).toBeCloseTo(8, 5);
  });

  it('adds nothing for an object no wrapper holds (control)', () => {
    const s = wrapped();
    const box = s.nodes.n_box.params as { position: number[] };
    expect(worldOf(s, 'n_box').slice(12, 15)).toEqual(box.position);
  });
});

// #1841 — the default camera is a member through the scene's `camera` socket alone. Hung from a
// group it has to be in the drawn tree, or the world output and the tree's readers disagree.
describe('a camera the scene holds only through its camera socket', () => {
  const ctx = clockedCtx(0, 0);
  const withGroup = () => {
    let s = run(buildDefaultDagState(), {
      type: 'addNode',
      nodeId: 'grp',
      nodeType: 'Group',
      params: { position: [5, 1, 0] },
    });
    s = run(s, { type: 'connect', from: { node: 'grp', socket: 'out' }, to: SCENE });
    return s;
  };
  const expectReadsAgree = (s: DagState) => {
    const world = evaluate(s, 'n_camera', { socket: 'world', ctx }).value as number[];
    expect(resolveWorldTransform(s, 'n_camera', ctx)!.position).toEqual(world.slice(12, 15));
    return world.slice(12, 15);
  };

  it('moves with a parent wired straight to it', () => {
    const s = run(withGroup(), {
      type: 'connect',
      from: { node: 'grp', socket: 'world' },
      to: { node: 'n_camera', socket: 'parent' },
    });
    expect(expectReadsAgree(s)).toEqual([8, 3, 3]);
  });

  it('moves with a parent given by Ctrl+P', () => {
    const made = buildParentToOps(withGroup(), ['n_camera'], 'grp', { keepTransform: false });
    if (!made.ok) throw new Error(made.reason);
    const s = applyOps(withGroup(), made.ops).next;
    expect(s.nodes.n_camera.inputs.parent).toEqual({ node: 'grp', socket: 'world' });
    expect(expectReadsAgree(s)).toEqual([8, 3, 3]);
  });

  it('stays out of the drawn tree with no parent (control)', () => {
    const s = withGroup();
    expect(sceneDrawOf(s as never)!.drawn.has('n_camera')).toBe(false);
    expect(expectReadsAgree(s)).toEqual([3, 2, 3]);
  });
});

/** Column-major 4×4 product a·b. */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
