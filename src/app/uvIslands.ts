// uvIslands — the ONE pure UV-island extractor (v0.6 #3, issue #181).
//
// Projects a three.js BufferGeometry's UV attribute into the read-only
// `EvaluatedUVs` display structure the UVEditor draws. THESIS §58 item 3:
// "view + transform, NOT surgery" — this never writes back, never unwraps.
// Islands are TOPOLOGICAL connected components (triangles sharing vertex
// indices), a display grouping (Blender shows islands too); we do not move
// verts or edit seams.
//
// THE SINGLE MAPPING SITE (V29 / A-1): both the resolver (box/sphere, sync) and
// UVEditor's glTF/baked path (async) call THIS — never two UV-projection sites
// that can drift. Pure / sync / no store reads (mirrors openpbrToThree).
//
// Large meshes are stride-sampled to a face cap (no silent truncation — the
// `sampled` flag surfaces it). A geometry with no `uv` attribute returns an
// honest empty result, never a crash.
//
// REF: CONTEXT A-1/A-4; PLAN W1 (1.2); vyapti V29; THESIS §58.

import type { BufferGeometry } from 'three';
import type { EvaluatedUVs, UVIsland, UVPoint } from '../nodes/types';

const DEFAULT_MAX_FACES = 20000;

const EMPTY: EvaluatedUVs = { islands: [], triangleCount: 0, sampled: false };

/** Union-find with path compression + union by size (vertex-index disjoint set). */
class DSU {
  private parent: Int32Array;
  private size: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    // path compression
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb;
      this.size[rb] += this.size[ra];
    } else {
      this.parent[rb] = ra;
      this.size[ra] += this.size[rb];
    }
  }
}

/**
 * Extract the UV islands of a geometry for read-only display.
 * Returns an empty result (no crash) when the geometry has no `uv` attribute.
 */
export function extractUVIslands(
  geometry: BufferGeometry,
  opts: { maxFaces?: number } = {},
): EvaluatedUVs {
  const maxFaces = opts.maxFaces ?? DEFAULT_MAX_FACES;
  const uv = geometry.getAttribute('uv');
  if (!uv) return EMPTY;
  const vertexCount = uv.count;

  // Triangle index list — synthesize a trivial per-vertex index for non-indexed
  // geometry (each consecutive 3 verts = one triangle, all verts unique → each
  // triangle is its own island, which is the honest topology for non-indexed).
  const indexAttr = geometry.getIndex();
  const totalTris = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(vertexCount / 3);
  if (totalTris === 0) return EMPTY;

  const idxAt = indexAttr ? (i: number) => indexAttr.getX(i) : (i: number) => i;

  // Stride-sample large meshes to the face cap (no silent truncation).
  const stride = totalTris > maxFaces ? Math.ceil(totalTris / maxFaces) : 1;
  const sampled = stride > 1;

  // Collect the sampled triangles' vertex indices first.
  const tris: [number, number, number][] = [];
  for (let t = 0; t < totalTris; t += stride) {
    const base = t * 3;
    tris.push([idxAt(base), idxAt(base + 1), idxAt(base + 2)]);
  }

  // Union the 3 vertices of every (sampled) triangle → connected components.
  const dsu = new DSU(vertexCount);
  for (const [a, b, c] of tris) {
    dsu.union(a, b);
    dsu.union(b, c);
  }

  // Group triangles by their component root, building per-island polylines + bounds.
  const byRoot = new Map<
    number,
    { polylines: UVPoint[][]; minU: number; minV: number; maxU: number; maxV: number }
  >();
  for (const [a, b, c] of tris) {
    const root = dsu.find(a);
    let island = byRoot.get(root);
    if (!island) {
      island = { polylines: [], minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
      byRoot.set(root, island);
    }
    const p: UVPoint[] = [];
    for (const vi of [a, b, c]) {
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      p.push([u, v]);
      if (u < island.minU) island.minU = u;
      if (v < island.minV) island.minV = v;
      if (u > island.maxU) island.maxU = u;
      if (v > island.maxV) island.maxV = v;
    }
    island.polylines.push(p);
  }

  const islands: UVIsland[] = [];
  for (const isl of byRoot.values()) {
    islands.push({
      polylines: isl.polylines,
      bounds: [isl.minU, isl.minV, isl.maxU, isl.maxV],
    });
  }

  return { islands, triangleCount: tris.length, sampled };
}

/** Union bounds across all islands → [minU, minV, maxU, maxV], or null when empty. */
export function unionUVBounds(uvs: EvaluatedUVs): [number, number, number, number] | null {
  if (uvs.islands.length === 0) return null;
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const isl of uvs.islands) {
    const [a, b, c, d] = isl.bounds;
    if (a < minU) minU = a;
    if (b < minV) minV = b;
    if (c > maxU) maxU = c;
    if (d > maxV) maxV = d;
  }
  return [minU, minV, maxU, maxV];
}
