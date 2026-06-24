// videoTimelineGeometry — verify the pure frame↔percent + bar-span mapping.

import { describe, expect, it } from 'vitest';
import {
  applyBarDrag,
  barPercent,
  frameToPercent,
  layerBarSpan,
  xDeltaToFrameDelta,
} from './videoTimelineGeometry';

describe('layerBarSpan', () => {
  it('outPoint -1 → length runs to the source end', () => {
    expect(layerBarSpan({ startFrame: 10, inPoint: 0, outPoint: -1 }, 30)).toEqual({
      startFrame: 10,
      lengthFrames: 30,
    });
  });

  it('explicit outPoint trims the length, inPoint shifts the start of the trim', () => {
    expect(layerBarSpan({ startFrame: 5, inPoint: 4, outPoint: 20 }, 100)).toEqual({
      startFrame: 5,
      lengthFrames: 16,
    });
  });

  it('clamps a degenerate trim to a visible 1-frame bar', () => {
    expect(layerBarSpan({ startFrame: 0, inPoint: 30, outPoint: 10 }, 30).lengthFrames).toBe(1);
  });
});

describe('frameToPercent', () => {
  it('maps [0,total] → [0,100]', () => {
    expect(frameToPercent(0, 150)).toBe(0);
    expect(frameToPercent(75, 150)).toBe(50);
    expect(frameToPercent(150, 150)).toBe(100);
  });

  it('clamps out-of-range frames', () => {
    expect(frameToPercent(-10, 150)).toBe(0);
    expect(frameToPercent(300, 150)).toBe(100);
  });
});

describe('barPercent', () => {
  it('converts a frame span to left/width percentages', () => {
    expect(barPercent({ startFrame: 30, lengthFrames: 30 }, 120)).toEqual({
      leftPct: 25,
      widthPct: 25,
    });
  });
});

describe('xDeltaToFrameDelta', () => {
  it('maps a pixel delta to a rounded frame delta against the track width', () => {
    // 100px of a 400px track over a 120-frame comp = 30 frames.
    expect(xDeltaToFrameDelta(100, 400, 120)).toBe(30);
    expect(xDeltaToFrameDelta(-100, 400, 120)).toBe(-30);
    expect(xDeltaToFrameDelta(0, 400, 120)).toBe(0);
  });

  it('returns 0 for a zero/negative track width (never NaN)', () => {
    expect(xDeltaToFrameDelta(100, 0, 120)).toBe(0);
    expect(xDeltaToFrameDelta(100, -10, 120)).toBe(0);
  });
});

describe('applyBarDrag', () => {
  const base = { startFrame: 10, inPoint: 0, outPoint: 30 };

  it('slide moves the whole bar, floored at 0', () => {
    expect(applyBarDrag(base, 30, 'slide', 5)).toEqual({
      startFrame: 15,
      inPoint: 0,
      outPoint: 30,
    });
    expect(applyBarDrag(base, 30, 'slide', -100)).toEqual({
      startFrame: 0,
      inPoint: 0,
      outPoint: 30,
    });
  });

  it('trim-left moves start + inPoint together so the right edge stays put', () => {
    // length = 30 - 0 = 30, right edge = 10 + 30 = 40.
    const out = applyBarDrag(base, 30, 'trim-left', 6);
    expect(out).toEqual({ startFrame: 16, inPoint: 6, outPoint: 30 });
    // right edge = startFrame + (outPoint - inPoint) = 16 + 24 = 40 (unchanged).
    expect(out.startFrame + (out.outPoint - out.inPoint)).toBe(40);
  });

  it('trim-left clamps so inPoint >= 0 and length stays >= 1', () => {
    expect(applyBarDrag(base, 30, 'trim-left', -100).inPoint).toBe(0);
    // pushing the left edge to the right edge keeps a 1-frame bar.
    expect(applyBarDrag(base, 30, 'trim-left', 100).inPoint).toBe(29);
  });

  it('trim-right moves the out edge and resolves an open (-1) outPoint', () => {
    expect(applyBarDrag(base, 30, 'trim-right', 10)).toEqual({
      startFrame: 10,
      inPoint: 0,
      outPoint: 40,
    });
    // outPoint -1 ("to source end" = srcFrames) resolves before applying the delta.
    expect(
      applyBarDrag({ startFrame: 0, inPoint: 0, outPoint: -1 }, 30, 'trim-right', 5).outPoint,
    ).toBe(35);
  });

  it('trim-right clamps so length stays >= 1', () => {
    expect(applyBarDrag(base, 30, 'trim-right', -100).outPoint).toBe(1);
  });
});
