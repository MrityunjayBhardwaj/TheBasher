// uvPlacement — resolving a map slot's UV placement, and writing it onto a texture.
// The ONE answer to "which placement does this slot use, and how is it applied",
// consumed by BOTH apply roads (#550).
//
// ── WHY THIS IS SHARED, when it is only four assignments ───────────────────────
//
// It is not the four assignments. It is the RESOLUTION rule and the PIVOT, both of
// which are silent when wrong:
//
//   · Resolution is `perMap[slot] ?? shared` — ONE lookup, never a composition. A
//     slot listed in `mapUvTransforms` uses its own placement INSTEAD of the shared
//     one. The `{tiling, offset, rotation}` family is not closed under composition
//     (a rotation after a non-uniform scale is a shear it cannot represent), so
//     "compose the two" has no correct implementation to drift toward — it can only
//     approximate, and the error appears only at rotation ≠ 0 on a stretched map.
//     Written twice, the second spelling would be the one that composes.
//
//   · The pivot is a property of the ROAD, and the two roads genuinely disagree:
//     the authored road places about the texture CENTRE, the glTF road about the UV
//     ORIGIN (which is what KHR_texture_transform means and what three's own
//     GLTFLoader writes). So the pivot is a PARAMETER here rather than a constant —
//     a caller has to state which road it is. See #551 for the axis itself.
//
// REF: src/app/materialRegistry.ts (`build`/`prep` — the authored road, CENTRE),
//      src/viewport/applyGltfUvTransform.ts (the glTF overlay road, ORIGIN),
//      src/app/material/openpbrToThree.ts (translates the IR's slot names to
//      three's, once); issues #550, #551, #181.

import type * as THREE from 'three';
import type { UvPlacement } from '../../nodes/types';

/** A per-slot placement bag, keyed by whatever vocabulary the caller's road uses. */
export type SlotPlacements<S extends string> = { readonly [K in S]?: UvPlacement };

/** The authored road's pivot — our own convention, not glTF/Blender parity (#551). */
export const CENTRE_PIVOT = [0.5, 0.5] as const;

/** The glTF road's pivot — KHR_texture_transform, and GLTFLoader's own default. */
export const ORIGIN_PIVOT = [0, 0] as const;

/** No placement at all: tiling [1,1], offset [0,0], rotation 0. */
export function isIdentityPlacement(p: UvPlacement): boolean {
  return (
    p.tiling[0] === 1 &&
    p.tiling[1] === 1 &&
    p.offset[0] === 0 &&
    p.offset[1] === 0 &&
    p.rotation === 0
  );
}

/**
 * The placement a slot draws with: its own if it has one, otherwise the material's
 * shared placement. REPLACEMENT, never composition — see the header.
 */
export function resolveSlotPlacement<S extends string>(
  shared: UvPlacement,
  perMap: SlotPlacements<S> | undefined,
  slot: S,
): UvPlacement {
  return perMap?.[slot] ?? shared;
}

/**
 * Write a placement onto a texture. The caller owns the texture (both roads CLONE
 * first — decoded textures are shared by hash, so mutating one cross-contaminates
 * every other material using that image) and supplies its road's pivot.
 */
export function placeTexture(
  tex: THREE.Texture,
  placement: UvPlacement,
  pivot: readonly [number, number],
): void {
  tex.center.set(pivot[0], pivot[1]);
  tex.repeat.set(placement.tiling[0], placement.tiling[1]);
  tex.offset.set(placement.offset[0], placement.offset[1]);
  tex.rotation = placement.rotation;
  tex.needsUpdate = true;
}
