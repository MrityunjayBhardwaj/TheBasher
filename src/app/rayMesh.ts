// rayMesh — the general data-layer ray/mesh geometry core (the "full Ray op", grounding:
// Houdini Ray SOP, sidefx.com/docs/houdini/nodes/sop/ray.html). Two methods, matching the
// Ray SOP's Method parameter:
//   • raycastMesh      — PROJECT RAYS: cast a ray from a point along a direction and return
//                        the hit (Möller–Trumbore per triangle). Honors Direction Type
//                        (forward / reverse / both) and Intersect-Farthest (closest vs
//                        farthest hit).
//   • nearestPointOnMesh — MINIMUM DISTANCE: the closest point on the surface to a query
//                        point (closest-point-on-triangle, Ericson RTCD), no direction.
//
// Both are PURE functions of (a mesh's local triangles, its world matrix, the query) — no
// THREE, no registry, no state — returning the hit POINT, the surface NORMAL there, and the
// DISTANCE (the Ray SOP's Point Intersection Normal + Distance). The seam
// (geometrySampleSource.ts) supplies the world matrix + query and picks the method.
//
// Supersedes the vertical-drop-only sampleTerrain.ts (a special case: project + down).
//
// REF: src/app/geometrySampleSource.ts (the seam); src/nodes/geometryQuery.ts (the node
//      params: method/direction/orientation/farthest); Houdini Ray SOP.

type Vec3 = [number, number, number];

export interface RayHit {
  /** The world-space hit point. */
  readonly point: Vec3;
  /** The unit surface normal at the hit (oriented to face the ray origin / query). */
  readonly normal: Vec3;
  /** Distance from the ray origin (project) or the query point (nearest) to the hit. */
  readonly distance: number;
}

export type RayOrientation = 'forward' | 'reverse' | 'both';

/** Transform a local point by a column-major 4×4 world matrix (THREE order), affine (w=1). */
function xf(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-12 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len];
}
/** The unit face normal of (a,b,c), flipped so it faces toward `toward` (the ray origin /
 *  query point) — so a driven "up" / tilt is consistent regardless of triangle winding. */
function faceNormalToward(a: Vec3, b: Vec3, c: Vec3, toward: Vec3): Vec3 {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  return dot(n, sub(toward, a)) < 0 ? [-n[0], -n[1], -n[2]] : n;
}

const EPS = 1e-7;

/** Iterate a triangle buffer's world-space verts, calling `visit(a,b,c)` per triangle. */
function forEachTriangle(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  m: ArrayLike<number>,
  visit: (a: Vec3, b: Vec3, c: Vec3) => void,
): void {
  const triCount = (index ? index.length : positions.length / 3) / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index[t * 3] : t * 3;
    const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
    const i2 = index ? index[t * 3 + 2] : t * 3 + 2;
    visit(
      xf(m, positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]),
      xf(m, positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]),
      xf(m, positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]),
    );
  }
}

/** Möller–Trumbore ray/triangle: the signed distance `t` along unit `dir` from `orig` to the
 *  intersection with (a,b,c), or NaN on a miss / back-of-origin (t ≤ EPS). */
function rayTriangle(orig: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const h = cross(dir, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < EPS) return NaN; // ray parallel to the triangle
  const f = 1 / det;
  const s = sub(orig, a);
  const u = f * dot(s, h);
  if (u < -EPS || u > 1 + EPS) return NaN;
  const q = cross(s, e1);
  const v = f * dot(dir, q);
  if (v < -EPS || u + v > 1 + EPS) return NaN;
  const t = f * dot(e2, q);
  return t > EPS ? t : NaN; // only hits AHEAD of the origin along dir
}

/**
 * PROJECT RAYS — cast a ray from `origin` along `dir` (need not be unit; normalized here)
 * and return the hit, or null on a miss. `orientation` casts forward, reverse, or both
 * (bidirectional); among the valid hits it keeps the CLOSEST, or the farthest when
 * `farthest` is true (the Ray SOP's Intersect-Farthest-Surface). The returned `distance`
 * is along the ray; `normal` faces back toward the origin.
 */
export function raycastMesh(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  worldMatrix: ArrayLike<number>,
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
    forEachTriangle(positions, index, worldMatrix, (a, b, c) => {
      const t = rayTriangle(origin, d, a, b, c);
      if (Number.isNaN(t)) return;
      if (best && (farthest ? t <= best.distance : t >= best.distance)) return;
      best = {
        point: [origin[0] + t * d[0], origin[1] + t * d[1], origin[2] + t * d[2]],
        normal: faceNormalToward(a, b, c, origin),
        distance: t,
      };
    });
  }
  return best;
}

/** The closest point on triangle (a,b,c) to `p` (Ericson, Real-Time Collision Detection). */
function closestPtTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * MINIMUM DISTANCE — the closest point on the mesh surface to `query`, or null for an empty
 * mesh. `distance` is |query − hit|; `normal` is the surface normal there, facing the query.
 * The Ray SOP's Minimum-Distance method (no direction).
 */
export function nearestPointOnMesh(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  worldMatrix: ArrayLike<number>,
  query: Vec3,
): RayHit | null {
  let best: RayHit | null = null;
  forEachTriangle(positions, index, worldMatrix, (a, b, c) => {
    const cp = closestPtTriangle(query, a, b, c);
    const d = Math.hypot(query[0] - cp[0], query[1] - cp[1], query[2] - cp[2]);
    if (best && d >= best.distance) return;
    best = { point: cp, normal: faceNormalToward(a, b, c, query), distance: d };
  });
  return best;
}
