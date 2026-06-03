// Suspense loader for baked geometry — the ONLY async reader of the OPFS
// authoritative baked-geometry bytes (Phase 151, Wave 1, issue #151).
//
// The pure resolver (resolveEvaluatedMesh) returns a GeometryRef HANDLE
// synchronously — it is NEVER made async (V29 purity; every sync consumer, the
// gizmo + inspector, depends on it). The async OPFS read lives HERE, in a React
// Suspense hook used by the renderer (BakedMeshR, Wave 2). On a cache miss the
// hook throws the in-flight promise; the viewport's <Suspense> boundary catches
// it; the resolved geometry is primed into geometryRegistry so the re-render is a
// sync registry hit.
//
// This mirrors opfsLoader.ts (the glTF blob-URL suspense path) exactly:
//   urlCache    → geometryRegistry (the resolved-value cache, keyed by ref.key)
//   promiseCache → in-flight reads, keyed by ref.key
//   errorCache   → rejected reads re-thrown on retry (no permanent suspended hang)
//
// REF: PLAN.md Wave 1 Task 2; opfsLoader.ts:30-111 (the suspense pattern);
//      bakedGeometryStore.ts (readBakedGeometry); geometryRegistry.ts (get/prime).

import type { BufferGeometry } from 'three';
import { getStorage } from '../boot';
import type { GeometryRef } from '../../nodes/types';
import * as geometryRegistry from '../geometryRegistry';
import { readBakedGeometry } from './bakedGeometryStore';

const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();

function loadAndPrime(ref: GeometryRef): Promise<void> {
  return (async () => {
    if (ref.descriptor.kind !== 'baked') {
      throw new Error(`bakedGeometryLoader: not a baked ref: ${ref.key}`);
    }
    const storage = await getStorage();
    const geom = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    geometryRegistry.prime(ref, geom);
  })();
}

/**
 * Suspense-style baked-geometry resolution (the non-hook core). Returns the
 * geometry synchronously when the registry already holds it (cache hit);
 * otherwise throws the in-flight OPFS-read promise so the surrounding <Suspense>
 * boundary catches it. After the promise resolves and primes the registry, the
 * next call is a sync hit. Kept as a plain function so non-React callers (tests,
 * future tools) can drive the same throw/await/retry cycle; `useBakedGeometry`
 * is the React-hook entry point.
 */
export function resolveBakedGeometry(ref: GeometryRef): BufferGeometry {
  const hit = geometryRegistry.get(ref);
  if (hit) return hit;

  // A prior read that rejected surfaces its Error here (mirrors opfsLoader's
  // errorCache — throwing a settled promise would suspend forever).
  const failed = errorCache.get(ref.key);
  if (failed) throw failed;

  let p = promiseCache.get(ref.key);
  if (!p) {
    // The promise always FULFILLS (priming the registry on success, recording
    // the Error on failure) so React's retry re-runs this — which then either
    // returns the primed geometry or throws the cached Error.
    p = loadAndPrime(ref).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(ref.key, err instanceof Error ? err : new Error(String(err)));
      },
    );
    promiseCache.set(ref.key, p);
  }
  throw p;
}

/**
 * React Suspense hook — the renderer (BakedMeshR, Wave 2) entry point. Thin
 * wrapper over `resolveBakedGeometry`; on a registry miss it throws the in-flight
 * promise and the viewport's <Suspense> boundary catches it.
 */
export function useBakedGeometry(ref: GeometryRef): BufferGeometry {
  return resolveBakedGeometry(ref);
}

/** Test-only — clear the in-flight + error caches. */
export function __resetBakedGeometryLoaderForTests(): void {
  promiseCache.clear();
  errorCache.clear();
}
