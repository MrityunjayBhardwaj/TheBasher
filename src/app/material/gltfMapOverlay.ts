// gltfMapOverlay — apply a GltfChild material's EDIT-LAYER texture maps onto an
// imported three.js material clone (#178 S5).
//
// THE EDIT-LAYER MODEL (user decision 2026-06-16): a glTF child's captured
// OpenPBR material renders from the imported clone (S3 overlay preserves the
// clone's embedded textures). Its IR `maps` are therefore a SPARSE OVERRIDE on
// top of that clone, NOT a from-scratch map set (the native-material semantics):
//   - null         → INHERIT the imported texture (leave the clone's slot — the
//                    default; an unedited import never touches a texture, so a
//                    100MB model pays ZERO re-bake/parity cost).
//   - CLEARED_MAP   → REMOVE the imported texture (slot → null).
//   - BakedTextureRef → REPLACE with this baked texture (the user picked a file →
//                    attachMapFromFile baked it to OPFS, S5 inspector).
// The imported textures keep serializing via the embedded glTF bytes (V41); only
// the user's edits become DAG-resident BakedTextureRefs.
//
// REF: #178 S5; src/viewport/SceneFromDAG.tsx (the overlay effect that calls
//      applyEditedMaps); src/app/asset/bakedTextureStore.ts (loadBakedTexture);
//      src/app/material/attachMapFromFile.ts (the bake-on-pick front door).

import * as THREE from 'three';
import type { BakedTextureRef, InlineMaterialMaps } from '../../nodes/types';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import { loadBakedTexture, type LoadBakedTextureHooks } from '../asset/bakedTextureStore';
import type { MaterialMapSlot } from './attachMapFromFile';

/**
 * The "cleared" sentinel for a glTF edit-layer map slot. A BakedTextureRef with
 * an EMPTY hash — it satisfies the schema (so it round-trips through setParam /
 * save / load) yet references no OPFS file (`collectAssetRefs` skips empty hashes,
 * `loadBakedTexture` is never called on it). It is the third state the
 * `BakedTextureRef | null` field needs: null = inherit imported, sentinel =
 * remove imported, real ref = replace.
 */
export const CLEARED_MAP: BakedTextureRef = {
  hash: '',
  colorSpace: 'no-colorspace',
  flipY: false,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
};

export function isClearedMap(ref: BakedTextureRef | null | undefined): boolean {
  return ref != null && ref.hash === '';
}

/** IR map slot → the three.js material property it drives. */
const SLOT_TO_THREE_PROP: Record<MaterialMapSlot, keyof THREE.MeshStandardMaterial> = {
  albedo: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metalness: 'metalnessMap',
  emissive: 'emissiveMap',
  ao: 'aoMap',
};

const SLOTS = Object.keys(SLOT_TO_THREE_PROP) as MaterialMapSlot[];

/** True iff any slot of this map set carries an edit (a real ref or a clear). */
export function hasMapEdits(maps: InlineMaterialMaps | undefined): boolean {
  if (!maps) return false;
  return SLOTS.some((slot) => maps[slot] != null);
}

/**
 * Apply a material's edit-layer maps onto a three material clone. null slots are
 * left as-is (inherit the imported texture); cleared slots are removed; real refs
 * are loaded from OPFS and set. ASYNC (texture decode); `isCancelled` lets the
 * caller bail when the overlay effect re-runs before the loads resolve, so a
 * stale load never lands on a replaced material. Returns true if it mutated the
 * material (so the caller can request a frame).
 */
export async function applyEditedMaps(
  material: THREE.Material,
  maps: InlineMaterialMaps | undefined,
  storage: StorageCapability,
  isCancelled: () => boolean,
  hooks: LoadBakedTextureHooks = {},
): Promise<boolean> {
  if (!maps || !('map' in material)) return false;
  const std = material as THREE.MeshStandardMaterial;
  let changed = false;
  for (const slot of SLOTS) {
    const ref = maps[slot];
    if (ref == null) continue; // inherit the imported texture
    const prop = SLOT_TO_THREE_PROP[slot];
    if (isClearedMap(ref)) {
      if (std[prop] != null) {
        (std as unknown as Record<string, unknown>)[prop] = null;
        changed = true;
      }
      continue;
    }
    const texture = await loadBakedTexture(storage, ref, hooks);
    if (isCancelled()) {
      texture.dispose();
      return changed;
    }
    (std as unknown as Record<string, unknown>)[prop] = texture;
    changed = true;
  }
  if (changed) std.needsUpdate = true;
  return changed;
}
