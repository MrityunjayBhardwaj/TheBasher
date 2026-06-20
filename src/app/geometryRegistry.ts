// Geometry registry — a derived RUNTIME cache mapping a deterministic
// `GeometryRef.key` to a built three.js BufferGeometry (v0.6 #1, issue #150).
//
// V1-EXEMPTION (the same rationale as the evaluator cache, src/core/dag/evaluator.ts):
//   this is a DERIVED cache, NOT authoritative state. It is keyed by the
//   resolver's deterministic key (producer identity + params, §48), it is
//   NEVER serialized into the DAG, and it never participates in Ops / undo /
//   content-hashing. Heavy BufferGeometry buffers stay HERE (and, for glTF, in
//   the loaded asset clone) — the DAG carries only the structure + a GeometryRef
//   handle (Ousterhout interface-depth: simple ref, deep registry).
//
// Determinism (§48): `get(ref)` builds-on-miss and returns the cached instance
//   on-hit. Two refs with the same `key` resolve to the SAME instance (no churn);
//   two refs with different params produce different keys (no false sharing).
//
// glTF scope (D-02 MINIMAL): the registry does NOT load glTF. A `gltf` descriptor
//   keys the child by (assetRef, childName); the actual BufferGeometry lives in
//   the GltfAsset's loaded three.js clone (GltfAssetR owns it, H45). `get()`
//   returns null for a gltf ref — the consumer reads geometry from the asset
//   clone, not from this registry.
//
// baked scope (Phase 151): a `baked` geometry is AUTHORITATIVE (the product of
//   applyMatrix4 on a clone, NOT rebuildable from params) — its bytes live in
//   OPFS keyed by content hash (bakedGeometryStore.ts). The registry cannot
//   BUILD it synchronously; the OPFS read is async. So `get()` returns the cached
//   buffer on a sync hit, else NULL (a cache MISS the renderer resolves by
//   suspending). `prime(ref, geom)` populates the cache after the async OPFS read
//   completes (the loader hook, bakedGeometryLoader.ts). The pure resolver stays
//   sync — it returns the handle only; the async load lives in the renderer hook
//   (V29 purity preserved; the resolver is NEVER made async).
//
// REF: PLAN.md Wave 1 Tasks 2-3; CONTEXT §C; RESEARCH §C/§Q2; vyapti V1 (exempt),
//      authoritative-baked-store vyapti.

import { BoxGeometry, Matrix4, SphereGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GeometryRef } from '../nodes/types';

const cache = new Map<string, BufferGeometry>();

/**
 * Resolve a GeometryRef to a cached three.js BufferGeometry, building on miss.
 *
 * Returns null for a `gltf` ref (the registry does not own loaded glTF geometry —
 * the asset clone does; see header). Returns null for a `baked` MISS — the bytes
 * live in OPFS and must be loaded asynchronously by the renderer hook, then
 * `prime`d (see header). Returns the SAME instance for repeated calls with an
 * identical key (cache hit).
 */
export function get(ref: GeometryRef): BufferGeometry | null {
  if (ref.kind === 'gltf') return null;
  const hit = cache.get(ref.key);
  if (hit) return hit;
  if (ref.kind === 'baked') return null; // miss → caller suspends + primes; no sync build
  const built = build(ref);
  if (built) cache.set(ref.key, built);
  return built;
}

/**
 * Populate the cache with an asynchronously-loaded baked geometry. Called by the
 * loader hook (bakedGeometryLoader.ts) after the OPFS read resolves, so a
 * subsequent `get(ref)` is a sync cache hit. Idempotent: a repeat prime for the
 * same key keeps the first instance (no churn; identical key → identical bytes).
 */
export function prime(ref: GeometryRef, geom: BufferGeometry): BufferGeometry {
  const existing = cache.get(ref.key);
  if (existing) {
    if (existing !== geom) geom.dispose();
    return existing;
  }
  cache.set(ref.key, geom);
  return geom;
}

function build(ref: GeometryRef): BufferGeometry | null {
  const d = ref.descriptor;
  if (d.kind === 'box') {
    return new BoxGeometry(d.size[0], d.size[1], d.size[2]);
  }
  if (d.kind === 'sphere') {
    return new SphereGeometry(d.radius, d.widthSegments, d.heightSegments);
  }
  if (d.kind === 'array') {
    // SOP / modifier (#209): recursively build the source handle, then merge
    // `count` CLONES each translated by i*offset (local space). Clone, never
    // mutate the cached source instance (other refs share it). A source that
    // can't build sync (gltf MISS / baked MISS → null) makes the whole array
    // unbuildable here — return null (a follow-up; the renderer renders nothing).
    const source = get(d.source);
    if (!source) return null;
    const copies: BufferGeometry[] = [];
    for (let i = 0; i < d.count; i++) {
      const m = new Matrix4().makeTranslation(d.offset[0] * i, d.offset[1] * i, d.offset[2] * i);
      copies.push(source.clone().applyMatrix4(m));
    }
    const merged = mergeGeometries(copies);
    for (const c of copies) c.dispose(); // mergeGeometries copies the buffers out
    return merged; // null only if the copies mismatch attributes (same source → never)
  }
  if (d.kind === 'mirror') {
    // SOP / modifier (#209): reflect the source across the local-origin plane whose
    // normal is `axis`, then merge the reflection back with the ORIGINAL (a symmetric
    // whole, 2× the verts — Blender's Mirror). Clone both halves — never mutate the
    // cached source (H111). The reflection matrix has determinant −1, which flips
    // triangle winding: `applyMatrix4` reflects the normal attribute (via the normal
    // matrix), but the index winding would now disagree with those normals →
    // front-faces become back-faces (the mirrored half renders inside-out). Reverse
    // the reflected copy's winding so winding and normals agree again.
    const source = get(d.source);
    if (!source) return null;
    // Reflection across the plane perpendicular to `axis` at `offset` along it:
    // p' = 2·offset − p on that axis (a scale of −1 plus a translation of 2·offset).
    const reflect = new Matrix4().makeScale(
      d.axis === 'x' ? -1 : 1,
      d.axis === 'y' ? -1 : 1,
      d.axis === 'z' ? -1 : 1,
    );
    const t = 2 * d.offset;
    reflect.setPosition(d.axis === 'x' ? t : 0, d.axis === 'y' ? t : 0, d.axis === 'z' ? t : 0);
    const original = source.clone();
    const reflected = reverseWinding(source.clone().applyMatrix4(reflect));
    const merged = mergeGeometries([original, reflected]);
    original.dispose();
    reflected.dispose();
    return merged; // null only on attribute mismatch (same source → never)
  }
  return null; // gltf / baked — not built here (gltf in asset clone, baked from OPFS)
}

/**
 * Reverse the triangle winding of `geom` in place (swap the 2nd & 3rd vertex of
 * each triangle). Needed after a reflection (determinant −1): the reflected
 * positions/normals are correct, but the index order would still imply the OLD
 * orientation, so without this the mirrored faces are back-facing. Handles indexed
 * geometry (box/sphere — the v1 sources) and falls back to swapping attribute
 * triplets for the non-indexed case. Returns `geom` for chaining.
 */
function reverseWinding(geom: BufferGeometry): BufferGeometry {
  const index = geom.getIndex();
  if (index) {
    const arr = index.array;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
    return geom;
  }
  for (const attr of Object.values(geom.attributes)) {
    const data = attr.array;
    const n = attr.itemSize;
    for (let i = 0; i + 2 < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const o1 = (i + 1) * n + k;
        const o2 = (i + 2) * n + k;
        const tmp = data[o1];
        data[o1] = data[o2];
        data[o2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
  return geom;
}

/** Test seam: drop every cached geometry (disposing GPU-less CPU buffers). */
export function clear(): void {
  for (const geom of cache.values()) geom.dispose();
  cache.clear();
}

/** Test/diagnostic seam: current number of cached geometries. */
export function size(): number {
  return cache.size;
}
