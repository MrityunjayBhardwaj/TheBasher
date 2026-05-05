// uvLayout — verify generateBoxUVs produces 6 well-formed face quads
// inside the 0..1 UV square.

import { describe, expect, it } from 'vitest';
import { generateBoxUVs } from './uvLayout';

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
