// CameraHelpers — pure frustum geometry for the #165 selectable camera body.

import { describe, expect, it } from 'vitest';
import { orthoFrustumSegments, perspectiveFrustumSegments } from './CameraHelpers';

describe('perspectiveFrustumSegments', () => {
  it('emits 10 line segments (apex→4 corners, base rect, up triangle)', () => {
    const segs = perspectiveFrustumSegments(45, 16 / 9, 0.9);
    // 10 segments × 2 endpoints × 3 coords.
    expect(segs.length).toBe(10 * 2 * 3);
  });

  it('places the base corners from fov + aspect (fov 90, aspect 1, depth 1)', () => {
    const segs = perspectiveFrustumSegments(90, 1, 1);
    // hh = tan(45°)*1 ≈ 1, hw ≈ 1. The base plane is at z = -1.
    // First segment is apex(0,0,0) → top-left(-1, 1, -1).
    const expected = [0, 0, 0, -1, 1, -1];
    segs.slice(0, 6).forEach((n, i) => expect(n).toBeCloseTo(expected[i]));
  });

  it('scales the base with aspect ratio', () => {
    const wide = perspectiveFrustumSegments(60, 2, 1);
    const square = perspectiveFrustumSegments(60, 1, 1);
    // top-left x of the wide frustum is twice the square one (aspect 2 vs 1).
    expect(wide[3]).toBeCloseTo(square[3] * 2);
  });

  it('degenerate fov does not throw and yields finite coords', () => {
    const segs = perspectiveFrustumSegments(Number.NaN, 1, 1);
    expect(segs.every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe('orthoFrustumSegments', () => {
  it('emits 12 line segments (front rect, back rect, 4 connectors)', () => {
    const segs = orthoFrustumSegments(1, 16 / 9, 0.9);
    expect(segs.length).toBe(12 * 2 * 3);
  });

  it('shrinks with zoom (higher zoom → smaller box)', () => {
    const z1 = orthoFrustumSegments(1, 1, 1);
    const z2 = orthoFrustumSegments(2, 1, 1);
    // front top-left y at index 1.
    expect(Math.abs(z2[1])).toBeCloseTo(Math.abs(z1[1]) / 2);
  });
});
