import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, SphereGeometry } from 'three';
import { extractUVIslands, unionUVBounds } from './uvIslands';

describe('extractUVIslands', () => {
  it('BoxGeometry → 6 islands, each spanning the full [0,1] UV square', () => {
    // three.js BoxGeometry maps EVERY face to the full [0,1] UV square (24 verts,
    // 4 per face, faces independent) — so 6 topological islands, each ~[0,0,1,1].
    // This is the REAL attribute, NOT the synthetic "cross unfold" baseline.
    const uvs = extractUVIslands(new BoxGeometry(1, 1, 1));
    expect(uvs.islands).toHaveLength(6);
    expect(uvs.triangleCount).toBe(12); // 6 faces × 2 tris
    expect(uvs.sampled).toBe(false);
    for (const isl of uvs.islands) {
      const [minU, minV, maxU, maxV] = isl.bounds;
      expect(minU).toBeCloseTo(0, 5);
      expect(minV).toBeCloseTo(0, 5);
      expect(maxU).toBeCloseTo(1, 5);
      expect(maxV).toBeCloseTo(1, 5);
    }
    expect(unionUVBounds(uvs)).toEqual([0, 0, 1, 1]);
  });

  it('SphereGeometry → exactly 1 connected island', () => {
    const uvs = extractUVIslands(new SphereGeometry(1, 8, 6));
    expect(uvs.islands).toHaveLength(1);
    expect(uvs.triangleCount).toBeGreaterThan(0);
  });

  it('non-indexed geometry → each triangle is its own island', () => {
    // 2 independent triangles, no shared indices.
    const g = new BufferGeometry();
    // prettier-ignore
    const pos = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 0, 0, 3, 0, 0, 2, 1, 0,
    ]);
    // prettier-ignore
    const uv = new Float32Array([
      0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1,
    ]);
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    const uvs = extractUVIslands(g);
    expect(uvs.islands).toHaveLength(2);
    expect(uvs.triangleCount).toBe(2);
  });

  it('geometry with no uv attribute → honest empty result (no crash)', () => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const uvs = extractUVIslands(g);
    expect(uvs).toEqual({ islands: [], triangleCount: 0, sampled: false });
    expect(unionUVBounds(uvs)).toBeNull();
  });

  it('exceeding the face cap → stride-sampled with sampled:true', () => {
    const uvs = extractUVIslands(new SphereGeometry(1, 64, 48), { maxFaces: 50 });
    expect(uvs.sampled).toBe(true);
    expect(uvs.triangleCount).toBeLessThanOrEqual(50);
    expect(uvs.triangleCount).toBeGreaterThan(0);
  });

  it('island polylines carry the REAL uv coordinates (not synthetic)', () => {
    const uvs = extractUVIslands(new BoxGeometry(1, 1, 1));
    // every triangle outline is a 3-point loop of real uv pairs in [0,1]
    for (const isl of uvs.islands) {
      for (const poly of isl.polylines) {
        expect(poly).toHaveLength(3);
        for (const [u, v] of poly) {
          expect(u).toBeGreaterThanOrEqual(0);
          expect(u).toBeLessThanOrEqual(1);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
