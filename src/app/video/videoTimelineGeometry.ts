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

/** Width of the left layer-outline column (names + toggles), in CSS px. */
export const OUTLINE_WIDTH_PX = 220;
/** Height of one layer row, in CSS px. */
export const ROW_HEIGHT_PX = 28;
/** Height of the frame ruler atop the track area, in CSS px. */
export const RULER_HEIGHT_PX = 22;

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
