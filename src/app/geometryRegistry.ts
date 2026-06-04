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

import { BoxGeometry, SphereGeometry, type BufferGeometry } from 'three';
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
  return null; // gltf / baked — not built here (gltf in asset clone, baked from OPFS)
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
