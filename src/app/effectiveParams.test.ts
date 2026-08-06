// #524 — the gate the issue asks for: bind an overlay to a cook-consumed param and assert
// the COOKED output moved.
//
// ⚠️ WHY EVERY ASSERTION HERE READS THE GEOMETRY KEY AND NOT THE RESOLVER. The issue's own
// "done when" says it, and the reason is that the resolver is the side that already agreed
// while the bug was live: `resolveEvaluatedParam` reported the driven `count` as 9 for as
// long as the defect existed. A test written against it passes before and after the fix and
// proves nothing. The geometry key is the cook's own output — the thing that was stale.
//
// REF: src/app/effectiveParams.ts (the fold); src/core/dag/types.ts (`cookParams`);
//      src/app/effectiveParams.gate.test.ts (the totality gate + the seam census);
//      issue #524.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { useTransientEditStore } from './stores/transientEditStore';
import { effectiveDagState } from './effectiveParams';

const ctxAt = (seconds: number): EvalCtx => ({ time: { frame: 0, seconds, normalized: 0 } });

function withOps(...ops: Op[]): DagState {
  let state = buildDefaultDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** The cook's own output for a node, at a time — the side that was stale. */
function cookedGeometryKey(state: DagState, id: string, seconds: number): string | undefined {
  const effective = effectiveDagState(state, ctxAt(seconds));
  const value = evaluate(effective, id, { ctx: ctxAt(seconds) }).value as {
    geometry?: { key?: string };
  };
  return value?.geometry?.key;
}

const sizeChannel = (): Op =>
  ({
    type: 'addNode',
    nodeId: 'ch_size',
    nodeType: 'KeyframeChannelVec3',
    params: {
      target: 'n_box_data',
      paramPath: 'size',
      keyframes: [
        { time: 0, value: [1, 1, 1] },
        { time: 2, value: [5, 5, 5] },
      ],
    },
  }) as Op;

/** A box → ArrayModifier lane with `count` driven to a constant 9. */
function drivenArrayState(): DagState {
  return withOps(
    { type: 'addNode', nodeId: 'n_arr', nodeType: 'ArrayModifier', params: { count: 2 } } as Op,
    {
      type: 'connect',
      from: { node: 'n_box_data', socket: 'out' },
      to: { node: 'n_arr', socket: 'target' },
    } as Op,
    { type: 'addNode', nodeId: 'c_9', nodeType: 'Clamp', params: { min: 9, max: 9 } } as Op,
    {
      type: 'addNode',
      nodeId: 'd_c',
      nodeType: 'ParamDriver',
      params: { target: 'n_arr', paramPath: 'count', blendMode: 'replace', order: 0 },
    } as Op,
    {
      type: 'connect',
      from: { node: 'c_9', socket: 'out' },
      to: { node: 'd_c', socket: 'in' },
    } as Op,
  );
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useTransientEditStore.getState().clearAll();
});

describe('#524 — an overlay on a cook-consumed param reaches the cook', () => {
  it('animates the geometry a cube is BUILT from, not just the number in the panel', () => {
    const state = withOps(sizeChannel());

    // The pair is the assertion. Before the fix both of these read `box|1,1,1`, and the
    // second one is the whole bug: the channel was sampled, reported, and written onto a
    // field with no reader while the geometry stayed the size the raw param built.
    expect(cookedGeometryKey(state, 'n_box_data', 0)).toBe('box|1,1,1');
    expect(cookedGeometryKey(state, 'n_box_data', 2)).toBe('box|5,5,5');
  });

  it('animates a modifier — the issue’s own case, a driven ArrayModifier count', () => {
    const state = drivenArrayState();
    // 9, not the authored 2. The `|9|` is the driven count landing in the descriptor the
    // geometry is built from.
    expect(cookedGeometryKey(state, 'n_arr', 0)).toBe('array|box|1,1,1|9|2,0,0');
  });

  it('lets a HELD edit reach the cook too, which is the same seam and not a second one', () => {
    // A transient is not a graph node, so nothing in the DAG names the box as a target. If
    // the pre-filter only looked at node params this would silently keep the stale geometry
    // — the exact failure being fixed, one layer up.
    const state = buildDefaultDagState();
    expect(cookedGeometryKey(state, 'n_box_data', 0)).toBe('box|1,1,1');
    useTransientEditStore.getState().set('n_box_data', 'size', [3, 3, 3]);
    expect(cookedGeometryKey(state, 'n_box_data', 0)).toBe('box|3,3,3');
  });

  it('leaves an un-overlaid graph alone, BY IDENTITY', () => {
    // Not cosmetic. The evaluator memoises its params hash on the params object identity, so
    // a fresh object per node per frame would turn an O(changed) walk into O(scene) — a
    // silent performance defect in place of a silent behavioural one.
    const state = buildDefaultDagState();
    expect(effectiveDagState(state, ctxAt(0))).toBe(state);
  });

  it('keeps every UNTOUCHED node’s identity when one node is overlaid', () => {
    const state = withOps(sizeChannel());
    const effective = effectiveDagState(state, ctxAt(2));
    expect(effective).not.toBe(state); // the box did change
    expect(effective.nodes['n_box_data']).not.toBe(state.nodes['n_box_data']);
    for (const id of Object.keys(state.nodes)) {
      if (id === 'n_box_data') continue;
      expect(effective.nodes[id], `${id} was rebuilt though nothing overlays it`).toBe(
        state.nodes[id],
      );
    }
  });
});
