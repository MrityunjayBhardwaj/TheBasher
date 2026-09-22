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
    reportable.push(withOwner(fork, result.reportable));
    fork = result.next;
    inverseOps.push({ forward: validated, inverse: result.inverse });
  }

  return { fork, inverseOps, reportable };
}

/**
 * #1189 — a write refused because it aimed at the wrong half of a split object names the
 * half that owns the param, so the model (and the director reading the DiffBar) can re-aim
 * in one step. Read against the state the op was applied TO. The reach stays the reader's:
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
