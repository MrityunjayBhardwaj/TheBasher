// captureBakedMaterial — read a RESOLVED three.js material off the live render
// clone and persist it (scalars + every texture map) into a serializable
// BakedMaterialSpec (Phase 151 Apply-Transform, Wave 4 Task 10, issue #151).
//
// BAKE WHAT RENDERS (M2 / H58 / H59): the input material is the one the renderer
// ACTUALLY drew — `clone.getObjectByName(childName).material` AFTER the #99/#124
// override effect ran. So an overridden glTF child bakes WITH the override applied
// (the spec records the POST-merge scalars, never the override node's params).
//
// READ-ONLY (H45 / M9): this NEVER mutates the live material or its textures. The
// clone material is already a per-instance `s.clone()` (#99); we read scalars and
// copy texture BYTES via persistTexture (path-2 canvas readback — the p151
// texture-readback e2e probe OBSERVED that no source-URI association survives the
// SkeletonUtils clone, only `texture.source.data`, so path-1 is not viable off the
// clone; we pass NO resolveSourcePath). That probe was retired with #1073, when the
// fixture it imported started arriving as native geometry; the observation is about
// the clone and still holds for every file that takes the clone road.
//
// materialClass (M1): three.js builds MeshStandard / MeshPhysical (any KHR_materials_*)
// / MeshBasic (KHR_materials_unlit) per glTF material. We detect the subclass so
// BakedMeshR rebuilds the right ctor — a basic/unlit material has no
// roughness/metalness/emissive (the in-guard mirrors SceneFromDAG's #99 unlit case).
//
// REF: PLAN.md Wave 4 Task 10; RESEARCH §M1/§M2/§M5; hetvabhasa H45/H58/H59;
//      bakedTextureStore.ts (persistTexture, path-2); types.ts BakedMaterialSpec.

import * as THREE from 'three';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import type {
  BakedMapSlot,
  BakedMaterialSpec,
  BakedTextureRef,
  UvPlacement,
} from '../../nodes/types';
import { persistTexture } from '../asset/bakedTextureStore';
import { CENTRE_PIVOT, isIdentityPlacement, rebasePlacementPivot } from '../material/uvPlacement';

const BAKED_MAP_SLOTS: readonly BakedMapSlot[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
];

/**
 * #1136 — each map's UV placement as it draws, restated about the centre pivot `BakedMeshR` places
 * with, or `undefined` when every map draws untransformed.
 *
 * Read off the live texture, `center` included: the clone road places about the UV origin (the glTF
 * convention it captured) and an authored material about the centre, and the bake has to keep what
 * either one drew. `rebasePlacementPivot` is exact, so the baked mesh draws the same UV matrix.
 * Exported because it is the decision; the rest of the capture is canvas readback.
 */
export function bakedMapPlacements(
  material: THREE.Material,
): BakedMaterialSpec['mapPlacements'] | undefined {
  const slots = material as unknown as Partial<Record<BakedMapSlot, THREE.Texture | null>>;
  const out: { [K in BakedMapSlot]?: UvPlacement } = {};
  for (const slot of BAKED_MAP_SLOTS) {
    const tex = slots[slot];
    if (!tex) continue;
    const drawn: UvPlacement = {
      tiling: [tex.repeat.x, tex.repeat.y],
      offset: [tex.offset.x, tex.offset.y],
      rotation: tex.rotation,
    };
    const placement = rebasePlacementPivot(drawn, [tex.center.x, tex.center.y], CENTRE_PIVOT);
    if (!isIdentityPlacement(placement)) out[slot] = placement;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Which three ctor BakedMeshR must rebuild (M1). */
function materialClassOf(mat: THREE.Material): BakedMaterialSpec['materialClass'] {
  if ((mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return 'physical';
  if ((mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) return 'basic';
  return 'standard';
}

/** `#rrggbb` for a three Color, or the fallback when the field is absent. */
function hexOf(c: THREE.Color | undefined, fallback: string): string {
  return c ? `#${c.getHexString()}` : fallback;
}

/**
 * Persist a texture map slot to OPFS via canvas readback (path 2). NO
 * resolveSourcePath — the probe proved the source-URI association does not survive
 * the clone, so path-1 is unavailable and persistTexture falls straight to the
 * universal canvas readback. Returns null when the slot is empty.
 */
async function persistSlot(
  storage: StorageCapability,
  tex: THREE.Texture | null | undefined,
): Promise<BakedTextureRef | null> {
  if (!tex) return null;
  return persistTexture(storage, tex);
}

/**
 * Capture a single resolved three.js material into a BakedMaterialSpec. Reads
 * scalars + 6 map slots; persists each present map to OPFS (awaited). Read-only.
 */
export async function captureBakedMaterial(
  storage: StorageCapability,
  material: THREE.Material,
): Promise<BakedMaterialSpec> {
  const cls = materialClassOf(material);

  // Basic / unlit: NO roughness/metalness/emissive (M1 in-guard). Only color +
  // base map + opacity carry. Persist the base map (path 2) if present.
  if (cls === 'basic') {
    const basic = material as THREE.MeshBasicMaterial;
    const map = await persistSlot(storage, basic.map);
    const mapPlacements = bakedMapPlacements(basic);
    return {
      materialClass: 'basic',
      color: hexOf(basic.color, '#ffffff'),
      roughness: 0.5,
      metalness: 0,
      opacity: basic.opacity,
      transparent: basic.transparent,
      emissive: '#000000',
      emissiveIntensity: 0,
      map,
      normalMap: null,
      roughnessMap: null,
      metalnessMap: null,
      aoMap: null,
      emissiveMap: null,
      ...(mapPlacements ? { mapPlacements } : {}),
    };
  }

  const std = material as THREE.MeshStandardMaterial;
  // Persist all six map slots (path 2). Each is read-only on the live texture.
  const [map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap] = await Promise.all([
    persistSlot(storage, std.map),
    persistSlot(storage, std.normalMap),
    persistSlot(storage, std.roughnessMap),
    persistSlot(storage, std.metalnessMap),
    persistSlot(storage, std.aoMap),
    persistSlot(storage, std.emissiveMap),
  ]);

  let spec: BakedMaterialSpec = {
    materialClass: cls, // 'standard' | 'physical'
    color: hexOf(std.color, '#ffffff'),
    roughness: typeof std.roughness === 'number' ? std.roughness : 0.5,
    metalness: typeof std.metalness === 'number' ? std.metalness : 0,
    opacity: std.opacity,
    transparent: std.transparent,
    emissive: hexOf(std.emissive, '#000000'),
    emissiveIntensity: typeof std.emissiveIntensity === 'number' ? std.emissiveIntensity : 1,
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    aoMap,
    emissiveMap,
  };
  // #1136 — absent, not empty, when nothing is transformed, so an ordinary bake writes no field.
  const mapPlacements = bakedMapPlacements(material);
  if (mapPlacements) spec = { ...spec, mapPlacements };

  // Physical-only scalars (M3) — captured only when the subclass is physical.
  // Map refs for these (clearcoatMap etc.) are a v0.6 #2 follow-up.
  if (cls === 'physical') {
    const p = material as THREE.MeshPhysicalMaterial;
    return {
      ...spec,
      physical: {
        clearcoat: p.clearcoat,
        clearcoatRoughness: p.clearcoatRoughness,
        transmission: p.transmission,
        ior: p.ior,
        sheen: p.sheen,
        specularIntensity: p.specularIntensity,
      },
    };
  }

  return spec;
}
