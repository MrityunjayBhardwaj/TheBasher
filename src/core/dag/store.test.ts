import { beforeEach, describe, expect, it } from 'vitest';
import { useDagStore } from './store';
import { seedTestRegistry } from './__fixtures__/testNodes';
import type { Op } from './types';

beforeEach(() => {
  seedTestRegistry();
  useDagStore.getState().reset();
});

describe('DagStore', () => {
  it('dispatch records the op in activity with source', () => {
    const store = useDagStore.getState();
    store.dispatch(
      { type: 'addNode', nodeId: 'n', nodeType: 'TestNumber', params: { value: 1 } },
      'agent',
      'demo',
    );
    const activity = useDagStore.getState().activity;
    expect(activity.length).toBe(1);
    expect(activity[0].source).toBe('agent');
    expect(activity[0].description).toBe('demo');
  });

  it('undo reverts state and pushes onto redo stack', () => {
    const store = useDagStore.getState();
    store.dispatch({
      type: 'addNode',
      nodeId: 'n',
      nodeType: 'TestNumber',
      params: { value: 1 },
    });
    expect(useDagStore.getState().state.nodes.n).toBeDefined();
    store.undo();
    expect(useDagStore.getState().state.nodes.n).toBeUndefined();
    expect(useDagStore.getState().redoStack.length).toBe(1);
  });

  it('redo reapplies the forward op', () => {
    const store = useDagStore.getState();
    store.dispatch({
      type: 'addNode',
      nodeId: 'n',
      nodeType: 'TestNumber',
      params: { value: 1 },
    });
    store.undo();
    store.redo();
    expect(useDagStore.getState().state.nodes.n).toBeDefined();
    expect(useDagStore.getState().redoStack.length).toBe(0);
  });

  it('new dispatch clears the redo stack', () => {
    const store = useDagStore.getState();
    store.dispatch({
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    });
    store.undo();
    expect(useDagStore.getState().redoStack.length).toBe(1);
    store.dispatch({
      type: 'addNode',
      nodeId: 'b',
      nodeType: 'TestNumber',
      params: { value: 2 },
    });
    expect(useDagStore.getState().redoStack.length).toBe(0);
  });

  it('dispatchBatch produces atomic undo (one undo reverts the whole batch)', () => {
    const store = useDagStore.getState();
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'a', nodeType: 'TestNumber', params: { value: 1 } },
      { type: 'addNode', nodeId: 'b', nodeType: 'TestNumber', params: { value: 2 } },
    ];
    store.dispatchBatch(ops, 'macro', 'add two');
    expect(Object.keys(useDagStore.getState().state.nodes).sort()).toEqual(['a', 'b']);
    // Per-op undo entries (atomic-as-batch is a Diff concern, P2.5).
    store.undo();
    store.undo();
    expect(useDagStore.getState().state.nodes).toEqual({});
  });

  it('rejects invalid op shape via zod (V7 spirit, P0 today)', () => {
    const store = useDagStore.getState();
    expect(() =>
      store.dispatch({ type: 'nope', nodeId: 'x' } as unknown as Op),
    ).toThrow();
  });
});
