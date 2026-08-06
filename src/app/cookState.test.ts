// Gate for `foldOverlays` (#582, epic #575).
//
// WHAT THIS HAS TO PROVE, AND WHY THE OBVIOUS CASE IS THE WEAKEST ONE. "An animated param
// folds to its value at t" passes for a fold that rewrites every node on every frame —
// which is the version that was measured to cost 4.77 ms/frame. So the cases that carry the
// slice are the ones about what is NOT rebuilt: a static sibling keeping its params OBJECT
// (not merely an equal one), an unchanged value keeping last frame's object, and a scene
// with no overlays at all coming back by reference.
//
// Object identity is asserted with `toBe` throughout, deliberately. `toEqual` would pass on
// a fold that allocates fresh-but-equal params every frame — the exact defect these cases
// exist to catch, and one no value assertion at any tier can see.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { timeDependentNodes } from './timeDependence';
import { createFoldCache, foldOverlays } from './cookState';
import { useTransientEditStore } from './stores/transientEditStore';

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

/** A keyframe channel on `target.count`, `n` keys, value 3 at t=0 rising by 1 per second. */
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

const countOf = (s: { nodes: Record<string, { params: unknown }> }, id: string) =>
  (s.nodes[id].params as { count: number }).count;

describe('#582 — foldOverlays', () => {
  beforeAll(() => registerAllNodes());
  afterEach(() => {
    for (const edit of [...useTransientEditStore.getState().edits.values()])
      useTransientEditStore.getState().clearNode(edit.nodeId);
  });

  it('folds a keyframed param to its value AT t', () => {
    const s = scene(1, [channelOp('ch', 'arr0', 2)]);
    expect(countOf(s, 'arr0')).toBe(3); // authored, unmoved

    expect(countOf(foldOverlays(s, 0), 'arr0')).toBe(3);
    expect(countOf(foldOverlays(s, 1), 'arr0')).toBe(4);
    expect(countOf(foldOverlays(s, 0.5), 'arr0')).toBe(3.5);
  });

  it('folds a HELD EDIT, which no time-varying set names — the #474 shape', () => {
    // A transient is constant over t, so `timeDependentNodes` does not flag it. If the
    // fold consulted that set for correctness rather than for caching, this case would
    // silently return the authored value and the curve would never repaint.
    const s = scene(1);
    useTransientEditStore.getState().set('arr0', 'count', 9);

    expect(timeDependentNodes(s).has('arr0')).toBe(false); // the precondition, asserted
    expect(countOf(foldOverlays(s, 0, timeDependentNodes(s)), 'arr0')).toBe(9);
  });

  it('leaves an un-overlaid node holding its ORIGINAL params object', () => {
    const s = scene(3, [channelOp('ch', 'arr0', 2)]);
    const cooked = foldOverlays(s, 1);

    expect(countOf(cooked, 'arr0')).toBe(4); // this one moved
    // …and the other two chains are the same objects, so their memo entries survive.
    for (const id of ['box1', 'arr1', 'box2', 'arr2'])
      expect(cooked.nodes[id].params).toBe(s.nodes[id].params);
  });

  it('returns the state BY REFERENCE when no overlay exists anywhere', () => {
    const s = scene(3);
    expect(foldOverlays(s, 0)).toBe(s);
    expect(foldOverlays(s, 7.5)).toBe(s);
  });

  it('reuses last call’s params object when the folded value has not moved', () => {
    const s = scene(1, [channelOp('ch', 'arr0', 2)]);
    const fold = createFoldCache();

    const a = foldOverlays(s, 0.25, undefined, { fold });
    const b = foldOverlays(s, 0.25, undefined, { fold });
    expect(b.nodes.arr0.params).toBe(a.nodes.arr0.params);

    // A real move must NOT be papered over by the reuse.
    const c = foldOverlays(s, 0.75, undefined, { fold });
    expect(c.nodes.arr0.params).not.toBe(a.nodes.arr0.params);
    expect(countOf(c, 'arr0')).toBe(3.75);
  });

  it('an authored edit under a cached fold is picked up, not served stale', () => {
    // The cache keys on the authored params OBJECT precisely so an op landing underneath
    // invalidates it. Without that arm this returns 9 forever.
    const s = scene(1);
    useTransientEditStore.getState().set('arr0', 'offset', [5, 0, 0]);
    const fold = createFoldCache();
    const varying = timeDependentNodes(s);

    foldOverlays(s, 0, varying, { fold });
    const edited = applyOp(s, {
      type: 'setParam',
      nodeId: 'arr0',
      paramPath: 'count',
      value: 12,
    }).next;
    expect(countOf(foldOverlays(edited, 0, varying, { fold }), 'arr0')).toBe(12);
  });

  it('a SOUND time-varying set changes the work, never the values', () => {
    // The set is a cache input. Folding with the real set and folding with no claim at all
    // must agree at every playhead position — otherwise the set has quietly become a
    // filter on what gets folded, which is how a road goes stale without any test failing.
    const s = scene(3, [channelOp('ch', 'arr0', 3), channelOp('ch2', 'box1', 2)]);
    const varying = timeDependentNodes(s);

    for (const t of [0, 0.5, 1, 1.75, 2]) {
      const withSet = foldOverlays(s, t, varying, { fold: createFoldCache() });
      const withNone = foldOverlays(s, t, undefined, { fold: createFoldCache() });
      expect(withSet.nodes).toEqual(withNone.nodes);
    }
  });

  it('UNDER-naming the set freezes a value — the asymmetry, pinned', () => {
    // Not a wish: this is what makes the set TRUSTED rather than advisory, and it is why
    // `timeDependentNodes` over-approximating is the safe direction. A lying set (here,
    // empty while `arr0` genuinely varies) is served the frame-0 value forever.
    const s = scene(1, [channelOp('ch', 'arr0', 2)]);
    const fold = createFoldCache();
    const lying = new Set<string>();

    expect(countOf(foldOverlays(s, 0, lying, { fold }), 'arr0')).toBe(3);
    expect(countOf(foldOverlays(s, 1, lying, { fold }), 'arr0')).toBe(3); // frozen

    // The same scrub with the honest set follows the channel.
    const honest = timeDependentNodes(s);
    const fold2 = createFoldCache();
    expect(countOf(foldOverlays(s, 0, honest, { fold: fold2 }), 'arr0')).toBe(3);
    expect(countOf(foldOverlays(s, 1, honest, { fold: fold2 }), 'arr0')).toBe(4);
  });
});
