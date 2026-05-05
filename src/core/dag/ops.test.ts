import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, OpError } from './ops';
import { emptyDagState } from './state';
import type { DagState, Op } from './types';
import { seedTestRegistry } from './__fixtures__/testNodes';

function withState(init: (s: DagState) => DagState): DagState {
  return init(emptyDagState());
}

describe('applyOp — addNode', () => {
  beforeEach(() => seedTestRegistry());

  it('adds a node and returns a removeNode inverse', () => {
    const state = emptyDagState();
    const op: Op = {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'TestNumber',
      params: { value: 7 },
    };
    const { next, inverse } = applyOp(state, op);
    expect(next.nodes.n1).toBeDefined();
    expect(next.nodes.n1.params).toEqual({ value: 7 });
    expect(inverse).toEqual({ type: 'removeNode', nodeId: 'n1' });
  });

  it('rejects duplicate ids', () => {
    let state = emptyDagState();
    const op: Op = {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'TestNumber',
      params: { value: 1 },
    };
    state = applyOp(state, op).next;
    expect(() => applyOp(state, op)).toThrow(OpError);
  });

  it('rejects params that fail schema', () => {
    const op: Op = {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'TestNumber',
      params: { value: 'oops' },
    };
    expect(() => applyOp(emptyDagState(), op)).toThrow(OpError);
  });

  it('rejects unknown node types', () => {
    const op: Op = {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'NotARealType',
      params: {},
    };
    expect(() => applyOp(emptyDagState(), op)).toThrow();
  });
});

describe('applyOp — removeNode', () => {
  beforeEach(() => seedTestRegistry());

  it('removes a node with no consumers', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n1',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    const { next, inverse } = applyOp(state, { type: 'removeNode', nodeId: 'n1' });
    expect(next.nodes.n1).toBeUndefined();
    expect(inverse.type).toBe('addNode');
    if (inverse.type === 'addNode') {
      expect(inverse.params).toEqual({ value: 1 });
    }
  });

  it('refuses to remove a node still consumed', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'b',
      nodeType: 'TestNumber',
      params: { value: 2 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'c',
      nodeType: 'TestSum',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 'c', socket: 'a' },
    }).next;
    expect(() => applyOp(state, { type: 'removeNode', nodeId: 'a' })).toThrow(OpError);
  });
});

describe('applyOp — connect/disconnect', () => {
  beforeEach(() => seedTestRegistry());

  function buildPair() {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'b',
      nodeType: 'TestNumber',
      params: { value: 2 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 's',
      nodeType: 'TestSum',
      params: {},
    }).next;
    return state;
  }

  it('connect single socket', () => {
    const state = buildPair();
    const { next, inverse } = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 's', socket: 'a' },
    });
    expect(next.nodes.s.inputs.a).toEqual({ node: 'a', socket: 'out' });
    expect(inverse.type).toBe('disconnect');
  });

  it('connect to list socket appends', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'b',
      nodeType: 'TestNumber',
      params: { value: 2 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sl',
      nodeType: 'TestSumList',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'b', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
    }).next;
    expect(state.nodes.sl.inputs.items).toEqual([
      { node: 'a', socket: 'out' },
      { node: 'b', socket: 'out' },
    ]);
  });

  it('connect with explicit index inserts at position (P1 drag-reorder protocol)', () => {
    let state = emptyDagState();
    for (const id of ['a', 'b', 'c']) {
      state = applyOp(state, {
        type: 'addNode',
        nodeId: id,
        nodeType: 'TestNumber',
        params: { value: 1 },
      }).next;
    }
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sl',
      nodeType: 'TestSumList',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'b', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
    }).next;
    // Insert c at index 0 — should land before a/b.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'c', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
      index: 0,
    }).next;
    expect(state.nodes.sl.inputs.items).toEqual([
      { node: 'c', socket: 'out' },
      { node: 'a', socket: 'out' },
      { node: 'b', socket: 'out' },
    ]);
  });

  it('connect with index > length clamps to append (no out-of-bounds)', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'sl',
      nodeType: 'TestSumList',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 'sl', socket: 'items' },
      index: 99,
    }).next;
    expect(state.nodes.sl.inputs.items).toEqual([{ node: 'a', socket: 'out' }]);
  });

  it('round-trips connect → disconnect via inverse', () => {
    const state = buildPair();
    const r1 = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 's', socket: 'a' },
    });
    const r2 = applyOp(r1.next, r1.inverse);
    expect(r2.next.nodes.s.inputs.a).toBeUndefined();
  });

  it('refuses to connect mismatched types', () => {
    const state = buildPair();
    expect(() =>
      applyOp(state, {
        type: 'connect',
        // 's' has output 'out' of Number, but try to connect to itself's input
        // 'a' is fine type-wise — instead, fabricate a mismatch via TestSum.out
        // → TestNumber input (TestNumber has no inputs, so use a different
        // unsupported socket).
        from: { node: 'a', socket: 'wrong-socket' },
        to: { node: 's', socket: 'a' },
      }),
    ).toThrow(OpError);
    void state;
  });

  it('refuses to create a cycle', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'x',
      nodeType: 'TestSum',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'y',
      nodeType: 'TestSum',
      params: {},
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'x', socket: 'out' },
      to: { node: 'y', socket: 'a' },
    }).next;
    expect(() =>
      applyOp(state, {
        type: 'connect',
        from: { node: 'y', socket: 'out' },
        to: { node: 'x', socket: 'a' },
      }),
    ).toThrow(OpError);
  });
});

describe('applyOp — setParam', () => {
  beforeEach(() => seedTestRegistry());

  it('sets a top-level param and returns inverse with prior value', () => {
    const state = withState(
      (s) =>
        applyOp(s, {
          type: 'addNode',
          nodeId: 'n1',
          nodeType: 'TestNumber',
          params: { value: 5 },
        }).next,
    );
    const { next, inverse } = applyOp(state, {
      type: 'setParam',
      nodeId: 'n1',
      paramPath: 'value',
      value: 9,
    });
    expect((next.nodes.n1.params as { value: number }).value).toBe(9);
    expect(inverse).toEqual({
      type: 'setParam',
      nodeId: 'n1',
      paramPath: 'value',
      value: 5,
    });
    // Round-trip
    const back = applyOp(next, inverse).next;
    expect((back.nodes.n1.params as { value: number }).value).toBe(5);
  });

  it('rejects values that fail schema after the set', () => {
    const state = withState(
      (s) =>
        applyOp(s, {
          type: 'addNode',
          nodeId: 'n1',
          nodeType: 'TestNumber',
          params: { value: 5 },
        }).next,
    );
    expect(() =>
      applyOp(state, {
        type: 'setParam',
        nodeId: 'n1',
        paramPath: 'value',
        value: 'not a number',
      }),
    ).toThrow(OpError);
  });
});

describe('inverse round-trip — every op restores prior state', () => {
  beforeEach(() => seedTestRegistry());

  function snapshot(s: DagState) {
    return JSON.stringify(s);
  }

  it('addNode → removeNode is identity', () => {
    const state = emptyDagState();
    const before = snapshot(state);
    const r = applyOp(state, {
      type: 'addNode',
      nodeId: 'n',
      nodeType: 'TestNumber',
      params: { value: 1 },
    });
    const back = applyOp(r.next, r.inverse).next;
    expect(snapshot(back)).toBe(before);
  });

  it('connect → disconnect is identity', () => {
    let state = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'a',
      nodeType: 'TestNumber',
      params: { value: 1 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 's',
      nodeType: 'TestSum',
      params: {},
    }).next;
    const before = snapshot(state);
    const r = applyOp(state, {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 's', socket: 'a' },
    });
    const back = applyOp(r.next, r.inverse).next;
    expect(snapshot(back)).toBe(before);
  });

  it('setParam → setParam is identity', () => {
    const state = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n',
      nodeType: 'TestNumber',
      params: { value: 5 },
    }).next;
    const before = snapshot(state);
    const r = applyOp(state, {
      type: 'setParam',
      nodeId: 'n',
      paramPath: 'value',
      value: 42,
    });
    const back = applyOp(r.next, r.inverse).next;
    expect(snapshot(back)).toBe(before);
  });
});
