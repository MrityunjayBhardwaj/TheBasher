// nlaLaneGeometry — the pure geometry of the NLA lane view (epic #283 Phase 5).
// ONE place for the layout constants + time↔percent mapping + resize/snap/
// midpoint-order math so the component and its e2e can never drift (the H95
// trap: a drag/position spec that mirrors geometry constants silently targets
// the wrong pixel when they change).
//
// The lane is laid out in PERCENTAGES of the VISIBLE view window (responsive,
// no pixel measurement needed for rendering — the pane mounts display:none, so
// px-computed positions would render garbage on first paint, R1). The window
// comes from the SHARED dock view (`useTimelineViewStore`) via the ONE mapping
// family: `visibleFrames` from ./timelineView (R2 — `timelineCanvasGeometry`'s
// plain map is deliberately NOT imported; mixing the two families mis-places
// strips whenever zoom ≠ 1). Pixel↔seconds conversion (for drag) measures the
// live lane width at pointerdown — a separate concern, also here.
//
// PURE: no store imports — `fps`/`totalFrames`/`view` are always parameters
// (R6, the videoTimelineGeometry discipline).
//
// REF: .planning/phases/nla-5-lane-ui/UI-SPEC.md §1.2/§2.1-§2.4/§3.4;
//      sibling precedent src/app/video/videoTimelineGeometry.ts; hetvabhasa
//      H95 (geometry in one place); vyapti V88 D2; issue #283.

import { visibleFrames, type TimelineView } from './timelineView';

/** Width of the left track-header column (names + M/S/▲▼), in CSS px.
 *  The observed OUTLINE_WIDTH_PX (videoTimelineGeometry.ts:18). */
export const NLA_HEADER_WIDTH_PX = 220;
/** Height of one track row, in CSS px (ROW_HEIGHT_PX, videoTimelineGeometry.ts:20). */
export const NLA_ROW_HEIGHT_PX = 28;
/** Height of the time ruler atop the lane area, in CSS px (RULER_HEIGHT_PX, :22). */
export const NLA_RULER_HEIGHT_PX = 22;
/** Width (CSS px) of the resize-handle hit zone at each end of a strip block
 *  (BAR_TRIM_HANDLE_PX, videoTimelineGeometry.ts:72). */
export const NLA_STRIP_HANDLE_PX = 8;
/** Width of the right-side strip-inspector column, in CSS px. */
export const NLA_INSPECTOR_WIDTH_PX = 220;
/** Pointer travel (px) that turns a click into a drag (LayerTimeline.tsx:58-59). */
export const NLA_DRAG_THRESHOLD_PX = 3;
/** Minimum RENDERED width (CSS px) of a strip block, applied as a presentational
 *  `min-width` floor in the component — NOT in the percent math (#288 N5). An
 *  orphan strip has a degenerate zero-length span (end === start → widthPct 0);
 *  without a floor it collapses to the px-1 padding + warn border and the
 *  "contributes nothing" state is nearly invisible. Kept out of `spanToPercent`
 *  so the geometry stays pure and the H95 placement e2e is untouched. */
export const NLA_STRIP_MIN_WIDTH_PX = 6;
/** Epsilon floor for `timeScale` — the schema requires strictly positive
 *  (zod .positive(), Strip.ts:34); a resize to zero width clamps here. */
export const NLA_MIN_TIMESCALE = 1e-4;

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A strip's placed extent on the global timeline, in seconds. */
export interface StripPlacedRange {
  readonly start: number;
  readonly end: number;
}

/** A strip block's CSS `left`/`width` as percentages of the lane width. */
export interface StripPercent {
  readonly leftPct: number;
  readonly widthPct: number;
}

/**
 * The placed span of a strip: `end = start + actLen·timeScale·repeat` —
 * EXACTLY the enumeration's crossfade range end (layeredChannels.ts:119).
 * There is no `end` param on Strip; length is always derived.
 */
export function stripPlacedRange(
  start: number,
  actLen: number,
  timeScale: number,
  repeat: number,
): StripPlacedRange {
  return { start, end: start + actLen * timeScale * repeat };
}

/** The visible frame window {startFrame, span} for the shared dock view. */
function visibleWindow(
  totalFrames: number,
  view: TimelineView,
): { startFrame: number; span: number } {
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  return { startFrame, span: Math.max(endFrame - startFrame, EPS) };
}

/**
 * A seconds span → CSS left/width percentages of the lane, relative to the
 * VISIBLE window (shared zoom/scroll view). Clamps rendering to the window
 * edges: a strip half off-screen renders its visible part; fully off-screen
 * degenerates to width 0.
 */
export function spanToPercent(
  startSec: number,
  endSec: number,
  fps: number,
  totalFrames: number,
  view: TimelineView,
): StripPercent {
  const { startFrame, span } = visibleWindow(totalFrames, view);
  const leftPct = clamp(((startSec * fps - startFrame) / span) * 100, 0, 100);
  const rightPct = clamp(((endSec * fps - startFrame) / span) * 100, 0, 100);
  return { leftPct, widthPct: Math.max(0, rightPct - leftPct) };
}

/**
 * A time in seconds → percent across the visible window (playhead, ruler
 * ticks). UNCLAMPED — an off-window playhead maps outside [0,100] and the
 * component decides to hide it.
 */
export function secondsToPercent(
  sec: number,
  fps: number,
  totalFrames: number,
  view: TimelineView,
): number {
  const { startFrame, span } = visibleWindow(totalFrames, view);
  return ((sec * fps - startFrame) / span) * 100;
}

/** Inverse of {@link secondsToPercent} — a lane percent back to seconds
 *  (ruler scrub). `fps <= 0` is degenerate → 0. */
export function percentToSeconds(
  pct: number,
  fps: number,
  totalFrames: number,
  view: TimelineView,
): number {
  if (fps <= 0) return 0;
  const { startFrame, span } = visibleWindow(totalFrames, view);
  return (startFrame + (pct / 100) * span) / fps;
}

/**
 * A pixel delta along the lane → a seconds delta, against the lane width
 * measured ONCE at pointerdown (the xDeltaToFrameDelta discipline,
 * videoTimelineGeometry.ts:89-97). Zero/negative width or fps returns 0 —
 * never NaN. Unrounded: frame-grid snapping is {@link snapToFrame}'s job at
 * commit time.
 */
export function xDeltaToSecondsDelta(
  deltaPx: number,
  laneWidthPx: number,
  fps: number,
  totalFrames: number,
  view: TimelineView,
): number {
  if (laneWidthPx <= 0 || fps <= 0) return 0;
  const { span } = visibleWindow(totalFrames, view);
  return ((deltaPx / laneWidthPx) * span) / fps;
}

/** Snap a time to the dock's frame grid (§2.1). `fps <= 0` passes through. */
export function snapToFrame(sec: number, fps: number): number {
  if (fps <= 0) return sec;
  return Math.round(sec * fps) / fps;
}

/**
 * Right-handle resize → the new `timeScale` (§2.2). The right edge moves to
 * `newEndSec`; `start`/`repeat` unchanged:
 * `timeScale' = timeScale·(newEnd − start)/(oldEnd − start)`, clamped to
 * {@link NLA_MIN_TIMESCALE} (the schema hard-rejects 0). A degenerate old
 * span (oldEnd ≤ oldStart) returns the clamped old value.
 */
export function resizeRight(
  oldStart: number,
  oldEnd: number,
  newEndSec: number,
  oldTimeScale: number,
): { timeScale: number } {
  const oldLen = oldEnd - oldStart;
  if (oldLen <= 0) return { timeScale: Math.max(oldTimeScale, NLA_MIN_TIMESCALE) };
  return {
    timeScale: Math.max((oldTimeScale * (newEndSec - oldStart)) / oldLen, NLA_MIN_TIMESCALE),
  };
}

/**
 * Left-handle resize → new `{start, timeScale}` with the RIGHT edge FIXED
 * (the compositor's trim-left invariant, applyBarDrag
 * videoTimelineGeometry.ts:125-131):
 * `timeScale' = timeScale·(oldEnd − newStart)/(oldEnd − oldStart)` clamped ≥
 * {@link NLA_MIN_TIMESCALE}, then `start' = oldEnd − actLen·timeScale'·repeat`
 * — start is recomputed AFTER the clamp so the right edge stays exact even
 * when the clamp bites. Both fields commit in ONE dispatch (one undo entry).
 */
export function resizeLeft(
  oldStart: number,
  oldEnd: number,
  newStartSec: number,
  oldTimeScale: number,
  actLen: number,
  repeat: number,
): { start: number; timeScale: number } {
  const oldLen = oldEnd - oldStart;
  const raw = oldLen <= 0 ? oldTimeScale : (oldTimeScale * (oldEnd - newStartSec)) / oldLen;
  const timeScale = Math.max(raw, NLA_MIN_TIMESCALE);
  return { start: oldEnd - actLen * timeScale * repeat, timeScale };
}

/**
 * Track ▲/▼ reorder → the ONE new `order` value for the ONE moved track
 * (§2.4 — never swap two tracks; two dispatches = two undo entries).
 * `belowOrder`/`aboveOrder` are the orders of the neighbors the track lands
 * BETWEEN (below = lower-order side); `null` = moving past an extreme (±1
 * beyond it). If the strict midpoint collides with a neighbor (float
 * exhaustion, or equal-order neighbors) nudge by 1e-6 — never emit an
 * exactly-equal order (equal orders tie-break lexicographically by id,
 * layeredChannels.ts:158, which would make the move a silent no-op).
 */
export function midpointOrder(belowOrder: number | null, aboveOrder: number | null): number {
  if (belowOrder === null && aboveOrder === null) return 0;
  if (belowOrder === null) return (aboveOrder as number) - 1;
  if (aboveOrder === null) return belowOrder + 1;
  const mid = (belowOrder + aboveOrder) / 2;
  return mid === belowOrder || mid === aboveOrder ? mid + 1e-6 : mid;
}

/** Which way a track reorder button moves a row. `'up'` = toward the top of
 *  the display (= HIGHER `Track.order`, the later-folded winner). */
export type NlaReorderDirection = 'up' | 'down';

/**
 * The disabled-at-extreme predicate (§2.4): ▲ on the TOP display row and ▼ on
 * the BOTTOM display row are DISABLED — the component checks this BEFORE
 * calling {@link midpointOrder} and emits NO dispatch for a no-op move (no
 * junk undo entries). `displayIndex` is the row's index in DISPLAY order
 * (0 = top = highest order). A single-row list disables both directions.
 */
export function reorderDisabled(
  direction: NlaReorderDirection,
  displayIndex: number,
  rowCount: number,
): boolean {
  if (rowCount <= 1) return true;
  return direction === 'up' ? displayIndex === 0 : displayIndex === rowCount - 1;
}
