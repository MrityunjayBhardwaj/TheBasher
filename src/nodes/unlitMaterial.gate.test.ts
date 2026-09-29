// #1123 — an unlit material is the optional `unlit: true`, absent when lit.
//
// Two things must hold. A material saved before the field existed comes back without it and keys as
// it did (`materialKeyOf` walks every own key). And an unlit material is never mistaken for a baked
// snapshot: `isBakedMaterialSpec` tells the two apart by `materialClass` alone, which is why this
// field is not called that on the inline spec even though the compile and the bake use that word.
//
// REF: src/nodes/materialSchema.ts (`isBakedMaterialSpec`, the schema, the hydrate);
//      src/app/material/openpbrToThree.ts (`materialClass: 'basic'` on the compile).

import { describe, expect, it } from 'vitest';
import {
  hydrateInlineMaterial,
  isBakedMaterialSpec,
  openpbrMaterialSchema,
} from './materialSchema';
import { materialKeyOf } from './materialKey';
import { openpbrToThree } from '../app/material/openpbrToThree';

const legacyRaw = { name: 'm', base: { color: '#ff0000' } };
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe('#1123 — a lit material saved before `unlit` keeps its identity', () => {
  it('hydrating it emits no unlit key, on either parse road', () => {
    expect(has(hydrateInlineMaterial(legacyRaw), 'unlit')).toBe(false);
    expect(has(openpbrMaterialSchema().parse({}) as object, 'unlit')).toBe(false);
  });

  it('CONTROL — a materialised key would key differently, so the row above can fail', () => {
    const base = hydrateInlineMaterial(legacyRaw);
    expect(materialKeyOf({ ...base, unlit: true })).not.toBe(materialKeyOf(base));
  });

  it('anything but true reads as lit and writes nothing', () => {
    for (const v of [false, 'true', 1, null]) {
      expect(has(hydrateInlineMaterial({ ...legacyRaw, unlit: v }), 'unlit')).toBe(false);
    }
    expect(() => openpbrMaterialSchema().parse({ unlit: false })).toThrow();
  });

  it('the compile names no class for it', () => {
    expect(has(openpbrToThree(hydrateInlineMaterial(legacyRaw)), 'materialClass')).toBe(false);
  });
});

describe('#1123 — an unlit material', () => {
  const raw = { ...legacyRaw, unlit: true };

  it('survives both parse roads', () => {
    expect(hydrateInlineMaterial(raw).unlit).toBe(true);
    expect((openpbrMaterialSchema().parse(raw) as { unlit?: unknown }).unlit).toBe(true);
  });

  it('compiles to the basic class', () => {
    expect(openpbrToThree(hydrateInlineMaterial(raw)).materialClass).toBe('basic');
  });

  it('is never read as a baked snapshot — the reason the field is not called materialClass', () => {
    expect(isBakedMaterialSpec(hydrateInlineMaterial(raw))).toBe(false);
    // The control: the same material with the baked word WOULD be misread.
    expect(isBakedMaterialSpec({ ...hydrateInlineMaterial(raw), materialClass: 'basic' })).toBe(
      true,
    );
  });
});
