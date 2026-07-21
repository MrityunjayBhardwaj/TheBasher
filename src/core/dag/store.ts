// DAG zustand store. Single mutation entry: `dispatch(op)`. Internal
// `setState` is wrapped so consumers cannot reach in directly — V1.
//
// Activity log records every applied op with source ('user' | 'agent' |
// 'macro' | 'render') for THESIS.md §15 (drawer Activity tab) and the
// agent's recent-activity context (§21). 'render' is the V8 file-rooted
// dispatch source — used by src/app/render/runWorkflow.ts to advance
// lastGoodFrame after each completed frame in a runComfyUIWorkflow run
// without bleeding render-side dispatch into src/render/.
//
// REF: THESIS.md §50, krama K2 + K10.

import { create } from 'zustand';
import { applyOp, validateOp } from './ops';
import { findDanglingIdRef } from './idRefSweep';
import type { DagState } from './state';
import { emptyDagState } from './state';
import type { Diff, InverseOp, Op } from './types';

export type OpSource = 'user' | 'agent' | 'macro' | 'render';

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

/**
 * An open interaction (a continuous drag — gizmo, scrub) accumulating its per-move
 * ops. While one is open, dispatch/dispatchBatch/dispatchAtomic mutate state but
 * DEFER the undo + activity records into this buffer; endInteraction flushes the
 * whole buffer as ONE undo entry + ONE activity line. So a drag from x:1 → x:1.2 is
 * a single Cmd+Z (back to x:1), not N incremental steps. `source`/`description` are
 * captured from the first buffered op (used when endInteraction is given none).
 */
interface InteractionBuffer {
  entries: InverseOp[];
  source: OpSource;
  description: string;
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
  /**
   * Open a drag transaction: every dispatch until `endInteraction` mutates state
   * but coalesces into ONE undo entry. Bracket a continuous gesture (gizmo drag,
   * scrub) so its per-move ops undo as one action, not incrementally. Re-entrant
   * (a second begin while one is open is a no-op).
   */
  beginInteraction: () => void;
  /**
   * Close the drag transaction opened by `beginInteraction`, flushing the buffered
   * ops as ONE undo entry + ONE activity line (description optional — defaults to
   * the first buffered op's). A bracket with zero moves (a click) flushes nothing.
   */
  endInteraction: (description?: string) => void;
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

// #435 — "does not silently dangle", in its FINAL-STATE form, on EVERY commit road.
// `removeNode`'s per-op guard covers edges (always explicitly torn down); an id-
// reference is a param that can legitimately outlive a removeNode mid-batch (Apply-
// Transform re-adds the baked node under the SAME id, #412), so the invariant is about
// the COMMITTED state, not a transient. Only a removeNode can turn a live ref into a
// dangling one, so the scan runs ONLY then — leaving every drag / param edit untouched.
// Called by all three commit paths (dispatch / dispatchBatch / dispatchAtomic) before
// their `set()`, so a rejected batch never mutates the store and no future commit road
// can reopen the raw-removeNode hole. Closes the dag.exec road no per-caller sweep reaches.
function assertNoDanglingIdRef(ops: readonly Op[], nextState: DagState): void {
  if (!ops.some((o) => o.type === 'removeNode')) return;
  const dangling = findDanglingIdRef(nextState.nodes);
  if (dangling) {
    throw new Error(
      `dispatch: node "${dangling.node}" would be left referencing removed node ` +
        `"${dangling.missing}". Clear or remove the referrer in the same batch.`,
    );
  }
}

// Module-scoped open interaction (a drag transaction). Not in the zustand state
// because per-move dispatches read/append it synchronously many times per second;
// keeping it out of the reactive state avoids needless subscriber churn. Flushed by
// endInteraction / hydrate / reset.
let interaction: InteractionBuffer | null = null;

export const useDagStore = create<DagStore>((set, get) => ({
  state: emptyDagState(),
  undoStack: [],
  redoStack: [],
  activity: [],
  pendingDiffs: [],

  dispatch(op, source = 'user', description) {
    const validated = validateOp(op);
    const { next, inverse } = applyOp(get().state, validated);
    assertNoDanglingIdRef([validated], next); // #435
    const inv: InverseOp = { forward: validated, inverse };
    // Inside a drag transaction: mutate state, buffer the undo/activity record.
    if (interaction) {
      if (interaction.entries.length === 0) {
        interaction.source = source;
        interaction.description = description ?? '';
      }
      interaction.entries.push(inv);
      set({ state: next });
      return inv;
    }
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
    assertNoDanglingIdRef(ops, working); // #435
    // Inside a drag transaction: mutate state, buffer the records (flat).
    if (interaction) {
      if (interaction.entries.length === 0) {
        interaction.source = source;
        interaction.description = description ?? '';
      }
      interaction.entries.push(...result);
      set({ state: working });
      return result;
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
    assertNoDanglingIdRef(ops, working); // #435 — throw before set(); store stays whole
    // Inside a drag transaction: append the ops FLAT to the buffer (not as a nested
    // group) so the whole gesture stays ONE flat undo entry.
    if (interaction) {
      if (interaction.entries.length === 0) {
        interaction.source = source;
        interaction.description = description ?? '';
      }
      interaction.entries.push(...result);
      set({ state: working });
      return result;
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
    interaction = null;
    set({
      state,
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
  },

  beginInteraction() {
    // Re-entrant: a stray second begin keeps the open buffer (the gizmo opens one
    // bracket per drag; do not split a drag into two undo entries).
    if (interaction) return;
    interaction = { entries: [], source: 'user', description: '' };
  },

  endInteraction(description) {
    const inter = interaction;
    interaction = null;
    if (!inter || inter.entries.length === 0) return; // a click with no move → nothing
    const desc = description ?? inter.description;
    const group: AtomicGroup = { __atomic: true, description: desc, entries: inter.entries };
    const entry: ActivityEntry = {
      id: ++activityCounter,
      timestamp: timeNow(),
      source: inter.source,
      op: inter.entries[inter.entries.length - 1].forward,
      description: desc,
    };
    set((s) => ({
      undoStack: [...s.undoStack, group],
      redoStack: [],
      activity: [...s.activity, entry],
    }));
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
    interaction = null;
    set({
      state: emptyDagState(),
      undoStack: [],
      redoStack: [],
      activity: [],
      pendingDiffs: [],
    });
  },
}));
