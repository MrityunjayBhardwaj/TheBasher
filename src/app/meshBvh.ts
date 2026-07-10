// meshBvh — the BVH-accelerated twin of rayMesh.ts's brute-force core (#301 Part 2).
// rayMesh.ts stays the PURE, THREE-free ORACLE (its per-triangle Möller–Trumbore /
// Ericson loops are the correctness baseline + the test oracle); this module accelerates
// the SAME queries with three-mesh-bvh (MIT) so a query is ~O(log tris)/sample instead of
// the brute-force O(tris)/sample/frame the seam ran before.
//
// HARD INVARIANT (the keystone test, meshBvh.test.ts): a BVH query returns the SAME hit as
// the brute-force core within epsilon — same point/normal/distance and the same
// tie-breaking (closest by default, farthest when `farthest`, min-distance for nearest).
// three-mesh-bvh brings its OWN intersection math, so parity is within-epsilon, not
// bit-exact; the NORMAL reuses rayMesh's `faceNormalToward` so that half stays identical to
// brute-force. If the two ever diverge beyond epsilon, the BVH is wrong, not brute-force.
//
// WORLD-SPACE by construction: the BVH is built over triangles already transformed to world
// space (the world matrix is baked into a fresh BufferGeometry once, with the SAME `xf` the
// brute-force core uses), so a query runs in world coordinates directly — distances and
// tie-breaking match the brute-force core (which also works in world space) and there is no
// ray-to-local transform. The seam (geometrySampleSource.ts) owns the cache, keyed by the
// positions array identity + the world-matrix hash: a static terrain builds ONCE and reuses
// across all samples/frames; a geometry rebuild or clone-swap yields a new positions array →
// a fresh BVH (WeakMap auto-GC). This is the acceleration only — semantics are rayMesh's.
//
// NOTE (a silent-boundary trap): `new MeshBVH(geometry)` REORDERS the geometry's index
// buffer in place to group triangles spatially, so a hit's `faceIndex` indexes into the
// REORDERED index. We therefore recover a hit face's vertices from `geometry.getIndex()`
// AFTER the build, never from the original index passed in.
//
// REF: src/app/rayMesh.ts (the brute-force oracle + shared xf/normalize/faceNormalToward);
//      src/app/geometrySampleSource.ts (the seam that caches + calls this); three-mesh-bvh.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  faceNormalToward,
  normalize,
  xf,
  type RayHit,
  type RayOrientation,
  type Vec3,
} from './rayMesh';

/** A world-space BVH over one mesh's triangle soup + the data to recover a hit face. */
export interface MeshBvh {
  readonly bvh: MeshBVH;
  /** World-space vertex positions (the baked geometry's `position` array). */
  readonly worldPositions: ArrayLike<number>;
  /** The geometry's index AFTER the build (three-mesh-bvh reorders it in place). */
  readonly index: ArrayLike<number>;
}

/**
 * Build a world-space BVH over the given LOCAL triangle soup. The world matrix is baked
 * into the vertex positions here (once) with the SAME `xf` the brute-force core applies per
 * triangle, so the BVH indexes the identical world triangles. A non-indexed buffer gets a
 * sequential index so every path is indexed (and `faceIndex` maps predictably).
 */
export function buildMeshBvh(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  worldMatrix: ArrayLike<number>,
): MeshBvh {
  const vertCount = (positions.length / 3) | 0;
  const world = new Float32Array(positions.length);
  for (let i = 0; i < vertCount; i++) {
    const p = xf(worldMatrix, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    world[i * 3] = p[0];
    world[i * 3 + 1] = p[1];
    world[i * 3 + 2] = p[2];
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(world, 3));
  if (index) {
    geometry.setIndex(Array.from(index));
  } else {
    const seq = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) seq[i] = i;
    geometry.setIndex(new BufferAttribute(seq, 1));
  }
  const bvh = new MeshBVH(geometry);
  // three-mesh-bvh reordered the index in place — read hit faces from the FINAL index.
  const finalIndex = geometry.getIndex()!.array as ArrayLike<number>;
  return { bvh, worldPositions: world, index: finalIndex };
}

/** The three world-space vertices of triangle `faceIndex` (into the reordered index). */
function faceVerts(mb: MeshBvh, faceIndex: number): [Vec3, Vec3, Vec3] {
  const p = mb.worldPositions;
  const i0 = mb.index[faceIndex * 3];
  const i1 = mb.index[faceIndex * 3 + 1];
  const i2 = mb.index[faceIndex * 3 + 2];
  return [
    [p[i0 * 3], p[i0 * 3 + 1], p[i0 * 3 + 2]],
    [p[i1 * 3], p[i1 * 3 + 1], p[i1 * 3 + 2]],
    [p[i2 * 3], p[i2 * 3 + 1], p[i2 * 3 + 2]],
  ];
}

// Reused across calls (single-threaded) to avoid per-sample allocation.
const _ray = new Ray();
const _query = new Vector3();
const _cpTarget = { point: new Vector3(), distance: 0, faceIndex: 0 };

/**
 * BVH-accelerated PROJECT RAYS — the `raycastMesh` twin. Same orientation (forward/reverse/
 * both) and farthest semantics, same tie-breaking (closest by default; farthest keeps the
 * max distance among valid hits). Double-sided (matches the brute-force Möller–Trumbore,
 * which accepts either winding). Returns null on a miss.
 */
export function raycastMeshBvh(
  mb: MeshBvh,
  origin: Vec3,
  dir: Vec3,
  opts?: { orientation?: RayOrientation; farthest?: boolean },
): RayHit | null {
  const orientation = opts?.orientation ?? 'forward';
  const farthest = opts?.farthest ?? false;
  const u = normalize(dir);
  if (u[0] === 0 && u[1] === 0 && u[2] === 0) return null;
  const dirs: Vec3[] =
    orientation === 'forward'
      ? [u]
      : orientation === 'reverse'
        ? [[-u[0], -u[1], -u[2]]]
        : [u, [-u[0], -u[1], -u[2]]];

  let best: RayHit | null = null;
  for (const d of dirs) {
    _ray.origin.set(origin[0], origin[1], origin[2]);
    _ray.direction.set(d[0], d[1], d[2]);
    const hits = mb.bvh.raycast(_ray, DoubleSide);
    for (const h of hits) {
      const t = h.distance;
      // Same skip logic as the brute-force core: closest keeps strict-min, farthest strict-max.
      if (best && (farthest ? t <= best.distance : t >= best.distance)) continue;
      const [a, b, c] = faceVerts(mb, h.faceIndex ?? 0);
      best = {
        point: [h.point.x, h.point.y, h.point.z],
        normal: faceNormalToward(a, b, c, origin),
        distance: t,
      };
    }
  }
  return best;
}

/**
 * BVH-accelerated MINIMUM DISTANCE — the `nearestPointOnMesh` twin. The closest surface
 * point to `query`; null for an empty mesh. `normal` faces the query (rayMesh primitive).
 */
export function nearestPointMeshBvh(mb: MeshBvh, query: Vec3): RayHit | null {
  const res = mb.bvh.closestPointToPoint(_query.set(query[0], query[1], query[2]), _cpTarget);
  if (!res) return null;
  const [a, b, c] = faceVerts(mb, res.faceIndex);
  return {
    point: [res.point.x, res.point.y, res.point.z],
    normal: faceNormalToward(a, b, c, query),
    distance: res.distance,
  };
}
