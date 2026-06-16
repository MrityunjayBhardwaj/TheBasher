// cameraFit — pure "frame all" math (#186): fit a bounding sphere with clip
// planes + orbit limits derived from the radius, never from constants.

import { describe, expect, it } from 'vitest';
import { clipPlanesForView, fitDistanceForSphere, fitViewToSphere } from './cameraFit';

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

  it('scales orbit dolly limits with the radius (tiny model → tiny minDistance)', () => {
    const tiny = fitViewToSphere([0, 0, 0], 0.01, 45, 1);
    const huge = fitViewToSphere([0, 0, 0], 1000, 45, 1);
    expect(tiny.minDistance).toBeLessThan(huge.minDistance);
    expect(huge.maxDistance).toBeGreaterThan(huge.distance);
    expect(tiny.minDistance).toBeGreaterThan(0);
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
    expect(planes.minDistance).toBeCloseTo(fit.minDistance, 9);
    expect(planes.maxDistance).toBeCloseTo(fit.maxDistance, 9);
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

  it('scales orbit dolly limits with the radius (tiny model → tiny minDistance)', () => {
    const tiny = clipPlanesForView(0.05, 0.01);
    const huge = clipPlanesForView(5000, 1000);
    expect(tiny.minDistance).toBeLessThan(huge.minDistance);
    expect(tiny.minDistance).toBeGreaterThan(0);
  });

  it('falls back to finite planes for degenerate camera distance / radius', () => {
    const bad = clipPlanesForView(Number.NaN, -5);
    expect(Number.isFinite(bad.near)).toBe(true);
    expect(Number.isFinite(bad.far)).toBe(true);
    expect(bad.far).toBeGreaterThan(bad.near);
    expect(bad.near).toBeGreaterThan(0);
  });
});
