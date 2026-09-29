// #1123 — the fuzz lobe (glTF sheen) is optional: absent when a material has none.
//
// A material saved before the lobe existed comes back without it, on both parse roads, and keys as
// it did (`materialKeyOf` walks every own key). A present lobe keeps OpenPBR's defaults inside it,
// so a partial one fills its siblings.
//
// REF: src/nodes/materialSchema.ts; ref/sources/openpbr/open_pbr_surface.mtlx (fuzz defaults).

import { describe, expect, it } from 'vitest';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';
import { openpbrToThree } from '../app/material/openpbrToThree';

const legacyRaw = { name: 'm', base: { color: '#ff0000' } };
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe('#1123 — a material saved before the fuzz lobe keeps its identity', () => {
  it('emits no fuzz key on either parse road', () => {
    expect(has(hydrateInlineMaterial(legacyRaw), 'fuzz')).toBe(false);
    expect(has(openpbrMaterialSchema().parse({}) as object, 'fuzz')).toBe(false);
  });

  it('CONTROL — a materialised lobe would key differently, so the row above can fail', () => {
    const base = hydrateInlineMaterial(legacyRaw);
    expect(
      materialKeyOf({ ...base, fuzz: { weight: 0, color: '#ffffff', roughness: 0.5 } }),
    ).not.toBe(materialKeyOf(base));
  });

  it('the compile emits no sheen for it', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial(legacyRaw));
    for (const k of ['sheen', 'sheenColor', 'sheenRoughness']) expect(has(drawn, k)).toBe(false);
  });
});

describe('#1123 — a present fuzz lobe', () => {
  it('fills its missing fields with OpenPBR defaults on both parse roads', () => {
    const want = { weight: 0.4, color: '#ffffff', roughness: 0.5 };
    expect(hydrateInlineMaterial({ ...legacyRaw, fuzz: { weight: 0.4 } }).fuzz).toEqual(want);
    const parsed = openpbrMaterialSchema().parse({ fuzz: { weight: 0.4 } }) as { fuzz?: unknown };
    expect(parsed.fuzz).toEqual(want);
  });

  it('compiles to three`s sheen, one field each', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        ...legacyRaw,
        fuzz: { weight: 0.4, color: '#ff8800', roughness: 0.2 },
      }),
    );
    expect(drawn).toMatchObject({ sheen: 0.4, sheenColor: '#ff8800', sheenRoughness: 0.2 });
  });
});
