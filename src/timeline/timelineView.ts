// timelineView — the SHARED zoom/pan model for the dopesheet (canvas) AND the
// curve editor (SVG). UX-BACKLOG #11: the two tabs are kept separate surfaces
// but read ONE view state, so switching tabs holds the same visible time
// window (the "unify" reframed as a shared view, not a shared canvas).
//
// THE MODEL (pure, V8-clean — no DOM, no store, no React):
//   view = { zoom, scroll }
//     zoom   ≥ 1 — 1 fits the whole [0, totalFrames] in the track width; N
//                  shows 1/N of the timeline.
//     scroll ∈ [0,1] — fraction of the OFF-SCREEN timeline scrolled past the
//                  left edge (0 = start, 1 = the right edge sits at the end).
//
// DEFAULT-VIEW PARITY (the e2e-safety invariant): at {zoom:1, scroll:0} with a
// baked edge inset, `frameToX` reproduces `timelineCanvasGeometry.keyframeToRect`
// EXACTLY (proof: inset + (frame/total)·(width−2·inset) is the same affine map).
// So the geometry-pinned e2e (p7.1, p7.12) and the cull contract (p6-w9) hold
// unchanged; only zoom>1 / scroll>0 introduce new behaviour.
//
// Each surface applies its OWN gutter / track width / inset; only `zoom` +
// `scroll` are shared, so a given (zoom, scroll) shows the same FRAME WINDOW on
// both surfaces (seamless tab switch) even though their pixel origins differ.
//
// REF: UX-BACKLOG #11; timelineCanvasGeometry.ts (keyframeToRect parity);
//      EditableCurve.tsx + TimelineCanvas.tsx (the two consumers).

export interface TimelineView {
  /** ≥1; 1 = fit the whole timeline in the track. */
  zoom: number;
  /** 0..1; fraction of the off-screen timeline scrolled past the left edge. */
  scroll: number;
}

export const DEFAULT_VIEW: TimelineView = { zoom: 1, scroll: 0 };

/** reze time-zoom bounds expressed as a multiple of fit (1 = whole timeline). */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 60;

/** Curve-editor VALUE-axis zoom bounds (reze 0.5–8×). Time zoom is shared;
 *  value zoom is curve-only, but lives here so both bounds are in one place. */
export const MIN_VALUE_ZOOM = 0.5;
export const MAX_VALUE_ZOOM = 8;

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The visible frame window [startFrame, endFrame] for a view over a timeline
 *  of `totalFrames`. At zoom 1 → [0, totalFrames]. */
export function visibleFrames(
  totalFrames: number,
  view: TimelineView,
): { startFrame: number; endFrame: number } {
  const total = Math.max(totalFrames, EPS);
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const span = total / zoom;
  const maxStart = Math.max(total - span, 0);
  const startFrame = clamp(view.scroll, 0, 1) * maxStart;
  return { startFrame, endFrame: startFrame + span };
}

/**
 * Map a frame to a CSS-px x within a surface's track. `insetPx` is a fixed
 * margin reserved on EACH side of the track so a terminal keyframe lands flush
 * (the keyframeToRect edge-inset, baked here for default-view parity).
 */
export function frameToX(
  frame: number,
  totalFrames: number,
  view: TimelineView,
  gutterPx: number,
  trackWidthPx: number,
  insetPx = 0,
): number {
  if (trackWidthPx <= 0) return gutterPx;
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  const span = Math.max(endFrame - startFrame, EPS);
  const inset = Math.min(insetPx, trackWidthPx / 2);
  const innerWidth = trackWidthPx - 2 * inset;
  return gutterPx + inset + ((frame - startFrame) / span) * innerWidth;
}

/** Inverse of frameToX — a track-px x back to a (possibly fractional) frame. */
export function xToFrame(
  x: number,
  totalFrames: number,
  view: TimelineView,
  gutterPx: number,
  trackWidthPx: number,
  insetPx = 0,
): number {
  if (trackWidthPx <= 0) return 0;
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  const span = Math.max(endFrame - startFrame, EPS);
  const inset = Math.min(insetPx, trackWidthPx / 2);
  const innerWidth = Math.max(trackWidthPx - 2 * inset, EPS);
  return startFrame + ((x - gutterPx - inset) / innerWidth) * span;
}

/**
 * Re-zoom while keeping `anchorFrame` pinned under the same screen x (reze's
 * "zoom anchored on the playhead"). Returns the new view; scroll is solved so
 * the anchor's screen fraction is preserved.
 */
export function zoomAtFrame(
  view: TimelineView,
  totalFrames: number,
  anchorFrame: number,
  nextZoom: number,
): TimelineView {
  const total = Math.max(totalFrames, EPS);
  const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  const spanOld = Math.max(endFrame - startFrame, EPS);
  const frac = clamp((anchorFrame - startFrame) / spanOld, 0, 1);
  const spanNew = total / z;
  const startNew = anchorFrame - frac * spanNew;
  const maxStart = Math.max(total - spanNew, 0);
  const scroll = maxStart <= 0 ? 0 : clamp(startNew / maxStart, 0, 1);
  return { zoom: z, scroll };
}

/**
 * Pan by a pixel delta (plain-wheel horizontal scroll). `deltaPx` > 0 scrolls
 * the content LEFT (reveals later frames), matching natural wheel/trackpad.
 */
export function panByPixels(
  view: TimelineView,
  totalFrames: number,
  deltaPx: number,
  trackWidthPx: number,
): TimelineView {
  const total = Math.max(totalFrames, EPS);
  const { startFrame, endFrame } = visibleFrames(totalFrames, view);
  const span = Math.max(endFrame - startFrame, EPS);
  const maxStart = Math.max(total - span, 0);
  if (maxStart <= 0 || trackWidthPx <= 0) return view;
  const deltaFrames = (deltaPx / trackWidthPx) * span;
  const scroll = clamp((startFrame + deltaFrames) / maxStart, 0, 1);
  return { zoom: view.zoom, scroll };
}
