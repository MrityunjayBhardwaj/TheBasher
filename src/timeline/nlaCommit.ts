// nlaCommit — the ONE commit funnel for every NLA lane-UI gesture (epic #283
// Phase 5, inc 5C; PLAN.md R4 mitigation).
//
// Every gesture in the NLA pane commits through here — either the mutator
// road (`dispatchMutatorFromUI`, the same five-gate validate→propose→accept
// spine the agent uses, H40) or the ONE sanctioned raw road (a one-op
// `dispatchAtomic` setParam on a paramPath no mutator covers: `Strip.muted`,
// UI-SPEC §2.5). `dispatchMutatorFromUI` returns `{ok:false, reason}` WITHOUT
// throwing and leaves the DAG byte-unchanged (B26) — a call site that ignores
// the result is a silent no-op (H70, the observed `window.alert` precedent is
// explicitly NOT followed). Funneling every commit through one seam means the
// {ok:false}→toast discipline is enforced in ONE place and unit-tested once,
// instead of re-remembered per gesture.
//
// Returns the result so callers can ALSO surface it inline (the 5D popover
// keeps its reason text open for correction).
//
// REF: .planning/phases/nla-5-lane-ui/PLAN.md inc 5C; UI-SPEC §2/§2.5;
//      src/app/animate/dispatchMutator.ts:78-121; dharana B26; hetvabhasa
//      H70; issue #283.

import {
  dispatchMutatorFromUI,
  dispatchPushDownToStrip,
  type DispatchResult,
} from '../app/animate/dispatchMutator';
import { useDagStore } from '../core/dag/store';
import { useNotificationStore } from '../app/stores/notificationStore';

/**
 * Commit a gesture through the mutator road. On `{ok:false}` the reason is
 * pushed to the notification store (severity error, verbatim) and the result
 * is returned either way — never swallowed, never thrown, never alerted.
 */
export function commitNla(mutatorName: string, spec: unknown, intent: string): DispatchResult {
  const res = dispatchMutatorFromUI(mutatorName, spec, intent);
  if (!res.ok) {
    useNotificationStore.getState().notify({ severity: 'error', message: res.reason });
  }
  return res;
}

/**
 * The sanctioned RAW road (UI-SPEC §2.5): a ONE-op setParam via
 * `dispatchAtomic` on a paramPath the NLA vocabulary intentionally does not
 * cover (`Strip.muted`; and, if ever exposed, the `Track.strips` whole-array
 * replace). `dispatchAtomic` THROWS on validation failure (unlike the mutator
 * road) — normalized here to the same `{ok:false, reason}` + toast contract
 * so call sites handle exactly one shape.
 */
/**
 * "Push down" (inc 5E, UI-SPEC §2.7) through the SAME toast funnel: the
 * composite (`dispatchPushDownToStrip` — createAction + addStrip + deleteNode
 * as ONE fork-evolve dispatch = ONE undo entry) returns `{ok:false, reason}`
 * without throwing; the reason (including the honesty-guard refusals that name
 * the blocking channel) reaches the notification surface, never a silent no-op.
 */
export function commitNlaPushDown(targetId: string): DispatchResult {
  const res = dispatchPushDownToStrip(targetId);
  if (!res.ok) {
    useNotificationStore.getState().notify({ severity: 'error', message: res.reason });
  }
  return res;
}

export function commitNlaSetParam(
  nodeId: string,
  paramPath: string,
  value: unknown,
  description: string,
): DispatchResult {
  try {
    useDagStore
      .getState()
      .dispatchAtomic([{ type: 'setParam', nodeId, paramPath, value }], 'user', description);
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    useNotificationStore.getState().notify({ severity: 'error', message: reason });
    return { ok: false, reason };
  }
}
