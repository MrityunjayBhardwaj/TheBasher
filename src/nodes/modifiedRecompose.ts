// recomposeModifiedObject — the ONE place an `Object` posing a `ModifiedData` becomes
// the flat `ModifiedMeshValue` the modifier renderer consumes (#415, the data lane).
//
// THE THIRD CONFIRMATION OF THE PLAY (light C3 → baked C5 → here): when a renderer for
// the FUSED form already exists, the compiler-forced arm is a RECOMPOSE, not an
// implementation. Pose off the Object, substance off the data, hand the flat value to
// the component the fused node already draws through. One band (H40/V126) — an
// `Object → …Modifier → ModifiedData` pair draws through the identical `ModifiedMeshR`
// the fused `ModifiedMesh` draws through, so the two cannot drift while both exist, and
// there is no parallel sync-registry walk to keep in step.
//
// WHY NOT JUST FALL THROUGH TO `ObjectMeshR`, which is also sync + registry-backed:
// `ModifiedDataValue.material` carries the WIDE `Inline | Baked | null` union (a
// modifier over a baked source inherits a `BakedMaterialSpec`, #358), while
// `ObjectMeshR`'s prop is the narrower `MeshDataValue` whose material #388 narrowed to
// inline-only. Casting across that gap compiles and then renders the failure #388
// MEASURED — a baked spec resolves to the grey `#808080` fallback. `ModifiedMeshR`
// already owns the narrowing for exactly this union (`'base' in mat`), so recomposing
// inherits that decision rather than re-deciding it here.
//
// THE TRS IS THE OBJECT'S, and that is the whole point of the split: `ModifiedDataValue`
// is `ModifiedMeshValue` MINUS the pose, because a modifier authors in local space and
// the object transform is inherited above the stack (Houdini S8; measured live in
// Blender 5.1.1 — `ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §3). Recomposing puts it
// back at the render seam, where the fused value always carried it.
//
// REF: src/nodes/lightRecompose.ts + src/nodes/bakedRecompose.ts (the same play, C3/C5);
//      src/nodes/types.ts (`ModifiedDataValue` — why it is not a `MeshDataValue`);
//      src/viewport/SceneFromDAG.tsx (`ObjectR`'s ModifiedData arm — the only caller
//      today, and `ModifiedMeshR`); docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issue #415.

import type { ModifiedMeshValue, ObjectValue, Vec3 } from './types';

/**
 * Reconstitute the flat `ModifiedMeshValue` for an `Object` posing a `ModifiedData`, or
 * return null for anything else (a fused ModifiedMesh, a mesh/curve/light/camera/baked
 * Object, a non-Object value) so the caller keeps its own road.
 */
export function recomposeModifiedObject(value: unknown): ModifiedMeshValue | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as ObjectValue;
  if (obj.kind !== 'Object' || obj.data == null || obj.data.kind !== 'ModifiedData') return null;
  const scale: Vec3 = obj.scale ?? [1, 1, 1];
  return {
    kind: 'ModifiedMesh',
    geometry: obj.data.geometry,
    position: obj.position,
    rotation: obj.rotation,
    scale,
    material: obj.data.material,
  };
}
