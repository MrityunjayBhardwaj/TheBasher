// #1321 — the specular lobe's weight and colour are optional fields: absent means OpenPBR's default
// (weight 1, colour white; `open_pbr_surface.mtlx:16,18`), and absent is what every material saved
// before them has. They must stay absent on both parse roads, or every saved material re-keys.
//
// REF: src/nodes/materialSchema.ts; ref/sources/openpbr/open_pbr_surface.mtlx.

import { describe, expect, it } from 'vitest';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';
import { openpbrToThree } from '../app/material/openpbrToThree';

const legacyRaw = { name: 'm', base: { color: '#ff0000' }, specular: { roughness: 0.4, ior: 1.5 } };
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe('#1321 — a material saved before the specular weight and colour keeps its identity', () => {
  it('neither field appears on either parse road', () => {
    const hydrated = hydrateInlineMaterial(legacyRaw).specular;
    const parsed = (openpbrMaterialSchema().parse(legacyRaw) as { specular: object }).specular;
    for (const k of ['weight', 'color']) {
      expect(has(hydrated, k)).toBe(false);
      expect(has(parsed, k)).toBe(false);
    }
  });

  it('CONTROL — a materialised weight would key differently, so the row above can fail', () => {
    const base = hydrateInlineMaterial(legacyRaw);
    expect(materialKeyOf({ ...base, specular: { ...base.specular, weight: 1 } })).not.toBe(
      materialKeyOf(base),
    );
  });

  it('the compile emits neither three field for it', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial(legacyRaw));
    expect(has(drawn, 'specularIntensity')).toBe(false);
    expect(has(drawn, 'specularColor')).toBe(false);
  });
});

describe('#1321 — set, they reach the compile under three`s names', () => {
  it('weight → specularIntensity, colour → specularColor', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        ...legacyRaw,
        specular: { roughness: 0.4, ior: 1.5, weight: 0.4, color: '#ffbc89' },
      }),
    );
    expect(drawn).toMatchObject({ specularIntensity: 0.4, specularColor: '#ffbc89' });
  });
});
