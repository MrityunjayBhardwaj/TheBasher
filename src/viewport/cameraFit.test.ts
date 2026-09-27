// cameraFit — pure "frame all" math (#186): fit a bounding sphere with clip
// planes derived from the radius, never from constants; and the orbit's dolly
// range, which is the view's (from its Clip End), never the scene's (#1288).

import { describe, expect, it } from 'vitest';
import {
  boxDepthAlongView,
  clipPlanesForView,
  dollyRangeForClip,
  fitDistanceForSphere,
  fitViewToSphere,
} from './cameraFit';

describe('fitDistanceForSphere', () => {
  it('places the camera so the sphere is tangent to the frustum (vertical fit)', () => {
    // Square viewport: vertical and horizontal FOV are equal, so d = r/sin(fov/2).
    const r = 2;
    const fov = 45;
    const expected = r / Math.sin((fov * Math.PI) / 180 / 2);
    expect(fitDistanceForSphere(r, fov, 1)).toBeCloseTo(expected, 6);
  });

  it('scales linearly with radius (10000× bigger model → 10000× the distance)', () => {
    const small = fitDistanceForSphere(0.01, 45, 16 / 9);
    const huge = fitDistanceForSphere(100, 45, 16 / 9);
    expect(huge / small).toBeCloseTo(100 / 0.01, 3);
  });

  it('a portrait viewport needs MORE distance than landscape (horizontal-constrained)', () => {
    const landscape = fitDistanceForSphere(1, 45, 16 / 9);
    const portrait = fitDistanceForSphere(1, 45, 9 / 16);
    expect(portrait).toBeGreaterThan(landscape);
  });

  it('falls back to a unit sphere / 45° / square for degenerate inputs', () => {
    const ref = fitDistanceForSphere(1, 45, 1);
    expect(fitDistanceForSphere(0, 45, 1)).toBeCloseTo(ref, 6);
    expect(fitDistanceForSphere(-5, 45, 1)).toBeCloseTo(ref, 6);
    expect(fitDistanceForSphere(1, 0, 1)).toBeCloseTo(ref, 6);
    expect(fitDistanceForSphere(1, 45, 0)).toBeCloseTo(ref, 6);
    expect(Number.isFinite(fitDistanceForSphere(Number.NaN, 45, 1))).toBe(true);
  });
});

describe('fitViewToSphere', () => {
  it('aims at the sphere center and sits a margin beyond the fit distance', () => {
    const fit = fitViewToSphere([10, 0, -5], 3, 45, 16 / 9);
    expect(fit.lookAt).toEqual([10, 0, -5]);
    // distance = fit distance × margin; position is that far from center.
    const d = Math.hypot(fit.position[0] - 10, fit.position[1] - 0, fit.position[2] - -5);
    expect(d).toBeCloseTo(fit.distance, 6);
    expect(fit.distance).toBeGreaterThan(fitDistanceForSphere(3, 45, 16 / 9));
  });

  it('derives clip planes from the radius — far clears the back, near hugs the front', () => {
    const fit = fitViewToSphere([0, 0, 0], 5, 45, 1);
    // far must be beyond the far side of the sphere (distance + radius).
    expect(fit.far).toBeGreaterThan(fit.distance + 5);
    // near is positive and in front of the sphere.
    expect(fit.near).toBeGreaterThan(0);
    expect(fit.near).toBeLessThan(fit.distance);
  });

  it('keeps far/near bounded so the depth buffer does not z-fight', () => {
    // A huge sphere whose geometric near would be tiny relative to far.
    const fit = fitViewToSphere([0, 0, 0], 100000, 45, 1);
    expect(fit.far / fit.near).toBeLessThanOrEqual(50_000 + 1);
    expect(fit.near).toBeGreaterThan(0);
  });

  it('frames along the canonical [3,2,3] viewing angle by default', () => {
    const fit = fitViewToSphere([0, 0, 0], 1, 45, 1);
    // direction from center→camera is the normalized [3,2,3] (x ≈ z, y smaller).
    const len = Math.hypot(3, 2, 3);
    expect(fit.position[0] / fit.distance).toBeCloseTo(3 / len, 5);
    expect(fit.position[1] / fit.distance).toBeCloseTo(2 / len, 5);
    expect(fit.position[2] / fit.distance).toBeCloseTo(3 / len, 5);
  });

  it('honors a custom (un-normalized) viewing direction', () => {
    const fit = fitViewToSphere([0, 0, 0], 1, 45, 1, { dir: [0, 0, 10] });
    expect(fit.position[0]).toBeCloseTo(0, 6);
    expect(fit.position[1]).toBeCloseTo(0, 6);
    expect(fit.position[2]).toBeCloseTo(fit.distance, 6);
  });

  it('survives a zero-radius (single point / empty) scene without NaN', () => {
    const fit = fitViewToSphere([1, 2, 3], 0, 45, 1);
    expect(Number.isFinite(fit.distance)).toBe(true);
    expect(Number.isFinite(fit.near)).toBe(true);
    expect(Number.isFinite(fit.far)).toBe(true);
    expect(fit.far).toBeGreaterThan(fit.near);
  });
});

describe('clipPlanesForView', () => {
  it('matches fitViewToSphere when called with the same fit distance (one source of truth)', () => {
    // #191: fitViewToSphere now delegates its plane math to clipPlanesForView.
    // Feeding the fit distance back in must reproduce the fit's planes exactly.
    const fit = fitViewToSphere([0, 0, 0], 7, 50, 16 / 9);
    const planes = clipPlanesForView(fit.distance, 7);
    expect(planes.near).toBeCloseTo(fit.near, 9);
    expect(planes.far).toBeCloseTo(fit.far, 9);
  });

  it('far clears the back of the sphere from the camera; near stays positive', () => {
    const r = 3464; // ~radius of a 4000-unit box, the #191 large-model case
    const planes = clipPlanesForView(5, r); // camera kept CLOSE (saved view)
    // far reaches past the farthest point of the sphere from the eye.
    expect(planes.far).toBeGreaterThan(5 + r);
    // far is bounds-derived, FAR past the old fixed 1000 — the #191 regression.
    expect(planes.far).toBeGreaterThan(1000);
    expect(planes.near).toBeGreaterThan(0);
  });

  it('grows far as the camera dollies away from the same content', () => {
    const near = clipPlanesForView(10, 50);
    const far = clipPlanesForView(500, 50);
    expect(far.far).toBeGreaterThan(near.far);
  });

  it('keeps far/near bounded so the depth buffer does not z-fight', () => {
    const planes = clipPlanesForView(100000, 100000);
    expect(planes.far / planes.near).toBeLessThanOrEqual(50_000 + 1);
    expect(planes.near).toBeGreaterThan(0);
  });

  it('falls back to finite planes for degenerate camera distance / radius', () => {
    const bad = clipPlanesForView(Number.NaN, -5);
    expect(Number.isFinite(bad.near)).toBe(true);
    expect(Number.isFinite(bad.far)).toBe(true);
    expect(bad.far).toBeGreaterThan(bad.near);
    expect(bad.near).toBeGreaterThan(0);
  });
});

// #1188 — how deep a box reaches along the view: the far plane is a PLANE, so
// the notice asks about the deepest corner along `forward`, not a sphere.
describe('boxDepthAlongView', () => {
  it('is the deepest corner along the view direction', () => {
    // Unit cube at the origin, eye 10 back on +Z looking down -Z: the deepest
    // corner is on the far face z = -0.5 → depth 10.5.
    expect(boxDepthAlongView([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], [0, 0, 10], [0, 0, -1])).toBe(
      10.5,
    );
  });

  it('does not over-answer a long flat scene seen along its short axis', () => {
    // A 2000 × 0 × 2000 ground plane seen from 5 above, looking straight down:
    // every point is 5 deep. A distance-to-sphere test (5 + radius ~1414)
    // would call this past a 1000 far plane; the plane test must not.
    const d = boxDepthAlongView([-1000, 0, -1000], [1000, 0, 1000], [0, 5, 0], [0, -1, 0]);
    expect(d).toBeCloseTo(5, 9);
    expect(d).toBeLessThan(1000);
  });

  it('normalizes forward and picks the corner per axis sign', () => {
    const f: [number, number, number] = [3, 0, 4]; // |f| = 5
    const d = boxDepthAlongView([-1, -1, -1], [1, 1, 1], [0, 0, 0], f);
    // Deepest corner (1, ±1, 1): (1·3 + 1·4) / 5 = 1.4.
    expect(d).toBeCloseTo(1.4, 9);
  });

  it('is negative when the whole box is behind the eye, NaN with no direction', () => {
    expect(boxDepthAlongView([-1, -1, 5], [1, 1, 6], [0, 0, 10], [0, 0, 1])).toBeLessThan(0);
    expect(boxDepthAlongView([0, 0, 0], [1, 1, 1], [0, 0, 0], [0, 0, 0])).toBeNaN();
  });
});

describe('dollyRangeForClip (#1288)', () => {
  it("is Blender's zoom range: a thousandth of the grid to ten Clip Ends", () => {
    // ED_view3d_dist_soft_range_get(v3d, false), view3d_utils.cc:154-165 (v5.1.1), at
    // Blender's default grid 1 and clip_end 1000.
    expect(dollyRangeForClip(1000)).toEqual({ minDistance: 0.001, maxDistance: 10_000 });
  });

  it('follows Clip End and nothing else — raising the clip is how a director reaches further', () => {
    expect(dollyRangeForClip(100).maxDistance).toBe(1000);
    expect(dollyRangeForClip(1e6).maxDistance).toBe(1e7);
    expect(dollyRangeForClip(100).minDistance).toBe(dollyRangeForClip(1e6).minDistance);
  });

  it("admits the distance that failed #1288: the walk's 587-unit travel, from the default clip", () => {
    // Measured before the fix: a wheel-out stopped at 38.08, the boot cube's (2.94 + 0.866) × 10.
    expect(dollyRangeForClip(1000).maxDistance).toBeGreaterThan(587);
  });

  it('falls back to the default Clip End for a degenerate one', () => {
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(dollyRangeForClip(bad)).toEqual(dollyRangeForClip(1000));
    }
  });
});
