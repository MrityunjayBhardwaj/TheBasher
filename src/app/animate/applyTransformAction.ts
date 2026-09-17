// applyTransformAction — what an Apply click does with the answer (#1130).
//
// `dispatchApplyTransform` refuses with a sentence saying why: two materials, an uncaptured
// material, a zero scale that can't be taken back out, colour layers a bake can't keep, and more.
// Both Apply surfaces (Object ▸ Apply and the N panel's buttons) used to `void` that answer, so a
// refused click did nothing visible and read as a broken button. They now both come through
// here, and a refusal reaches the director as a toast, the app's one notice surface for a refused
// edit. Agent and script callers keep calling `dispatchApplyTransform` and read the result.
//
// REF: dispatchApplyTransform.ts (`DispatchResult`); stores/notificationStore.ts; issue #1130.

import { useNotificationStore } from '../stores/notificationStore';
import {
  dispatchApplyTransform,
  type ApplyMask,
  type DispatchResult,
} from './dispatchApplyTransform';

/**
 * Apply `mask` to `nodeId` and tell the director when it doesn't happen. A refusal is a warning
 * carrying the dispatch's own sentence; a throw (storage failing mid-write, say) is an error, so
 * it can't surface as an unhandled rejection with nothing on screen either.
 */
export async function applyTransformFromUi(
  nodeId: string,
  mask: ApplyMask,
  apply: (nodeId: string, mask: ApplyMask) => Promise<DispatchResult> = dispatchApplyTransform,
): Promise<DispatchResult> {
  const { notify } = useNotificationStore.getState();
  let result: DispatchResult;
  try {
    result = await apply(nodeId, mask);
  } catch (err) {
    const reason = `Apply failed: ${err instanceof Error ? err.message : String(err)}`;
    notify({ severity: 'error', message: reason });
    return { ok: false, reason };
  }
  if (!result.ok) notify({ severity: 'warn', message: result.reason });
  return result;
}
