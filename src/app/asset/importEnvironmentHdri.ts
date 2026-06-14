// UX #9 — import an .hdr/.exr environment file into OPFS and return its assetRef.
//
// The thin app-facing wrapper over envHdriStore.persistEnvHdri: resolves the
// active storage capability, persists by content hash, and hands back the
// assetRef string to drop into the Scene's `envSource`. Used by the inspector's
// Environment "Import…" button (slice 3) and the dev seam (e2e). Throws on an
// unsupported extension so the caller can surface it (V38: no silent no-op).
//
// REF: src/app/asset/envHdriStore.ts (persistEnvHdri); vyapti V47.

import { getStorage } from '../boot';
import { persistEnvHdri } from './envHdriStore';

export async function importEnvironmentHdri(bytes: Uint8Array, filename: string): Promise<string> {
  const storage = await getStorage();
  return persistEnvHdri(storage, bytes, filename);
}
