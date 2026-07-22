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
import { applyOp, validateOp, type Reportable } from '../../core/dag/ops';

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
 * DagState shape so a spread is sufficient) and apply `ops` sequentially.
 * Returns the forked state and the inverse ops needed to undo the sequence.
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

  const inverseOps: InverseOp[] = [];
  const reportable: (Reportable | null)[] = [];
  let fork: DagState = { ...state, nodes: { ...state.nodes } };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const validated = validateOp(op);
    const result = applyOp(fork, validated);
    fork = result.next;
    inverseOps.push({ forward: validated, inverse: result.inverse });
    reportable.push(result.reportable ?? null);
  }

  return { fork, inverseOps, reportable };
}

/**
 * Clone a DAG state. Convenience wrapper when no ops need applying yet
 * (e.g. pre-seeding the diff store with a blank state).
 */
export function cloneState(state: DagState): DagState {
  return { ...state, nodes: { ...state.nodes } };
}
