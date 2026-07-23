// history — the app-level undo/redo seam.
//
// Undo/redo restore the DAG directly; they do NOT replay the edit commands. A
// sub-selection that names an array element by POSITION cannot survive that: a
// keyframe is identified by `(channelId, time)`, and after an undo across an
// insert/delete that time can silently name a DIFFERENT key. Such a selection is
// DROPPED here on a history move — the director sees it fall away (truthful)
// rather than drift onto a neighbouring element (#326).
//
// A curve control point is NO LONGER position-addressed: it carries a stable id
// (#453), so `(nodeId, pointId)` names the same physical point after any restore
// — the id travels with the point through the DAG that undo/redo puts back. It
// therefore SURVIVES a history move and is deliberately NOT cleared here. That is
// the thorough #326 fix for curve points; keyframes still await the same
// treatment (their ids are a later phase), so they remain on the drop list.
//
// This is the ONE seam every undo/redo trigger routes through (the MenuBar Edit
// items + the keyboard shortcut). A time-addressed sub-selection is cleared HERE,
// not at each call site (one projection, not a parallel list — the same
// discipline the sub-selection stores were split out under).

import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from '../timeline/timelineSelection';

/** Drop every sub-selection that still names an element by POSITION (today only
 *  the timeline keyframe, `(channelId, time)`) — see the file header. The curve
 *  point selection is id-addressed (#453) and survives a restore, so it is NOT
 *  cleared here. Called only after a history move actually happened. */
function clearTimeAddressedSubSelections(): void {
  useTimelineSelection.getState().setActiveKeyframe(null);
}

/** Undo one history entry, then drop any time-addressed sub-selection. A no-op
 *  undo (empty stack) leaves the sub-selection alone — nothing moved. */
export function historyUndo(): void {
  const entry = useDagStore.getState().undo();
  if (entry) clearTimeAddressedSubSelections();
}

/** Redo one history entry, then drop any time-addressed sub-selection. A no-op
 *  redo (empty stack) leaves the sub-selection alone — nothing moved. */
export function historyRedo(): void {
  const entry = useDagStore.getState().redo();
  if (entry) clearTimeAddressedSubSelections();
}
