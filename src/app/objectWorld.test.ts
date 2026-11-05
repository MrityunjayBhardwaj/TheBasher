// #1810 — a child takes its parent as an input, so its world transform is a value on a wire.
//
// The proof: for a nested hierarchy at several times, the `world` output of each object, in the
// graph wired the new way (each `children` edge turned into a parent input), equals what
// `resolveWorldTransform` gives for the same object in the graph wired today.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
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
import { resolveWorldTransform } from './resolveWorldTransform';
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
  const IN_GRP = { node: 'grp', socket: 'children' };
  s = makeSplitCube(s, { objectId: 'box', position: [0, 1, 2], connectTo: IN_GRP }).state;
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
    connectTo: IN_GRP,
  }).state;
  s = run(s, {
    type: 'addNode',
    nodeId: 'nul',
    nodeType: 'Null',
    params: { position: [0.5, 0.5, 0], rotation: [10, 0, 0] },
  });
  s = run(s, {
    type: 'connect',
    from: { node: 'nul', socket: 'out' },
    to: { node: 'holder', socket: 'children' },
  });
  s = makeSplitCamera(s, { objectId: 'cam', position: [0, 0, 4], connectTo: IN_GRP }).state;
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
  return s;
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

describe('#1810 — parenting has two sources until files are converted (#1824)', () => {
  it('the world follows the parent input, never the `children` wire', () => {
    // `box` still hangs in grp's children (as drawn today) and takes `top`'s world as its parent.
    let s = rig();
    s = run(s, {
      type: 'connect',
      from: { node: 'top', socket: 'world' },
      to: { node: 'box', socket: 'parent' },
    });
    const viaTop = worldOf(s, 'box', 1);
    const topWorld = worldOf(s, 'top', 1);
    const own = worldOf(rig(), 'box', 1); // no parent input: its own transform
    // world(box) = world(top) · own(box), whatever holds it in `children`.
    const product = multiply(topWorld, own);
    expect(diff(viaTop, product)).toBeLessThan(1e-12);
    // …and `resolveWorldTransform`, which reads the `children` wires, still says grp.
    expect(diff(viaTop, todayOf(s, 'box', 1))).toBeGreaterThan(0.1);
  });

  it('with no parent input, an object hung in `children` reads its own transform as its world', () => {
    const s = rig();
    const own = worldOf(s, 'box', 1);
    expect(diff(own, todayOf(s, 'box', 1))).toBeGreaterThan(0.1); // grp is not applied
    expect(own[12]).toBeCloseTo(1.5, 12); // the key, halfway from 0 to 3
  });

  it('wiring the same relation both ways is a loop, and connect refuses it', () => {
    const s = rig();
    expect(() =>
      run(s, {
        type: 'connect',
        from: { node: 'grp', socket: 'world' },
        to: { node: 'box', socket: 'parent' },
      }),
    ).toThrow('connect: would create a cycle (grp → box)');
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

/** Column-major 4×4 product a·b. */
function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
