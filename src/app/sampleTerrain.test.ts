import { describe, expect, it } from 'vitest';
import { sampleTerrainHeight } from './sampleTerrain';

// A 20×20 quad in the XZ plane at local y=0 (verts 0..3), indexed as two triangles.
const QUAD_VERTS = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// The same quad expressed as two sequential (non-indexed) triangles.
const QUAD_NONINDEXED = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, -10, 10, 0, 10, -10, 0, 10];

describe('sampleTerrainHeight', () => {
  it('samples a flat plane: height 0, up normal, XZ passed through', () => {
    const s = sampleTerrainHeight(QUAD_VERTS, QUAD_INDEX, IDENTITY, 0.5, 0.3);
    expect(s).not.toBeNull();
    expect(s!.height).toBeCloseTo(0, 6);
    expect(s!.point).toEqual([0.5, expect.closeTo(0, 6), 0.3]);
    expect(s!.normal[0]).toBeCloseTo(0, 6);
    expect(s!.normal[1]).toBeCloseTo(1, 6);
    expect(s!.normal[2]).toBeCloseTo(0, 6);
  });

  it('interpolates height on a tilted plane (y = 0.5·x) and tilts the normal', () => {
    // The quad with y raised to 0.5·x → a ramp rising toward +X.
    const ramp = [-10, -5, -10, 10, 5, -10, 10, 5, 10, -10, -5, 10];
    const s = sampleTerrainHeight(ramp, QUAD_INDEX, IDENTITY, 2, 0);
    expect(s).not.toBeNull();
    expect(s!.height).toBeCloseTo(1, 6); // 0.5·2
    // Plane y − 0.5x = 0 ⇒ up normal ∝ (−0.5, 1, 0).
    const n = s!.normal;
    expect(n[1]).toBeGreaterThan(0);
    expect(n[0]).toBeLessThan(0);
    expect(n[0] / n[1]).toBeCloseTo(-0.5, 6);
  });

  it('applies the world matrix (a plane translated up by 5 samples at y=5)', () => {
    const up5 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1]; // translation in [13]
    const s = sampleTerrainHeight(QUAD_VERTS, QUAD_INDEX, up5, 3, -4);
    expect(s).not.toBeNull();
    expect(s!.height).toBeCloseTo(5, 6);
  });

  it('returns null when the query XZ is off the mesh footprint', () => {
    expect(sampleTerrainHeight(QUAD_VERTS, QUAD_INDEX, IDENTITY, 100, 100)).toBeNull();
  });

  it('returns the topmost surface when triangles stack over the same XZ', () => {
    const upper = QUAD_NONINDEXED.map((v, i) => (i % 3 === 1 ? v + 3 : v)); // raise y by 3
    const both = [...QUAD_NONINDEXED, ...upper];
    const s = sampleTerrainHeight(both, null, IDENTITY, 0, 0);
    expect(s).not.toBeNull();
    expect(s!.height).toBeCloseTo(3, 6);
  });

  it('handles a non-indexed buffer (sequential triangles)', () => {
    const s = sampleTerrainHeight(QUAD_NONINDEXED, null, IDENTITY, -2, 5);
    expect(s).not.toBeNull();
    expect(s!.height).toBeCloseTo(0, 6);
  });
});
