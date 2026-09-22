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
