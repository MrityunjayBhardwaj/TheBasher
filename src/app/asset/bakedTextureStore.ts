// Baked-texture persist / load + content-hash + OPFS store
// (Phase 151 Apply-Transform, Wave 3 Task 7, issue #151).
//
// SELF-CONTAINED store (M4 option a): a baked glTF child must survive its source
// asset being deleted (the H60 orphan class made permanent). So a baked texture is
// copied to OPFS by content hash — `baked-texture/<hash>.<ext>` — never referenced
// back into `user-imports/<name>/`. Two bakes of the same source texture dedupe to
// ONE file (the §48 determinism goal), bounding the byte-duplication cost.
//
// TWO readback paths (RESEARCH §M4):
//   (1) PREFERRED — copy the ORIGINAL compressed bytes. If a source-URI
//       association survived the SkeletonUtils clone, the original PNG/JPG bytes
//       still live in OPFS; copy them verbatim (lossless, no re-encode, cheap).
//   (2) FALLBACK (universal, ALWAYS shipped) — draw `texture.image` to an
//       OffscreenCanvas, `toBlob()` → PNG bytes → OPFS. Re-encodes (the
//       content-hash differs from the source's) but the IMAGE is visually
//       identical, and it works for ANY texture (procedural, modified, or one
//       whose source association did not survive the clone).
//
// The LOKAYATA PROBE (the `__basher_gltf_meshes.mapProbe` seam + the
// `p151-texture-readback-probe` e2e) observes which path is available on the
// clone at runtime BEFORE the bake commits — path (2) is shipped unconditionally
// so the wave cannot block on the MEDIUM-confidence path-(1) item.
//
// Colorspace (M5/M8): a map loaded without its sRGB colorspace washes out on
// reload. `BakedTextureRef.colorSpace` carries it; `loadBakedTexture` sets it
// explicitly. The load is suspense-cached (mirrors opfsLoader.ts), the only async
// reader of the authoritative OPFS texture bytes.
//
// H45 / read-only capture: `persistTexture` READS `texture.image` (or copies
// source bytes) — it NEVER mutates the live clone material/texture. The clone
// material is already a per-instance `s.clone()` (#99).
//
// REF: PLAN.md Wave 3 Task 7; RESEARCH §M4/§M5/§M8; bakedGeometryStore.ts (the
//      mirrored content-hash store); opfsLoader.ts:30-111 (the suspense pattern);
//      GROUND_TRUTH_GLTF.md §STAGE 3 (Texture associations).

import * as THREE from 'three';
import { hashValue } from '../../core/dag/hash';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import type { BakedTextureRef } from '../../nodes/types';

/** Root OPFS directory for baked texture blobs. */
export const BAKED_TEXTURE_ROOT = 'baked-texture';

/**
 * three.js colorspace constants ('srgb' | 'srgb-linear' | '') mapped onto the
 * serializable `BakedTextureRef.colorSpace` enum. three's `NoColorSpace` is the
 * empty string; persist it as the explicit `'no-colorspace'` token.
 */
function toBakedColorSpace(cs: string): BakedTextureRef['colorSpace'] {
  if (cs === THREE.SRGBColorSpace) return 'srgb';
  if (cs === THREE.LinearSRGBColorSpace) return 'srgb-linear';
  return 'no-colorspace';
}

/** Inverse of {@link toBakedColorSpace}: the ref token → a three colorspace. */
function fromBakedColorSpace(cs: BakedTextureRef['colorSpace']): THREE.ColorSpace {
  if (cs === 'srgb') return THREE.SRGBColorSpace;
  if (cs === 'srgb-linear') return THREE.LinearSRGBColorSpace;
  return THREE.NoColorSpace;
}

/** The OPFS file path for a baked texture, keyed by content hash + extension. */
export function bakedTexturePath(hash: string, ext: string): string {
  const safeExt = ext.replace(/^\./, '').toLowerCase() || 'png';
  return `${BAKED_TEXTURE_ROOT}/${hash}.${safeExt}`;
}

/**
 * Hash raw image bytes deterministically (FNV-1a over the byte array — same
 * `hashValue` util the baked-geometry store uses, so the two stores share one
 * determinism contract).
 */
function hashBytes(bytes: Uint8Array): string {
  return hashValue(Array.from(bytes));
}

/** Lowercase file extension of an OPFS/URI path (no leading dot), or '' if none. */
function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  if (dot <= slash) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * Optional override of the byte-readback strategy (test seam). happy-dom cannot
 * decode a real PNG or run `OffscreenCanvas.convertToBlob`, so unit tests inject
 * a deterministic encoder; the browser/e2e path uses the real canvas readback.
 */
export interface PersistTextureHooks {
  /**
   * Path (1): if the texture carries a source-URI association that maps back to a
   * still-present OPFS file, return its path so the ORIGINAL bytes are copied
   * verbatim. Return null to fall through to the canvas readback (path 2).
   */
  resolveSourcePath?: (texture: THREE.Texture) => string | null;
  /**
   * Path (2): encode `texture.image` to PNG bytes. Defaults to the OffscreenCanvas
   * readback; injected in unit tests where no real image decoder exists.
   */
  encodeImage?: (texture: THREE.Texture) => Promise<{ bytes: Uint8Array; ext: string }>;
}

/** Default canvas readback (path 2) — draw `texture.image` → PNG bytes. */
async function canvasReadback(texture: THREE.Texture): Promise<{ bytes: Uint8Array; ext: string }> {
  const image = texture.image as
    | (CanvasImageSource & { width?: number; height?: number })
    | undefined;
  const width = (image as { width?: number } | undefined)?.width ?? 0;
  const height = (image as { height?: number } | undefined)?.height ?? 0;
  if (!image || width <= 0 || height <= 0) {
    throw new Error('bakedTextureStore: texture.image has no decodable dimensions');
  }
  // OffscreenCanvas is available in the worker + the modern main thread; fall
  // back to a DOM <canvas> if the platform lacks it.
  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('bakedTextureStore: no 2d context for canvas readback');
    ctx.drawImage(image, 0, 0);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('bakedTextureStore: no 2d context for canvas readback');
    ctx.drawImage(image, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png',
      );
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, ext: 'png' };
}

/**
 * Persist a three.js Texture to OPFS by content hash, returning a serializable
 * handle. READ-ONLY on the texture (H45). Idempotent: an already-present
 * content-hashed file is not rewritten (SC-4 dedupe).
 *
 * Tries path (1) (original-bytes copy) when `hooks.resolveSourcePath` yields a
 * present OPFS file, then falls back to path (2) (canvas readback) — which is
 * always available, so the wave never blocks on the path-(1) probe outcome.
 */
export async function persistTexture(
  storage: StorageCapability,
  texture: THREE.Texture,
  hooks: PersistTextureHooks = {},
): Promise<BakedTextureRef> {
  let bytes: Uint8Array | null = null;
  let ext = 'png';

  // Path (1) — copy the original compressed bytes verbatim (lossless).
  const sourcePath = hooks.resolveSourcePath?.(texture) ?? null;
  if (sourcePath) {
    try {
      const srcBytes = await storage.read(sourcePath);
      bytes = srcBytes;
      ext = extOf(sourcePath) || 'png';
    } catch {
      // The source file vanished (deleted asset) — fall through to path (2).
      bytes = null;
    }
  }

  // Path (2) — canvas readback (universal fallback).
  if (!bytes) {
    const encoded = await (hooks.encodeImage ?? canvasReadback)(texture);
    bytes = encoded.bytes;
    ext = encoded.ext || 'png';
  }

  const hash = hashBytes(bytes);
  const path = bakedTexturePath(hash, ext);
  if (!(await storage.exists(path))) {
    await storage.write(path, bytes);
  }

  return {
    hash: `${hash}.${ext}`,
    colorSpace: toBakedColorSpace(texture.colorSpace),
    flipY: texture.flipY,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
  };
}

/** Split a `BakedTextureRef.hash` ('<hash>.<ext>') into its OPFS path. */
function refToPath(ref: BakedTextureRef): string {
  const dot = ref.hash.lastIndexOf('.');
  if (dot <= 0) return bakedTexturePath(ref.hash, 'png');
  return bakedTexturePath(ref.hash.slice(0, dot), ref.hash.slice(dot + 1));
}

/**
 * Optional override of the texture decode step (test seam). happy-dom has no
 * image decoder, so unit tests inject a fake loader; the browser/e2e path uses
 * the real `THREE.TextureLoader`.
 */
export interface LoadBakedTextureHooks {
  decode?: (url: string) => Promise<THREE.Texture>;
}

/**
 * Load a baked texture back from OPFS into a three.js Texture, restoring the
 * captured colorspace / flipY / wrap state EXACTLY (M5 — wrong colorspace washes
 * out color on reload). Async; the renderer (BakedMeshR, Task 8) wraps this in a
 * suspense cache.
 */
export async function loadBakedTexture(
  storage: StorageCapability,
  ref: BakedTextureRef,
  hooks: LoadBakedTextureHooks = {},
): Promise<THREE.Texture> {
  const bytes = await storage.read(refToPath(ref));
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const url = URL.createObjectURL(new Blob([ab]));
  try {
    const texture = await (hooks.decode ?? defaultDecode)(url);
    // Restore the captured state EXPLICITLY — TextureLoader defaults to
    // NoColorSpace + flipY=true, which is wrong for glTF maps.
    texture.colorSpace = fromBakedColorSpace(ref.colorSpace);
    texture.flipY = ref.flipY;
    texture.wrapS = ref.wrapS as THREE.Wrapping;
    texture.wrapT = ref.wrapT as THREE.Wrapping;
    texture.needsUpdate = true;
    return texture;
  } finally {
    // The TextureLoader has already read the blob into a decoded image by the
    // time it resolves; the URL can be revoked.
    URL.revokeObjectURL(url);
  }
}

/** Default decode via three's TextureLoader (real browser path). */
function defaultDecode(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url);
}

/** Test-only — expose the colorspace mapping for assertions. */
export const __bakedTextureColorSpace = { toBakedColorSpace, fromBakedColorSpace };
