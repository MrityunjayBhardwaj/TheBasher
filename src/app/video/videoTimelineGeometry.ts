// videoTimelineGeometry — the pure geometry of the Compositor's layer timeline
// (spine 1c.3). ONE place for the layout constants + frame↔percent mapping so the
// component and its e2e can never drift (the H95 trap: a drag/position spec that
// mirrors geometry constants silently targets the wrong pixel when they change).
//
// The timeline is laid out in PERCENTAGES of the track width (responsive, no pixel
// measurement needed for rendering): a frame maps to [0,100]% across the comp's
// [0, durationFrames] range, reusing the tested `frameToX` clamp from the dopesheet
// geometry. Pixel↔frame conversion (for drag) is a separate concern (1c.3b) that
// measures the live track width.
//
// REF: docs/COMPOSITOR-DESIGN.md §7; reuses src/timeline/timelineCanvasGeometry
//      (frameToX); hetvabhasa H95 (geometry in one place); issue #237.

import { frameToX } from '../../timeline/timelineCanvasGeometry';
import {
  LANE_HEADER_WIDTH_PX,
  LANE_ROW_HEIGHT_PX,
  LANE_RULER_HEIGHT_PX,
  LANE_TRIM_HANDLE_PX,
} from '../../timeline/timelineSettings';

// The layout constants are the SHARED `lane` family, single-sourced in
// timelineSettings.json (retiring the hand-copy this file and nlaLaneGeometry.ts
// used to keep in lockstep). Re-exported under their original names so call
// sites (LayerTimeline.tsx) are untouched.

/** Width of the left layer-outline column (names + toggles), in CSS px. */
export const OUTLINE_WIDTH_PX = LANE_HEADER_WIDTH_PX;
/** Height of one layer row, in CSS px. */
export const ROW_HEIGHT_PX = LANE_ROW_HEIGHT_PX;
/** Height of the frame ruler atop the track area, in CSS px. */
export const RULER_HEIGHT_PX = LANE_RULER_HEIGHT_PX;

/** A layer's extent on the comp timeline, in comp frames. */
export interface LayerBarSpan {
  /** First comp frame the layer occupies. */
  readonly startFrame: number;
  /** Length in comp frames (>= 1). */
  readonly lengthFrames: number;
}

/**
 * The comp-frame span a layer occupies, given its trim + position and the source
 * length. `outPoint < 0` means "to source end" → the source length bounds it.
 * Length is clamped to >= 1 so a degenerate trim still renders a visible bar.
 */
export function layerBarSpan(
  layer: { startFrame: number; inPoint: number; outPoint: number },
  srcFrames: number,
): LayerBarSpan {
  const effectiveOut = layer.outPoint < 0 ? srcFrames : layer.outPoint;
  const lengthFrames = Math.max(1, effectiveOut - layer.inPoint);
  return { startFrame: layer.startFrame, lengthFrames };
}

/** Map a comp frame to a percent [0,100] across [0, totalFrames]. */
export function frameToPercent(frame: number, totalFrames: number): number {
  return frameToX(frame, totalFrames, 100);
}

/** A layer bar's CSS `left`/`width` as percentages of the track width. */
export interface BarPercent {
  readonly leftPct: number;
  readonly widthPct: number;
}

/** Convert a frame span to left/width percentages of the track. */
export function barPercent(span: LayerBarSpan, totalFrames: number): BarPercent {
  const leftPct = frameToPercent(span.startFrame, totalFrames);
  const rightPct = frameToPercent(span.startFrame + span.lengthFrames, totalFrames);
  return { leftPct, widthPct: Math.max(0, rightPct - leftPct) };
}

// ── Bar drag (1c.3b) ────────────────────────────────────────────────────────
// The bar is drawn in percentages (responsive), but a DRAG arrives in pixels —
// so dragging needs the inverse map, measured against the live track width. The
// pixel→frame delta + the param math both live here (the H95 guard: the drag
// e2e mirrors these, so they must have ONE home shared with the component).

/** Width (CSS px) of the trim-handle hit zone at each end of a layer bar. The
 *  body between the two handles is the slide zone. (Shared `lane` family —
 *  timelineSettings.json.) */
export const BAR_TRIM_HANDLE_PX = LANE_TRIM_HANDLE_PX;

/** Which part of a bar a drag is moving. */
export type BarDragMode = 'trim-left' | 'trim-right' | 'slide';

/** A layer's raw trim/position params (outPoint < 0 = "to source end"). */
export interface LayerBarParams {
  readonly startFrame: number;
  readonly inPoint: number;
  readonly outPoint: number;
}

/**
 * Convert a pixel delta along the track to a (rounded, integer) comp-frame
 * delta. Inverse of `frameToPercent` against the measured track width. A
 * zero/negative width returns 0 (no drag possible) — never NaN.
 */
export function xDeltaToFrameDelta(
  deltaPx: number,
  trackWidthPx: number,
  totalFrames: number,
): number {
  if (trackWidthPx <= 0) return 0;
  const span = Math.max(totalFrames, 1);
  return Math.round((deltaPx / trackWidthPx) * span);
}

/**
 * Apply a drag of `mode` by `deltaFrames` to a layer's bar params, returning the
 * new {startFrame, inPoint, outPoint}. `srcFrames` resolves an "to source end"
 * outPoint (< 0) to an absolute frame so trimming the right edge works on it.
 *
 * - `slide`      — move the whole bar: startFrame += delta (floored at 0).
 * - `trim-left`  — move the LEFT edge: startFrame += delta AND inPoint += delta,
 *                  so the right edge (startFrame + length) stays put. Clamped so
 *                  inPoint >= 0, startFrame >= 0, and length stays >= 1.
 * - `trim-right` — move the RIGHT edge: outPoint = effectiveOut + delta, clamped
 *                  so length stays >= 1. startFrame + inPoint unchanged.
 *
 * Pure + total: any delta yields a valid bar (the invariants are clamped here,
 * not at the call site), so the component just renders the result.
 */
export function applyBarDrag(
  p: LayerBarParams,
  srcFrames: number,
  mode: BarDragMode,
  deltaFrames: number,
): LayerBarParams {
  const effectiveOut = p.outPoint < 0 ? srcFrames : p.outPoint;
  switch (mode) {
    case 'slide': {
      return { ...p, startFrame: Math.max(0, p.startFrame + deltaFrames) };
    }
    case 'trim-left': {
      // delta clamped so inPoint+delta ∈ [0, effectiveOut-1] and startFrame+delta >= 0.
      const lo = Math.max(-p.inPoint, -p.startFrame);
      const hi = effectiveOut - 1 - p.inPoint;
      const d = deltaFrames < lo ? lo : deltaFrames > hi ? hi : deltaFrames;
      return { startFrame: p.startFrame + d, inPoint: p.inPoint + d, outPoint: p.outPoint };
    }
    case 'trim-right': {
      // newOut >= inPoint + 1 (length >= 1).
      const newOut = Math.max(p.inPoint + 1, effectiveOut + deltaFrames);
      return { ...p, outPoint: newOut };
    }
  }
}

// ── Playhead transport (video-mode scrub) ────────────────────────────────────
// The global playhead (timeStore, in seconds at GLOBAL_FPS) is the ONE clock the
// composite reads. The comp works in its own fps, so the playhead ruler + the
// viewer + a ruler-scrub must agree on a single global↔comp mapping. These pure
// helpers are that single map (H95: the transport e2e mirrors them).

/**
 * The global playhead frame (timeStore frames at `globalFps`) → this comp's
 * frame, clamped to [0, totalFrames]. The drawn ruler playhead and the
 * composited frame both route through this, so they never disagree.
 */
export function globalFrameToCompFrame(
  globalFrame: number,
  globalFps: number,
  compFps: number,
  totalFrames: number,
): number {
  const f = Math.round((globalFrame / globalFps) * compFps);
  return f < 0 ? 0 : f > totalFrames ? totalFrames : f;
}

/**
 * A comp frame → the global playhead time in SECONDS (what `timeStore.setTime`
 * takes). Inverse of the comp-frame mapping; a ruler scrub routes through this
 * so a click lands on the same frame the playhead draws.
 */
export function compFrameToSeconds(compFrame: number, compFps: number): number {
  return compFps > 0 ? compFrame / compFps : 0;
}

/**
 * A pixel offset along the track → the comp frame under it, clamped to
 * [0, totalFrames]. Inverse of `frameToPercent` against the live track width
 * (the scrub equivalent of `xDeltaToFrameDelta`). Zero/negative width → frame 0.
 */
export function xToCompFrame(offsetX: number, trackWidthPx: number, totalFrames: number): number {
  if (trackWidthPx <= 0) return 0;
  const f = Math.round((offsetX / trackWidthPx) * Math.max(totalFrames, 1));
  return f < 0 ? 0 : f > totalFrames ? totalFrames : f;
}

/**
 * The comp's playable duration in seconds — used to size the global playhead
 * range while in video mode so playback loops at the comp boundary (not the
 * unrelated 3D default). `compFps <= 0` is degenerate → 0.
 */
export function compDurationSeconds(totalFrames: number, compFps: number): number {
  return compFps > 0 ? totalFrames / compFps : 0;
}
