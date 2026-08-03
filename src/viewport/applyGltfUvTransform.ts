// applyGltfUvTransform — paint a DAG material's UV placement onto an imported glTF
// child's inherited map textures (#181 / V53, per-slot since #550).
//
// Lived inside `SceneFromDAG.tsx` until #550's render slice. It moved out for one
// reason: the per-slot resolution and the skip rule below are invisible in review
// and were observable only through a 34-minute browser suite. See
// `applyGltfUvTransform.gate.test.ts`. The call site is unchanged.
//
// ── THE PIVOT IS THE UV ORIGIN ON THIS ROAD ────────────────────────────────────
//
// `center = [0,0]`, which is what KHR_texture_transform means and what three's own
// GLTFLoader writes (`extendTexture` never sets `center`), so an UNEDITED import is
// byte-identical to what the loader produced. The AUTHORED road pivots about the
// texture centre instead — our own convention. Both are right for their road; the
// pivot travels with the ROAD, not with the value (#551).
//
// ── THE SKIP RULE ──────────────────────────────────────────────────────────────
//
// A slot whose RESOLVED placement is identity is left ALONE rather than written
// with identity. The imported clone's own texture already carries whatever
// transform the loader applied, so writing identity over it would FLATTEN a correct
// import. Before #550 this was one material-level early return on the shared value;
// per slot, it additionally lets a listed slot be re-applied while its neighbours
// keep the loader's own — which is what makes an edited per-map placement reach the
// screen without disturbing the maps that were not edited.

import type * as THREE from 'three';
import type { UvPlacement } from '../nodes/types';
import type { ThreeMapUvTransforms } from '../app/material/openpbrToThree';
import {
  isIdentityPlacement,
  ORIGIN_PIVOT,
  placeTexture,
  resolveSlotPlacement,
} from '../app/material/uvPlacement';

/** The map slots a glTF child's placement applies to. */
export const GLTF_UV_MAP_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
] as const;

/**
 * Apply a glTF child material's captured KHR_texture_transform onto an OVERLAY
 * material's map textures. Each slot uses its own placement from `perMap` if it has
 * one, otherwise `shared` — replacement, never composition.
 *
 * Textures are SHARED by the clone (A-5), so each is CLONED before mutation.
 */
export function applyGltfUvTransform(
  mat: THREE.Material,
  shared: UvPlacement,
  perMap: ThreeMapUvTransforms | undefined,
): void {
  if (!('map' in mat)) return;
  const std = mat as unknown as Record<string, THREE.Texture | null | undefined>;
  let touched = false;
  for (const slot of GLTF_UV_MAP_SLOTS) {
    const tex = std[slot];
    if (!tex) continue;
    const placement = resolveSlotPlacement(shared, perMap, slot);
    if (isIdentityPlacement(placement)) continue; // keep what the loader applied
    const c = tex.clone();
    placeTexture(c, placement, ORIGIN_PIVOT);
    std[slot] = c;
    touched = true;
  }
  if (touched) mat.needsUpdate = true;
}
