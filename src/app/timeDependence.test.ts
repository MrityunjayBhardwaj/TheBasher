// Gate for `timeDependentNodes` (#578, epic #575).
//
// THE ASSERTION THAT CARRIES THE SLICE IS THE NEGATIVE ONE. A flag that marks everything
// is exactly as useful as no flag, and it passes every "is the animated thing flagged?"
// test. So each case here names what must stay UNFLAGGED, and the mixed-scene case is the
// one to keep honest: a static sibling chain must survive an animated neighbour.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { timeDependentNodes } from './timeDependence';

/** `n` chains of BoxData → ArrayModifier, ids suffixed by index. */
function scene(chains: number, extra: Op[] = []): DagState {
  let state = emptyDagState();
  const ops: Op[] = [];
  for (let i = 0; i < chains; i++) {
    ops.push({
      type: 'addNode',
      nodeId: `box${i}`,
      nodeType: 'BoxData',
      params: { size: [1, 1, 1] },
    });
    ops.push({
      type: 'addNode',
      nodeId: `arr${i}`,
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0], muted: false },
    });
    ops.push({
      type: 'connect',
      from: { node: `box${i}`, socket: 'out' },
      to: { node: `arr${i}`, socket: 'target' },
    });
  }
  for (const op of [...ops, ...extra]) state = applyOp(state, op).next;
  return state;
}

/** A keyframe channel targeting `target`, with `n` keys. */
function channelOp(id: string, target: string, keys: number): Op {
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: 'KeyframeChannelNumber',
    params: {
      target,
      paramPath: 'count',
      keyframes: Array.from({ length: keys }, (_, k) => ({
        time: k,
        value: 3 + k,
        interpolation: 'linear',
      })),
    },
  };
}

describe('#578 — timeDependentNodes', () => {
  beforeAll(() => registerAllNodes());

  it('a fully static scene yields the EMPTY set', () => {
    expect([...timeDependentNodes(scene(3))]).toEqual([]);
  });

  it('MIXED SCENE: an animated chain flags itself + descendants, and siblings stay clean', () => {
    // Channel on box0 → box0 and its consumer arr0 are time-dependent. Chains 1 and 2 are
    // untouched, and THAT is the claim — a flag that marked them too would be worthless.
    const s = scene(3, [channelOp('ch', 'box0', 3)]);
    const flagged = timeDependentNodes(s);

    expect(flagged.has('box0')).toBe(true);
    expect(flagged.has('arr0')).toBe(true); // propagated downstream
    for (const id of ['box1', 'arr1', 'box2', 'arr2']) {
      expect(flagged.has(id), `${id} must stay unflagged`).toBe(false);
    }
    // The channel node itself is not flagged: its evaluate returns a sampler whose value
    // does not change per frame — the t-dependence lands on the TARGET.
    expect(flagged.has('ch')).toBe(false);
    expect(flagged.size).toBe(2);
  });

  it('propagation reaches beyond ONE hop (a 1-hop test passes without recursion)', () => {
    const s = scene(1, [
      { type: 'addNode', nodeId: 'arrB', nodeType: 'ArrayModifier', params: {} },
      { type: 'addNode', nodeId: 'arrC', nodeType: 'ArrayModifier', params: {} },
      {
        type: 'connect',
        from: { node: 'arr0', socket: 'out' },
        to: { node: 'arrB', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'arrB', socket: 'out' },
        to: { node: 'arrC', socket: 'target' },
      },
      channelOp('ch', 'box0', 2),
    ]);
    const flagged = timeDependentNodes(s);
    // box0 → arr0 → arrB → arrC : three hops from the seed.
    expect([...flagged].sort()).toEqual(['arr0', 'arrB', 'arrC', 'box0']);
  });

  it('EXCLUSION: a single-keyframe channel is CONSTANT and must not be flagged', () => {
    const one = timeDependentNodes(scene(1, [channelOp('ch', 'box0', 1)]));
    expect([...one]).toEqual([]);
    // Presence control in the same case: the identical setup with two keys DOES flag,
    // so the exclusion is about the key count and not about the fixture being inert.
    const two = timeDependentNodes(scene(1, [channelOp('ch', 'box0', 2)]));
    expect(two.has('box0')).toBe(true);
  });

  it('EXCLUSION: a ParamDriver is constant over t today and must not be flagged', () => {
    // If drivers ever gain a time-varying source this case reds, which is the point —
    // the decision gets revisited loudly rather than being silently wrong.
    const s = scene(1, [
      {
        type: 'addNode',
        nodeId: 'drv',
        nodeType: 'ParamDriver',
        params: { target: 'box0', paramPath: 'size.0' },
      },
    ]);
    expect([...timeDependentNodes(s)]).toEqual([]);
  });

  it('a TimeSource seeds itself and its consumers', () => {
    const s = scene(0, [{ type: 'addNode', nodeId: 'clock', nodeType: 'TimeSource', params: {} }]);
    expect(timeDependentNodes(s).has('clock')).toBe(true);
  });

  it('CALL COUNT: the walk visits each node ONCE, not once per incoming edge', () => {
    // A diamond: box0 → arr0, and a second consumer of box0 that also feeds arrB. arrB is
    // reachable by two paths, so a walk that expands per-edge visits it twice. Value
    // assertions cannot tell one traversal from a hundred — only a counter can.
    const s = scene(1, [
      { type: 'addNode', nodeId: 'arrX', nodeType: 'ArrayModifier', params: {} },
      { type: 'addNode', nodeId: 'arrB', nodeType: 'ArrayModifier', params: {} },
      {
        type: 'connect',
        from: { node: 'box0', socket: 'out' },
        to: { node: 'arrX', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'arr0', socket: 'out' },
        to: { node: 'arrB', socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: 'arrX', socket: 'out' },
        to: { node: 'arrB', socket: 'target' },
      },
      channelOp('ch', 'box0', 2),
    ]);

    const counters = { visits: 0 };
    const flagged = timeDependentNodes(s, counters);
    expect([...flagged].sort()).toEqual(['arr0', 'arrB', 'arrX', 'box0']);
    // Exactly one visit per flagged node — 4, not 5 (arrB has two incoming paths).
    expect(counters.visits).toBe(4);

    // The counter must be able to read ZERO, or a spy that silently failed to intercept
    // would pass the case above for the wrong reason.
    const empty = { visits: 0 };
    timeDependentNodes(scene(2), empty);
    expect(empty.visits).toBe(0);
  });
});
