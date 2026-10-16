// Forked DAG — clone state, apply Op[], return fork + inverse ops.
//
// Pure functions. The diff store wraps these, and the SceneFromDAG ghost
// overlay renders from the fork. The user accepts → fork ops flow through
// the real Op dispatcher. Reject → fork is discarded, zero real state
// changes (V1 hard rule).
//
// REF: THESIS.md §19, krama K3, vyapti V7.

import type { DagState } from '../../core/dag/state';
import type { Op, InverseOp } from '../../core/dag/types';
import { applyOps, GraphRefusal, type Reportable } from '../../core/dag/ops';
import { templateEdits } from '../../core/dag/templates';
import { resolveDataParamOwner } from '../../app/resolveDataParamOwner';

export interface ForkResult {
  /** The forked DAG state after applying all ops. */
  fork: DagState;
  /** Inverse ops that can revert the fork back to pre-op state. */
  inverseOps: InverseOp[];
  /**
   * Per-op REPORTABLE no-op signal (#423), aligned index-for-index with the
   * input `ops`: a `Reportable` where the op was accepted but changed nothing
   * (a wrong-half write the schema stripped), `null` where the op did real work.
   */
  reportable: (Reportable | null)[];
}

/**
 * Clone a DAG state (shallow copy — node records are immutable within the
 * DagState shape so a spread is sufficient) and apply `ops` as one batch.
 * Returns the forked state and the inverse ops needed to undo the sequence.
 *
 * #1664 — one batch (`applyOps`), as the store applies the plan once it is
 * accepted: the sub-network rules are asked of the graph the plan ends in
 * (#1623), so a plan that passes through a node sitting in two places halfway
 * through a rewire is accepted here exactly when the store would accept it.
 *
 * Throws on any op validation failure — Pre-condition is that ops were
 * already validated by the tool handler's zod schema, but applyOp re-
 * validates against the current DAG shape (node existence, socket types,
 * cycle detection), which can fail if the agent's tool output references
 * nodes that don't exist in the fork's intermediate state.
 */
export function createFork(state: DagState, ops: Op[]): ForkResult {
  if (ops.length === 0) {
    return { fork: { ...state, nodes: { ...state.nodes } }, inverseOps: [], reportable: [] };
  }

  const { next: planned, applied } = applyOps(state, ops);
  // #1557 D4 — what the plan does to a template's other instances, shown as the store will commit
  // it (the store works it out again on accept, from the plan's own operations).
  const edits = templateEdits(state, planned);
  if ('refusal' in edits) throw new GraphRefusal(edits.refusal);
  const next = edits.ops.length ? applyOps(planned, edits.ops).next : planned;
  const fork: DagState = { ...next, nodes: { ...next.nodes } };
  const inverseOps: InverseOp[] = applied.map((a) => ({ forward: a.forward, inverse: a.inverse }));
  // The owner a stripped write names is read off the graph the plan ends in (`withOwner`).
  const reportable = applied.map((a) => withOwner(fork, a.reportable));
  return { fork, inverseOps, reportable };
}

/**
 * #1189 — a write refused because it aimed at the wrong half of a split object names the
 * half that owns the param, so the model (and the director reading the DiffBar) can re-aim
 * in one step. Read against the graph the plan ends in. The reach stays the reader's:
 * the op is still refused — an outer node reaches an inner value only explicitly (promote),
 * never by the op layer forwarding it.
 */
function withOwner(state: DagState, r: Reportable | undefined): Reportable | null {
  if (!r) return null;
  if (r.badge !== 'stripped-write') return r;
  const root = r.paramPath.split(/[.[]/)[0];
  const owner = resolveDataParamOwner(state, r.nodeId, root);
  return owner && owner !== r.nodeId ? { ...r, owner } : r;
}

/**
 * Clone a DAG state. Convenience wrapper when no ops need applying yet
 * (e.g. pre-seeding the diff store with a blank state).
 */
export function cloneState(state: DagState): DagState {
  return { ...state, nodes: { ...state.nodes } };
}
