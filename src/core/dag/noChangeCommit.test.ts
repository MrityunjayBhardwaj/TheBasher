// #1189 — a write that changes nothing commits nothing.
//
// Everything that decides "the project changed" keys on the state REFERENCE: the undo
// push here, the unsaved flag and autosave in boot.ts. So the contract under test is one
// sentence — an op that changed nothing hands back the SAME state object, and the store
// then records it in the activity log and nowhere else.
//
// Each case is paired with a real edit through the same road (the control), so a store
// that simply stopped committing anything would fail here too.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from './ops';
import { emptyDagState, type DagState } from './state';
import { useDagStore } from './store';
import type { Op } from './types';
import { registerAllNodes } from '../../nodes/registerAll';
import { makeSplitCube } from '../../test-utils/splitCube';

function cube(): DagState {
  return makeSplitCube(emptyDagState(), { objectId: 'n_box', size: [1, 1, 1] }).state;
}

const REAL: Op = { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [2, 2, 2] };

/** Every shape of "changed nothing" the live measurement found, one row each. */
const NO_CHANGE: [string, Op][] = [
  [
    'a data param aimed at the Object',
    { type: 'setParam', nodeId: 'n_box', paramPath: 'size', value: [2, 2, 2] },
  ],
  [
    'a param neither half owns',
    { type: 'setParam', nodeId: 'n_box', paramPath: 'siez', value: [2, 2, 2] },
  ],
  [
    'a wrong leaf under an owned root',
    { type: 'setParam', nodeId: 'n_box_data', paramPath: 'material.nonexistent', value: 1 },
  ],
  [
    'the value it already has',
    { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [1, 1, 1] },
  ],
];

beforeEach(() => {
  registerAllNodes();
  useDagStore.getState().hydrate(cube());
});

describe('#1189 — applyOp: nothing changed ⇒ the same state object', () => {
  it('control: a real edit returns a new state', () => {
    const s = cube();
    expect(applyOp(s, REAL).next).not.toBe(s);
  });

  it.each(NO_CHANGE)('%s returns the same state', (_label, op) => {
    const s = cube();
    const r = applyOp(s, op);
    expect(r.next).toBe(s);
    // Still answered in full: the inverse exists for a caller holding it.
    expect(r.inverse.type).toBe('setParam');
  });

  it('a refused write keeps its flag — the refusal stays visible', () => {
    const r = applyOp(cube(), NO_CHANGE[0][1]);
    expect(r.reportable?.badge).toBe('stripped-write');
  });
});

describe('#1189 — the store commits nothing for an op that changed nothing', () => {
  const store = () => useDagStore.getState();

  it('control: dispatch of a real edit sets state and pushes one undo step', () => {
    const before = store().state;
    store().dispatch(REAL);
    expect(store().state).not.toBe(before);
    expect(store().undoStack).toHaveLength(1);
  });

  it.each(NO_CHANGE)('dispatch: %s — same state, no undo, activity kept', (_label, op) => {
    const before = store().state;
    store().dispatch(op);
    expect(store().state).toBe(before);
    expect(store().undoStack).toHaveLength(0);
    expect(store().activity).toHaveLength(1);
  });

  it('dispatch keeps the refusal on the activity entry', () => {
    store().dispatch(NO_CHANGE[0][1]);
    expect(store().activity[0].reportable?.badge).toBe('stripped-write');
  });

  it('dispatchAtomic: all no-ops → no undo group and the same state; activity per op', () => {
    const before = store().state;
    const ops = NO_CHANGE.map(([, op]) => op);
    const out = store().dispatchAtomic(ops);
    expect(out).toHaveLength(ops.length); // still index-aligned for the caller
    expect(store().state).toBe(before);
    expect(store().undoStack).toHaveLength(0);
    expect(store().activity).toHaveLength(ops.length);
  });

  it('dispatchAtomic: a real edit among no-ops → one group holding ONLY the edit', () => {
    // Both no-ops are REFUSED writes, which change nothing whatever came before. (A
    // same-value write placed after REAL would be a real change back — order matters.)
    store().dispatchAtomic([NO_CHANGE[0][1], REAL, NO_CHANGE[1][1]]);
    expect(store().undoStack).toHaveLength(1);
    const group = store().undoStack[0] as { entries: { forward: Op }[] };
    expect(group.entries.map((e) => e.forward)).toEqual([REAL]);
    // ...and undoing it restores the cube exactly.
    store().undo();
    expect((store().state.nodes.n_box_data.params as { size: number[] }).size).toEqual([1, 1, 1]);
  });

  it('dispatchBatch: all no-ops → no undo steps; a real edit → exactly one', () => {
    const before = store().state;
    store().dispatchBatch([NO_CHANGE[1][1], NO_CHANGE[3][1]]);
    expect(store().state).toBe(before);
    expect(store().undoStack).toHaveLength(0);
    store().dispatchBatch([NO_CHANGE[1][1], REAL]);
    expect(store().undoStack).toHaveLength(1);
  });

  it('a drag that only re-writes the same value leaves no undo step', () => {
    store().beginInteraction();
    store().dispatch(NO_CHANGE[3][1]);
    store().dispatch(NO_CHANGE[3][1]);
    store().endInteraction('drag');
    expect(store().undoStack).toHaveLength(0);
    // Control: a drag that moves something is still one step.
    store().beginInteraction();
    store().dispatch(REAL);
    store().endInteraction('drag');
    expect(store().undoStack).toHaveLength(1);
  });
});

// #1191 — the same contract for every other op that can be asked to change nothing. The
// census covered all nine `apply*`: addNode, removeNode, disconnect and removeSpareParam
// either change something or throw, so these four are the whole set.
//
// Each op gets its own controls, and the ones that matter most are the NEAR MISSES: a
// write that looks like a repeat but is not — a rename that keeps the name and drops a
// link, a spare param that keeps its value and changes its promotion, a list socket that
// grows.
// A guard keyed on the written field alone would call those no-ops and drop a real edit.

const DATA_EDGE: Op = {
  type: 'connect',
  from: { node: 'n_box_data', socket: 'out' },
  to: { node: 'n_box', socket: 'data' },
};
const SPARE: Op = {
  type: 'setSpareParam',
  nodeId: 'n_box',
  key: 'k',
  param: { type: 'float', value: 1 },
};
const withScene = (s: DagState): DagState =>
  applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
const childEdge: Op = {
  type: 'connect',
  from: { node: 'n_box', socket: 'out' },
  to: { node: 'scene', socket: 'children' },
};
/** Run `setup` through the op layer, so the starting state is one the product can reach. */
const after = (setup: Op[], s: DagState = cube()): DagState =>
  setup.reduce((acc, op) => applyOp(acc, op).next, s);

/** [label, starting state, op] — each must hand back the state it was given. */
const NO_CHANGE_1191: [string, () => DagState, Op][] = [
  ['connect: the producer a single socket already holds', () => cube(), DATA_EDGE],
  [
    'setMeta: the name it already has',
    () => after([{ type: 'setMeta', nodeId: 'n_box', name: 'Cube' }]),
    { type: 'setMeta', nodeId: 'n_box', name: 'Cube' },
  ],
  [
    'setMeta: clear a name that was never set',
    () => cube(),
    { type: 'setMeta', nodeId: 'n_box', name: undefined },
  ],
  [
    'setMeta: the link it already follows',
    () => after([{ type: 'setMeta', nodeId: 'n_box', name: 'Box', nameFrom: 'n_box_data' }]),
    { type: 'setMeta', nodeId: 'n_box', name: 'Box', nameFrom: 'n_box_data' },
  ],
  [
    'setHidden: false on a visible node',
    () => cube(),
    { type: 'setHidden', nodeId: 'n_box', hidden: false },
  ],
  [
    'setHidden: true on a hidden node',
    () => after([{ type: 'setHidden', nodeId: 'n_box', hidden: true }]),
    { type: 'setHidden', nodeId: 'n_box', hidden: true },
  ],
  [
    'setHidden: false over a stored `hidden: false` key (left as it is)',
    () => {
      const s = cube();
      return { ...s, nodes: { ...s.nodes, n_box: { ...s.nodes.n_box, meta: { hidden: false } } } };
    },
    { type: 'setHidden', nodeId: 'n_box', hidden: false },
  ],
  ['setSpareParam: the value it already holds', () => after([SPARE]), SPARE],
];

/** [label, starting state, op] — each LOOKS like a repeat and is a real change. */
const NEAR_MISS_1191: [string, () => DagState, Op][] = [
  [
    'connect: a single socket held by ANOTHER producer (displaced)',
    () =>
      applyOp(cube(), {
        type: 'addNode',
        nodeId: 'n_other_data',
        nodeType: 'BoxData',
        params: { size: [3, 3, 3] },
      }).next,
    { ...DATA_EDGE, from: { node: 'n_other_data', socket: 'out' } } as Op,
  ],
  [
    'connect: a list socket grows even for a producer it holds',
    () => after([childEdge], withScene(cube())),
    childEdge,
  ],
  [
    'setMeta: same name, the link dropped',
    () => after([{ type: 'setMeta', nodeId: 'n_box', name: 'Box', nameFrom: 'n_box_data' }]),
    { type: 'setMeta', nodeId: 'n_box', name: 'Box' },
  ],
  [
    'setSpareParam: same value, now promoted',
    () => after([SPARE]),
    {
      type: 'setSpareParam',
      nodeId: 'n_box',
      key: 'k',
      param: { type: 'float', value: 1, promoted: true },
    },
  ],
];

/** Plain real edits, one per op. */
const REAL_1191: [string, () => DagState, Op][] = [
  ['connect: a new producer on an empty socket', () => withScene(cube()), childEdge],
  ['setMeta: a new name', () => cube(), { type: 'setMeta', nodeId: 'n_box', name: 'Zed' }],
  [
    'setHidden: hide a visible node',
    () => cube(),
    { type: 'setHidden', nodeId: 'n_box', hidden: true },
  ],
  [
    'setSpareParam: a new value',
    () => after([SPARE]),
    { ...SPARE, param: { type: 'float', value: 2 } } as Op,
  ],
];

describe('#1191 — connect / setMeta / setHidden / setSpareParam: nothing changed ⇒ the same state', () => {
  it.each(NO_CHANGE_1191)('%s', (_label, start, op) => {
    const s = start();
    const r = applyOp(s, op);
    expect(r.next).toBe(s);
    expect(r.inverse).toBeDefined();
  });

  it.each([...NEAR_MISS_1191, ...REAL_1191])('control — %s: a new state', (_label, start, op) => {
    const s = start();
    const r = applyOp(s, op);
    expect(r.next).not.toBe(s);
    expect(JSON.stringify(r.next)).not.toBe(JSON.stringify(s));
  });

  it.each(NO_CHANGE_1191)('dispatch: %s — no undo, activity kept', (_label, start, op) => {
    const store = useDagStore.getState();
    store.hydrate(start());
    const before = useDagStore.getState().state;
    useDagStore.getState().dispatch(op);
    expect(useDagStore.getState().state).toBe(before);
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    expect(useDagStore.getState().activity).toHaveLength(1);
  });

  it.each([...NEAR_MISS_1191, ...REAL_1191])(
    'dispatch control — %s: one undo step that undoes',
    (_label, start, op) => {
      useDagStore.getState().hydrate(start());
      const before = useDagStore.getState().state;
      useDagStore.getState().dispatch(op);
      expect(useDagStore.getState().undoStack).toHaveLength(1);
      useDagStore.getState().undo();
      // Content, not bytes: an undone setMeta rebuilds its meta with keys in another order.
      expect(useDagStore.getState().state).toEqual(before);
    },
  );
});
