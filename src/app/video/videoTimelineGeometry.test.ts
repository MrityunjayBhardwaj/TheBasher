// videoTimelineGeometry — verify the pure frame↔percent + bar-span mapping.

import { describe, expect, it } from 'vitest';
import {
  applyBarDrag,
  barPercent,
  compDurationSeconds,
  compFrameToSeconds,
  frameToPercent,
  globalFrameToCompFrame,
  layerBarSpan,
  xDeltaToFrameDelta,
  xToCompFrame,
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

describe('transport scrub mapping', () => {
  it('globalFrameToCompFrame converts the 60fps global playhead into comp frames', () => {
    // 1s at 30fps comp = frame 30; the global playhead reaches 1s at frame 60.
    expect(globalFrameToCompFrame(60, 60, 30, 150)).toBe(30);
    expect(globalFrameToCompFrame(0, 60, 30, 150)).toBe(0);
  });

  it('globalFrameToCompFrame clamps to [0, totalFrames]', () => {
    expect(globalFrameToCompFrame(-30, 60, 30, 150)).toBe(0);
    expect(globalFrameToCompFrame(100000, 60, 30, 150)).toBe(150);
  });

  it('compFrameToSeconds is the inverse used for setTime (frame / fps)', () => {
    expect(compFrameToSeconds(30, 30)).toBe(1);
    expect(compFrameToSeconds(0, 30)).toBe(0);
    expect(compFrameToSeconds(15, 0)).toBe(0); // degenerate fps → 0, never NaN
  });

  it('xToCompFrame maps a pixel offset across the track to a clamped comp frame', () => {
    // halfway across a 200px track over 150 frames → frame 75.
    expect(xToCompFrame(100, 200, 150)).toBe(75);
    expect(xToCompFrame(0, 200, 150)).toBe(0);
    expect(xToCompFrame(200, 200, 150)).toBe(150);
    expect(xToCompFrame(400, 200, 150)).toBe(150); // past the end clamps
    expect(xToCompFrame(-50, 200, 150)).toBe(0); // before the start clamps
    expect(xToCompFrame(50, 0, 150)).toBe(0); // zero width → frame 0, never NaN
  });

  it('compDurationSeconds sizes the playhead range to the comp boundary', () => {
    expect(compDurationSeconds(150, 30)).toBe(5);
    expect(compDurationSeconds(150, 0)).toBe(0); // degenerate fps → 0
  });

  it('scrub round-trips: a comp frame → seconds → comp frame is stable', () => {
    const fps = 30;
    for (const cf of [0, 30, 75, 150]) {
      const secs = compFrameToSeconds(cf, fps);
      const back = globalFrameToCompFrame(Math.round(secs * 60), 60, fps, 150);
      expect(back).toBe(cf);
    }
  });
});
