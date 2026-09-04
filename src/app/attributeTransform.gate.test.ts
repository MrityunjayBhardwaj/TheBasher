// #723 — AN ATTRIBUTE DECLARES WHAT A MATRIX MAY DO TO IT, AND THE GATHER HONOURS IT.
//
// `AttributeType` is a storage WIDTH: a `float3` may be a position, a velocity, a normal or a
// colour, and under a matrix those must not be treated alike. Before this the substrate could
// not tell them apart, so it refused every `float3` under a mirror — dropping a per-point
// colour, which needs no transform at all, to avoid corrupting a normal, which does.
//
// ── WHY ALL SIX TYPES ARE DECLARED WHEN ONLY FOUR CAN BE HONOURED ─────────────────────────
//
// The narrower `'none' | 'direction'` was considered and rejected. It sizes the vocabulary to
// today's two operators rather than to the domain, and — the deciding argument — it destroys
// information at the mint: a producer KNOWS whether its `float3` is a velocity or a normal,
// and a type that cannot record the difference makes it unrecoverable later. `quaternion` and
// `matrix` are declared and REFUSED BY NAME, which is a different thing from absent.
//
// ── THE NORMAL RULE IS GROUNDED IN LIBRARY SOURCE ─────────────────────────────────────────
//
// `ref/houdini/SOP.md:24` names a "Normal" type without printing the matrix and records the
// inverse-transpose as UNVERIFIED. It does not need to be verified there: three implements it
// (`Matrix3.js:201`, `setFromMatrix4(m).invert().transpose()`) and `BufferGeometry.applyMatrix4`
// already applies exactly that to a geometry's BUILT-IN normals (`BufferGeometry.js:145-147`).
// Honouring `normal` here is the store road ceasing to disagree with the buffer road.
//
// ── TWO BUGS THESE ROWS EXIST BECAUSE OF, BOTH FOUND BY OBSERVATION AND NOT BY READING ────
//
//  1. The content key omitted `transform`, so six semantically different attributes minted ONE
//     key and the store served the first for all of them — #649's collision in a new field.
//     The probe's six cases all returned the first one's answer.
//  2. The tiled-key memo was keyed on `(order, sourceKey)`, complete only while the gather was
//     a pure permutation. A `position` through `mirror(x, 5)` came back with `mirror(x, 0)`'s
//     values. The matrix is in the key now — and ONLY when something is actually transformed,
//     because keying on it unconditionally busts the memo on every step of an offset drag.
//
// REF: src/app/attributeTransform.ts; src/app/copyTransform.ts; src/nodes/attributes.ts
//      (`TRANSFORM_TYPES`); ref/houdini/SOP.md:24; issue #723.

import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { TRANSFORM_TYPES, type AttributeData, type TransformType } from '../nodes/attributes';
import { transformRuleFor } from './attributeTransform';
import { copyMatrixOf, mirrorMatrixOf } from './copyTransform';
import { mintAttributes } from '../nodes/attributeKey';
import { insert, read } from './attributeStore';
import { boxGeometryRef, mirrorGeometryRef } from './modifierGeometry';
import { pointCountOf } from './pointIdentity';

/** A box's points, every one carrying +X, declared as `transform`. */
function mirroredX(transform: TransformType | undefined, offset: number) {
  const n = (pointCountOf(boxGeometryRef([1, 1, 1], null).descriptor) as { count?: number })
    .count as number;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) data[i * 3] = 1;
  const minted = mintAttributes({
    N: { domain: 'point', type: 'float3', count: n, data, transform } as AttributeData,
  })!;
  insert(minted.key, minted.set, 'overlay');
  const ref = mirrorGeometryRef(boxGeometryRef([1, 1, 1], minted.key), 'x', offset);
  const out = ref.attributeKey ? read(ref.attributeKey) : null;
  const carried = out?.['N'];
  if (!carried) return null;
  const half = carried.count / 2;
  return [carried.data[half * 3], carried.data[half * 3 + 1], carried.data[half * 3 + 2]];
}

describe('#723 a declared transform type is honoured under a matrix', () => {
  it('every declared type has a rule or a named refusal, and the list is closed', () => {
    // DENOMINATOR: censused over the CLOSED list, so a seventh member is examined here
    // without an edit — and `transformRuleFor`'s `never` stops it compiling before that.
    expect(TRANSFORM_TYPES.length).toBeGreaterThan(0);
    for (const t of TRANSFORM_TYPES) {
      const rule = transformRuleFor(t);
      expect(['identity', 'mapped', 'refused']).toContain(rule.kind);
      if (rule.kind === 'refused') expect(rule.why.length).toBeGreaterThan(20);
    }
    // UNCLASSIFIED IS NOT `'none'`. Reading silence as "do nothing" is the failure mode.
    expect(transformRuleFor(undefined).kind).toBe('refused');
    expect(transformRuleFor('none').kind).toBe('identity');
  });

  it('the four honoured rules are the four distinct behaviours, on one matrix', () => {
    // A reflection across x at offset 5, which has BOTH a linear part and a translation —
    // the translation is what separates `position` from `vector` at all.
    const m = mirrorMatrixOf('x', 5);
    const at = (t: TransformType) => {
      const rule = transformRuleFor(t);
      if (rule.kind !== 'mapped') return null;
      return rule.apply(new Vector3(1, 0, 0), m).toArray();
    };
    expect(at('position')).toEqual([9, 0, 0]); // 2*5 - 1 — follows the translation
    expect(at('vector')).toEqual([-1, 0, 0]); // linear part only
    expect(at('normal')).toEqual([-1, 0, 0]); // inverse-transpose; equals the linear part here
    expect(transformRuleFor('none').kind).toBe('identity');
  });

  it('🔴 normal and vector agree under a reflection and MUST NOT under a non-uniform scale', () => {
    // The decision this build cannot take yet, as a test that reds when it becomes takeable.
    // A reflection is orthogonal and symmetric, so its inverse-transpose IS itself and the two
    // rules coincide — which is why shipping only a merged 'direction' looked adequate and was
    // not. Under a non-uniform scale they diverge, and this row is what proves the distinction
    // is real rather than decorative.
    const nonUniform = new Matrix4().makeScale(2, 1, 1);
    const v = (t: TransformType) => {
      const rule = transformRuleFor(t);
      if (rule.kind !== 'mapped') throw new Error(`${t} has no rule`);
      return rule.apply(new Vector3(1, 1, 0), nonUniform).toArray();
    };
    expect(v('vector')).toEqual([2, 1, 0]); // scaled along x
    expect(v('normal')).toEqual([0.5, 1, 0]); // inverse-transpose — stays perpendicular
    expect(v('vector')).not.toEqual(v('normal'));
  });

  it('the copy matrix has ONE statement, and the builders read it', () => {
    // Copy 0 of a mirror is the preserved original and takes the identity; copy 1 is the
    // reflection. An array's copy i is offset*i. Both must equal what the builders apply.
    const mirror = { kind: 'mirror', axis: 'x', offset: 5 } as never;
    expect(copyMatrixOf(mirror, 0)!.elements).toEqual(new Matrix4().elements);
    expect(copyMatrixOf(mirror, 1)!.elements).toEqual(mirrorMatrixOf('x', 5).elements);
    const array = { kind: 'array', offset: [2, 0, 0] } as never;
    expect(copyMatrixOf(array, 0)!.elements).toEqual(new Matrix4().elements);
    expect(copyMatrixOf(array, 3)!.elements).toEqual(
      new Matrix4().makeTranslation(6, 0, 0).elements,
    );
    // A kind that places no copies by a matrix says so, rather than answering the identity —
    // the gather branches on the null and leaves values alone.
    expect(copyMatrixOf({ kind: 'box', size: [1, 1, 1] } as never, 1)).toBeNull();
  });

  it('🔴 END TO END: the reflected half carries the transformed values, per declared type', () => {
    // The whole point, observed through the real ref → store → gather road rather than by
    // calling the rule directly.
    expect(mirroredX('none', 0)).toEqual([1, 0, 0]); // untouched
    expect(mirroredX('vector', 0)).toEqual([-1, 0, 0]);
    expect(mirroredX('normal', 0)).toEqual([-1, 0, 0]);
    // The discriminator: at a non-zero offset a position follows the translation and a
    // direction does not. This is the row that would have caught the memo collision.
    expect(mirroredX('position', 5)).toEqual([9, 0, 0]);
    expect(mirroredX('vector', 5)).toEqual([-1, 0, 0]);
    // And the two that cannot be honoured are refused rather than carried wrong.
    expect(mirroredX(undefined, 0)).toBeNull();
    expect(mirroredX('quaternion', 0)).toBeNull();
    expect(mirroredX('matrix', 0)).toBeNull();
  });

  it('the transform type is part of the content key, so two meanings cannot collide', () => {
    // Bug 1 above. Same name, domain, type, count and bytes — different declared meaning.
    const bytes = () => new Float32Array([1, 0, 0]);
    const of = (transform: TransformType | undefined) =>
      mintAttributes({
        N: { domain: 'point', type: 'float3', count: 1, data: bytes(), transform } as AttributeData,
      })!.key;
    const keys = [of(undefined), of('none'), of('vector'), of('normal'), of('position')];
    expect(new Set(keys).size).toBe(keys.length);
    // AND an UNCLASSIFIED attribute hashes exactly as it did before the field existed, which
    // is why no pinned key in this repo moved. The obvious spelling — `transform: undefined` —
    // did move them: `stableStringify` walks `Object.keys` and emits the key as `null`.
    expect(of(undefined)).not.toBe(of('none'));
  });
});
