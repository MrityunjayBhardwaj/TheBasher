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
import { ClosurePreservationError } from '../closure/expand';
import type { ClosureSpec } from '../closure/types';
import type { Op } from '../../core/dag/types';

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
      createFork(state, [{ type: 'setParam', nodeId: 'nonexistent', paramPath: 'x', value: 5 }]),
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
    useDiffStore
      .getState()
      .propose(
        state,
        [{ type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] }],
        'move box',
      );
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
    useDiffStore
      .getState()
      .propose(
        state,
        [{ type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] }],
        'move box',
      );
    rejectDiff();
    expect(useDiffStore.getState().status).toBe('rejected');
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('acceptSelectedOps feeds forward ops into the provided dispatcher', () => {
    const state = buildBaselineDag();
    const ops = [{ type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] }];
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
    useDiffStore
      .getState()
      .propose(
        state,
        [{ type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] }],
        'move box',
      );
    useDiffStore.getState().selectAll(false);
    expect(acceptSelectedOps(() => {})).toBe(false);
  });

  it('reset clears everything', () => {
    const state = buildBaselineDag();
    useDiffStore
      .getState()
      .propose(
        state,
        [{ type: 'setParam', nodeId: 'box', paramPath: 'position', value: [2, 0, 0] }],
        'move box',
      );
    useDiffStore.getState().reset();
    expect(useDiffStore.getState().status).toBe('idle');
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V13 closure-preservation gate (Wave A)
// ---------------------------------------------------------------------------

describe('useDiffStore.propose — closure-preservation gate', () => {
  function buildScene(): DagState {
    // Adds a sibling to the baseline so closure constraints have something
    // to reject against.
    let s = buildBaselineDag();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'sibling',
      nodeType: 'BoxMesh',
      params: { size: [1, 1, 1], position: [3, 0, 0], rotation: [0, 0, 0] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'sibling', socket: 'out' },
      to: { node: 'scene', socket: 'children' },
    }).next;
    return s;
  }

  it('omitting closureSpec keeps the gate vacuous (existing callers unchanged)', () => {
    const state = buildScene();
    // Without a spec the gate must NOT fire — preserves P0/P1/P2 callers
    // that pre-date Wave A.
    const ops: Op[] = [
      { type: 'setParam', nodeId: 'sibling', paramPath: 'position', value: [9, 0, 0] },
    ];
    const diff = useDiffStore.getState().propose(state, ops, 'edit sibling');
    expect(diff.closure).toBeUndefined();
    expect(useDiffStore.getState().status).toBe('pending');
  });

  it('closure spec rejects ops outside the closure with ClosurePreservationError', () => {
    const state = buildScene();
    // User has `box` selected → closure = {box, scene, render} via
    // parent ∘ children. `sibling` is outside.
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    const ops: Op[] = [
      { type: 'setParam', nodeId: 'sibling', paramPath: 'position', value: [9, 0, 0] },
    ];
    expect(() =>
      useDiffStore.getState().propose(state, ops, 'edit sibling', undefined, spec),
    ).toThrow(ClosurePreservationError);
  });

  it('rejection is pre-fork: store status stays idle, no pending diff', () => {
    const state = buildScene();
    const beforeStatus = useDiffStore.getState().status;
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    expect(() =>
      useDiffStore
        .getState()
        .propose(
          state,
          [{ type: 'setParam', nodeId: 'sibling', paramPath: 'position', value: [9, 0, 0] }],
          'oob',
          undefined,
          spec,
        ),
    ).toThrow(ClosurePreservationError);
    expect(useDiffStore.getState().status).toBe(beforeStatus);
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('in-closure ops pass and the closure is preserved on the PendingDiff', () => {
    const state = buildScene();
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    const ops: Op[] = [
      { type: 'setParam', nodeId: 'box', paramPath: 'rotation', value: [45, 0, 0] },
    ];
    const diff = useDiffStore.getState().propose(state, ops, 'rotate box', undefined, spec);
    expect(diff.closure).toBeDefined();
    expect(diff.closure!.nodes.has('box')).toBe(true);
    expect(diff.closure!.nodes.has('scene')).toBe(true);
  });

  it('fresh addNode of a new id is allowed even when closure is narrow', () => {
    const state = buildScene();
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'newCube',
        nodeType: 'BoxMesh',
        params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
      },
      // Wiring the new node into scene.children is fine: scene IS in
      // closure (box's parent), and connect's target is scene.
      {
        type: 'connect',
        from: { node: 'newCube', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
    ];
    const diff = useDiffStore.getState().propose(state, ops, 'add', undefined, spec);
    expect(diff.ops).toHaveLength(2);
  });

  it('subsequent ops referencing a freshly-introduced id are allowed', () => {
    const state = buildScene();
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: 'newCube',
        nodeType: 'BoxMesh',
        params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
      },
      // setParam on the freshly-added id — must pass the gate even though
      // newCube isn't in the original closure expansion.
      { type: 'setParam', nodeId: 'newCube', paramPath: 'rotation', value: [10, 0, 0] },
    ];
    const diff = useDiffStore.getState().propose(state, ops, 'add+rotate', undefined, spec);
    expect(diff.ops).toHaveLength(2);
  });

  it('closure rooted on a fresh-add id resolves via post-fork expansion (spawnWithProperties chain)', () => {
    // Live-smoke regression: spawn a sphere via mesh.add, then a Mutator
    // (e.g. setMaterialColor) authors a closure rooted on the FRESH id.
    // At propose time, the closure root doesn't exist in `state` yet —
    // it only exists in the post-fork. Pre-fix, expandClosure(spec, state)
    // returned an empty closure and the connect-to-scene op failed the
    // gate. Post-fix, expansion runs against the post-fork state.
    const state = buildScene();
    const newSphereId = 'newSphere';
    const ops: Op[] = [
      // mesh.add — spawn the sphere into scene.children.
      {
        type: 'addNode',
        nodeId: newSphereId,
        nodeType: 'SphereMesh',
        params: { radius: 1, position: [0, 0, 0] },
      },
      {
        type: 'connect',
        from: { node: newSphereId, socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      },
      // mutator.setMaterialColor — target the fresh id, closure roots on it.
      // The closure walker needs the connect-to-scene to be applied so the
      // parent walk from newSphereId reaches scene; otherwise scene is
      // outside closure and the connect op above would fail the gate.
      { type: 'setParam', nodeId: newSphereId, paramPath: 'material.color', value: '#ffc0cb' },
    ];
    const spec: ClosureSpec = {
      rootSelectors: [newSphereId],
      followedEdges: ['parent'],
    };
    const diff = useDiffStore.getState().propose(state, ops, 'spawn+color', undefined, spec);
    expect(diff.ops).toHaveLength(3);
    expect(diff.closure?.nodes.has(newSphereId)).toBe(true);
    expect(diff.closure?.nodes.has('scene')).toBe(true);
  });
});
