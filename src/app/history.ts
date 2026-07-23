// history — the app-level undo/redo seam.
//
// Undo/redo restore the DAG directly; they do NOT replay the edit commands that
// keep a POSITION-ADDRESSED sub-selection naming the same element. A sub-selection
// identifies an array element by position — a curve control point by
// `(nodeId, pointIndex)`, a keyframe by `(channelId, time)` — and those positions
// shift as points/keys are inserted and deleted. The edit commands re-index the
// sub-selection so it keeps naming the SAME element; a history restore bypasses
// them, so after an undo the same stored index/time can silently name a DIFFERENT
// element (#326). It doesn't crash — every reader resolves through a validating
// accessor that goes inert when the reference is stale — but the gizmo can land on
// a neighbouring point without the director asking for it.
//
// The honest fix at this level (issue #326, option 1): a history move DROPS any
// position-addressed sub-selection. The director sees the selection fall away —
// truthful — rather than drift onto a different element. Addressing points by a
// real per-point id (so the reference survives a restore) is the thorough fix and
// a schema change; it is deferred (#326 option 3).
//
// This is the ONE seam every undo/redo trigger routes through (the MenuBar Edit
// items + the keyboard shortcut). A new position-addressed sub-selection store is
// cleared HERE, not at each call site (one projection, not a parallel list — the
// same discipline the sub-selection stores were split out under).

import { useDagStore } from '../core/dag/store';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useTimelineSelection } from '../timeline/timelineSelection';

/** Drop every sub-selection that names an element by position — see the file
 *  header. Called only after a history move actually happened. */
function clearPositionAddressedSubSelections(): void {
  useCurveSelectionStore.getState().clear();
  useTimelineSelection.getState().setActiveKeyframe(null);
}

/** Undo one history entry, then drop any position-addressed sub-selection. A
 *  no-op undo (empty stack) leaves the sub-selection alone — nothing moved. */
export function historyUndo(): void {
  const entry = useDagStore.getState().undo();
  if (entry) clearPositionAddressedSubSelections();
}

/** Redo one history entry, then drop any position-addressed sub-selection. A
 *  no-op redo (empty stack) leaves the sub-selection alone — nothing moved. */
export function historyRedo(): void {
  const entry = useDagStore.getState().redo();
  if (entry) clearPositionAddressedSubSelections();
}
