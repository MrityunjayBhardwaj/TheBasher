// videoTimelineGeometry — verify the pure frame↔percent + bar-span mapping.

import { describe, expect, it } from 'vitest';
import { barPercent, frameToPercent, layerBarSpan } from './videoTimelineGeometry';

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
