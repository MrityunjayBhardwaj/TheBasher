// gltfMaterialToOpenpbr — the REVERSE of openpbrToThree: read a three.js material
// (the embedded material on a loaded glTF clone) → the OpenPBR inline IR
// (InlineMaterialSpec), so imported glTF materials can live in the DAG and be
// edited exactly like a native Box/Sphere material (issue #178 — bring glTF
// materials into the ONE OpenPBR substrate; the user-facing "materials list").
//
// PURE / sync. Texture MAPS are NOT captured here (deferred slice) — the IR's map
// slots stay null and the renderer keeps reusing the clone's embedded textures;
// the SCALAR + colour lobes are what this converter recovers. Field reads are
// duck-typed and defaulted: a glTF material may be MeshStandardMaterial,
// MeshPhysicalMaterial, or — KHR_materials_unlit — MeshBasicMaterial (no
// roughness/metalness/emissive), so a missing field falls back to the same value
// hydrateInlineMaterial would use and never yields an out-of-band IR.
//
// ROUND-TRIP: openpbrToThree(gltfMaterialToOpenpbr(m)) recovers m's core scalars
// (proven in the unit test) — the V29 "one adapter, no drift" guarantee made
// bidirectional, so a captured material renders identically to its glTF source.
//
// REF: #178 (glTF materials → OpenPBR DAG); src/app/material/openpbrToThree.ts
//      (the forward adapter); app/asset/readGltfMaterials.ts (field-read style;
//      gone in #1053, at 9734f82e).

import type * as THREE from 'three';
import type { InlineMaterialSpec } from '../../nodes/types';
import { NULL_MAPS, IDENTITY_UV_TRANSFORM } from '../../nodes/materialSchema';

/** `#rrggbb` from a three.Color, or the fallback when the field is absent. */
function hex(c: { getHexString?: () => string } | undefined, fallback: string): string {
  return c && typeof c.getHexString === 'function' ? `#${c.getHexString()}` : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Compile a loaded glTF clone's three.js material → the OpenPBR inline IR.
 * The exact inverse of `openpbrToThree` for the WebGL-supported lobes:
 *   color→base.color, metalness→base.metalness, roughness→specular.roughness,
 *   ior→specular.ior, clearcoat→coat.weight, clearcoatRoughness→coat.roughness,
 *   transmission→transmission.weight, emissive→emission.color,
 *   emissiveIntensity→emission.luminance (1:1), opacity→geometry.opacity.
 * Maps are seeded null (captured in a later slice); uvTransform is identity.
 */
export function gltfMaterialToOpenpbr(mat: THREE.Material): InlineMaterialSpec {
  const m = mat as THREE.MeshPhysicalMaterial; // duck-typed; fields read defensively
  return {
    name: mat.name || 'default',
    base: { color: hex(m.color, '#ffffff'), metalness: num(m.metalness, 0) },
    // GLTFLoader sets roughness from roughnessFactor (glTF default 1); three's own
    // MeshStandard default is also 1. Read it straight; fall back to 1.
    specular: { roughness: num(m.roughness, 1), ior: num(m.ior, 1.5) },
    coat: { weight: num(m.clearcoat, 0), roughness: num(m.clearcoatRoughness, 0) },
    transmission: { weight: num(m.transmission, 0) },
    // luminance ↔ emissiveIntensity is 1:1 (EMISSION_NIT_TO_INTENSITY = 1.0).
    emission: { color: hex(m.emissive, '#000000'), luminance: num(m.emissiveIntensity, 0) },
    geometry: { opacity: num(m.opacity, 1) },
    maps: { ...NULL_MAPS },
    uvTransform: {
      tiling: [...IDENTITY_UV_TRANSFORM.tiling],
      offset: [...IDENTITY_UV_TRANSFORM.offset],
      rotation: IDENTITY_UV_TRANSFORM.rotation,
    },
  };
}
