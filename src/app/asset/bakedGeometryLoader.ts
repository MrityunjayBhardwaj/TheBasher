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
//   errorCache   → rejected reads, answered with an empty stand-in (#1308)
//
// REF: PLAN.md Wave 1 Task 2; opfsLoader.ts:30-111 (the suspense pattern);
//      bakedGeometryStore.ts (readBakedGeometry); geometryRegistry.ts (get/prime).

import { BufferGeometry } from 'three';
import { getStorage } from '../boot';
import type { GeometryRef } from '../../nodes/types';
import { getForRead, prime } from '../geometryRegistry';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { bakedGeometryPath, readBakedGeometry } from './bakedGeometryStore';

const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();
const missingCache = new Map<string, BufferGeometry>();

/**
 * #1308 — what a baked mesh draws when its bytes cannot be read: nothing, one instance per ref.
 * Blender keeps an object whose mesh data is missing and draws it empty. This is NOT primed into
 * the registry, so every sync reader keeps seeing "no geometry" rather than a real empty mesh.
 */
function missingGeometryFor(key: string): BufferGeometry {
  let geom = missingCache.get(key);
  if (!geom) {
    geom = new BufferGeometry();
    geom.name = 'missing-geometry';
    missingCache.set(key, geom);
  }
  return geom;
}

/** The asset banner's key for a baked geometry: the file it was read from. */
function geometryLabel(ref: GeometryRef): string {
  const d = ref.descriptor;
  return d.kind === 'baked' ? bakedGeometryPath(d.hash, d.vertexCount) : ref.key;
}

function loadAndPrime(ref: GeometryRef): Promise<void> {
  return (async () => {
    if (ref.descriptor.kind !== 'baked') {
      throw new Error(`bakedGeometryLoader: not a baked ref: ${ref.key}`);
    }
    const storage = await getStorage();
    const geom = await readBakedGeometry(storage, ref.descriptor.hash, ref.descriptor.vertexCount);
    prime(ref, geom);
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
 *
 * #1308 — a read that FAILED returns an empty stand-in instead of re-throwing. The throw was there
 * so a failed read would not suspend forever, and it relied on an error boundary `BakedMeshR` does
 * not have: one missing geometry file unmounted the whole app (measured: blank page, no scene). The
 * stand-in ends the suspension just as well, keeps the object in the scene, and the banner names
 * the file.
 */
export function resolveBakedGeometry(ref: GeometryRef): BufferGeometry {
  const hit = getForRead(ref);
  if (hit) return hit;

  if (errorCache.has(ref.key)) return missingGeometryFor(ref.key);

  let p = promiseCache.get(ref.key);
  if (!p) {
    // The promise always FULFILLS (priming the registry on success, recording
    // the Error on failure) so React's retry re-runs this — which then either
    // returns the primed geometry or the empty stand-in.
    p = loadAndPrime(ref).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(ref.key, err instanceof Error ? err : new Error(String(err)));
        useAssetErrorStore
          .getState()
          .report(
            geometryLabel(ref),
            `geometry could not be read, drawn empty: ${formatAssetError(err)}`,
          );
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
  missingCache.clear();
}
