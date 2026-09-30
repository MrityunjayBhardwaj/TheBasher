// attachMapFromFile — the File → THREE.Texture → OPFS entry point for v0.6 #2
// texture maps (#178, W5, D-04). persistTexture (bakedTextureStore.ts) takes an
// ALREADY-decoded texture mid-pipeline; this adds the front door: decode a picked
// File, set the per-slot colorspace BEFORE persisting (M5 — a data map persisted
// as sRGB washes out), then content-hash it into OPFS (V30 authoritative bytes).
// The IR map slot carries only the returned BakedTextureRef handle.
//
// Per-slot colorspace (D-04, mirrors the BakedMeshR sRGB/linear split):
//   albedo / emissive  → sRGB   (colour data)
//   normal / roughness / metalness / ao → linear (non-colour data)
//
// A decode/persist failure is surfaced via assetErrorStore (the MERGED feedback
// surface on main — NOT the #172 notificationStore, which is an unmerged PR).
//
// REF: CONTEXT D-04; PLAN W5 (5.1); vyapti V30; hetvabhasa H59 (map-aware); #178.

import * as THREE from 'three';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import { MATERIAL_MAP_SLOT_TABLE } from '../../nodes/types';
import type { BakedTextureRef, IrMapSlot } from '../../nodes/types';
import { MAP_UV_SLOTS } from '../../nodes/materialSchema';
import {
  fromBakedColorSpace,
  persistTexture,
  type PersistTextureHooks,
} from '../asset/bakedTextureStore';

/** A material map slot (IR vocabulary). The list and each slot's colour space are the slot table's (#1324). */
export type MaterialMapSlot = IrMapSlot;

export const MATERIAL_MAP_SLOTS: readonly MaterialMapSlot[] = MAP_UV_SLOTS;

export interface AttachMapHooks {
  /** Override the File→Texture decode (test seam — happy-dom has no decoder). */
  decode?: (url: string) => Promise<THREE.Texture>;
  /** Forwarded to persistTexture (test seam for the canvas-readback step). */
  persist?: PersistTextureHooks;
}

function defaultDecode(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url);
}

/**
 * Decode a picked image File, stamp the per-slot colorspace, and persist it to
 * OPFS — returning the serializable BakedTextureRef to write onto the IR map slot.
 * ASYNC: the setParam that records the ref must run only after this resolves.
 */
export async function attachMapFromFile(
  storage: StorageCapability,
  file: File,
  slot: MaterialMapSlot,
  hooks: AttachMapHooks = {},
): Promise<BakedTextureRef> {
  const url = URL.createObjectURL(file);
  try {
    const texture = await (hooks.decode ?? defaultDecode)(url);
    // Set the colorspace BEFORE persist so the ref captures it (M5). flipY keeps
    // the TextureLoader default (true) — the standard image-upload orientation
    // (glTF's flipY=false is a glTF-specific convention, not used for uploads).
    texture.colorSpace = fromBakedColorSpace(MATERIAL_MAP_SLOT_TABLE[slot].colorSpace); // D-04
    return await persistTexture(storage, texture, hooks.persist);
  } finally {
    URL.revokeObjectURL(url);
  }
}
