// uvLayout — verify generateBoxUVs produces 6 well-formed face quads
// inside the 0..1 UV square.

import { describe, expect, it } from 'vitest';
import { generateBoxUVs, generateSphereUVs } from './uvLayout';

describe('generateBoxUVs', () => {
  it('returns six face quads', () => {
    const quads = generateBoxUVs();
    expect(quads).toHaveLength(6);
    for (const q of quads) {
      expect(q).toHaveLength(4);
    }
  });

  it('every UV coordinate is inside [0, 1]', () => {
    for (const q of generateBoxUVs()) {
      for (const [u, v] of q) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('each face is a unit-area axis-aligned quad (canonical cross unfold)', () => {
    for (const q of generateBoxUVs()) {
      const [a, b, c, d] = q;
      // Same-row edges share a V; same-column edges share a U.
      expect(a[1]).toBeCloseTo(b[1]);
      expect(c[1]).toBeCloseTo(d[1]);
      expect(a[0]).toBeCloseTo(d[0]);
      expect(b[0]).toBeCloseTo(c[0]);
    }
  });

  it('the six faces tile distinct positions (no overlap of face centers)', () => {
    const centers = generateBoxUVs().map((q) => {
      const u = (q[0][0] + q[2][0]) / 2;
      const v = (q[0][1] + q[2][1]) / 2;
      return `${u.toFixed(3)},${v.toFixed(3)}`;
    });
    expect(new Set(centers).size).toBe(6);
  });

  it('is deterministic — same call twice returns identical layout', () => {
    expect(generateBoxUVs()).toEqual(generateBoxUVs());
  });
});

describe('generateSphereUVs', () => {
  it('returns (widthSegments + 1) meridians + (heightSegments + 1) parallels', () => {
    // 24 + 1 verticals + 16 + 1 horizontals = 25 + 17 = 42 polylines.
    const polys = generateSphereUVs(24, 16);
    expect(polys.length).toBe(25 + 17);
  });

  it('every polyline is a 2-point line inside the 0..1 square', () => {
    for (const p of generateSphereUVs(8, 6)) {
      expect(p).toHaveLength(2);
      for (const [u, v] of p) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('first meridian is at u=0; last meridian is at u=1 (full equirectangular wrap)', () => {
    const polys = generateSphereUVs(8, 6);
    // Meridians come first; first and last span u=0 and u=1 respectively.
    expect(polys[0][0][0]).toBe(0);
    expect(polys[0][1][0]).toBe(0);
    expect(polys[8][0][0]).toBe(1);
    expect(polys[8][1][0]).toBe(1);
  });

  it('parallels span u=0..1 horizontally', () => {
    const polys = generateSphereUVs(8, 6);
    // Parallels begin at index widthSegments+1 = 9.
    const firstParallel = polys[9];
    expect(firstParallel[0][0]).toBe(0);
    expect(firstParallel[1][0]).toBe(1);
    // First parallel sits at v=0 (south pole row).
    expect(firstParallel[0][1]).toBe(0);
    expect(firstParallel[1][1]).toBe(0);
  });

  it('is deterministic', () => {
    expect(generateSphereUVs(12, 8)).toEqual(generateSphereUVs(12, 8));
  });
});
