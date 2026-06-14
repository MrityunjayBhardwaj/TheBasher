// Environment-HDRI persist / load + content-hash + OPFS store (UX #9 slice 2).
//
// Mirrors bakedTextureStore.ts: a SELF-CONTAINED, content-hash-keyed OPFS store
// (`env-hdri/<hash>.<ext>`) so an imported .hdr/.exr survives across sessions and
// embeds in the .basher bundle (V41, collected in slice 4). Two imports of the
// same file dedupe to ONE blob (the determinism goal bakedTexture also keeps).
//
// Unlike a glTF map, an HDRI is LINEAR radiance data — RGBELoader/EXRLoader
// return a HalfFloat DataTexture; we set NO sRGB colorspace, only the
// EquirectangularReflectionMapping that three needs to treat it as an env map.
// drei's <Environment map={…}> assigns it to `scene.environment` directly (no
// PMREM in that path — three processes the equirect env map at render).
//
// REF: bakedTextureStore.ts (the mirrored content-hash store); vyapti V47;
//      three RGBELoader / EXRLoader (DataTextureLoader.parse).

import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { hashValue } from '../../core/dag/hash';
import type { StorageCapability } from '../../core/storage/StorageCapability';

/** Root OPFS directory for imported environment HDRI blobs. */
export const ENV_HDRI_ROOT = 'env-hdri';

/** The .hdr / .exr extensions the file-import path accepts. */
export const SUPPORTED_ENV_EXTS = ['hdr', 'exr'] as const;
export type EnvHdriExt = (typeof SUPPORTED_ENV_EXTS)[number];

/** Lowercase file extension of a path/URI (no leading dot), or '' if none. */
export function envExtOf(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  if (dot <= slash) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/** True iff the filename/path carries a supported HDRI extension. */
export function isSupportedEnvExt(path: string): boolean {
  return (SUPPORTED_ENV_EXTS as readonly string[]).includes(envExtOf(path));
}

/** Deterministic content hash of the raw HDRI bytes (FNV-1a over the array —
 *  the same util the baked stores use, so all OPFS stores share one contract). */
function hashBytes(bytes: Uint8Array): string {
  return hashValue(Array.from(bytes));
}

/** The OPFS file path (== the stored assetRef) for an HDRI, keyed by content
 *  hash + extension. */
export function envHdriPath(hash: string, ext: string): string {
  const safeExt = ext.replace(/^\./, '').toLowerCase() || 'hdr';
  return `${ENV_HDRI_ROOT}/${hash}.${safeExt}`;
}

/**
 * Persist imported HDRI bytes to OPFS by content hash; returns the assetRef
 * (the OPFS path) to store in the Scene's `envSource`. Write-if-absent so a
 * re-import of identical bytes is a no-op (dedupe). Throws on an unsupported
 * extension — the caller surfaces it (V38: no silent no-op).
 */
export async function persistEnvHdri(
  storage: StorageCapability,
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const ext = envExtOf(filename);
  if (!(SUPPORTED_ENV_EXTS as readonly string[]).includes(ext)) {
    throw new Error(
      `Unsupported environment file ".${ext}" — import a .hdr or .exr equirectangular map.`,
    );
  }
  const hash = hashBytes(bytes);
  const path = envHdriPath(hash, ext);
  if (!(await storage.exists(path))) {
    await storage.write(path, bytes);
  }
  return path;
}

/** Decode hook seam — happy-dom can't run RGBELoader/EXRLoader on real bytes, so
 *  unit tests inject a fake decoder. The real browser path uses the loaders. */
export interface LoadEnvHdriHooks {
  decode?: (url: string, ext: string) => Promise<THREE.DataTexture>;
}

function defaultDecode(url: string, ext: string): Promise<THREE.DataTexture> {
  if (ext === 'exr') return new EXRLoader().loadAsync(url);
  return new RGBELoader().loadAsync(url);
}

/**
 * Load an imported HDRI back from OPFS into an equirectangular env texture.
 * Sets `mapping = EquirectangularReflectionMapping` (required for three to use
 * it as `scene.environment`); leaves the linear HDR colorspace untouched. The
 * loader (environmentTextureLoader.ts) wraps this in a suspense cache.
 */
export async function loadEnvHdri(
  storage: StorageCapability,
  assetRef: string,
  hooks: LoadEnvHdriHooks = {},
): Promise<THREE.Texture> {
  const bytes = await storage.read(assetRef);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const url = URL.createObjectURL(new Blob([ab]));
  try {
    const ext = envExtOf(assetRef) || 'hdr';
    const texture = await (hooks.decode ?? defaultDecode)(url, ext);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.needsUpdate = true;
    return texture;
  } finally {
    URL.revokeObjectURL(url);
  }
}
