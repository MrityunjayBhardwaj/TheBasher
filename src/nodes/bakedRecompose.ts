// recomposeBakedObject — the ONE place an `Object` posing a `BakedData` becomes the
// flat `BakedMeshValue` the baked renderer consumes (#388, Stage C · C5).
//
// The baked mesh's render road is ASYNCHRONOUS and already exists: `BakedMeshR`
// suspends on `useBakedGeometry` (the OPFS read), primes `geometryRegistry`, and
// builds the material imperatively from the flat `BakedMaterialSpec` — picking the
// three.js ctor from `materialClass` and assigning six texture slots at explicit
// colorspaces. None of that is reachable through `ObjectMeshR`, whose road is
// synchronous registry + inline OpenPBR IR: a baked handle resolves to null there
// (the object vanishes) and a baked spec narrows to the grey fallback. Both measured
// before `BakedData` was written.
//
// So the split's Object half does what the light split does (`lightRecompose.ts`):
// reconstitute the flat value at the render seam and hand it to the SAME renderer the
// fused node uses. One band, no parallel walk (H40/V126) — an `Object → BakedData`
// pair draws through the identical component the fused `BakedMesh` draws through, so
// they cannot drift while both exist.
//
// The pose comes off the Object, the substance off the data. `scale` is carried for
// completeness and byte-identity with the fused value; `BakedMeshR` deliberately
// renders at IDENTITY scale because the TRS is baked into the verts, and that
// behaviour is inherited unchanged rather than re-decided here.
//
// REF: src/nodes/lightRecompose.ts (the same play for C3); src/nodes/BakedData.ts
//      (why a baked payload is not a MeshData); src/viewport/SceneFromDAG.tsx
//      (`ObjectR`'s BakedData arm — the only caller today, and `BakedMeshR`);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issue #388.

import type { BakedMeshValue, ObjectValue, Vec3 } from './types';

/**
 * Reconstitute the flat `BakedMeshValue` for an `Object` posing a `BakedData`, or
 * return null for anything else (a fused BakedMesh, a mesh/curve/light/camera
 * Object, a non-Object value) so the caller keeps its own road.
 */
export function recomposeBakedObject(value: unknown): BakedMeshValue | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as ObjectValue;
  if (obj.kind !== 'Object' || obj.data == null || obj.data.kind !== 'BakedData') return null;
  const scale: Vec3 = obj.scale ?? [1, 1, 1];
  return {
    kind: 'BakedMesh',
    geometry: obj.data.geometry,
    position: obj.position,
    rotation: obj.rotation,
    scale,
    material: obj.data.material,
  };
}
