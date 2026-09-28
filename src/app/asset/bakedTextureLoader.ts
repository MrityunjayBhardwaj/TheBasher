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

import { DataTexture, RGBAFormat, SRGBColorSpace, type Texture } from 'three';
import { getStorage } from '../boot';
import type { BakedTextureRef } from '../../nodes/types';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { loadBakedTexture } from './bakedTextureStore';

const textureCache = new Map<string, Texture>();
const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();
const missingCache = new Map<string, Texture>();

/**
 * #1048 — what a map that cannot be read draws: one magenta texel, as Blender draws an image it
 * cannot find, so the object stays on screen and the gap is visible where it is. One per failed
 * key, never shared: materials clone and re-assert colour space on what they are handed.
 */
function missingTextureFor(key: string): Texture {
  let tex = missingCache.get(key);
  if (!tex) {
    tex = new DataTexture(new Uint8Array([255, 0, 255, 255]), 1, 1, RGBAFormat);
    tex.colorSpace = SRGBColorSpace;
    tex.name = 'missing-image';
    tex.needsUpdate = true;
    missingCache.set(key, tex);
  }
  return tex;
}

/** The asset banner's key for an image: where it was looked for, so two failures never merge. */
function imageLabel(ref: BakedTextureRef): string {
  return ref.store === 'project' ? `images/${ref.hash}` : `textures/${ref.hash}`;
}

/**
 * #1050 — the cache key is the whole texture state, not the image. A cached Texture carries the
 * wrap, filters, flip and colour space it was loaded with, and every material clones it with those
 * intact (`materialRegistry` re-asserts only colour space). Keyed by the image alone, the first
 * material to load an image decided how every later one sampled it — reachable the moment two
 * materials share a project image under different samplers.
 */
function cacheKeyOf(ref: BakedTextureRef): string {
  return [
    ref.store ?? 'global',
    ref.hash,
    ref.colorSpace,
    ref.flipY ? 1 : 0,
    ref.wrapS,
    ref.wrapT,
    ref.magFilter ?? '-',
    ref.minFilter ?? '-',
  ].join('|');
}

/**
 * Start one read+decode for `ref`, shared by the Suspense and peek roads. A failure is cached and
 * reported to the asset banner once, by the image's name — never thrown into render (#1048).
 */
function startLoad(key: string, ref: BakedTextureRef): Promise<void> {
  const p = (async () => {
    const storage = await getStorage();
    const tex = await loadBakedTexture(storage, ref);
    textureCache.set(key, tex);
  })().then(
    () => undefined,
    (err: unknown) => {
      errorCache.set(key, err instanceof Error ? err : new Error(String(err)));
      useAssetErrorStore
        .getState()
        .report(
          imageLabel(ref),
          `image could not be read, drawn magenta: ${formatAssetError(err)}`,
        );
    },
  );
  promiseCache.set(key, p);
  return p;
}

/**
 * Suspense-style baked-texture resolution (the non-hook core). Returns the
 * decoded Texture synchronously on a cache hit; otherwise throws the in-flight
 * OPFS-read+decode promise so the surrounding <Suspense> boundary catches it.
 *
 * #1048 — a read that FAILED returns the magenta stand-in instead of re-throwing. The throw was
 * there so a failed read would not suspend forever, and it relied on an error boundary that only
 * the clone road and the environment have: on a native mesh or a primitive with a map, one missing
 * image file unmounted the whole app (measured: blank page, no scene). The stand-in ends the
 * suspension just as well, keeps the object drawn, and the banner names the image.
 */
export function resolveBakedTexture(ref: BakedTextureRef): Texture {
  const key = cacheKeyOf(ref);
  const hit = textureCache.get(key);
  if (hit) return hit;

  if (errorCache.has(key)) return missingTextureFor(key);

  throw promiseCache.get(key) ?? startLoad(key, ref);
}

/**
 * Non-throwing peek for read-only consumers OUTSIDE a Suspense boundary (the UV
 * editor's texture backdrop, V48). Returns the decoded Texture on a cache hit;
 * otherwise kicks off the same OPFS-read+decode (so a later re-poll resolves)
 * and returns null. A cached decode FAILURE also returns null — the consumer
 * shows no backdrop rather than crashing (resilience by construction).
 */
export function peekBakedTexture(ref: BakedTextureRef): Texture | null {
  const key = cacheKeyOf(ref);
  const hit = textureCache.get(key);
  if (hit) return hit;
  if (errorCache.has(key)) return null;
  if (!promiseCache.has(key)) startLoad(key, ref);
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
  missingCache.clear();
}
