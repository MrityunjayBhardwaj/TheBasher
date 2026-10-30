// #1729 — a world-transform read costs the depth of its node, not the size of its scene.
//
// The read used to search the scene from the top for its node, and at every node it passed it
// folded that node's channels with two scans of the whole node table: N nodes passed × N nodes
// scanned. Measured in the playback table (#1727) on the dev build, with a nested object selected:
// 2.9 ms per frame at 100 objects, 10.7 at 200, 49.2 at 400, 195.9 at 800.
//
// The instrument here is a count of reads of the node table: `state.nodes` is wrapped in a Proxy
// that counts every property get, so every scan, every lookup and every evaluate that touches a
// node is counted, whoever makes it. The scene index is built on the first read of a table and
// kept, so each count is taken on a second read at a new time — the per-frame case.
//
// The scene: N static objects at the top level, and a chain of D Groups holding the object read,
// the top Group keyed. The count must not move when N grows, and must grow with D.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { createEvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitSphere } from '../test-utils/splitSphere';
import { layeredChannelValues } from './layeredChannels';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';
import { sceneIndexOf } from './sceneIndex';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const at = (seconds: number) =>
  ({ time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } }) as never;
function run(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

const TARGET = 'deep';

/** `n` static top-level spheres, then Groups g0 ⊃ g1 ⊃ … ⊃ g(depth-1) ⊃ `deep`, g0 keyed. */
function scene(n: number, depth: number): DagState {
  let s = buildDefaultDagState();
  for (let i = 0; i < n; i++) {
    s = makeSplitSphere(s, {
      objectId: `s${i}`,
      position: [i, 0, 0],
      connectTo: { node: 'n_scene', socket: 'children' },
    }).state;
  }
  s = makeSplitSphere(s, { objectId: TARGET, position: [0, 0, 1] }).state;
  const ops: Op[] = [];
  for (let d = 0; d < depth; d++) {
    ops.push({
      type: 'addNode',
      nodeId: `g${d}`,
      nodeType: 'Group',
      params: { position: [1, 0, 0] },
    });
  }
  for (let d = 0; d < depth; d++) {
    const child = d + 1 < depth ? `g${d + 1}` : TARGET;
    ops.push({
      type: 'connect',
      from: { node: child, socket: 'out' },
      to: { node: `g${d}`, socket: 'children' },
    });
  }
  ops.push({
    type: 'connect',
    from: { node: 'g0', socket: 'out' },
    to: { node: 'n_scene', socket: 'children' },
  });
  ops.push({
    type: 'addNode',
    nodeId: 'g0_key',
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target: 'g0',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 2, value: [0, 4, 0], easing: 'linear' },
      ],
    },
  } as Op);
  return run(s, ops);
}

/** `state` with its node table wrapped so every read of a node is counted. */
function counted(state: DagState) {
  let reads = 0;
  const nodes = new Proxy(state.nodes, {
    get(target, key, receiver) {
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    state: { ...state, nodes } as DagState,
    reads: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

/** Node-table reads made by one read at a new time, after a first read built the index. */
function readsFor(n: number, depth: number, read: 'world' | 'parent'): number {
  const c = counted(scene(n, depth));
  const cache = createEvaluatorCache();
  const go = (s: number) =>
    read === 'world'
      ? resolveWorldTransform(c.state, TARGET, at(s), cache)
      : resolveParentWorldMatrix(c.state, TARGET, at(s), cache);
  expect(go(0.5), 'the first read finds the node').not.toBeNull();
  c.reset();
  expect(go(1), 'the measured read finds the node').not.toBeNull();
  return c.reads();
}

describe('#1729 — the world read costs the depth of its node, not the size of its scene', () => {
  for (const read of ['parent', 'world'] as const) {
    it(`${read}: the same number of node reads at 50 and at 400 static objects`, () => {
      const small = readsFor(50, 3, read);
      const large = readsFor(400, 3, read);
      console.log(`[#1729 ${read}] depth 3: ${small} node reads at N=50, ${large} at N=400`);
      expect(large).toBe(small);
    });

    it(`${read}: more node reads at depth 6 than at depth 2`, () => {
      const shallow = readsFor(100, 2, read);
      const deep = readsFor(100, 6, read);
      console.log(`[#1729 ${read}] N=100: ${shallow} node reads at depth 2, ${deep} at depth 6`);
      expect(deep).toBeGreaterThan(shallow);
    });
  }

  it('the read is right: deep sits under its keyed chain, at depth 3 and t = 1', () => {
    // g0 is keyed (0,0,0) → (0,4,0) over 2 s, so (0,2,0) at t = 1; g1 and g2 sit at (1,0,0) each.
    const s = scene(20, 3);
    const parent = resolveParentWorldMatrix(s, TARGET, at(1));
    expect(parent?.elements.slice(12, 15)).toEqual([2, 2, 0]);
    const world = resolveWorldTransform(s, TARGET, at(1));
    world!.position.forEach((v, i) => expect(v).toBeCloseTo([2, 2, 1][i], 9));
  });

  it('a node held by two Groups is read through the first in scene order, as the scene search does', () => {
    // g0 ⊃ g1 ⊃ deep, and also hx ⊃ deep with hx at (0,0,5) added after g0. The search from the
    // root meets g0's subtree first; the walk up cannot choose between two holders, so it hands the
    // read to that search. At t = 0 g0's key holds it at the origin and g1 sits at (1,0,0), so the
    // parent is at (1,0,0); through hx it would be (0,0,5).
    let s = scene(5, 2);
    s = run(s, [
      { type: 'addNode', nodeId: 'hx', nodeType: 'Group', params: { position: [0, 0, 5] } },
      {
        type: 'connect',
        from: { node: TARGET, socket: 'out' },
        to: { node: 'hx', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'hx', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ]);
    expect(sceneIndexOf(s.nodes).parentsOf(TARGET)).toEqual(['g1', 'hx']);
    const parent = resolveParentWorldMatrix(s, TARGET, at(0));
    expect(parent?.elements.slice(12, 15)).toEqual([1, 0, 0]);
  });

  it('a top-level node and a node nothing holds have no parent world', () => {
    const s = scene(5, 2);
    expect(resolveParentWorldMatrix(s, 's0', at(0))).toBeNull();
    expect(resolveParentWorldMatrix(s, `${TARGET}_data`, at(0))).toBeNull();
  });
});

describe('#1729 — the scene index hands each fold exactly what the whole table gives it', () => {
  it('channels, strips, tracks and actions: the fold is the same for every node', () => {
    let s = scene(4, 2);
    const ops: Op[] = [];
    // Two strips on two targets in two tracks, one muted, plus a soloed bare channel elsewhere.
    for (const [target, track, order] of [
      ['s0', 'trk_a', 0],
      ['g1', 'trk_b', 1],
    ] as const) {
      ops.push(
        {
          type: 'addNode',
          nodeId: `act_${target}`,
          nodeType: 'Action',
          params: {
            name: `act_${target}`,
            channels: [
              {
                valueType: 'vec3',
                paramPath: 'position',
                keyframes: [
                  { time: 0, value: [0, 0, 0] },
                  { time: 2, value: [3, 1, 0] },
                ],
              },
            ],
          },
        } as Op,
        {
          type: 'addNode',
          nodeId: `strip_${target}`,
          nodeType: 'Strip',
          params: { name: `strip_${target}`, action: `act_${target}`, target },
        } as Op,
        {
          type: 'addNode',
          nodeId: track,
          nodeType: 'Track',
          params: { name: track, strips: [`strip_${target}`, 'strip_s0'], order },
        } as Op,
      );
    }
    ops.push({
      type: 'addNode',
      nodeId: 's1_key',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: 's1',
        paramPath: 'position',
        solo: true,
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [1, 1, 1], easing: 'linear' },
        ],
      },
    } as Op);
    s = run(s, ops);
    const index = sceneIndexOf(s.nodes);
    const sample = (vs: ReturnType<typeof layeredChannelValues>) =>
      vs.map((v) => ({
        ...v,
        sample: [0, 0.7, 1.5].map((t) => v.sample(t)),
        influenceAt: undefined,
      }));
    let compared = 0;
    for (const id of Object.keys(s.nodes)) {
      const whole = layeredChannelValues(s.nodes, id);
      expect(sample(layeredChannelValues(index.layeredNodesFor(id), id)), id).toEqual(
        sample(whole),
      );
      compared += whole.length;
    }
    // The comparison saw folds with something in them: g0's key, s1's key, both strips.
    expect(compared).toBeGreaterThanOrEqual(4);
  });
});
