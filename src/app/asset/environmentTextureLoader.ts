// Suspense loader for an imported environment HDRI — the async reader of the
// OPFS .hdr/.exr bytes (UX #9 slice 2).
//
// Mirrors bakedTextureLoader.ts exactly: a per-assetRef texture cache, an
// in-flight promise cache (Suspense throw), and an error cache so a rejected
// read answers with a magenta stand-in (#1309). The renderers (EnvironmentFile,
// StudioAreaLightR) call `useEnvironmentTexture(assetRef)`; the OPFS read +
// RGBELoader/EXRLoader decode lives in envHdriStore.loadEnvHdri, never in a
// pure resolver (V29 purity).
//
// REF: bakedTextureLoader.ts (the mirrored suspense hook); envHdriStore.ts
//      (loadEnvHdri); vyapti V47.

import {
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearSRGBColorSpace,
  RGBAFormat,
  type Texture,
} from 'three';
import { getStorage } from '../boot';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { loadEnvHdri } from './envHdriStore';
import { rememberFailedRead, useReadFailureEpoch } from './readFailures';

const textureCache = new Map<string, Texture>();
const promiseCache = new Map<string, Promise<void>>();
const errorCache = new Map<string, Error>();
const missingCache = new Map<string, Texture>();

/**
 * #1309 — the stand-in's size. An equirect environment is prefiltered at `width / 4` (three's
 * `PMREMGenerator.fromEquirectangular`), so a one-texel stand-in prefilters to nothing: measured,
 * 1×1 gives an all-black atlas, 64×32 gives every lit texel exactly (1, 0, 1).
 */
const MISSING_WIDTH = 64;
const MISSING_HEIGHT = 32;

/**
 * #1309 — what an HDRI that cannot be read is drawn as: magenta, one instance per asset. Blender
 * fills an image it cannot read with one magenta texel in both engines (Cycles `IMAGE_MISSING_RGBA`,
 * EEVEE `GPU_texture_create_error`), world and light textures alike.
 */
function missingEnvironmentFor(assetRef: string): Texture {
  let tex = missingCache.get(assetRef);
  if (!tex) {
    const data = new Float32Array(MISSING_WIDTH * MISSING_HEIGHT * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 1;
      data[i + 2] = 1;
      data[i + 3] = 1;
    }
    tex = new DataTexture(data, MISSING_WIDTH, MISSING_HEIGHT, RGBAFormat, FloatType);
    tex.mapping = EquirectangularReflectionMapping;
    tex.colorSpace = LinearSRGBColorSpace;
    tex.name = 'missing-image';
    tex.needsUpdate = true;
    missingCache.set(assetRef, tex);
  }
  return tex;
}

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
 *
 * #1309 — a read that FAILED returns the magenta stand-in instead of re-throwing. The throw relied
 * on an error boundary, and only the world environment has one: a studio light whose texture was
 * missing unmounted the whole app (measured: blank page, no scene). Under the boundary the world
 * lost its lighting instead of showing what was wrong. The banner names the file either way.
 */
export function resolveEnvironmentTexture(assetRef: string): Texture {
  const hit = textureCache.get(assetRef);
  if (hit) return hit;

  if (errorCache.has(assetRef)) return missingEnvironmentFor(assetRef);

  let p = promiseCache.get(assetRef);
  if (!p) {
    p = loadAndCache(assetRef).then(
      () => undefined,
      (err: unknown) => {
        errorCache.set(assetRef, err instanceof Error ? err : new Error(String(err)));
        useAssetErrorStore
          .getState()
          .report(assetRef, `image could not be read, drawn magenta: ${formatAssetError(err)}`);
        // #1312 — the failure answers only until the file is written again: importing the same
        // HDRI writes the same path.
        rememberFailedRead(assetRef, () => {
          errorCache.delete(assetRef);
          promiseCache.delete(assetRef);
          missingCache.delete(assetRef);
          useAssetErrorStore.getState().clear(assetRef);
        });
      },
    );
    promiseCache.set(assetRef, p);
  }
  throw p;
}

/** React Suspense hook — the EnvironmentFile entry point. */
export function useEnvironmentTexture(assetRef: string): Texture {
  useReadFailureEpoch(); // #1312 — re-resolve once a failed file is written again
  return resolveEnvironmentTexture(assetRef);
}

/** Test-only — clear the caches. */
export function __resetEnvironmentTextureLoaderForTests(): void {
  textureCache.clear();
  promiseCache.clear();
  errorCache.clear();
  missingCache.clear();
}
