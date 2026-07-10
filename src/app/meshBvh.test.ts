import { describe, expect, it } from 'vitest';
import { nearestPointOnMesh, raycastMesh, type RayHit, type RayOrientation } from './rayMesh';
import { buildMeshBvh, nearestPointMeshBvh, raycastMeshBvh } from './meshBvh';

type Vec3 = [number, number, number];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A deterministic LCG so the "random" query set is reproducible (no Math.random flake).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A dense, non-planar terrain: an N×N grid of quads over x,z ∈ [-10,10] with per-vertex
 *  random heights (so nearest-point + normals genuinely vary triangle to triangle). */
function denseTerrain(n: number, rng: () => number): { positions: number[]; index: number[] } {
  const positions: number[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const x = -10 + (20 * ix) / n;
      const z = -10 + (20 * iz) / n;
      const y = (rng() - 0.5) * 3; // height ∈ [-1.5, 1.5]
      positions.push(x, y, z);
    }
  }
  const index: number[] = [];
  const row = n + 1;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iz * row + ix;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  return { positions, index };
}

function expectSameHit(
  bvh: RayHit | null,
  brute: RayHit | null,
  label: string,
  query?: Vec3,
): void {
  if (brute === null) {
    expect(bvh, `${label}: brute missed, bvh should miss`).toBeNull();
    return;
  }
  expect(bvh, `${label}: brute hit, bvh should hit`).not.toBeNull();
  const h = bvh!;
  expect(h.distance, `${label}: distance`).toBeCloseTo(brute.distance, 4);
  for (let k = 0; k < 3; k++) {
    expect(h.point[k], `${label}: point[${k}]`).toBeCloseTo(brute.point[k], 4);
  }
  if (query) {
    // NEAREST: the normal at a shared EDGE/vertex foot is genuinely ambiguous — the adjacent
    // triangles give different (both valid) normals and brute-force vs three-mesh-bvh may
    // pick either. So assert the bvh normal is a real oriented surface normal (unit length,
    // facing the query) rather than bit-matching an arbitrary tie-break. The bvh-vs-brute
    // normal EQUALITY is proven by the ray cases below, where every hit is a unique interior
    // triangle (and the faceIndex→vertex recovery is the same code path).
    const len = Math.hypot(h.normal[0], h.normal[1], h.normal[2]);
    expect(len, `${label}: normal is unit`).toBeCloseTo(1, 6);
    const toQuery = dot3(
      [query[0] - h.point[0], query[1] - h.point[1], query[2] - h.point[2]],
      h.normal,
    );
    expect(toQuery, `${label}: normal faces the query`).toBeGreaterThanOrEqual(-1e-6);
  } else {
    for (let k = 0; k < 3; k++) {
      expect(h.normal[k], `${label}: normal[${k}]`).toBeCloseTo(brute.normal[k], 3);
    }
  }
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('meshBvh — the keystone invariant: BVH == brute-force within epsilon', () => {
  const rng = lcg(0xba5e); // fixed seed → reproducible geometry + queries
  const { positions, index } = denseTerrain(24, rng); // 24×24×2 = 1152 triangles
  // A translate+scale world matrix so world transforms are exercised (not identity-only).
  const world = [1.5, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1.5, 0, 2, 1, -3, 1];
  const mb = buildMeshBvh(positions, index, world);

  it('project rays (forward/reverse/both × closest/farthest) match brute-force over 400 random queries', () => {
    const orientations: RayOrientation[] = ['forward', 'reverse', 'both'];
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      // A random origin in a box straddling the (transformed) terrain, random-ish direction.
      const origin: Vec3 = [(rng() - 0.5) * 40, (rng() - 0.5) * 30 + 1, (rng() - 0.5) * 40];
      const dir: Vec3 = [(rng() - 0.5) * 2, rng() - 0.9, (rng() - 0.5) * 2];
      const orientation = orientations[i % 3];
      const farthest = i % 2 === 0;
      const opts = { orientation, farthest };
      const brute = raycastMesh(positions, index, world, origin, dir, opts);
      const bvh = raycastMeshBvh(mb, origin, dir, opts);
      if (brute) hits++;
      expectSameHit(bvh, brute, `ray#${i} ${orientation}${farthest ? '/far' : ''}`);
    }
    expect(hits, 'the random set should actually hit the terrain sometimes').toBeGreaterThan(50);
  });

  it('nearest-point matches brute-force over 400 random queries', () => {
    for (let i = 0; i < 400; i++) {
      const q: Vec3 = [(rng() - 0.5) * 50, (rng() - 0.5) * 40, (rng() - 0.5) * 50];
      const brute = nearestPointOnMesh(positions, index, world, q);
      const bvh = nearestPointMeshBvh(mb, q);
      expectSameHit(bvh, brute, `nearest#${i}`, q);
    }
  });

  it('handles a non-indexed buffer (matches brute-force)', () => {
    // Expand the indexed terrain into a non-indexed soup.
    const soup: number[] = [];
    for (const vi of index)
      soup.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
    const mbSoup = buildMeshBvh(soup, null, IDENTITY);
    const q: Vec3 = [1.3, 8, -2.1];
    expectSameHit(
      nearestPointMeshBvh(mbSoup, q),
      nearestPointOnMesh(soup, null, IDENTITY, q),
      'nonindexed-nearest',
      q,
    );
    const origin: Vec3 = [1.3, 8, -2.1];
    const dir: Vec3 = [0, -1, 0];
    expectSameHit(
      raycastMeshBvh(mbSoup, origin, dir),
      raycastMesh(soup, null, IDENTITY, origin, dir),
      'nonindexed-ray',
    );
  });

  it('a total miss returns null on both roads', () => {
    const origin: Vec3 = [1000, 50, 1000];
    const dir: Vec3 = [0, -1, 0];
    expect(raycastMeshBvh(mb, origin, dir)).toBeNull();
    expect(raycastMesh(positions, index, world, origin, dir)).toBeNull();
  });
});
