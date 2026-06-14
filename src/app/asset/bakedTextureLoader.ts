// Suspense loader for baked textures — the async reader of the OPFS authoritative
// baked-texture bytes (Phase 151, Wave 3 Task 8, issue #151).
//
// Mirrors bakedGeometryLoader.ts / opfsLoader.ts exactly: a per-ref cache keyed by
// the `BakedTextureRef.hash`, an in-flight promise cache (Suspense throw), and an
// error cache so a rejected read re-throws on retry (no permanent suspended hang).
// The renderer (BakedMeshR) calls `useBakedTexture` for each non-null map slot;
// the async OPFS read + TextureLoader decode lives HERE, never in the pure
// resolver (V29 purity).
//
// REF: PLAN.md Wave 3 Task 8; bakedGeometryLoader.ts (the mirrored suspense hook);
//      bakedTextureStore.ts (loadBakedTexture); opfsLoader.ts:30-111.

import type { Texture } from 'three';
import { getStorage } from '../boot';
import type { BakedTextureRef } from '../../nodes/types';
import { loadBakedTexture } from './bakedTextureStore';

const textureCache = new Map<string, Texture>();
const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();

function loadAndCache(ref: BakedTextureRef): Promise<void> {
  return (async () => {
    const storage = await getStorage();
    const tex = await loadBakedTexture(storage, ref);
    textureCache.set(ref.hash, tex);
  })();
}

/**
 * Suspense-style baked-texture resolution (the non-hook core). Returns the
 * decoded Texture synchronously on a cache hit; otherwise throws the in-flight
 * OPFS-read+decode promise so the surrounding <Suspense> boundary catches it.
 */
export function resolveBakedTexture(ref: BakedTextureRef): Texture {
  const hit = textureCache.get(ref.hash);
  if (hit) return hit;

  const failed = errorCache.get(ref.hash);
  if (failed) throw failed;

  let p = promiseCache.get(ref.hash);
  if (!p) {
    p = loadAndCache(ref).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(ref.hash, err instanceof Error ? err : new Error(String(err)));
      },
    );
    promiseCache.set(ref.hash, p);
  }
  throw p;
}

/**
 * Non-throwing peek for read-only consumers OUTSIDE a Suspense boundary (the UV
 * editor's texture backdrop, V48). Returns the decoded Texture on a cache hit;
 * otherwise kicks off the same OPFS-read+decode (so a later re-poll resolves)
 * and returns null. A cached decode FAILURE also returns null — the consumer
 * shows no backdrop rather than crashing (resilience by construction).
 */
export function peekBakedTexture(ref: BakedTextureRef): Texture | null {
  const hit = textureCache.get(ref.hash);
  if (hit) return hit;
  if (errorCache.has(ref.hash)) return null;
  if (!promiseCache.has(ref.hash)) {
    const p = loadAndCache(ref).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(ref.hash, err instanceof Error ? err : new Error(String(err)));
      },
    );
    promiseCache.set(ref.hash, p);
  }
  return null;
}

/**
 * React Suspense hook — the BakedMeshR entry point for one map slot. Accepts a
 * nullable ref (a primitive bake / an absent map slot) and returns null for it,
 * so callers can invoke this hook UNCONDITIONALLY for all 6 fixed map slots
 * (rules-of-hooks safe) — only the present refs actually suspend.
 */
export function useBakedTexture(ref: BakedTextureRef | null): Texture | null {
  if (!ref) return null;
  return resolveBakedTexture(ref);
}

/** Test-only — clear the caches. */
export function __resetBakedTextureLoaderForTests(): void {
  textureCache.clear();
  promiseCache.clear();
  errorCache.clear();
}
