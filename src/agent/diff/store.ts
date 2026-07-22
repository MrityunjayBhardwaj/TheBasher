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
import type { Reportable } from '../../core/dag/ops';
import type { OpSource } from '../../core/dag/store';
import { cloneState, createFork } from './forkedDag';
import {
  ClosurePreservationError,
  expandClosure,
  isFreshAddNode,
  opTargetNodeId,
} from '../closure/expand';
import type { ClosureSet, ClosureSpec } from '../closure/types';

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
  /**
   * Per-op source label (e.g. "agent:mesh.add"). Aligned with `ops`.
   * Used to rebuild a meaningful undo title when the user accepts only a
   * subset of the proposed ops.
   */
  opSources?: string[];
  /**
   * The closure expanded from the spec passed to propose(). Present when
   * the caller declared a closure; absent for unscoped proposals (e.g.
   * raw dag.exec without a selection-derived scope) — Wave A's
   * conservative inference path.
   */
  closure?: ClosureSet;
  /** Human-readable description (becomes undo entry title if accepted). */
  description: string;
  /** Per-op acceptance. All true by default. */
  selected: boolean[];
  /**
   * Mutator-emitted warnings (lossy aspects, deferrals) accumulated
   * across the turn. Surfaced by DiffBar so the user sees them BEFORE
   * accepting. Empty / undefined when no Mutator dispatched.
   */
  warnings?: string[];
  /**
   * Per-op REPORTABLE no-op signal (#423), aligned with `ops`: a `Reportable`
   * where a proposed op was accepted but changed nothing (a wrong-half write the
   * schema stripped), `null` otherwise. Surfaced by DiffBar so the user sees the
   * op-vs-subject mismatch BEFORE accepting. Undefined when no op was flagged.
   */
  reportable?: (Reportable | null)[];
  /** Timestamp of creation. */
  createdAt: number;
}

export interface DiffStore {
  status: DiffStatus;
  pendingDiff: PendingDiff | null;
  /**
   * Fork the DAG and set pending. Returns the PendingDiff.
   *
   * When `closureSpec` is provided, the closure-preservation gate
   * (vyapti V13) runs BEFORE createFork: every op must target a node
   * inside the expanded closure, OR introduce a fresh node id.
   * Violation throws ClosurePreservationError; the fork is never
   * created and store state is untouched (V1 hard rule).
   */
  propose: (
    state: DagState,
    ops: Op[],
    description: string,
    opSources?: string[],
    closureSpec?: ClosureSpec,
    warnings?: string[],
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

  propose(state, ops, description, opSources, closureSpec, warnings) {
    // Build the fork FIRST. V1 still holds (fork is a clone, no real
    // state mutation). The fork is needed to expand closures rooted on
    // ids introduced by ops in this same batch (e.g. spawnWithProperties
    // chain: mesh.add spawns mesh_xyz, mutator.setMaterialColor's
    // closure roots on mesh_xyz). Without applying ops first, the closure
    // expander can't see the new id and walks an empty subgraph —
    // every connect-to-scene op then fails the gate.
    const { fork, inverseOps, reportable } = createFork(state, ops);

    // V13 closure-preservation gate. Runs after the fork is built but
    // BEFORE we set state — rejection still leaves zero real changes.
    // The gate is vacuous when closureSpec is omitted (P-7 mitigation).
    let closure: ClosureSet | undefined;
    if (closureSpec) {
      // Expand against the fork: closure roots must resolve, and the
      // walker needs the post-batch graph to find consumers/producers.
      closure = expandClosure(closureSpec, fork);
      // A removeNode deletes its target — by construction the node is gone from
      // `fork`, so the fork-expanded closure cannot reach it and the membership
      // check below would falsely reject. But V13 must still catch a removeNode
      // that reaches OUTSIDE the mutator's declared scope. So expand the SAME
      // closureSpec against the ORIGINAL `state` (where the node still exists)
      // and exempt a removeNode only when its target is in THAT closure — a
      // deleteNode mutator roots its closure on the node(s) it deletes, so a
      // legitimate delete is contained, while an out-of-closure removeNode still
      // throws. Computed lazily (only when the batch actually removes a node).
      // (P7.12 D3 — the revert path deletes edge-less baked channels.)
      let originalClosure: ClosureSet | undefined;
      const closureContainsInOriginal = (nodeId: string): boolean => {
        originalClosure ??= expandClosure(closureSpec, state);
        return originalClosure.nodes.has(nodeId);
      };
      // Track ids introduced earlier in this same diff via fresh
      // addNode so subsequent ops referencing them pass the gate.
      const introducedIds = new Set<string>();
      for (const op of ops) {
        if (op.type === 'addNode' && isFreshAddNode(op, state)) {
          introducedIds.add(op.nodeId);
          continue;
        }
        if (op.type === 'removeNode' && closureContainsInOriginal(op.nodeId)) {
          continue;
        }
        const target = opTargetNodeId(op);
        if (target !== null && !closure.nodes.has(target) && !introducedIds.has(target)) {
          throw new ClosurePreservationError(target, closure);
        }
      }
    }
    const diff: PendingDiff = {
      originalState: cloneState(state),
      forkState: fork,
      ops,
      inverseOps,
      opSources,
      closure,
      description,
      selected: ops.map(() => true),
      warnings: warnings && warnings.length > 0 ? warnings : undefined,
      reportable: reportable.some(Boolean) ? reportable : undefined,
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
  dispatchAtomic: (ops: Op[], source?: OpSource, description?: string) => unknown,
): boolean {
  const diffStore = useDiffStore.getState();
  const selected = diffStore.getSelectedOps();
  if (!selected) return false;

  const diff = diffStore.pendingDiff!;
  const allSelected = diff.selected.every(Boolean);
  // P5: when only a subset is accepted, the original description (built from
  // the full proposed batch) is misleading. Rebuild it from the selected
  // op sources so the undo entry reflects what actually landed.
  const description = allSelected ? diff.description : buildPartialDescription(diff);
  dispatchAtomic(selected.forward, 'agent', description);
  diffStore.markApplied();
  return true;
}

function buildPartialDescription(diff: PendingDiff): string {
  if (diff.opSources && diff.opSources.length === diff.ops.length) {
    const acceptedSources = new Set<string>();
    for (let i = 0; i < diff.ops.length; i++) {
      if (diff.selected[i]) acceptedSources.add(diff.opSources[i]);
    }
    // #21: sort to make the undo title deterministic. Set iteration is
    // insertion-order in modern JS, but the insertion order itself is
    // op-emission-order — which a future Mutator refactor could shuffle
    // without anyone realising the user-visible undo string changed
    // with it. Locale-independent ASCII sort keeps test fixtures stable.
    const list = [...acceptedSources].sort().join(', ');
    return list ? `(partial) ${list}` : `(partial) ${diff.description}`;
  }
  return `(partial) ${diff.description}`;
}

/**
 * Reject the pending diff. Zero state changes (V1 hard rule).
 */
export function rejectDiff(): void {
  useDiffStore.getState().reject();
}
