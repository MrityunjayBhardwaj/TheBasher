import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useDagStore } from './store';
import { seedTestRegistry } from './__fixtures__/testNodes';
import { registerNodeType } from './registry';
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

  it('dispatchBatch produces per-op undo entries (one undo per op)', () => {
    const store = useDagStore.getState();
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'a', nodeType: 'TestNumber', params: { value: 1 } },
      { type: 'addNode', nodeId: 'b', nodeType: 'TestNumber', params: { value: 2 } },
    ];
    store.dispatchBatch(ops, 'macro', 'add two');
    expect(Object.keys(useDagStore.getState().state.nodes).sort()).toEqual(['a', 'b']);
    store.undo();
    store.undo();
    expect(useDagStore.getState().state.nodes).toEqual({});
  });

  it('dispatchAtomic groups ops into ONE undo entry', () => {
    const store = useDagStore.getState();
    const ops: Op[] = [
      { type: 'addNode', nodeId: 'a', nodeType: 'TestNumber', params: { value: 1 } },
      { type: 'addNode', nodeId: 'b', nodeType: 'TestNumber', params: { value: 2 } },
      { type: 'addNode', nodeId: 's', nodeType: 'TestSum', params: {} },
    ];
    store.dispatchAtomic(ops, 'macro', 'add three');
    expect(Object.keys(useDagStore.getState().state.nodes).sort()).toEqual(['a', 'b', 's']);
    expect(useDagStore.getState().undoStack.length).toBe(1);

    // ONE undo reverts the whole atomic group.
    store.undo();
    expect(useDagStore.getState().state.nodes).toEqual({});
    expect(useDagStore.getState().redoStack.length).toBe(1);

    // Redo restores all three.
    store.redo();
    expect(Object.keys(useDagStore.getState().state.nodes).sort()).toEqual(['a', 'b', 's']);
    expect(useDagStore.getState().redoStack.length).toBe(0);
  });

  it('dispatchAtomic undoes inverses in REVERSE order (so removeNode-after-disconnect works)', () => {
    const store = useDagStore.getState();
    // Build a→s; the atomic group disconnects then removes s. Forward order
    // matters: removeNode would fail if `s` still consumed `a`.
    store.dispatch({
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 5 },
    });
    store.dispatch({
      type: 'addNode',
      nodeId: 's',
      nodeType: 'TestSum',
      params: {},
    });
    store.dispatch({
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 's', socket: 'a' },
    });
    const sizeBefore = useDagStore.getState().undoStack.length;

    store.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: 'a', socket: 'out' },
          to: { node: 's', socket: 'a' },
        },
        { type: 'removeNode', nodeId: 's' },
      ],
      'user',
      'detach and remove',
    );
    expect(useDagStore.getState().state.nodes.s).toBeUndefined();
    expect(useDagStore.getState().undoStack.length).toBe(sizeBefore + 1);

    // Undo MUST replay [addNode s, then connect a→s] — reverse of forward.
    // If order were forward, addNode would run AFTER connect → connect's
    // inverse refers to a node that doesn't exist yet → throws.
    store.undo();
    expect(useDagStore.getState().state.nodes.s).toBeDefined();
    expect(useDagStore.getState().state.nodes.s.inputs.a).toEqual({
      node: 'a',
      socket: 'out',
    });
  });

  it('empty dispatchAtomic is a no-op', () => {
    const store = useDagStore.getState();
    store.dispatchAtomic([], 'user', 'nothing');
    expect(useDagStore.getState().undoStack.length).toBe(0);
  });

  it('an interaction coalesces N per-move dispatches into ONE undo entry (drag)', () => {
    const store = useDagStore.getState();
    store.dispatch({ type: 'addNode', nodeId: 'n', nodeType: 'TestNumber', params: { value: 0 } });
    const baseUndo = useDagStore.getState().undoStack.length; // 1
    const baseActivity = useDagStore.getState().activity.length;

    // A drag: begin → 3 per-move setParam (value 0 → 1 → 2 → 3) → end.
    store.beginInteraction();
    store.dispatch({ type: 'setParam', nodeId: 'n', paramPath: 'value', value: 1 });
    store.dispatch({ type: 'setParam', nodeId: 'n', paramPath: 'value', value: 2 });
    store.dispatch({ type: 'setParam', nodeId: 'n', paramPath: 'value', value: 3 });
    store.endInteraction('drag value');

    // State reflects the FINAL value; the whole drag is exactly ONE undo entry +
    // ONE activity line (not three).
    expect((useDagStore.getState().state.nodes.n.params as { value: number }).value).toBe(3);
    expect(useDagStore.getState().undoStack.length).toBe(baseUndo + 1);
    expect(useDagStore.getState().activity.length).toBe(baseActivity + 1);

    // ONE undo reverts the WHOLE drag back to the pre-drag value (0), not 3→2→1.
    store.undo();
    expect((useDagStore.getState().state.nodes.n.params as { value: number }).value).toBe(0);
    expect(useDagStore.getState().undoStack.length).toBe(baseUndo);

    // ONE redo restores the final value.
    store.redo();
    expect((useDagStore.getState().state.nodes.n.params as { value: number }).value).toBe(3);
  });

  it('an interaction buffers dispatchAtomic ops FLAT (one undo entry for the gesture)', () => {
    const store = useDagStore.getState();
    store.beginInteraction();
    store.dispatchAtomic(
      [{ type: 'addNode', nodeId: 'a', nodeType: 'TestNumber', params: { value: 1 } }],
      'user',
      'move a',
    );
    store.dispatchAtomic(
      [{ type: 'addNode', nodeId: 'b', nodeType: 'TestNumber', params: { value: 2 } }],
      'user',
      'move b',
    );
    store.endInteraction('drag');
    expect(useDagStore.getState().undoStack.length).toBe(1); // not 2 nested groups
    store.undo();
    expect(useDagStore.getState().state.nodes).toEqual({}); // both reverted in one undo
  });

  it('an interaction with no moves flushes nothing (a click is not an undo entry)', () => {
    const store = useDagStore.getState();
    store.beginInteraction();
    store.endInteraction('drag with no move');
    expect(useDagStore.getState().undoStack.length).toBe(0);
    expect(useDagStore.getState().activity.length).toBe(0);
  });

  it('rejects invalid op shape via zod (V7 spirit, P0 today)', () => {
    const store = useDagStore.getState();
    expect(() => store.dispatch({ type: 'nope', nodeId: 'x' } as unknown as Op)).toThrow();
  });
});

// #435 — the id-reference dangle guard (final-state form) at the commit chokepoint.
// A minimal node type that DECLARES a subject id-ref, registered on top of the test
// registry so the guard has something to consult (getNodeType reads `idRefs`).
function seedRefNode(): void {
  registerNodeType<{ target: string }, number>({
    type: 'TestRefNode',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ target: z.string().default('') }),
    inputs: {},
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: () => 0,
    idRefs: [{ path: 'target', shape: 'id', role: 'subject' }],
  });
}

describe('DagStore — #435 id-reference dangle guard', () => {
  beforeEach(() => {
    seedTestRegistry();
    seedRefNode();
    useDagStore.getState().reset();
  });

  function seedRefScene(): void {
    const store = useDagStore.getState();
    store.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'subject', nodeType: 'TestNumber', params: { value: 1 } },
        { type: 'addNode', nodeId: 'ref', nodeType: 'TestRefNode', params: { target: 'subject' } },
      ],
      'user',
      'seed',
    );
  }

  it('REJECTS a raw removeNode that leaves a referrer dangling — and does not mutate', () => {
    seedRefScene();
    const store = useDagStore.getState();
    const before = store.state.nodes;
    // The raw-dag.exec road: remove the referenced node with no sweep of the referrer.
    expect(() =>
      store.dispatchAtomic([{ type: 'removeNode', nodeId: 'subject' }], 'agent', 'raw'),
    ).toThrow(/still referencing removed node|referencing removed|referrer/i);
    // Throw came BEFORE set() — the store is untouched, subject still present.
    expect(useDagStore.getState().state.nodes).toBe(before);
    expect(useDagStore.getState().state.nodes.subject).toBeDefined();
  });

  it('ALLOWS remove + re-add of the SAME id in one batch (the Apply-Transform pattern)', () => {
    seedRefScene();
    const store = useDagStore.getState();
    // #412 id inheritance: the subject is removed and re-created under the same id, so the
    // referrer is momentarily dangling mid-batch yet whole once committed. A per-op guard
    // would (wrongly) reject this; the final-state guard accepts it.
    expect(() =>
      store.dispatchAtomic(
        [
          { type: 'removeNode', nodeId: 'subject' },
          { type: 'addNode', nodeId: 'subject', nodeType: 'TestNumber', params: { value: 2 } },
        ],
        'user',
        'rebake',
      ),
    ).not.toThrow();
    expect(useDagStore.getState().state.nodes.subject).toBeDefined();
    expect((useDagStore.getState().state.nodes.ref.params as { target: string }).target).toBe(
      'subject',
    );
  });

  it('guards the single-dispatch road too, not only dispatchAtomic', () => {
    seedRefScene();
    const store = useDagStore.getState();
    // Defense-in-depth: a bare removeNode via dispatch() (a road no production caller
    // uses today) is guarded by the same shared check, so a future caller can't reopen
    // the hole.
    expect(() => store.dispatch({ type: 'removeNode', nodeId: 'subject' }, 'agent')).toThrow(
      /referencing removed node|referrer/i,
    );
    expect(useDagStore.getState().state.nodes.subject).toBeDefined();
  });

  it('ALLOWS removing the referrer and its subject together', () => {
    seedRefScene();
    const store = useDagStore.getState();
    // Both gone → nothing survives pointing at a missing id → whole final state.
    expect(() =>
      store.dispatchAtomic(
        [
          { type: 'removeNode', nodeId: 'ref' },
          { type: 'removeNode', nodeId: 'subject' },
        ],
        'user',
        'delete both',
      ),
    ).not.toThrow();
    expect(useDagStore.getState().state.nodes.subject).toBeUndefined();
    expect(useDagStore.getState().state.nodes.ref).toBeUndefined();
  });
});
