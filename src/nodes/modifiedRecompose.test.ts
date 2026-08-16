import { describe, expect, it } from 'vitest';
import { recomposeModifiedObject } from './modifiedRecompose';
import { arrayGeometryRef, boxGeometryRef } from '../app/modifierGeometry';
import { hydrateInlineMaterial } from './materialSchema';
import type {
  BakedMaterialSpec,
  GeometryRef,
  InlineMaterialSpec,
  MeshDataValue,
  ModifiedDataValue,
  ObjectValue,
} from './types';

// ⚠️ THIS TIER MEASURES THE COMPOSED VALUE, NOT THE RENDERED OUTPUT. It cannot see the
// failure the arm exists to prevent (an invisible mesh / a grey material) — that is the
// e2e tier's job, and a green file here is not "it draws". What it DOES pin is the two
// things a recompose can silently get wrong: which half each field comes from, and
// whether a payload survives by reference.

// A REAL array-over-box handle from the same builder the modifier road uses, not a
// hand-shaped literal — a fabricated descriptor would pass a structural comparison while
// being something the registry could never build.
const GEOM: GeometryRef = arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 3, [2, 0, 0]);

// A trap colour: neither a primitive default nor `#808080`, the grey a material renders
// as when it is mistaken for the wrong spec shape — so an assertion on it cannot pass
// while the road is broken.
const INLINE: InlineMaterialSpec = hydrateInlineMaterial(null, '#c81e5a');

// The case that is the whole reason ModifiedData is not a MeshData: a modifier over a
// BAKED source inherits a `BakedMaterialSpec`, which `MeshDataValue.material` no longer
// admits (#388 narrowed it to inline-only).
const BAKED: BakedMaterialSpec = {
  materialClass: 'physical',
  color: '#c81e5a',
  roughness: 0.4,
  metalness: 0.1,
  opacity: 1,
  transparent: false,
  emissive: '#000000',
  emissiveIntensity: 1,
  map: null,
  normalMap: null,
  roughnessMap: null,
  metalnessMap: null,
  aoMap: null,
  emissiveMap: null,
};

function modifiedData(material: ModifiedDataValue['material']): ModifiedDataValue {
  return { kind: 'ModifiedData', geometry: GEOM, material };
}

function objPosingModified(over?: Partial<ObjectValue>): ObjectValue {
  return {
    kind: 'Object',
    position: [1, 2, 3],
    rotation: [10, 20, 30],
    scale: [2, 1, 1],
    data: modifiedData(INLINE),
    ...over,
  };
}

describe('recomposeModifiedObject', () => {
  it('reconstitutes the flat ModifiedMeshValue: pose off the Object, substance off the data', () => {
    // The pose is the ONE thing `ModifiedDataValue` deliberately does not carry — a
    // modifier authors in local space and the Object above the stack owns the transform
    // (Houdini S8; measured in Blender 5.1.1). The recompose is where it comes back.
    expect(recomposeModifiedObject(objPosingModified())).toEqual({
      kind: 'ModifiedMesh',
      geometry: GEOM,
      position: [1, 2, 3],
      rotation: [10, 20, 30],
      scale: [2, 1, 1],
      material: INLINE,
    });
  });

  it('carries a BAKED material through unchanged — the arm MeshData does not have', () => {
    // A field-by-field rebuild would drop a slot; worse, routing this through the mesh
    // road narrows it to the grey fallback (measured, #388). Pin identity, not a field
    // list, and pin it on the wide arm specifically.
    const out = recomposeModifiedObject(objPosingModified({ data: modifiedData(BAKED) }));
    expect(out?.material).toBe(BAKED);
    expect(out?.geometry).toBe(GEOM);
  });

  it('carries a null material (a source with none) as null, not as a fabricated default', () => {
    // `ModifiedMeshR` owns the fallback decision. Inventing one here would give the
    // renderer two places to disagree about what "no material" means.
    expect(recomposeModifiedObject(objPosingModified({ data: modifiedData(null) }))?.material).toBe(
      null,
    );
  });

  it('hydrates a missing scale to identity (the H14 hydrate seam)', () => {
    const noScale = {
      ...objPosingModified(),
      scale: undefined as unknown as ObjectValue['scale'],
    };
    expect(recomposeModifiedObject(noScale)?.scale).toEqual([1, 1, 1]);
  });

  it('returns null for every other ObjectData, an Empty, a null value and a non-Object', () => {
    const meshData: MeshDataValue = {
      kind: 'MeshData',
      geometry: { key: 'box|1', descriptor: { kind: 'box', size: [1, 1, 1] } },
      material: null,
    };
    expect(recomposeModifiedObject(objPosingModified({ data: meshData }))).toBeNull();
    expect(recomposeModifiedObject(objPosingModified({ data: null }))).toBeNull();
    expect(recomposeModifiedObject(null)).toBeNull();
    expect(recomposeModifiedObject('ModifiedData')).toBeNull();
  });

  it('returns null for a still-fused ModifiedMeshValue, so its own road is untouched', () => {
    // The fused node reaches `ModifiedMeshR` directly through the SceneChild dispatch.
    // Recomposing it here would double-handle the same value.
    expect(
      recomposeModifiedObject({
        kind: 'ModifiedMesh',
        geometry: GEOM,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        material: INLINE,
      }),
    ).toBeNull();
  });
});
