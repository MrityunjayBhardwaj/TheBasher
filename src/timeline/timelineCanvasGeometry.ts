// Timeline-canvas geometry — pure layout math (D-W9-4).
//
// The old Dopesheet re-derived its layout math inline, per render, with
// `left = (t / Math.max(duration, 0.0001)) * 100%` repeated at three call
// sites (Dopesheet.tsx:111, :127, :224) and an 8x8 diamond hard-coded at
// :225-226. That made the layout math untestable and forced every future
// canvas shell to re-derive it — the D-W9-4 anti-pattern.
//
// This module consolidates that math into one place. It is the single
// source of truth for "where does pixel X go". The TimelineCanvas shell
// (C3 static layer, C4 rAF playhead) is a thin imperative wrapper over
// these functions and must NOT re-derive any of this inline.
//
// CONTRACT — CSS pixels only. Every input and output here is in CSS px.
// Device-pixel-ratio scaling is C3's concern (it scales the canvas
// backing store and calls ctx.scale(dpr,dpr) so draw code stays in CSS
// px). There is deliberately NO `dpr` parameter anywhere in this module:
// geometry is resolution-independent by construction.
//
// Frame-space vs seconds-space (the C2 pre-mortem — off-by-one risk):
// `frame` is INTEGER (mirrors timeStore.deriveFrame; used for the
// currentFrameRef escape hatch + the `data-playhead-px` / readout). The
// playhead itself is drawn from CONTINUOUS seconds (`secondsToX`) for
// sub-frame smoothness. These are distinct functions with distinct names
// on purpose — never collapse them.
//
// PURITY: no DOM, no store reads, no React, no imports. Inputs -> numbers
// or plain rects. Same args in -> strictly-equal result out (determinism).
//
// REF: D-W9-4, D-W9-6; vyapti V8 (reads no DAG, dispatches nothing).

/**
 * Zero-duration / zero-width guard epsilon.
 *
 * Mirrors the `Math.max(duration, 0.0001)` precedent from the old
 * Dopesheet (Dopesheet.tsx:111, :127): a zero or negative span would
 * divide-by-zero into NaN/Infinity. Clamping the denominator to a tiny
 * positive value collapses every keyframe to x=0 instead — a degenerate
 * but finite, NaN-free layout.
 */
const SPAN_EPSILON = 0.0001;

/**
 * Half-width (CSS px) of the playhead dirty strip C4 restores+strokes.
 *
 * The playhead is a 1px stroke. Anti-aliasing bleeds the stroke ~0.5px
 * either side of the geometric x, and sub-pixel x positions smear it
 * further. A half-width of 2px gives a 4px-wide strip: 1px stroke +
 * ~0.5px AA each side + sub-pixel slack, so `drawImage(offscreen,
 * strip, strip)` fully covers and restores the static pixels the old
 * playhead line touched. Widening this is cheap (a few px of redraw);
 * making it too narrow leaves a 1px erase artifact trailing the
 * playhead — so err wide.
 */
export const PLAYHEAD_STRIP_HALF_WIDTH_PX = 2;

/**
 * Edge inset (CSS px) the keyframe-diamond geometry reserves on EACH side
 * of the track so a terminal keyframe (t=0 or t=duration) sits flush and
 * FULLY visible against the canvas edge instead of half-clipped off it.
 *
 * WHY (UIR F-7 / FLAG-2 escape): `secondsToX` maps [0,dur]→[0,widthPx];
 * a diamond centered on that puts t=0 at x∈[-diamond/2,+diamond/2] (half
 * behind the row-label gutter / off the left edge) and t=dur at
 * x∈[widthPx-diamond/2, widthPx+diamond/2] (half off the right edge). The
 * frame-0 keyframe — the single most common keyframe in any animation —
 * is therefore half-invisible. The W9 e2e passed blind because
 * `data-rendered-keyframes` counts culled entries (2), not painted pixels
 * (1 visible) — a concrete escape of the FLAG-2 count≠pixels gap.
 *
 * Set to HALF the production diamond box (DIAMOND_PX = 8, TimelineCanvas
 * .tsx) so a terminal diamond's outer edge lands exactly on the canvas
 * edge (flush, fully visible, zero wasted margin). `keyframeToRect` takes
 * `diamondPx` as a parameter though, so it uses `max(this, diamondPx/2)`
 * as the EFFECTIVE inset — a larger-than-default diamond still cannot
 * clip off the edge (the invariant "terminal diamond fully visible" holds
 * for ANY diamond size, not just the default 8px). Applied ONLY in
 * `keyframeToRect` — `secondsToX` and the playhead path (a 1px line,
 * visible at x=0 anyway, and a shipped FLAG-2-verified contract) are
 * deliberately NOT inset, keeping the blast radius to the diamond
 * geometry alone.
 */
export const KEYFRAME_EDGE_INSET_PX = 4;

/** A non-negative, finite pixel rect in CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert continuous seconds to an integer frame index.
 *
 * Mirrors `timeStore.deriveFrame` (= `Math.round(seconds * 60)`), but
 * `fps` is INJECTED, not hard-coded — that is the whole testability win
 * over the inline version. Used for the `currentFrameRef` escape hatch
 * and the `data-playhead-px`-derived frame / readout. NOT used to draw
 * the playhead (that uses continuous seconds — see `secondsToX`).
 */
export function secondsToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Linear map from an integer frame to a CSS-px x within `widthPx`.
 *
 * Clamps `frame` to `[0, totalFrames]` so out-of-range frames pin to the
 * track edges instead of overflowing. Zero-guarded on both `totalFrames`
 * and `widthPx`: a zero (or negative) span or width returns 0 — finite,
 * never NaN/Infinity (the Dopesheet `Math.max` precedent generalized).
 */
export function frameToX(
  frame: number,
  totalFrames: number,
  widthPx: number,
): number {
  if (widthPx <= 0) return 0;
  const span = Math.max(totalFrames, SPAN_EPSILON);
  const clamped = frame < 0 ? 0 : frame > span ? span : frame;
  return (clamped / span) * widthPx;
}

/**
 * Linear map from continuous seconds to a CSS-px x within `widthPx`.
 *
 * This is the PLAYHEAD path: time is continuous, so the playhead moves
 * smoothly between frame boundaries (sub-frame). Same clamp + zero-guard
 * discipline as `frameToX`. Kept a distinct function from `frameToX`
 * deliberately (the C2 off-by-one pre-mortem) — the playhead and the
 * frame readout must never be derived through the same code path.
 */
export function secondsToX(
  seconds: number,
  durationSeconds: number,
  widthPx: number,
): number {
  if (widthPx <= 0) return 0;
  const span = Math.max(durationSeconds, SPAN_EPSILON);
  const clamped = seconds < 0 ? 0 : seconds > span ? span : seconds;
  return (clamped / span) * widthPx;
}

/**
 * Rect (CSS px) for a single keyframe diamond.
 *
 * Generalizes the old inline diamond: Dopesheet drew an 8x8 box centered
 * on `left = (time/duration)*100%` and on the row's vertical middle
 * (`top-1/2 -translate-1/2`, Dopesheet.tsx:220-226). Here the center x
 * comes from `secondsToX` (shared with the playhead's seconds-space, so
 * a diamond at time t sits exactly under the playhead at time t), and
 * the rect is the `diamondPx`-sized box centered on
 * (centerX, rowMiddleY). The canvas shell draws the rotated diamond
 * within this box.
 */
export function keyframeToRect(
  timeSeconds: number,
  rowIndex: number,
  durationSeconds: number,
  widthPx: number,
  rowHeightPx: number,
  diamondPx: number,
): Rect {
  // UIR F-7: inset the time→x map by KEYFRAME_EDGE_INSET_PX on EACH side so
  // a terminal diamond (t=0 / t=dur) lands flush-and-fully-visible against
  // the canvas edge instead of half-clipped. Map into
  // [inset, widthPx - inset] instead of [0, widthPx]. Zero-guard: if the
  // canvas is too narrow to hold both insets (widthPx - 2*inset <= 0), fall
  // back to the un-inset map (which is itself zero-guarded → 0), preserving
  // the existing NaN-free degenerate-layout discipline. secondsToX itself
  // is NOT modified — the inset lives here only, so the playhead path
  // (secondsToX direct) is provably untouched.
  // Effective inset = at least half the diamond, so a terminal diamond of
  // ANY size lands fully on-canvas (not just the default 8px box). For the
  // production DIAMOND_PX=8 this is exactly KEYFRAME_EDGE_INSET_PX (=4).
  const inset = Math.max(KEYFRAME_EDGE_INSET_PX, diamondPx / 2);
  const innerWidth = widthPx - 2 * inset;
  const centerX =
    innerWidth > 0
      ? inset + secondsToX(timeSeconds, durationSeconds, innerWidth)
      : secondsToX(timeSeconds, durationSeconds, widthPx);
  const rowTop = rowIndex * rowHeightPx;
  const centerY = rowTop + rowHeightPx / 2;
  return {
    x: centerX - diamondPx / 2,
    y: centerY - diamondPx / 2,
    w: diamondPx,
    h: diamondPx,
  };
}

/**
 * Pixel→seconds — the EXACT inverse of `keyframeToRect`'s center-x map
 * (D-07, Phase 7.1 keyframe drag-to-retime).
 *
 * This inverts the DIAMOND center-x mapping, NOT bare `secondsToX`. The
 * bare map is the playhead path and is deliberately NOT inset (see
 * KEYFRAME_EDGE_INSET_PX doc); the diamonds a director grabs ARE inset by
 * `Math.max(KEYFRAME_EDGE_INSET_PX, diamondPx/2)` exactly as
 * `keyframeToRect:177-182` applies it. An inset-blind inverse would drift
 * by the inset at the track edges — grabbing/dropping the t=0 or
 * t=duration key would be off (the F-7 / H35-family trap). So this undoes
 * the inset identically, INCLUDING `keyframeToRect`'s degenerate
 * `innerWidth <= 0` else-branch (which used the un-inset
 * `secondsToX(t,dur,widthPx)`), so the round-trip holds even when the
 * canvas is too narrow to hold both insets.
 *
 * CSS px only. Pure (no DOM, no store, no React, no dpr) — same V8
 * contract as the rest of this module. Clamps the input x into the valid
 * band so an out-of-track cursor pins to [0, durationSeconds] (never NaN,
 * never overshoot).
 */
export function xToSeconds(
  xPx: number,
  durationSeconds: number,
  widthPx: number,
  diamondPx: number,
): number {
  if (widthPx <= 0) return 0;
  const span = Math.max(durationSeconds, SPAN_EPSILON);
  const inset = Math.max(KEYFRAME_EDGE_INSET_PX, diamondPx / 2);
  const innerWidth = widthPx - 2 * inset;
  if (innerWidth <= 0) {
    // Degenerate fallback mirrors keyframeToRect's else-branch (which
    // used the un-inset secondsToX(t,dur,widthPx)): invert THAT branch
    // so the round-trip still holds when the canvas is too narrow.
    const c = xPx < 0 ? 0 : xPx > widthPx ? widthPx : xPx;
    return (c / widthPx) * span;
  }
  // Invert: centerX = inset + (clamp(t,0,span)/span) * innerWidth
  const rel = xPx - inset;
  const clamped = rel < 0 ? 0 : rel > innerWidth ? innerWidth : rel;
  return (clamped / innerWidth) * span;
}

/**
 * Cull keyframes to those within the visible seconds range, INCLUSIVE.
 *
 * Returns the INDICES (not the keyframes) of every entry whose
 * `timeSeconds` is in `[visibleStartSec, visibleEndSec]` — the caller
 * maps the index back to its channel/keyframe id. `result.length` is
 * exactly the `data-rendered-keyframes` mirror attr (D-W9-4): the count
 * of diamonds actually painted, so narrowing the visible range provably
 * reduces the rendered count.
 *
 * Bounds are inclusive on BOTH ends so a keyframe sitting exactly on a
 * visible-range edge is drawn (a half-clipped diamond at the edge is
 * better than a vanished one).
 */
export function cullVisibleKeyframes(
  keyframes: ReadonlyArray<{ timeSeconds: number }>,
  visibleStartSec: number,
  visibleEndSec: number,
): { index: number }[] {
  const out: { index: number }[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const t = keyframes[i].timeSeconds;
    if (t >= visibleStartSec && t <= visibleEndSec) {
      out.push({ index: i });
    }
  }
  return out;
}

/**
 * The narrow dirty strip C4 restores (`drawImage`) then strokes the
 * playhead into (D-W9-3). Spans the FULL canvas height (the playhead is
 * a vertical line) and is `2 * stripHalfWidthPx` wide, centered on
 * `xPx`.
 *
 * Clamped to the canvas box: the strip never starts before x=0 nor
 * extends past `canvasHeightPx` / the right edge is the caller's canvas
 * width concern (the strip's right extent is bounded by where the
 * playhead can be, which `secondsToX`/`frameToX` already clamp into the
 * canvas). x is floored at 0 and the width is trimmed if the strip would
 * start left of the canvas, so the returned rect is always inside the
 * canvas bounds — never negative x, never negative w.
 */
export function playheadStripRect(
  xPx: number,
  stripHalfWidthPx: number,
  canvasHeightPx: number,
): Rect {
  const rawLeft = xPx - stripHalfWidthPx;
  const left = rawLeft < 0 ? 0 : rawLeft;
  // If the raw strip started left of 0, trim the overflow off the width
  // so the rect stays inside the canvas (never wider than intended,
  // never negative).
  const fullWidth = stripHalfWidthPx * 2;
  const width = rawLeft < 0 ? Math.max(fullWidth + rawLeft, 0) : fullWidth;
  const height = canvasHeightPx < 0 ? 0 : canvasHeightPx;
  return { x: left, y: 0, w: width, h: height };
}
