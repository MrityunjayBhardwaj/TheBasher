// #633 (ns-1) — the attribute key, the unconstructible empty set, and the two byte-identity
// assertions that keep this phase's deferral from leaking.
//
// The last two are the reason this file matters more than its size suggests. Both assert
// that a string produced by code this phase does NOT touch is still, byte for byte, the
// string it produces today. Neither is a regression guard on unchanged code:
//
//   - The four GEOMETRY key literals enforce the phase's central deferral. The moment
//     anyone folds an attribute component into `GeometryRef.key`, those four strings change,
//     every existing geometry re-keys, and the render-side fork this phase deliberately did
//     not open gets decided by accident. The four strings red first.
//   - The MATERIAL key literal covers the one measured re-mint hazard. `materialKeyOf` is a
//     GENERIC key walk — a field added to the material IR joins the key automatically, which
//     is the property it is built for and also the property that silently re-mints every
//     material in every project. The next slice puts a per-object material SLOT LIST on the
//     table; if it lands inside the IR instead of beside it, nothing throws, nothing renders
//     wrong, and every cache in every save quietly misses. This assertion is what notices.
//
// REF: src/nodes/attributeKey.ts; src/nodes/materialKey.ts; src/app/modifierGeometry.ts;
//      .anvi/project_management/phases/ns-1-attribute-domains/PLAN.md §8 step 6; issues #633, #634.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from '../app/modifierGeometry';
import { BoxDataNode, BoxDataParams } from './BoxData';
import type { MeshDataValue } from './types';
import { attributeKeyOf, mintAttributes } from './attributeKey';
import type { AttributeData } from './attributes';

const uv = (data: number[]): AttributeData => ({
  domain: 'corner',
  type: 'float2',
  count: data.length / 2,
  data: new Float32Array(data),
});

const materialIndex = (values: number[]): AttributeData => ({
  domain: 'face',
  type: 'int',
  count: values.length,
  data: new Int32Array(values),
});

describe('#633 attributeKeyOf — equal content, equal key', () => {
  it('keys two independently built equal sets the same', () => {
    const a = attributeKeyOf({ material_index: materialIndex([0, 0, 1]) });
    const b = attributeKeyOf({ material_index: materialIndex([0, 0, 1]) });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('does not depend on the order names were written in', () => {
    const one = attributeKeyOf({ UVMap: uv([0, 0, 1, 0]), material_index: materialIndex([0]) });
    const other = attributeKeyOf({ material_index: materialIndex([0]), UVMap: uv([0, 0, 1, 0]) });
    expect(one).toBe(other);
  });

  it('keys over the WHOLE set, so every part of it can move the key', () => {
    const base = { material_index: materialIndex([0, 0, 1]) };
    const key = attributeKeyOf(base);

    // values
    expect(attributeKeyOf({ material_index: materialIndex([0, 1, 1]) })).not.toBe(key);
    // element count
    expect(attributeKeyOf({ material_index: materialIndex([0, 0]) })).not.toBe(key);
    // domain
    expect(
      attributeKeyOf({ material_index: { ...materialIndex([0, 0, 1]), domain: 'point' } }),
    ).not.toBe(key);
    // name
    expect(attributeKeyOf({ other_index: materialIndex([0, 0, 1]) })).not.toBe(key);
    // a second entry
    expect(attributeKeyOf({ ...base, UVMap: uv([0, 0, 1, 0]) })).not.toBe(key);
  });

  it('is independent of the backing array type for equal values', () => {
    const asInt = attributeKeyOf({ mark: materialIndex([1, 2, 3]) });
    const asFloat = attributeKeyOf({
      mark: { domain: 'face', type: 'int', count: 3, data: new Float32Array([1, 2, 3]) },
    });
    expect(asInt).toBe(asFloat);
  });
});

describe('#633 absent and empty', () => {
  it('omits an entry explicitly set to undefined rather than counting it as present', () => {
    // The whole key rests on this: a generic walk that treats `{field: undefined}` as a
    // present field re-mints every key the moment a new optional field is declared.
    const withUndefined = attributeKeyOf({
      material_index: materialIndex([0]),
      UVMap: undefined as unknown as AttributeData,
    });
    expect(withUndefined).toBe(attributeKeyOf({ material_index: materialIndex([0]) }));
  });

  it('makes the empty set unconstructible from the mint', () => {
    expect(mintAttributes({})).toBeNull();
    expect(mintAttributes({ UVMap: undefined })).toBeNull();
    expect(attributeKeyOf({})).toBeNull();
  });

  it('mints a key and a set together for a non-empty input', () => {
    const minted = mintAttributes({ material_index: materialIndex([0, 0, 1]) });
    expect(minted).not.toBeNull();
    expect(minted?.key).toBe(attributeKeyOf({ material_index: materialIndex([0, 0, 1]) }));
    expect(Object.keys(minted!.set)).toEqual(['material_index']);
  });

  it('refuses an attribute whose declared count disagrees with what it carries', () => {
    expect(() =>
      mintAttributes({
        UVMap: { domain: 'corner', type: 'float2', count: 3, data: new Float32Array([0, 0]) },
      }),
    ).toThrow(/malformed/);
  });
});

describe('#633 byte identity — the geometry key is NOT touched by this phase', () => {
  it('the four hand-built key templates still produce today’s exact strings', () => {
    const box = boxGeometryRef([1, 1, 1]);
    const sphere = sphereGeometryRef(1, 32, 16);

    expect(box.key).toBe('box|1,1,1');
    expect(sphere.key).toBe('sphere|1|32|16');
    expect(arrayGeometryRef(box, 3, [2, 0, 0]).key).toBe('array|box|1,1,1|3|2,0,0');
    expect(mirrorGeometryRef(box, 'x', 0).key).toBe('mirror|box|1,1,1|x|0');
  });

  it('the descriptor union has gained no attribute-bearing member', () => {
    // The key strings above would not move if an attribute rode in a member the templates
    // ignore, so the shape is checked as well as the string.
    const types = sourceFiles().find(([path]) => path === 'src/nodes/types.ts');
    expect(types).toBeDefined();
    const source = stripComments(types![1]);
    const start = source.indexOf('export type GeometryDescriptor =');
    expect(start).toBeGreaterThan(-1);
    // The union's own members end in `;`, so the declaration runs to the NEXT top-level
    // `export` rather than to the first semicolon.
    const rest = source.slice(start);
    const end = rest.slice(1).search(/\nexport\s/);
    expect(end).toBeGreaterThan(-1);
    const union = rest.slice(0, end + 1);

    const kinds = [...union.matchAll(/kind:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual([
      'array',
      'baked',
      'box',
      'gltf',
      'mirror',
      'sphere',
    ]);
    expect(/attribut/i.test(union)).toBe(false);
  });
});

describe('#633 byte identity — the material key must not move when the slot list arrives', () => {
  it('an unmodified BoxData still mints today’s exact material key', () => {
    const params = BoxDataParams.parse({ size: [1, 1, 1], material: {} });
    const value = BoxDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;

    expect(value.materialKey).toBe(
      '{base:{color:#cccccc,metalness:0,},specular:{roughness:0.3,ior:1.5,},' +
        'coat:{weight:0,roughness:0,},transmission:{weight:0,},' +
        'emission:{color:#000000,luminance:0,},geometry:{opacity:1,},' +
        'maps:{albedo:n,normal:n,roughness:n,metalness:n,emissive:n,ao:n,},' +
        'uvTransform:{tiling:[1,1,],offset:[0,0,],rotation:0,},}',
    );
  });
});
