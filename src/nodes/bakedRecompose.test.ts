import { describe, expect, it } from 'vitest';
import { recomposeBakedObject } from './bakedRecompose';
import type {
  BakedDataValue,
  BakedMaterialSpec,
  GeometryRef,
  MeshDataValue,
  ObjectValue,
} from './types';

// A baked handle + a captured material as `BakedData.evaluate` emits them. The
// colour is a TRAP value: it is neither the primitive default nor `#808080`, the
// grey the renderer falls back to when a baked spec is mistaken for an inline
// OpenPBR IR — so a test that reads it cannot pass while the road is broken.
const GEOM: GeometryRef = {
  key: 'baked|abc123',
  kind: 'baked',
  descriptor: { kind: 'baked', hash: 'abc123', vertexCount: 36 },
};

const MATERIAL: BakedMaterialSpec = {
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

const BAKED_DATA: BakedDataValue = { kind: 'BakedData', geometry: GEOM, material: MATERIAL };

function objPosingBaked(over?: Partial<ObjectValue>): ObjectValue {
  return {
    kind: 'Object',
    position: [1, 2, 3],
    rotation: [10, 20, 30],
    scale: [1, 1, 1],
    data: BAKED_DATA,
    ...over,
  };
}

describe('recomposeBakedObject', () => {
  it('reconstitutes the flat BakedMeshValue: pose off the Object, substance off the data', () => {
    expect(recomposeBakedObject(objPosingBaked())).toEqual({
      kind: 'BakedMesh',
      geometry: GEOM,
      position: [1, 2, 3],
      rotation: [10, 20, 30],
      scale: [1, 1, 1],
      material: MATERIAL,
    });
  });

  it('carries the baked material BY REFERENCE, every slot intact', () => {
    // The whole reason baked is its own ObjectData member: the renderer picks its
    // three.js ctor from `materialClass` and assigns six texture slots. A recompose
    // that rebuilt the spec field-by-field would drop a slot added later in silence,
    // so pin identity, not a field list.
    const out = recomposeBakedObject(objPosingBaked());
    expect(out?.material).toBe(MATERIAL);
    expect(out?.geometry).toBe(GEOM);
  });

  it('hydrates a missing scale to identity (the H14 hydrate seam)', () => {
    const obj = objPosingBaked();
    const noScale = { ...obj, scale: undefined as unknown as ObjectValue['scale'] };
    expect(recomposeBakedObject(noScale)?.scale).toEqual([1, 1, 1]);
  });

  it('returns null for a mesh Object, an Empty, a null value and a non-Object', () => {
    const meshData: MeshDataValue = {
      kind: 'MeshData',
      geometry: { key: 'box|1', kind: 'box', descriptor: { kind: 'box', size: [1, 1, 1] } },
      material: null,
    };
    expect(recomposeBakedObject(objPosingBaked({ data: meshData }))).toBeNull();
    expect(recomposeBakedObject(objPosingBaked({ data: null }))).toBeNull();
    expect(recomposeBakedObject(null)).toBeNull();
    expect(recomposeBakedObject('BakedData')).toBeNull();
  });

  it('returns null for a still-fused BakedMeshValue, so its own road is untouched', () => {
    // The fused node reaches `BakedMeshR` directly through the SceneChild dispatch.
    // Recomposing it (or returning it here) would double-handle the same value.
    expect(
      recomposeBakedObject({
        kind: 'BakedMesh',
        geometry: GEOM,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        material: MATERIAL,
      }),
    ).toBeNull();
  });
});
