// #634 (ns-1) — what a primitive derives, and what it refuses to derive.
//
// The population here is DEGENERATE by construction: every producer writes a uniform
// assignment, so these assertions cannot distinguish the attribute road from the sibling
// field it now reads through. That is expected, and it is why the discriminating two-valued
// case is minted separately rather than looked for here.
//
// REF: src/nodes/meshAttributes.ts; src/app/attributeStore.ts; issues #633, #634.

import { describe, expect, it } from 'vitest';
import { boxDescriptor, sphereDescriptor } from '../app/modifierGeometry';
import { read } from '../app/attributeStore';
import { MATERIAL_INDEX } from './attributes';
import { mintMeshAttributes, uniformMaterialAttributes } from './meshAttributes';
import { BoxDataNode, BoxDataParams } from './BoxData';
import { SphereDataNode, SphereDataParams } from './SphereData';
import type { GeometryDescriptor, MeshDataValue } from './types';

describe('#634 a primitive derives a uniform face-domain material_index', () => {
  it('sizes the attribute to the geometry’s faces and puts every face on slot 0', () => {
    const minted = uniformMaterialAttributes(boxDescriptor([1, 1, 1]));
    expect(minted).not.toBeNull();

    const attribute = minted!.set[MATERIAL_INDEX];
    expect(attribute.domain).toBe('face');
    expect(attribute.type).toBe('int');
    expect(attribute.count).toBe(6); // a box has six FACES — six quads, since #770
    expect(attribute.data.length).toBe(6);
    expect([...attribute.data]).toEqual(new Array(6).fill(0));
  });

  it('follows the geometry’s own tessellation rather than a fixed number', () => {
    // `w x h` polygons since #770, where these read `2 x w x (h - 1)` triangles. The row's
    // point is unchanged — the count follows the segments rather than a constant.
    expect(uniformMaterialAttributes(sphereDescriptor(1, 8, 4))!.set[MATERIAL_INDEX].count).toBe(
      32,
    );
    expect(uniformMaterialAttributes(sphereDescriptor(1, 32, 16))!.set[MATERIAL_INDEX].count).toBe(
      512,
    );
  });

  it('derives NOTHING when the face count is not derivable from params', () => {
    // glTF and baked geometry keep their buffers elsewhere. Absence is the honest answer;
    // a fabricated count would be a length that agrees with nothing.
    const gltf: GeometryDescriptor = { kind: 'gltf', assetRef: 'asset', childName: 'child' };
    expect(uniformMaterialAttributes(gltf)).toBeNull();
    expect(mintMeshAttributes(gltf, 'evaluate')).toBeNull();
  });

  it('puts the derived set in the store under the key it hands back', () => {
    const key = mintMeshAttributes(boxDescriptor([3, 3, 3]), 'evaluate');
    expect(key).not.toBeNull();
    expect(read(key!)?.[MATERIAL_INDEX].count).toBe(6);
  });

  it('is content-keyed, so two equal geometries converge on one key', () => {
    expect(mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')).toBe(
      mintMeshAttributes(boxDescriptor([5, 5, 5]), 'evaluate'),
    );
    // …and a different face count does not.
    expect(mintMeshAttributes(sphereDescriptor(1, 8, 4), 'evaluate')).not.toBe(
      mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate'),
    );
  });
});

describe('#634 both primitive producers carry the key', () => {
  it('BoxData mints one', () => {
    const params = BoxDataParams.parse({ size: [1, 1, 1], material: {} });
    const value = BoxDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;
    expect(value.attributeKey).not.toBeNull();
    expect(read(value.attributeKey!)?.[MATERIAL_INDEX].count).toBe(6);
  });

  it('SphereData mints one, sized to its own segments', () => {
    const params = SphereDataParams.parse({ radius: 1, widthSegments: 8, heightSegments: 4 });
    const value = SphereDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;
    expect(value.attributeKey).not.toBeNull();
    expect(read(value.attributeKey!)?.[MATERIAL_INDEX].count).toBe(32);
  });
});
