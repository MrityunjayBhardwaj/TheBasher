// Diff store — holds the pending agent diff and the current fork state.
//
// The lifecycle follows krama K3:
//   1. Agent emits tool output → Op[]
//   2. createFork applies to a DAG clone
//   3. Diff store holds the fork + metadata
//   4. User previews via ghost overlay (SceneFromDAG reads diffStore)
//   5. Accept → feed through real Op dispatcher (dispatchAtomic)
//   6. Reject → discard fork, zero state changes
//
// REF: THESIS.md §19, krama K3.

import { create } from 'zustand';
import type { DagState } from '../../core/dag/state';
import type { InverseOp, Op } from '../../core/dag/types';
import { cloneState, createFork } from './forkedDag';

export type DiffStatus = 'idle' | 'pending' | 'previewing' | 'applied' | 'rejected';

export interface PendingDiff {
  /** Original DAG state snapshot when the diff was created. */
  originalState: DagState;
  /** Forked DAG state (ops applied). */
  forkState: DagState;
  /** The ops the agent proposed. */
  ops: Op[];
  /** Inverse ops (one per forward op). */
  inverseOps: InverseOp[];
  /** Human-readable description (becomes undo entry title if accepted). */
  description: string;
  /** Per-op acceptance. All true by default. */
  selected: boolean[];
  /** Timestamp of creation. */
  createdAt: number;
}

export interface DiffStore {
  status: DiffStatus;
  pendingDiff: PendingDiff | null;
  /** Fork the DAG and set pending. Returns the PendingDiff. */
  propose: (
    state: DagState,
    ops: Op[],
    description: string,
  ) => PendingDiff;
  /** Toggle acceptance of a single op by index. */
  toggleOp: (index: number) => void;
  /** Select/deselect all ops. */
  selectAll: (selected: boolean) => void;
  /** Get the subset of selected ops + inverses. */
  getSelectedOps: () => { forward: Op[]; inverse: InverseOp[] } | null;
  /** Mark as applied. */
  markApplied: () => void;
  /** Mark as rejected. */
  reject: () => void;
  /** Reset to idle. */
  reset: () => void;
}

export const useDiffStore = create<DiffStore>((set, get) => ({
  status: 'idle',
  pendingDiff: null,

  propose(state, ops, description) {
    const { fork, inverseOps } = createFork(state, ops);
    const diff: PendingDiff = {
      originalState: cloneState(state),
      forkState: fork,
      ops,
      inverseOps,
      description,
      selected: ops.map(() => true),
      createdAt: Date.now(),
    };
    set({ status: 'pending', pendingDiff: diff });
    return diff;
  },

  toggleOp(index) {
    const diff = get().pendingDiff;
    if (!diff) return;
    const selected = [...diff.selected];
    if (index >= 0 && index < selected.length) {
      selected[index] = !selected[index];
    }
    set({ pendingDiff: { ...diff, selected } });
  },

  selectAll(selected) {
    const diff = get().pendingDiff;
    if (!diff) return;
    set({
      pendingDiff: {
        ...diff,
        selected: diff.ops.map(() => selected),
      },
    });
  },

  getSelectedOps() {
    const diff = get().pendingDiff;
    if (!diff) return null;
    const forward: Op[] = [];
    const inverse: InverseOp[] = [];
    for (let i = 0; i < diff.ops.length; i++) {
      if (diff.selected[i]) {
        forward.push(diff.ops[i]);
        inverse.push(diff.inverseOps[i]);
      }
    }
    return forward.length > 0 ? { forward, inverse } : null;
  },

  markApplied() {
    set({ status: 'applied' });
  },

  reject() {
    set({ status: 'rejected', pendingDiff: null });
  },

  reset() {
    set({ status: 'idle', pendingDiff: null });
  },
}));

/**
 * Accept the selected ops from the pending diff. Feeds them through the
 * real store's dispatchAtomic so one Cmd+Z reverts the whole agent action.
 * Returns true if ops were dispatched, false if nothing was selected.
 *
 * Call from `src/app/` context where a dispatcher is available.
 *
 * @param dispatchAtomic — the real store's dispatchAtomic function, e.g.
 *   `useDagStore.getState().dispatchAtomic`
 */
export function acceptSelectedOps(
  dispatchAtomic: (ops: Op[], source: string, description?: string) => unknown,
): boolean {
  const diffStore = useDiffStore.getState();
  const selected = diffStore.getSelectedOps();
  if (!selected) return false;

  const diff = diffStore.pendingDiff!;
  dispatchAtomic(selected.forward, 'agent', diff.description);
  diffStore.markApplied();
  return true;
}

/**
 * Reject the pending diff. Zero state changes (V1 hard rule).
 */
export function rejectDiff(): void {
  useDiffStore.getState().reject();
}
