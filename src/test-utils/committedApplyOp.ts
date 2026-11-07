// applyOp as a commit does it: the op, then the follow-ups the store's commit step adds, so a
// constraint that names its object is on that object's chain. For fixtures built off the store.

import { chainFollowUpOps } from '../core/dag/chainEdit';
import { applyOp as rawApplyOp, applyOps } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';

export function applyOp(state: DagState, op: Op): ReturnType<typeof rawApplyOp> {
  const applied = rawApplyOp(state, op);
  const ops = chainFollowUpOps(state, applied.next);
  return ops.length === 0 ? applied : { ...applied, next: applyOps(applied.next, ops).next };
}
