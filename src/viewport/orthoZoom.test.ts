// orthoZoomForView — the pure ortho-zoom helper that frames the orthographic
// editor camera to match the perspective view at the orbit pivot.

import { describe, expect, it } from 'vitest';
import { orthoZoomForView } from './EditorViewCamera';
import { orthoZoomForScale } from './cameraFit';

describe('orthoZoomForView', () => {
  it('equates ortho world-height with the perspective frustum at the pivot', () => {
    // perspective world-height at distance d, fov θ = 2·d·tan(θ/2).
    // ortho zoom z = viewportHeight / worldHeight.
    const d = 5;
    const fov = 45;
    const h = 1080;
    const worldHeight = 2 * d * Math.tan((fov * Math.PI) / 180 / 2);
    expect(orthoZoomForView(d, fov, h)).toBeCloseTo(h / worldHeight, 6);
  });

  it('scales inversely with distance (dolly out → smaller zoom)', () => {
    const near = orthoZoomForView(3, 45, 1080);
    const far = orthoZoomForView(9, 45, 1080);
    expect(near).toBeGreaterThan(far);
    // Triple the distance → one third the zoom (linear in 1/d).
    expect(far).toBeCloseTo(near / 3, 4);
  });

  it('scales with viewport height (taller canvas → larger zoom)', () => {
    expect(orthoZoomForView(5, 45, 2160)).toBeCloseTo(2 * orthoZoomForView(5, 45, 1080), 4);
  });

  it('returns a safe 1 for degenerate inputs (no NaN/Infinity leak)', () => {
    expect(orthoZoomForView(0, 45, 1080)).toBe(1);
    expect(orthoZoomForView(-5, 45, 1080)).toBe(1);
    expect(orthoZoomForView(5, 45, 0)).toBe(1);
    expect(orthoZoomForView(Number.NaN, 45, 1080)).toBe(1);
    expect(orthoZoomForView(5, 45, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('orthoZoomForScale (#1774)', () => {
  it('shows exactly orthoScale world units of height on a pixel-sized frustum', () => {
    for (const [scale, h] of [
      [6, 1080],
      [2.5, 720],
      [40, 333],
    ] as const) {
      // drei's frustum is h pixels tall; the visible world height is h / zoom.
      expect(h / orthoZoomForScale(scale, h)).toBeCloseTo(scale, 9);
    }
  });

  it('returns a safe 1 for a degenerate scale or viewport', () => {
    expect(orthoZoomForScale(0, 1080)).toBe(1);
    expect(orthoZoomForScale(-3, 1080)).toBe(1);
    expect(orthoZoomForScale(Number.NaN, 1080)).toBe(1);
    expect(orthoZoomForScale(6, 0)).toBe(1);
  });
});
