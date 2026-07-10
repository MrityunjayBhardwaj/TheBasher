// sampleTerrain — the pure ray-vs-mesh vertical sampling core (#300 follow-up: the
// geometry-query primitive that closes the "respecting the terrain" half of procedural
// rigging — a wheel/foot follows the ground).
//
// Given a mesh's triangles (a BufferGeometry's `position` attribute + optional index)
// and its world matrix, plus a query point (world XZ), return the GROUND under that
// point: the world hit point, its height (Y), and the surface normal there. "Ground"
// = the highest triangle the vertical ray through (x, z) passes through — so an
// overhang samples the top surface, and a heightfield samples its single face.
//
// This is the DATA-LAYER intersection the codebase lacked (all prior ray code is the
// editor's THREE.Raycaster against the RENDERED scene — Gizmo drag, R3F pointer pick).
// It is a pure function of (triangles, matrix, x, z): no THREE, no registry, no state —
// so it unit-tests directly and is safe to call from the driver-resolution seam.
//
// v1 samples a VERTICAL drop (a downward ray). The XZ-containment test is 2D barycentric
// on each triangle's XZ projection; the height is the barycentric interpolation of the
// three world Y's. A general ray direction (Möller–Trumbore) is a later increment.
//
// REF: src/app/resolveWorldTransform.ts (the world matrix the seam supplies);
//      src/app/geometryRegistry.ts (the BufferGeometry the seam materializes);
//      memory project_drivers-controllers-opnet (the geometry-query north-star).

type Vec3 = [number, number, number];

export interface TerrainSample {
  /** The world-space ground point directly under the query (its XZ === query XZ). */
  readonly point: Vec3;
  /** Convenience: `point[1]`, the ground height — what a scalar Y target reads. */
  readonly height: number;
  /** The unit surface normal at the hit, oriented to point up (`normal[1] >= 0`). */
  readonly normal: Vec3;
}

/** Transform a local point by a column-major 4×4 world matrix (THREE convention:
 *  translation in elements 12/13/14), assuming an affine matrix (w = 1). */
function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function normalizeUp(v: Vec3): Vec3 {
  let [x, y, z] = v;
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return [0, 1, 0];
  x /= len;
  y /= len;
  z /= len;
  // Orient toward +Y so a driven "up" (tilt to slope) is consistent regardless of the
  // triangle's winding — a downward query wants the surface's upward face.
  return y < 0 ? [-x, -y, -z] : [x, y, z];
}

/**
 * Sample the ground under world XZ `(x, z)`. `positions` is a flat local-space vertex
 * buffer (`geom.getAttribute('position').array`, stride 3); `index` is the triangle
 * index (`geom.getIndex()?.array`) or null for a non-indexed buffer (sequential tris);
 * `worldMatrix` places the mesh in the world (column-major 16). Returns the highest
 * hit, or null when the ray misses every triangle (the query is off the mesh's XZ
 * footprint) — the caller falls back (e.g. keeps the authored Y).
 */
export function sampleTerrainHeight(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  worldMatrix: ArrayLike<number>,
  x: number,
  z: number,
): TerrainSample | null {
  const triCount = (index ? index.length : positions.length / 3) / 3;
  let best: TerrainSample | null = null;

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index[t * 3] : t * 3;
    const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
    const i2 = index ? index[t * 3 + 2] : t * 3 + 2;

    // World-space triangle verts.
    const a = transformPoint(worldMatrix, positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]); // prettier-ignore
    const b = transformPoint(worldMatrix, positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]); // prettier-ignore
    const c = transformPoint(worldMatrix, positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]); // prettier-ignore

    // 2D barycentric of (x, z) in the triangle's XZ projection.
    const v0x = b[0] - a[0];
    const v0z = b[2] - a[2];
    const v1x = c[0] - a[0];
    const v1z = c[2] - a[2];
    const v2x = x - a[0];
    const v2z = z - a[2];
    const d00 = v0x * v0x + v0z * v0z;
    const d01 = v0x * v1x + v0z * v1z;
    const d11 = v1x * v1x + v1z * v1z;
    const d20 = v2x * v0x + v2z * v0z;
    const d21 = v2x * v1x + v2z * v1z;
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-12) continue; // degenerate / edge-on-vertical triangle
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    const eps = 1e-6;
    if (u < -eps || v < -eps || w < -eps) continue; // (x, z) outside this triangle

    const height = u * a[1] + v * b[1] + w * c[1];
    if (best && height <= best.height) continue; // keep the topmost surface

    // Face normal (world) = (b−a) × (c−a), oriented up.
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const ez = b[2] - a[2];
    const fx = c[0] - a[0];
    const fy = c[1] - a[1];
    const fz = c[2] - a[2];
    const normal = normalizeUp([ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx]);

    best = { point: [x, height, z], height, normal };
  }

  return best;
}
