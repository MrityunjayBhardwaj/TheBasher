// nlaLaneGeometry — golden values for the NLA lane math (epic #283 Phase 5,
// inc 5A). The H95 lockstep contract: the component AND every NLA e2e import
// this module, so these units are the single behavioral spec for placement,
// drag deltas, resize, snap, and reorder math.

import { describe, it, expect } from 'vitest';
import { DEFAULT_VIEW, type TimelineView } from './timelineView';
import {
  NLA_MIN_TIMESCALE,
  stripPlacedRange,
  spanToPercent,
  secondsToPercent,
  percentToSeconds,
  xDeltaToSecondsDelta,
  snapToFrame,
  resizeRight,
  resizeLeft,
  midpointOrder,
  reorderDisabled,
} from './nlaLaneGeometry';

const FPS = 30;
const TOTAL_FRAMES = 150; // 5s timeline

describe('stripPlacedRange — end = start + actLen·timeScale·repeat (layeredChannels.ts:119)', () => {
  it('derives the placed end from the schema fields', () => {
    expect(stripPlacedRange(1, 2, 1.5, 2)).toEqual({ start: 1, end: 7 });
    expect(stripPlacedRange(0, 2, 1, 1)).toEqual({ start: 0, end: 2 });
  });
});

describe('spanToPercent — percent of the VISIBLE window (shared zoom view)', () => {
  it('maps a span at the default view (zoom 1 = whole timeline)', () => {
    // 0..2s of a 5s timeline → left 0%, width 40%.
    const { leftPct, widthPct } = spanToPercent(0, 2, FPS, TOTAL_FRAMES, DEFAULT_VIEW);
    expect(leftPct).toBeCloseTo(0, 6);
    expect(widthPct).toBeCloseTo(40, 6);
  });
  it('respects zoom: the same span doubles in percent at zoom 2', () => {
    const view: TimelineView = { zoom: 2, scroll: 0 }; // visible = frames 0..75
    const { leftPct, widthPct } = spanToPercent(1, 2, FPS, TOTAL_FRAMES, view);
    expect(leftPct).toBeCloseTo(40, 6); // 30/75
    expect(widthPct).toBeCloseTo(40, 6); // (60−30)/75
  });
  it('clamps rendering to the window edges (half off-screen → visible part only)', () => {
    const view: TimelineView = { zoom: 2, scroll: 0 }; // visible = frames 0..75 (0..2.5s)
    const { leftPct, widthPct } = spanToPercent(2, 4, FPS, TOTAL_FRAMES, view);
    expect(leftPct).toBeCloseTo(80, 6); // 60/75
    expect(widthPct).toBeCloseTo(20, 6); // right edge clamped to 100%
  });
  it('fully off-window → degenerate width 0, never negative', () => {
    const view: TimelineView = { zoom: 2, scroll: 0 }; // visible 0..2.5s
    const { widthPct } = spanToPercent(3, 4, FPS, TOTAL_FRAMES, view);
    expect(widthPct).toBe(0);
  });
});

describe('secondsToPercent / percentToSeconds — inverse pair', () => {
  it('round-trips a time through the percent map at zoom+scroll', () => {
    const view: TimelineView = { zoom: 2, scroll: 1 }; // visible = frames 75..150
    const pct = secondsToPercent(3.5, FPS, TOTAL_FRAMES, view); // frame 105 → 40%
    expect(pct).toBeCloseTo(40, 6);
    expect(percentToSeconds(pct, FPS, TOTAL_FRAMES, view)).toBeCloseTo(3.5, 9);
  });
  it('secondsToPercent is UNCLAMPED (off-window playhead maps outside 0..100)', () => {
    const view: TimelineView = { zoom: 2, scroll: 1 }; // visible 2.5..5s
    expect(secondsToPercent(0, FPS, TOTAL_FRAMES, view)).toBeLessThan(0);
  });
  it('percentToSeconds is 0-safe on fps', () => {
    expect(percentToSeconds(50, 0, TOTAL_FRAMES, DEFAULT_VIEW)).toBe(0);
  });
});

describe('xDeltaToSecondsDelta — drag px → seconds against the measured lane width', () => {
  it('converts through the visible window (default view)', () => {
    // 60px of a 600px lane = 10% of 150 visible frames = 15 frames = 0.5s.
    expect(xDeltaToSecondsDelta(60, 600, FPS, TOTAL_FRAMES, DEFAULT_VIEW)).toBeCloseTo(0.5, 9);
  });
  it('scales with zoom (same px = fewer frames when zoomed in)', () => {
    const view: TimelineView = { zoom: 2, scroll: 0 }; // 75 visible frames
    expect(xDeltaToSecondsDelta(60, 600, FPS, TOTAL_FRAMES, view)).toBeCloseTo(0.25, 9);
  });
  it('is 0-safe on laneWidthPx (returns 0, never NaN/Infinity)', () => {
    expect(xDeltaToSecondsDelta(60, 0, FPS, TOTAL_FRAMES, DEFAULT_VIEW)).toBe(0);
    expect(xDeltaToSecondsDelta(60, -10, FPS, TOTAL_FRAMES, DEFAULT_VIEW)).toBe(0);
  });
  it('is 0-safe on fps', () => {
    expect(xDeltaToSecondsDelta(60, 600, 0, TOTAL_FRAMES, DEFAULT_VIEW)).toBe(0);
  });
  it('preserves sign for leftward drags', () => {
    expect(xDeltaToSecondsDelta(-60, 600, FPS, TOTAL_FRAMES, DEFAULT_VIEW)).toBeCloseTo(-0.5, 9);
  });
});

describe('snapToFrame — the §2.1 frame-grid snap', () => {
  it('rounds to the nearest frame', () => {
    expect(snapToFrame(0.51, FPS)).toBeCloseTo(0.5, 9); // 15.3 → frame 15
    expect(snapToFrame(0.52, FPS)).toBeCloseTo(16 / 30, 9); // 15.6 → frame 16
    expect(snapToFrame(-0.51, FPS)).toBeCloseTo(-0.5, 9); // negative start is legal
  });
  it('passes through on degenerate fps', () => {
    expect(snapToFrame(0.51, 0)).toBe(0.51);
  });
});

describe('resizeRight — timeScale from the new right edge (§2.2)', () => {
  it('golden: doubling the span doubles timeScale', () => {
    expect(resizeRight(0, 2, 4, 1).timeScale).toBeCloseTo(2, 9);
  });
  it('golden: non-zero start, fractional scale', () => {
    // span 1..4 (len 3, ts 1.5) dragged to end 2 → ts·(2−1)/3 = 0.5.
    expect(resizeRight(1, 4, 2, 1.5).timeScale).toBeCloseTo(0.5, 9);
  });
  it('clamps to NLA_MIN_TIMESCALE when dragged to/past zero width', () => {
    expect(resizeRight(0, 2, 0, 1).timeScale).toBe(NLA_MIN_TIMESCALE);
    expect(resizeRight(0, 2, -1, 1).timeScale).toBe(NLA_MIN_TIMESCALE);
  });
  it('degenerate old span returns the clamped old value', () => {
    expect(resizeRight(2, 2, 3, 1).timeScale).toBe(1);
    expect(resizeRight(2, 2, 3, 0).timeScale).toBe(NLA_MIN_TIMESCALE);
  });
});

describe('resizeLeft — right edge FIXED, start recomputed AFTER the clamp (§2.2)', () => {
  it('golden: halving from the left keeps the right edge exact', () => {
    // span 0..2 (actLen 2, ts 1, repeat 1) dragged to newStart 1.
    const { start, timeScale } = resizeLeft(0, 2, 1, 1, 2, 1);
    expect(timeScale).toBeCloseTo(0.5, 9);
    expect(start).toBeCloseTo(1, 9);
    expect(start + 2 * timeScale * 1).toBeCloseTo(2, 12); // right edge invariant
  });
  it('golden: repeat > 1 participates in the recomputed start', () => {
    // span 0..4 (actLen 1, ts 2, repeat 2) dragged to newStart 2 → ts 1, start = 4 − 1·1·2 = 2.
    const { start, timeScale } = resizeLeft(0, 4, 2, 2, 1, 2);
    expect(timeScale).toBeCloseTo(1, 9);
    expect(start).toBeCloseTo(2, 9);
  });
  it('clamp bites: right edge STILL exact (start recomputed after the clamp)', () => {
    // dragged to the right edge (zero width) → ts clamps to MIN; start must be
    // recomputed from the CLAMPED ts so start + actLen·ts·repeat === oldEnd.
    const { start, timeScale } = resizeLeft(0, 2, 2, 1, 2, 1);
    expect(timeScale).toBe(NLA_MIN_TIMESCALE);
    expect(start + 2 * timeScale * 1).toBe(2); // exact, not approximate
    expect(start).toBeLessThan(2);
  });
});

describe('midpointOrder — strictly-between order for a ONE-track ▲/▼ move (§2.4)', () => {
  it('midpoint between two neighbors', () => {
    expect(midpointOrder(0, 10)).toBe(5);
    expect(midpointOrder(-2, -1)).toBe(-1.5);
  });
  it('±1 past an extreme (null neighbor)', () => {
    expect(midpointOrder(null, 0)).toBe(-1); // moving below the bottom
    expect(midpointOrder(5, null)).toBe(6); // moving above the top
    expect(midpointOrder(null, null)).toBe(0);
  });
  it('float collision → 1e-6 nudge, never an exactly-equal order', () => {
    // equal-order neighbors (the lexicographic tie-break case, layeredChannels.ts:158)
    const collided = midpointOrder(1, 1);
    expect(collided).not.toBe(1);
    expect(collided).toBeCloseTo(1 + 1e-6, 12);
    // float exhaustion: the midpoint of two adjacent doubles lands ON a neighbor
    const above = 1 + Number.EPSILON;
    const nudged = midpointOrder(1, above);
    expect(nudged).not.toBe(1);
    expect(nudged).not.toBe(above);
  });
});

describe('reorderDisabled — ▲ on top / ▼ on bottom emits NO dispatch (§2.4)', () => {
  it('disables up at the top display row and down at the bottom', () => {
    expect(reorderDisabled('up', 0, 3)).toBe(true);
    expect(reorderDisabled('up', 1, 3)).toBe(false);
    expect(reorderDisabled('down', 2, 3)).toBe(true);
    expect(reorderDisabled('down', 1, 3)).toBe(false);
  });
  it('a single row disables both directions (no junk undo entries)', () => {
    expect(reorderDisabled('up', 0, 1)).toBe(true);
    expect(reorderDisabled('down', 0, 1)).toBe(true);
  });
});
