// Suspense loader for an imported environment HDRI — the async reader of the
// OPFS .hdr/.exr bytes (UX #9 slice 2).
//
// Mirrors bakedTextureLoader.ts exactly: a per-assetRef texture cache, an
// in-flight promise cache (Suspense throw), and an error cache so a rejected
// read re-throws on retry (no permanent suspended hang). The renderer
// (EnvironmentFile) calls `useEnvironmentTexture(assetRef)`; the OPFS read +
// RGBELoader/EXRLoader decode lives in envHdriStore.loadEnvHdri, never in a
// pure resolver (V29 purity).
//
// REF: bakedTextureLoader.ts (the mirrored suspense hook); envHdriStore.ts
//      (loadEnvHdri); vyapti V47.

import type { Texture } from 'three';
import { getStorage } from '../boot';
import { loadEnvHdri } from './envHdriStore';

const textureCache = new Map<string, Texture>();
const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();

function loadAndCache(assetRef: string): Promise<void> {
  return (async () => {
    const storage = await getStorage();
    const tex = await loadEnvHdri(storage, assetRef);
    textureCache.set(assetRef, tex);
  })();
}

/**
 * Suspense-style HDRI resolution (the non-hook core). Returns the decoded
 * Texture synchronously on a cache hit; otherwise throws the in-flight
 * OPFS-read+decode promise so the surrounding <Suspense> boundary catches it.
 */
export function resolveEnvironmentTexture(assetRef: string): Texture {
  const hit = textureCache.get(assetRef);
  if (hit) return hit;

  const failed = errorCache.get(assetRef);
  if (failed) throw failed;

  let p = promiseCache.get(assetRef);
  if (!p) {
    p = loadAndCache(assetRef).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(assetRef, err instanceof Error ? err : new Error(String(err)));
      },
    );
    promiseCache.set(assetRef, p);
  }
  throw p;
}

/** React Suspense hook — the EnvironmentFile entry point. */
export function useEnvironmentTexture(assetRef: string): Texture {
  return resolveEnvironmentTexture(assetRef);
}

/** Test-only — clear the caches. */
export function __resetEnvironmentTextureLoaderForTests(): void {
  textureCache.clear();
  promiseCache.clear();
  errorCache.clear();
}
