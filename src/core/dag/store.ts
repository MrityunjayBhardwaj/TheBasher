// DAG zustand store. Single mutation entry: `dispatch(op)`. Internal
// `setState` is wrapped so consumers cannot reach in directly — V1.
//
// Activity log records every applied op with source ('user' | 'agent' |
// 'macro') for THESIS.md §15 (drawer Activity tab) and the agent's recent-
// activity context (§21).
//
// REF: THESIS.md §50, krama K2.

import { create } from 'zustand';
import { applyOp, validateOp } from './ops';
import type { DagState } from './state';
import { emptyDagState } from './state';
import type { Diff, InverseOp, Op } from './types';

export type OpSource = 'user' | 'agent' | 'macro';

export interface ActivityEntry {
  id: number;
  timestamp: number;
  source: OpSource;
  op: Op;
  description?: string;
}

export interface DagStore {
  state: DagState;
  undoStack: InverseOp[];
  redoStack: InverseOp[];
  activity: ActivityEntry[];
  pendingDiffs: Diff[];
  /** Apply a single op. Throws on validation failure; never partially mutates. */
  dispatch: (op: Op, source?: OpSource, description?: string) => InverseOp;
  /** Replay multiple ops as one undo entry. */
  dispatchBatch: (ops: Op[], source?: OpSource, description?: string) => InverseOp[];
  /** Replace state wholesale (project load only — bypasses op log). */
  hydrate: (state: DagState) => void;
  undo: () => InverseOp | undefined;
  redo: () => InverseOp | undefined;
  reset: () => void;
}

let activityCounter = 0;
let timeNow: () => number = () => Date.now();
/** Test hook only — do not use in production code. */
export function __setTimeNowForTests(fn: () => number): void {
  timeNow = fn;
}

export const useDagStore = create<DagStore>((set, get) => ({
  state: emptyDagState(),
  undoStack: [],
  redoStack: [],
  activity: [],
  pendingDiffs: [],

  dispatch(op, source = 'user', description) {
    const validated = validateOp(op);
    const { next, inverse } = applyOp(get().state, validated);
    const inv: InverseOp = { forward: validated, inverse };
    const entry: ActivityEntry = {
      id: ++activityCounter,
      timestamp: timeNow(),
      source,
      op: validated,
      description,
    };
    set((s) => ({
      state: next,
      undoStack: [...s.undoStack, inv],
      redoStack: [],
      activity: [...s.activity, entry],
    }));
    return inv;
  },

  dispatchBatch(ops, source = 'user', description) {
    const result: InverseOp[] = [];
    let working = get().state;
    const newActivity: ActivityEntry[] = [];
    for (const op of ops) {
      const validated = validateOp(op);
      const { next, inverse } = applyOp(working, validated);
      working = next;
      const inv: InverseOp = { forward: validated, inverse };
      result.push(inv);
      newActivity.push({
        id: ++activityCounter,
        timestamp: timeNow(),
        source,
        op: validated,
        description,
      });
    }
    set((s) => ({
      state: working,
      undoStack: [...s.undoStack, ...result],
      redoStack: [],
      activity: [...s.activity, ...newActivity],
    }));
    return result;
  },

  hydrate(state) {
    set({
      state,
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
  },

  undo() {
    const stack = get().undoStack;
    if (stack.length === 0) return undefined;
    const last = stack[stack.length - 1];
    const validated = validateOp(last.inverse);
    const { next } = applyOp(get().state, validated);
    set((s) => ({
      state: next,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, last],
    }));
    return last;
  },

  redo() {
    const stack = get().redoStack;
    if (stack.length === 0) return undefined;
    const last = stack[stack.length - 1];
    const validated = validateOp(last.forward);
    const { next, inverse } = applyOp(get().state, validated);
    const inv: InverseOp = { forward: validated, inverse };
    set((s) => ({
      state: next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, inv],
    }));
    return inv;
  },

  reset() {
    set({
      state: emptyDagState(),
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
  },
}));
