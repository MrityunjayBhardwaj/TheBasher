// Exhaustive unit tests for the pure timeline-canvas geometry module
// (C2 / D-W9-4). The canvas shell (C3/C4) is a thin imperative wrapper
// over these functions, so correctness is proven HERE — jsdom cannot run
// a real 2D canvas (H32: do not fake-test pixels).
//
// Coverage per the W9 plan C2 section:
//  - frame boundary: 0 / last / > total clamps
//  - zero-width canvas -> 0 (no NaN/Infinity)
//  - zero duration -> Math.max guard precedent
//  - culling: empty / all-in / all-out / partial / exact-boundary inclusive
//  - strip rect never exceeds canvas bounds
//  - CSS-px-only contract (no dpr param anywhere in the module)
//  - determinism (every fn twice, same args -> strictly equal)
//  - pre-mortem observation: frameToX(secondsToFrame(s,60),N,W)
//    ~= secondsToX(s,dur,W) within 1px at frame boundaries

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const MODULE_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/timeline/timelineCanvasGeometry.ts'),
  'utf8',
);
import {
  secondsToFrame,
  frameToX,
  secondsToX,
  keyframeToRect,
  xToSeconds,
  cullVisibleKeyframes,
  playheadStripRect,
  PLAYHEAD_STRIP_HALF_WIDTH_PX,
  KEYFRAME_EDGE_INSET_PX,
} from './timelineCanvasGeometry';

const isFinitePositiveOrZero = (n: number) =>
  Number.isFinite(n) && !Number.isNaN(n) && n >= 0;

describe('secondsToFrame', () => {
  it('mirrors deriveFrame = round(seconds * fps) with fps injected', () => {
    expect(secondsToFrame(0, 60)).toBe(0);
    expect(secondsToFrame(1, 60)).toBe(60);
    expect(secondsToFrame(2.5, 60)).toBe(150);
    // round, not floor (matches timeStore.deriveFrame)
    expect(secondsToFrame(0.999, 60)).toBe(60); // 59.94 -> 60
    expect(secondsToFrame(0.008, 60)).toBe(0); // 0.48 -> 0
  });

  it('honors the injected fps (not hard-coded 60)', () => {
    expect(secondsToFrame(1, 24)).toBe(24);
    expect(secondsToFrame(1, 30)).toBe(30);
    expect(secondsToFrame(2, 25)).toBe(50);
  });

  it('is finite for negative seconds', () => {
    expect(secondsToFrame(-1, 60)).toBe(-60);
    expect(Number.isFinite(secondsToFrame(-0.5, 60))).toBe(true);
  });
});

describe('frameToX — boundary + clamp + zero-guard', () => {
  it('frame 0 -> x 0', () => {
    expect(frameToX(0, 600, 1000)).toBe(0);
  });

  it('last frame -> full width', () => {
    expect(frameToX(600, 600, 1000)).toBe(1000);
  });

  it('mid frame -> linear', () => {
    expect(frameToX(300, 600, 1000)).toBe(500);
  });

  it('frame > totalFrames clamps to width (no overflow)', () => {
    expect(frameToX(9999, 600, 1000)).toBe(1000);
  });

  it('negative frame clamps to 0', () => {
    expect(frameToX(-50, 600, 1000)).toBe(0);
  });

  it('zero-width canvas -> 0 (no NaN / Infinity)', () => {
    const r = frameToX(300, 600, 0);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
    expect(Number.isFinite(r)).toBe(true);
  });

  it('negative width -> 0', () => {
    expect(frameToX(300, 600, -100)).toBe(0);
  });

  it('zero totalFrames -> finite via Math.max guard (no /0 = Infinity)', () => {
    const r = frameToX(0, 0, 1000);
    expect(Number.isFinite(r)).toBe(true);
    expect(Number.isNaN(r)).toBe(false);
    // span clamps to epsilon; frame 0 still maps to 0
    expect(r).toBe(0);
  });

  it('negative totalFrames -> finite (guarded)', () => {
    const r = frameToX(5, -10, 1000);
    expect(Number.isFinite(r)).toBe(true);
    expect(Number.isNaN(r)).toBe(false);
  });
});

describe('secondsToX — boundary + clamp + zero-guard', () => {
  it('seconds 0 -> x 0', () => {
    expect(secondsToX(0, 10, 1000)).toBe(0);
  });

  it('duration end -> full width', () => {
    expect(secondsToX(10, 10, 1000)).toBe(1000);
  });

  it('sub-frame continuity: 2.5s of 10s -> quarter width', () => {
    expect(secondsToX(2.5, 10, 1000)).toBe(250);
  });

  it('seconds > duration clamps to width', () => {
    expect(secondsToX(999, 10, 1000)).toBe(1000);
  });

  it('negative seconds clamps to 0', () => {
    expect(secondsToX(-3, 10, 1000)).toBe(0);
  });

  it('zero-width canvas -> 0 (no NaN)', () => {
    const r = secondsToX(5, 10, 0);
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });

  it('zero duration -> Math.max(duration, eps) guard, finite', () => {
    const r = secondsToX(5, 0, 1000);
    expect(Number.isFinite(r)).toBe(true);
    expect(Number.isNaN(r)).toBe(false);
    // 5 > eps so it clamps to the (epsilon) span end = full width, finite
    expect(r).toBe(1000);
  });

  it('zero duration AND zero seconds -> 0, finite', () => {
    const r = secondsToX(0, 0, 1000);
    expect(r).toBe(0);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe('keyframeToRect — diamond box (generalizes Dopesheet 8x8)', () => {
  it('centers an 8x8 diamond on (inset secondsToX, row middle)', () => {
    // UIR F-7: inset=4 → innerWidth = 1000-8 = 992; time 5 of 10s over
    // 992px -> 496, +inset 4 -> centerX 500 (midpoint is symmetric, so
    // the inset leaves it unchanged); row 2 of 24px rows -> rowTop 48,
    // centerY 60; 8px box -> x 496 y 56 w8 h8.
    const r = keyframeToRect(5, 2, 10, 1000, 24, 8);
    expect(r).toEqual({ x: 496, y: 56, w: 8, h: 8 });
  });

  it('row 0 keyframe at t=0 -> box edge-inset, fully on-canvas', () => {
    // UIR F-7 (the fix): old behavior put this at x:-4 (half off the
    // left edge / behind the label gutter). With the edge inset the
    // diamond center is at x=inset=4, so x = 4 - 8/2 = 0 — flush and
    // fully visible, never negative.
    const r = keyframeToRect(0, 0, 10, 1000, 24, 8);
    expect(r).toEqual({ x: 0, y: 8, w: 8, h: 8 });
  });

  // ── UIR F-7: terminal keyframes fully visible (the FLAG-2 escape) ────────
  it('UIR F-7: t=0 keyframe rect is fully on-canvas (rect.x >= 0)', () => {
    // Sweep several track widths + diamond sizes — the most common
    // keyframe in any animation (frame 0) must never clip off the left.
    for (const w of [200, 480, 1000, 1920]) {
      for (const d of [6, 8, 12]) {
        const r = keyframeToRect(0, 0, 10, w, 24, d);
        expect(r.x).toBeGreaterThanOrEqual(0);
        // and with inset == d/2 it lands flush (left edge exactly at 0)
        if (KEYFRAME_EDGE_INSET_PX === d / 2) {
          expect(r.x).toBe(0);
        }
      }
    }
  });

  it('UIR F-7: t=duration keyframe right edge <= widthPx (fully visible)', () => {
    for (const w of [200, 480, 1000, 1920]) {
      for (const d of [6, 8, 12]) {
        const r = keyframeToRect(10, 0, 10, w, 24, d);
        expect(r.x + r.w).toBeLessThanOrEqual(w);
        if (KEYFRAME_EDGE_INSET_PX === d / 2) {
          // flush against the right edge, zero wasted margin
          expect(r.x + r.w).toBe(w);
        }
      }
    }
  });

  it('UIR F-7: interior keyframe center stays monotonic & proportional between the insets', () => {
    const w = 1000;
    const inset = KEYFRAME_EDGE_INSET_PX;
    const cx = (t: number) => {
      const r = keyframeToRect(t, 0, 10, w, 24, 8);
      return r.x + r.w / 2;
    };
    const c0 = cx(0);
    const cMid = cx(5);
    const cEnd = cx(10);
    // bounded strictly inside [inset, w - inset]
    expect(c0).toBeCloseTo(inset, 10);
    expect(cEnd).toBeCloseTo(w - inset, 10);
    // monotone increasing through the interior
    expect(cMid).toBeGreaterThan(c0);
    expect(cEnd).toBeGreaterThan(cMid);
    // proportional: t=5 of 10s is the exact midpoint of [inset, w-inset]
    expect(cMid).toBeCloseTo((inset + (w - inset)) / 2, 10);
    // quarter point is proportionally placed too
    expect(cx(2.5)).toBeCloseTo(inset + 0.25 * (w - 2 * inset), 10);
  });

  it('UIR F-7: degenerate widthPx <= 2*inset -> finite, no NaN/Infinity (zero-guard preserved)', () => {
    for (const w of [0, 1, KEYFRAME_EDGE_INSET_PX, 2 * KEYFRAME_EDGE_INSET_PX]) {
      const r = keyframeToRect(5, 1, 10, w, 24, 8);
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isNaN(r.x)).toBe(false);
      expect(Number.isFinite(r.y)).toBe(true);
      expect(Number.isFinite(r.w)).toBe(true);
      expect(Number.isFinite(r.h)).toBe(true);
    }
  });

  it('UIR F-7: deterministic — same args twice -> deep-equal rect', () => {
    expect(keyframeToRect(0, 0, 10, 1000, 24, 8)).toEqual(
      keyframeToRect(0, 0, 10, 1000, 24, 8),
    );
    expect(keyframeToRect(10, 3, 10, 480, 24, 8)).toEqual(
      keyframeToRect(10, 3, 10, 480, 24, 8),
    );
  });

  it('exports a documented edge-inset constant = half the diamond box', () => {
    expect(KEYFRAME_EDGE_INSET_PX).toBeGreaterThan(0);
    expect(Number.isInteger(KEYFRAME_EDGE_INSET_PX)).toBe(true);
    expect(KEYFRAME_EDGE_INSET_PX).toBe(4); // half the 8px Dopesheet diamond
  });

  it('shares the seconds-space x with the playhead at the midpoint', () => {
    // The diamond is intentionally inset relative to the raw secondsToX
    // map (UIR F-7) so terminal keyframes are not clipped; at the exact
    // midpoint the inset is symmetric, so a t=mid diamond still sits
    // under the playhead (secondsToX, un-inset) at that same t.
    const r = keyframeToRect(5, 0, 10, 1000, 24, 8);
    const playheadX = secondsToX(5, 10, 1000);
    expect(r.x + r.w / 2).toBeCloseTo(playheadX, 10);
  });

  it('zero duration -> finite rect (no NaN)', () => {
    const r = keyframeToRect(5, 1, 0, 1000, 24, 8);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isNaN(r.x)).toBe(false);
  });

  it('zero-width canvas -> finite rect', () => {
    const r = keyframeToRect(5, 1, 10, 0, 24, 8);
    expect(Number.isFinite(r.x)).toBe(true);
  });
});

describe('xToSeconds (D-07 inverse) — exact inverse of keyframeToRect center-x', () => {
  // The proof xToSeconds is the TRUE inverse: derive x from
  // keyframeToRect EXACTLY as the canvas does (NOT secondsToX — an
  // inset-blind inverse would PASS a secondsToX round-trip but FAIL the
  // t=0 / t=duration edges, which is exactly the F-7/H35 trap D-07 guards).
  const DUR = 10;
  const W = 400;
  const D = 8;
  // The SAME centerX the canvas computes for time t.
  const centerXOf = (t: number) => {
    const r = keyframeToRect(t, 0, DUR, W, 24, D);
    return r.x + D / 2;
  };

  it('interior round-trip within 1e-9', () => {
    for (const t of [0.5, 1.0, 3.333, 7.7, 9.5]) {
      const back = xToSeconds(centerXOf(t), DUR, W, D);
      expect(Math.abs(back - t)).toBeLessThan(1e-9);
    }
  });

  it('F-7 edges: t=0 and t=duration round-trip within 1e-9', () => {
    // These are the terminal keyframes the inset exists for; an
    // inset-blind inverse fails HERE specifically.
    const back0 = xToSeconds(centerXOf(0), DUR, W, D);
    expect(Math.abs(back0 - 0)).toBeLessThan(1e-9);
    const backEnd = xToSeconds(centerXOf(DUR), DUR, W, D);
    expect(Math.abs(backEnd - DUR)).toBeLessThan(1e-9);
  });

  it('clamps below the left inset to 0 and past (width - inset) to duration', () => {
    expect(xToSeconds(-50, DUR, W, D)).toBe(0);
    expect(xToSeconds(0, DUR, W, D)).toBe(0); // exactly at x=0 (< inset) → 0
    const past = xToSeconds(W + 100, DUR, W, D);
    expect(past).toBe(DUR);
    expect(Number.isNaN(past)).toBe(false);
  });

  it('degenerate widthPx <= 0 -> 0 (finite, no NaN)', () => {
    expect(xToSeconds(123, DUR, 0, D)).toBe(0);
    expect(xToSeconds(123, DUR, -100, D)).toBe(0);
  });

  it('degenerate widthPx - 2*inset <= 0 -> finite, clean round-trip vs keyframeToRect else-branch', () => {
    // width 6, diamond 8 → inset 4, innerWidth = 6-8 = -2 ≤ 0; both
    // keyframeToRect and xToSeconds fall back to the un-inset map.
    const narrowW = 6;
    for (const t of [0, 3, 7, 10]) {
      const r = keyframeToRect(t, 0, DUR, narrowW, 24, D);
      const cx = r.x + D / 2;
      const back = xToSeconds(cx, DUR, narrowW, D);
      expect(Number.isFinite(back)).toBe(true);
      expect(Number.isNaN(back)).toBe(false);
      // round-trips against the else-branch (un-inset secondsToX over
      // widthPx, clamped) within 1e-9
      const span = Math.max(DUR, 0.0001);
      const expected = (Math.min(Math.max(cx, 0), narrowW) / narrowW) * span;
      expect(Math.abs(back - expected)).toBeLessThan(1e-9);
    }
  });

  it('deterministic — same args twice -> strictly equal', () => {
    expect(xToSeconds(123, DUR, W, D)).toBe(xToSeconds(123, DUR, W, D));
  });
});

describe('cullVisibleKeyframes — returns indices, inclusive bounds', () => {
  const kfs = [
    { timeSeconds: 0 },
    { timeSeconds: 1 },
    { timeSeconds: 2 },
    { timeSeconds: 3 },
    { timeSeconds: 4 },
  ];

  it('empty input -> empty result', () => {
    expect(cullVisibleKeyframes([], 0, 10)).toEqual([]);
  });

  it('all-in: every keyframe inside range', () => {
    const r = cullVisibleKeyframes(kfs, 0, 10);
    expect(r).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ]);
    expect(r.length).toBe(kfs.length); // == data-rendered-keyframes
  });

  it('all-out: every keyframe outside range', () => {
    expect(cullVisibleKeyframes(kfs, 100, 200)).toEqual([]);
  });

  it('partial: only middle keyframes survive', () => {
    expect(cullVisibleKeyframes(kfs, 1.5, 3.5)).toEqual([
      { index: 2 },
      { index: 3 },
    ]);
  });

  it('exact lower boundary is INCLUSIVE', () => {
    // start exactly on kf time 1 -> index 1 included
    expect(cullVisibleKeyframes(kfs, 1, 1)).toEqual([{ index: 1 }]);
  });

  it('exact upper boundary is INCLUSIVE', () => {
    // range [2,4] includes both the 2 and the 4 endpoints
    expect(cullVisibleKeyframes(kfs, 2, 4)).toEqual([
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ]);
  });

  it('returns indices, not keyframe objects (caller maps back to ids)', () => {
    const r = cullVisibleKeyframes(kfs, 2, 2);
    expect(r).toEqual([{ index: 2 }]);
    expect(r[0]).not.toHaveProperty('timeSeconds');
  });

  it('preserves original index order regardless of value spacing', () => {
    const sparse = [
      { timeSeconds: 0 },
      { timeSeconds: 50 },
      { timeSeconds: 2 },
    ];
    // visible [0,3] -> originals 0 and 2 (NOT re-sorted)
    expect(cullVisibleKeyframes(sparse, 0, 3)).toEqual([
      { index: 0 },
      { index: 2 },
    ]);
  });
});

describe('playheadStripRect — never exceeds canvas bounds', () => {
  it('centered strip mid-canvas', () => {
    const r = playheadStripRect(500, 2, 300);
    expect(r).toEqual({ x: 498, y: 0, w: 4, h: 300 });
  });

  it('strip at x=0 is trimmed (never negative x, never negative w)', () => {
    const r = playheadStripRect(0, 2, 300);
    expect(r.x).toBe(0);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeGreaterThanOrEqual(0);
    // raw left = -2, trimmed: width = 4 + (-2) = 2
    expect(r).toEqual({ x: 0, y: 0, w: 2, h: 300 });
  });

  it('strip near left edge clamps x to 0', () => {
    const r = playheadStripRect(1, 2, 300);
    expect(r.x).toBe(0);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });

  it('strip fully off the left (x negative) -> zero width, x 0', () => {
    const r = playheadStripRect(-10, 2, 300);
    expect(r.x).toBe(0);
    expect(r.w).toBe(0);
    expect(r.w).toBeGreaterThanOrEqual(0);
  });

  it('negative canvas height -> height 0 (never negative)', () => {
    const r = playheadStripRect(500, 2, -50);
    expect(r.h).toBe(0);
    expect(r.h).toBeGreaterThanOrEqual(0);
  });

  it('strip spans the full canvas height (vertical playhead line)', () => {
    const r = playheadStripRect(500, 2, 480);
    expect(r.y).toBe(0);
    expect(r.h).toBe(480);
  });

  it('all rect fields finite & non-negative across a sweep', () => {
    for (let x = -20; x <= 1020; x += 7) {
      const r = playheadStripRect(x, PLAYHEAD_STRIP_HALF_WIDTH_PX, 300);
      expect(isFinitePositiveOrZero(r.x)).toBe(true);
      expect(isFinitePositiveOrZero(r.y)).toBe(true);
      expect(isFinitePositiveOrZero(r.w)).toBe(true);
      expect(isFinitePositiveOrZero(r.h)).toBe(true);
    }
  });

  it('exports a documented half-width constant wide enough for stroke + AA', () => {
    expect(PLAYHEAD_STRIP_HALF_WIDTH_PX).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(PLAYHEAD_STRIP_HALF_WIDTH_PX)).toBe(true);
  });
});

describe('CSS-px-only contract — no dpr anywhere (dpr is C3 concern)', () => {
  it('module source declares no dpr parameter / no dpr identifier', () => {
    const src = MODULE_SOURCE;
    // strip block + line comments so the documentation prose explaining
    // "no dpr param" does not trip the assertion — we assert on CODE.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/devicePixelRatio/);
    expect(code).not.toMatch(/\bdpr\b/);
  });

  it('module imports no store / DOM / React (purity)', () => {
    const src = MODULE_SOURCE;
    expect(src).not.toMatch(/from ['"].*stores/);
    expect(src).not.toMatch(/\bdocument\b/);
    expect(src).not.toMatch(/\bwindow\b/);
    expect(src).not.toMatch(/getState\(/);
    expect(src).not.toMatch(/from ['"]react['"]/);
  });
});

describe('determinism — same args twice -> strictly equal result', () => {
  it('scalar functions return === on repeat call', () => {
    expect(secondsToFrame(2.5, 60)).toBe(secondsToFrame(2.5, 60));
    expect(frameToX(123, 600, 1000)).toBe(frameToX(123, 600, 1000));
    expect(secondsToX(3.3, 10, 1000)).toBe(secondsToX(3.3, 10, 1000));
  });

  it('object-returning functions are deep-equal on repeat call', () => {
    expect(keyframeToRect(5, 2, 10, 1000, 24, 8)).toEqual(
      keyframeToRect(5, 2, 10, 1000, 24, 8),
    );
    expect(cullVisibleKeyframes([{ timeSeconds: 1 }], 0, 5)).toEqual(
      cullVisibleKeyframes([{ timeSeconds: 1 }], 0, 5),
    );
    expect(playheadStripRect(500, 2, 300)).toEqual(
      playheadStripRect(500, 2, 300),
    );
  });

  it('no hidden state — interleaved calls do not affect each other', () => {
    const a = frameToX(100, 600, 1000);
    secondsToX(7, 10, 999);
    keyframeToRect(1, 1, 10, 800, 24, 8);
    const b = frameToX(100, 600, 1000);
    expect(a).toBe(b);
  });
});

describe('pre-mortem observation — frame-space vs seconds-space within 1px', () => {
  // The off-by-one risk: the playhead is drawn from secondsToX (continuous)
  // but data-playhead-px/readout use the frame (integer). At frame
  // boundaries the two paths must converge to within 1px, or the readout
  // would disagree with the visible playhead.
  it('frameToX(secondsToFrame(s,60), N, W) ~= secondsToX(s, dur, W) at frame boundaries', () => {
    const fps = 60;
    const durationSeconds = 10;
    const totalFrames = secondsToFrame(durationSeconds, fps); // 600
    const widthPx = 1000;

    // sample exact frame-boundary seconds: every 12 frames across the range
    for (let f = 0; f <= totalFrames; f += 12) {
      const s = f / fps; // a seconds value that lands exactly on a frame
      const viaFrame = frameToX(
        secondsToFrame(s, fps),
        totalFrames,
        widthPx,
      );
      const viaSeconds = secondsToX(s, durationSeconds, widthPx);
      expect(Math.abs(viaFrame - viaSeconds)).toBeLessThanOrEqual(1);
    }
  });

  it('sub-frame seconds: secondsToX is smooth between two integer frames', () => {
    // between frame 60 (1.0s) and frame 61 (1.0166s) secondsToX must
    // produce intermediate x values (proves it is NOT frame-quantized)
    const x1 = secondsToX(1.0, 10, 1000);
    const xMid = secondsToX(1.008, 10, 1000);
    const x2 = secondsToX(1.0166, 10, 1000);
    expect(xMid).toBeGreaterThan(x1);
    expect(xMid).toBeLessThan(x2);
  });
});
