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
//      src/app/material/attachMapFromFile.ts (the bake-on-pick front door);
//      src/app/material/uvPlacement.ts (the shared resolve+write, #553);
//      src/app/material/openpbrToThree.ts (THREE_SLOT_OF — the one slot-name
//      correspondence, folded in here rather than respelled);
//      src/app/material/replacedMapPlacement.gate.test.ts (the #553 gate).

import * as THREE from 'three';
import type { BakedTextureRef, InlineMaterialMaps, UvPlacement } from '../../nodes/types';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import { loadBakedTexture, type LoadBakedTextureHooks } from '../asset/bakedTextureStore';
import { MATERIAL_MAP_SLOTS, type MaterialMapSlot } from './attachMapFromFile';
import { THREE_SLOT_OF } from './openpbrToThree';
import {
  ORIGIN_PIVOT,
  placeTexture,
  resolveSlotPlacement,
  type SlotPlacements,
} from './uvPlacement';

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

/**
 * An IMPORTED-TEXTURE descriptor (direct-import milestone, V53): a captured glTF
 * texture, `hash:''` + a `gltfTexture` index. Like a cleared slot it has no OPFS
 * file — but its meaning is the OPPOSITE: INHERIT the clone's imported texture
 * (leave the slot untouched), NOT remove it. It exists only to make the slot
 * inspector-visible + DAG-addressable; the bytes ride in the embedded `.glb`.
 * MUST be checked before {@link isClearedMap} (both share `hash:''`).
 */
export function isImportedMap(ref: BakedTextureRef | null | undefined): boolean {
  return ref != null && ref.hash === '' && typeof ref.gltfTexture === 'number';
}

/** A CLEARED slot = empty hash AND no glTF-import identity (else it is an
 *  imported descriptor, which inherits rather than removes — disambiguated
 *  because both sentinels carry `hash:''`). */
export function isClearedMap(ref: BakedTextureRef | null | undefined): boolean {
  return ref != null && ref.hash === '' && typeof ref.gltfTexture !== 'number';
}

// The IR slot → three.js property correspondence and the slot list are NOT
// respelled here (#553). `THREE_SLOT_OF` is the one place the two vocabularies
// meet — its own header names this module as the copy to fold in — and
// `MATERIAL_MAP_SLOTS` is the one slot list. A local table agreeing today is
// exactly how the six-IR-slots-over-five-glTF-fields bug reached the screen.
const SLOTS = MATERIAL_MAP_SLOTS;

/** True iff any slot carries a real EDIT — a replacement ref or a clear. An
 *  imported-texture descriptor is NOT an edit (it inherits the clone's texture),
 *  so a freshly-imported textured material with only captured descriptors does
 *  ZERO map work (the "unedited import pays zero cost" invariant holds). */
export function hasMapEdits(maps: InlineMaterialMaps | undefined): boolean {
  if (!maps) return false;
  return SLOTS.some((slot) => {
    const ref = maps[slot];
    return ref != null && !isImportedMap(ref);
  });
}

/**
 * The UV placement a REPLACED texture must draw with (#553): the material's
 * shared placement, plus any per-slot placements that replace it outright.
 *
 * REQUIRED rather than optional, deliberately. This function previously took no
 * placement at all, so a replaced map drew unplaced while the panel went on
 * reporting the placement the director had set — silent, and invisible from the
 * DAG side. An optional parameter with a sensible default reproduces exactly
 * that: the caller that forgets is the caller that renders wrong. Required makes
 * the omission a type error instead.
 */
export interface EditedMapPlacement {
  readonly shared: UvPlacement;
  readonly perMap?: SlotPlacements<MaterialMapSlot>;
}

/**
 * Apply a material's edit-layer maps onto a three material clone. null slots are
 * left as-is (inherit the imported texture); cleared slots are removed; real refs
 * are loaded from OPFS, PLACED, and set. ASYNC (texture decode); `isCancelled`
 * lets the caller bail when the overlay effect re-runs before the loads resolve,
 * so a stale load never lands on a replaced material. Returns true if it mutated
 * the material (so the caller can request a frame).
 *
 * ── WHY THIS ROAD NEITHER CLONES NOR SKIPS IDENTITY (#553) ────────────────────
 *
 * Both are true of `applyGltfUvTransform` and NEITHER transfers here, which is
 * worth stating because copying them would read as consistency:
 *
 *   · No clone. `loadBakedTexture` decodes a FRESH texture per call — it builds a
 *     blob URL and runs a TextureLoader, and nothing between it and this function
 *     caches. The texture has exactly one consumer, so writing to it cannot
 *     cross-contaminate. The inherited road clones because ITS textures come off
 *     the shared imported clone.
 *   · No skip rule. That road leaves an identity-resolving slot alone so it does
 *     not flatten the transform the loader applied to an inherited texture. A
 *     freshly decoded texture has no loader transform to preserve, so there is
 *     nothing to protect and the write is unconditional.
 */
export async function applyEditedMaps(
  material: THREE.Material,
  maps: InlineMaterialMaps | undefined,
  placement: EditedMapPlacement,
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
    if (isImportedMap(ref)) continue; // captured descriptor → inherit (leave clone)
    const prop = THREE_SLOT_OF[slot];
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
    // #553 — the replacement draws with THIS slot's placement: its own if it has
    // one, else the material's shared placement. One lookup, never a composition,
    // and through the writer both roads share rather than a second spelling of the
    // four assignments. The pivot is the UV ORIGIN — this is the glTF road (#551).
    placeTexture(
      texture,
      resolveSlotPlacement(placement.shared, placement.perMap, slot),
      ORIGIN_PIVOT,
    );
    (std as unknown as Record<string, unknown>)[prop] = texture;
    changed = true;
  }
  if (changed) std.needsUpdate = true;
  return changed;
}
