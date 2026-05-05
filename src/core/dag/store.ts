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

/**
 * A composite undo entry produced by `dispatchAtomic`. Holds the original op
 * sequence and their inverses; one user-visible undo reverts the whole
 * batch by replaying inverses in reverse order.
 */
export interface AtomicGroup {
  __atomic: true;
  description: string;
  entries: InverseOp[];
}

type UndoEntry = InverseOp | AtomicGroup;

function isAtomic(e: UndoEntry): e is AtomicGroup {
  return (e as AtomicGroup).__atomic === true;
}

export interface DagStore {
  state: DagState;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  activity: ActivityEntry[];
  pendingDiffs: Diff[];
  /** Apply a single op. Throws on validation failure; never partially mutates. */
  dispatch: (op: Op, source?: OpSource, description?: string) => InverseOp;
  /** Replay multiple ops; each gets its own undo entry. Use dispatchAtomic
   *  when the batch should undo as one user-visible action. */
  dispatchBatch: (ops: Op[], source?: OpSource, description?: string) => InverseOp[];
  /**
   * Replay multiple ops as ONE composite undo entry. P1's drag-reorder needs
   * `disconnect → connect` to undo as one keypress. The Diff system (P2.5)
   * also lands on top of this.
   */
  dispatchAtomic: (ops: Op[], source?: OpSource, description?: string) => InverseOp[];
  /** Replace state wholesale (project load only — bypasses op log). */
  hydrate: (state: DagState) => void;
  undo: () => UndoEntry | undefined;
  redo: () => UndoEntry | undefined;
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

  dispatchAtomic(ops, source = 'user', description) {
    if (ops.length === 0) return [];
    const result: InverseOp[] = [];
    let working = get().state;
    const newActivity: ActivityEntry[] = [];
    // Apply forward; collect inverses pre-mutation per op (K2 step 3).
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
    const group: AtomicGroup = {
      __atomic: true,
      description: description ?? '',
      entries: result,
    };
    set((s) => ({
      state: working,
      undoStack: [...s.undoStack, group],
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
    let working = get().state;
    if (isAtomic(last)) {
      // Replay inverses in REVERSE order — last op applied is first to undo.
      for (let i = last.entries.length - 1; i >= 0; i--) {
        const inv = validateOp(last.entries[i].inverse);
        working = applyOp(working, inv).next;
      }
    } else {
      const inv = validateOp(last.inverse);
      working = applyOp(working, inv).next;
    }
    set((s) => ({
      state: working,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, last],
    }));
    return last;
  },

  redo() {
    const stack = get().redoStack;
    if (stack.length === 0) return undefined;
    const last = stack[stack.length - 1];
    let working = get().state;
    let pushBack: UndoEntry;
    if (isAtomic(last)) {
      const fresh: InverseOp[] = [];
      for (const e of last.entries) {
        const f = validateOp(e.forward);
        const { next, inverse } = applyOp(working, f);
        working = next;
        fresh.push({ forward: f, inverse });
      }
      pushBack = { __atomic: true, description: last.description, entries: fresh };
    } else {
      const f = validateOp(last.forward);
      const { next, inverse } = applyOp(working, f);
      working = next;
      pushBack = { forward: f, inverse };
    }
    set((s) => ({
      state: working,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, pushBack],
    }));
    return pushBack;
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
