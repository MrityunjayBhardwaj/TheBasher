// timelineView — pure zoom/pan math + the default-view parity invariant.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  visibleFrames,
  frameToX,
  xToFrame,
  zoomAtFrame,
  panByPixels,
  type TimelineView,
} from './timelineView';
import { keyframeToRect } from './timelineCanvasGeometry';

const TOTAL = 600; // 10s @ 60fps
const GUTTER = 84;
const WIDTH = 600; // track width (canvas width minus gutter)
const INSET = 5; // max(KEYFRAME_EDGE_INSET_PX=4, DIAMOND_PX/2=5)

describe('visibleFrames', () => {
  it('zoom 1 shows the whole timeline', () => {
    expect(visibleFrames(TOTAL, DEFAULT_VIEW)).toEqual({ startFrame: 0, endFrame: TOTAL });
  });
  it('zoom 2 shows half, scroll picks the half', () => {
    expect(visibleFrames(TOTAL, { zoom: 2, scroll: 0 })).toEqual({ startFrame: 0, endFrame: 300 });
    expect(visibleFrames(TOTAL, { zoom: 2, scroll: 1 })).toEqual({
      startFrame: 300,
      endFrame: 600,
    });
    expect(visibleFrames(TOTAL, { zoom: 2, scroll: 0.5 })).toEqual({
      startFrame: 150,
      endFrame: 450,
    });
  });
  it('clamps zoom to [1, MAX_ZOOM]', () => {
    expect(visibleFrames(TOTAL, { zoom: 0.1, scroll: 0 }).endFrame).toBe(TOTAL);
    expect(visibleFrames(TOTAL, { zoom: 9999, scroll: 0 }).endFrame).toBeCloseTo(
      TOTAL / MAX_ZOOM,
      6,
    );
  });
});

describe('frameToX default-view parity with keyframeToRect', () => {
  // The e2e-safety invariant: at the default view, frameToX (with the diamond
  // inset baked in) reproduces keyframeToRect's center-x EXACTLY, so the
  // geometry-pinned e2e (p7.1/p7.12) and cull contract (p6-w9) hold unchanged.
  it('matches keyframeToRect center-x for every frame at zoom 1', () => {
    for (const frame of [0, 1, 60, 150, 333, 599, 600]) {
      const t = frame / 60;
      const rect = keyframeToRect(t, 0, TOTAL / 60, WIDTH, 24, 10);
      const expected = GUTTER + rect.x + rect.w / 2; // component adds the gutter
      const got = frameToX(frame, TOTAL, DEFAULT_VIEW, GUTTER, WIDTH, INSET);
      expect(got).toBeCloseTo(expected, 6);
    }
  });
});

describe('frameToX / xToFrame round-trip', () => {
  const views: TimelineView[] = [DEFAULT_VIEW, { zoom: 3, scroll: 0.25 }, { zoom: 10, scroll: 1 }];
  it('inverts cleanly across zoom/scroll', () => {
    for (const v of views) {
      for (const frame of [0, 120, 300, 600]) {
        const x = frameToX(frame, TOTAL, v, GUTTER, WIDTH, INSET);
        const back = xToFrame(x, TOTAL, v, GUTTER, WIDTH, INSET);
        expect(back).toBeCloseTo(frame, 4);
      }
    }
  });
});

describe('zoomAtFrame', () => {
  it('keeps the anchor frame under the same screen x', () => {
    const v0 = DEFAULT_VIEW;
    const anchor = 300;
    const xBefore = frameToX(anchor, TOTAL, v0, GUTTER, WIDTH, INSET);
    const v1 = zoomAtFrame(v0, TOTAL, anchor, 4);
    const xAfter = frameToX(anchor, TOTAL, v1, GUTTER, WIDTH, INSET);
    expect(v1.zoom).toBe(4);
    expect(xAfter).toBeCloseTo(xBefore, 3);
  });
  it('clamps zoom to MAX_ZOOM', () => {
    expect(zoomAtFrame(DEFAULT_VIEW, TOTAL, 0, 9999).zoom).toBe(MAX_ZOOM);
  });
});

describe('panByPixels', () => {
  it('is a no-op at zoom 1 (nothing off-screen to scroll)', () => {
    expect(panByPixels(DEFAULT_VIEW, TOTAL, 200, WIDTH)).toEqual(DEFAULT_VIEW);
  });
  it('scrolls right within bounds when zoomed', () => {
    const v = panByPixels({ zoom: 2, scroll: 0 }, TOTAL, WIDTH, WIDTH); // pan one track-width
    expect(v.scroll).toBeGreaterThan(0);
    expect(v.scroll).toBeLessThanOrEqual(1);
  });
  it('clamps scroll to [0,1]', () => {
    expect(panByPixels({ zoom: 2, scroll: 0.9 }, TOTAL, 1e6, WIDTH).scroll).toBe(1);
    expect(panByPixels({ zoom: 2, scroll: 0.1 }, TOTAL, -1e6, WIDTH).scroll).toBe(0);
  });
});
