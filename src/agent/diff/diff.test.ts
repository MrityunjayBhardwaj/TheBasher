// Tests for the forked DAG and diff store.
//
// The critical invariants:
//   1. Mutating the fork does NOT touch the real store (V1)
//   2. Accept feeds ops through dispatchAtomic (single undo entry, K3 step 7)
//   3. Reject discards the fork with zero state changes
//   4. Per-op toggle selects subsets
//
// REF: THESIS.md §19, krama K3, vyapti V7.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { createFork } from './forkedDag';
import { useDiffStore, acceptSelectedOps, rejectDiff } from './store';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useDiffStore.getState().reset();
});

function buildBaselineDag(): DagState {
  let state = emptyDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, near: 0.1, far: 1000, position: [3, 2, 3], lookAt: [0, 0, 0] },
  }).next;
  // Wire scene
  state = applyOp(state, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  state = {
    ...state,
    outputs: { ...state.outputs, scene: { node: 'scene', socket: 'out' } },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Forked DAG
// ---------------------------------------------------------------------------

describe('createFork', () => {
  it('returns identical fork + empty inverses for empty ops', () => {
    const state = buildBaselineDag();
    const { fork, inverseOps } = createFork(state, []);
    expect(fork.nodes).toEqual(state.nodes);
    expect(inverseOps).toHaveLength(0);
  });

  it('fork is isolated — mutating the fork does not affect the original', () => {
    const state = buildBaselineDag();
    const ops = [
      { type: 'setParam' as const, nodeId: 'box', paramPath: 'position', value: [5, 0, 0] },
    ];
    const { fork } = createFork(state, ops);
    // Original unchanged
    expect(state.nodes['box'].params).not.toEqual(fork.nodes['box'].params);
    // Fork has the new position
    expect((fork.nodes['box'].params as Record<string, unknown>).position).toEqual([5, 0, 0]);
    // Original still has the default position (not [5, 0, 0])
    expect((state.nodes['box'].params as Record<string, unknown>).position).toEqual([0, 0, 0]);
  });

  it('applies multiple ops sequentially', () => {
    const state = buildBaselineDag();
    const originalBoxCount = Object.keys(state.nodes).length;
    const ops = [
      {
        type: 'addNode' as const,
        nodeId: 'new_box',
        nodeType: 'BoxMesh',
        params: { size: [2, 2, 2], position: [1, 0, 0], rotation: [0, 0, 0] },
      },
      {
        type: 'connect' as const,
        from: { node: 'new_box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
    ];
    const { fork, inverseOps } = createFork(state, ops);
    expect(Object.keys(fork.nodes).length).toBe(originalBoxCount + 1);
    expect(inverseOps).toHaveLength(2);
    // Inverse of connect should be disconnect
    expect(inverseOps[1].inverse.type).toBe('disconnect');
  });

  it('throws on invalid op (nonexistent node)', () => {
    const state = buildBaselineDag();
    expect(() =>
      createFork(state, [
        { type: 'setParam', nodeId: 'nonexistent', paramPath: 'x', value: 5 },
      ]),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Diff store
// ---------------------------------------------------------------------------

describe('useDiffStore', () => {
  it('starts idle with no pending diff', () => {
    expect(useDiffStore.getState().status).toBe('idle');
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('propose creates a pending diff with all ops selected', () => {
    const state = buildBaselineDag();
    useDiffStore.getState().propose(state, [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
    ], 'move box');
    const store = useDiffStore.getState();
    expect(store.status).toBe('pending');
    expect(store.pendingDiff).not.toBeNull();
    expect(store.pendingDiff!.description).toBe('move box');
    expect(store.pendingDiff!.selected).toEqual([true]);
    expect(store.pendingDiff!.ops).toHaveLength(1);
  });

  it('toggleOp flips per-op selection', () => {
    const state = buildBaselineDag();
    const ops = [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
      { type: 'setParam', nodeId: 'box', paramPath: 'size', value: [3, 3, 3] },
    ];
    useDiffStore.getState().propose(state, ops, 'edit box');
    useDiffStore.getState().toggleOp(0);
    expect(useDiffStore.getState().pendingDiff!.selected).toEqual([false, true]);
  });

  it('selectAll sets all ops to the given value', () => {
    const state = buildBaselineDag();
    const ops = [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
      { type: 'setParam', nodeId: 'box', paramPath: 'size', value: [3, 3, 3] },
    ];
    useDiffStore.getState().propose(state, ops, 'edit box');
    useDiffStore.getState().selectAll(false);
    expect(useDiffStore.getState().pendingDiff!.selected).toEqual([false, false]);
  });

  it('getSelectedOps returns only selected ops', () => {
    const state = buildBaselineDag();
    const ops = [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
      { type: 'setParam', nodeId: 'box', paramPath: 'size', value: [3, 3, 3] },
    ];
    useDiffStore.getState().propose(state, ops, 'edit box');
    useDiffStore.getState().toggleOp(0); // deselect first
    const selected = useDiffStore.getState().getSelectedOps();
    expect(selected).not.toBeNull();
    expect(selected!.forward).toHaveLength(1);
    expect(selected!.forward[0].paramPath).toBe('size');
  });

  it('reject clears the diff and sets status to rejected', () => {
    const state = buildBaselineDag();
    useDiffStore.getState().propose(state, [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
    ], 'move box');
    rejectDiff();
    expect(useDiffStore.getState().status).toBe('rejected');
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('acceptSelectedOps feeds forward ops into the provided dispatcher', () => {
    const state = buildBaselineDag();
    const ops = [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
    ];
    useDiffStore.getState().propose(state, ops, 'move box');

    let dispatched: { ops: unknown[]; source: string; description?: string } | null = null;
    const mockDispatch = (forwardOps: unknown[], source: string, description?: string) => {
      dispatched = { ops: forwardOps, source, description };
    };

    expect(acceptSelectedOps(mockDispatch)).toBe(true);
    expect(dispatched).not.toBeNull();
    expect(dispatched!.ops).toHaveLength(1);
    expect(dispatched!.source).toBe('agent');
    expect(dispatched!.description).toBe('move box');
    expect(useDiffStore.getState().status).toBe('applied');
  });

  it('acceptSelectedOps returns false when nothing selected', () => {
    const state = buildBaselineDag();
    useDiffStore.getState().propose(state, [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
    ], 'move box');
    useDiffStore.getState().selectAll(false);
    expect(acceptSelectedOps(() => {})).toBe(false);
  });

  it('reset clears everything', () => {
    const state = buildBaselineDag();
    useDiffStore.getState().propose(state, [
      { type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] },
    ], 'move box');
    useDiffStore.getState().reset();
    expect(useDiffStore.getState().status).toBe('idle');
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });
});
