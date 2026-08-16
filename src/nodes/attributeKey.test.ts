// #633 (ns-1) — the attribute key, the unconstructible empty set, and the two byte-identity
// assertions that keep this phase's deferral from leaking.
//
// The last two are the reason this file matters more than its size suggests. Both assert
// that a string produced by code this phase does NOT touch is still, byte for byte, the
// string it produces today. Neither is a regression guard on unchanged code:
//
//   - The four GEOMETRY key literals enforced ns-1's central deferral: the moment anyone
//     folded an attribute component into `GeometryRef.key`, those four strings changed and
//     the render-side fork ns-1 deliberately did not open would have been decided by
//     accident. 🔴 #638 IS THE PHASE THAT OPENS IT, ON PURPOSE. The literals stay — as the
//     BASE templates, asserted with the attribute question answered "none" — and the block
//     below adds what the fold itself must satisfy. They no longer forbid the fold; they
//     bound it to the one component that was decided.
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
  boxDescriptor,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import { hashValue } from '../core/dag/hash';
import { nonAlignedMaterialMeshData, twoMaterialMeshData } from '../test-utils/twoMaterialMesh';
import { BoxDataNode, BoxDataParams } from './BoxData';
import type { GeometryRef, MeshDataValue, Vec3 } from './types';
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

describe('#638 the geometry key — the four BASE templates, and the ONE component that folds in', () => {
  // 🔴 THIS BLOCK'S TITLE USED TO SAY "the geometry key is NOT touched by this phase", and
  // #638 is the phase that touches it. The block is RESTATED rather than deleted or
  // relaxed, because the property it guarded is still the one that matters — it has simply
  // split in two. The four base templates must still produce today's exact strings, and
  // the ONLY thing that may extend them is the attribute component, in the one shape below.
  //
  // ⚠️ The restatement is not cosmetic. Every assertion in the old block goes GREEN under
  // the fold, because passing `null` reproduces the base string exactly — so left alone
  // this block would have kept asserting a sentence that had stopped being true, and no
  // test reads a title.

  it('the four hand-built key templates still produce today’s exact strings unfolded', () => {
    const box = boxGeometryRef([1, 1, 1], null);
    const sphere = sphereGeometryRef(1, 32, 16, null);

    expect(box.key).toBe('box|1,1,1');
    expect(sphere.key).toBe('sphere|1|32|16');
    expect(arrayGeometryRef(box, 3, [2, 0, 0]).key).toBe('array|box|1,1,1|3|2,0,0');
    expect(mirrorGeometryRef(box, 'x', 0).key).toBe('mirror|box|1,1,1|x|0');
  });

  it('an unanswered attribute question is a NAMED refusal, not a silent undefined', () => {
    // The requirement is a required parameter, which production cannot omit — but neither
    // `npm run typecheck` nor vitest typechecks a `*.test.*` call site, so the only thing
    // standing between a missed test call and a ref carrying `attributeKey: undefined` is
    // this refusal. Such a ref hashes differently from one without the field, so it
    // re-keys every mesh value in every project with no error anywhere.
    expect(() =>
      (boxGeometryRef as (s: Vec3, k?: string | null) => GeometryRef)([1, 1, 1]),
    ).toThrow(/without answering the attribute question/);
  });

  it('answering “none” leaves the field ABSENT, not present-and-undefined', () => {
    const box = boxGeometryRef([1, 1, 1], null);
    expect('attributeKey' in box).toBe(false);
    // Two keys, not three: D8 removed the hand-written `kind` beside `descriptor`, so the
    // handle's whole surface is the key and the thing it describes.
    expect(Object.keys(box).sort()).toEqual(['descriptor', 'key']);
  });

  it('the component extends the base template, and two indices give two keys', () => {
    const uniform = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')!;
    const folded = boxGeometryRef([1, 1, 1], uniform);

    expect(folded.key).toBe(`box|1,1,1|a:${uniform}`);
    expect(folded.attributeKey).toBe(uniform);

    // The point of the whole phase: same size, DIFFERENT per-face assignment ⇒ different
    // geometry ⇒ a different cache key ⇒ two built instances that can carry two layouts.
    const twoValued = new Int32Array(12);
    twoValued.fill(1, 6);
    const split = mintAttributes({
      material_index: { domain: 'face', type: 'int', count: 12, data: twoValued },
    })!;
    expect(boxGeometryRef([1, 1, 1], split.key).key).not.toBe(folded.key);
  });

  it('equal size and equal assignment still give ONE key — the sharing the cache exists for', () => {
    const a = boxGeometryRef([2, 2, 2], mintMeshAttributes(boxDescriptor([2, 2, 2]), 'evaluate'));
    const b = boxGeometryRef([2, 2, 2], mintMeshAttributes(boxDescriptor([2, 2, 2]), 'evaluate'));
    expect(a.key).toBe(b.key);

    // …and the component is a function of the FACE COUNT, not of size: a box has twelve
    // faces at every size, so the fold does not shatter sharing across sizes either.
    expect(mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate')).toBe(
      mintMeshAttributes(boxDescriptor([9, 9, 9]), 'evaluate'),
    );
  });

  it('a glTF-sourced handle is byte-identical, and its value hash has not moved', () => {
    // `faceCountOf` is null for gltf/baked, so neither can carry a component — which is
    // what keeps a baked key (and the OPFS path it doubles as) from moving. Pinned as a
    // HASH rather than by inspection: a field materialising as `undefined` would change
    // the hash while leaving every structural assertion above green.
    //
    // ⚠️ THE REFERENCE LITERAL BELOW LOST ITS `kind` AT STEP 8 (D8), and the hash moved with
    // it. That is a shape change and not a regression, and the thing it could have broken
    // was checked rather than assumed: the OPFS path is `bakedGeometryKey`, built from the
    // content hash of the BUFFERS (position/normal/uv/index), never from this object — so no
    // stored path moves. Nothing in `ProjectSchema` carries a descriptor either. The one
    // persisted spelling of the handle is `BakedGeometryRefSchema`, and an already-saved
    // value parses clean under it with the stale field stripped.
    const gltf: GeometryRef = {
      key: 'gltf|asset|child',
      descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
    };
    expect('attributeKey' in gltf).toBe(false);
    expect(hashValue(gltf)).toBe(
      hashValue({
        key: 'gltf|asset|child',
        descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
      }),
    );
    // The discriminator: the same handle WITH the field present-and-undefined is a
    // different value to the hash, which is the failure this whole shape avoids.
    expect(hashValue({ ...gltf, attributeKey: undefined })).not.toBe(hashValue(gltf));
  });

  it('the phase’s own two-valued fixture carries a component in its handle', () => {
    // If this fixture were left unfolded it would be the constructor for the exact defect
    // the phase exists to prevent: a bare key ⇒ no groups written ⇒ the stock six-side
    // layout survives ⇒ a two-length material array draws twelve of thirty-six triangles.
    const value = twoMaterialMeshData();
    expect(value.geometry.attributeKey).toBe(value.attributeKey);
    expect(value.geometry.key).toBe(`box|1,1,1|a:${value.attributeKey}`);
    expect(value.geometry.key).not.toBe(nonAlignedMaterialMeshData().geometry.key);
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
