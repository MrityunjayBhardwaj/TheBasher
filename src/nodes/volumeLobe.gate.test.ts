// #1322 — a volume is three optional fields: the transmission lobe's `color` and `depth` (OpenPBR's
// transmission_color / transmission_depth) and `geometry.thickness` (glTF's thickness hint). A
// material saved before them keeps its identity and draws as it did: transmissive glass keeps the
// default thickness, and nothing absorbs.
//
// REF: src/app/material/openpbrToThree.ts; ref/sources/openpbr/open_pbr_surface.mtlx;
//      ref/sources/gltf-spec/extensions/KHR_materials_volume.md.

import { describe, expect, it } from 'vitest';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';
import { DEFAULT_TRANSMISSION_THICKNESS, openpbrToThree } from '../app/material/openpbrToThree';

const glass = { name: 'm', base: { color: '#ffffff' }, transmission: { weight: 1 } };
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe('#1322 — glass saved before the volume fields keeps its identity and its look', () => {
  it('none of the three appears on either parse road', () => {
    const h = hydrateInlineMaterial(glass);
    const z = openpbrMaterialSchema().parse(glass) as typeof h;
    for (const m of [h, z]) {
      expect(has(m.transmission, 'color')).toBe(false);
      expect(has(m.transmission, 'depth')).toBe(false);
      expect(has(m.geometry, 'thickness')).toBe(false);
    }
  });

  it('CONTROL — a materialised depth would key differently', () => {
    const base = hydrateInlineMaterial(glass);
    expect(materialKeyOf({ ...base, transmission: { ...base.transmission, depth: 0 } })).not.toBe(
      materialKeyOf(base),
    );
  });

  it('it still draws the default thickness, and absorbs nothing', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial(glass));
    expect(drawn.thickness).toBe(DEFAULT_TRANSMISSION_THICKNESS);
    expect(has(drawn, 'attenuationDistance')).toBe(false);
    expect(has(drawn, 'attenuationColor')).toBe(false);
  });
});

describe('#1322 — set, the volume fields survive both parse roads', () => {
  const raw = {
    ...glass,
    transmission: { weight: 1, color: '#7ccbff', depth: 0.5 },
    geometry: { opacity: 1, thickness: 0.2 },
  };

  it('the hand-written hydrate keeps all three', () => {
    const m = hydrateInlineMaterial(raw);
    expect(m.transmission).toEqual({ weight: 1, color: '#7ccbff', depth: 0.5 });
    expect(m.geometry.thickness).toBe(0.2);
  });

  it('the zod schema keeps all three (an undeclared field is stripped without a word)', () => {
    const m = openpbrMaterialSchema().parse(raw) as ReturnType<typeof hydrateInlineMaterial>;
    expect(m.transmission).toEqual({ weight: 1, color: '#7ccbff', depth: 0.5 });
    expect(m.geometry.thickness).toBe(0.2);
  });
});

describe('#1322 — the volume fields reach the compile', () => {
  it('depth and colour become three`s attenuation; the thickness replaces the default', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({
        ...glass,
        transmission: { weight: 1, color: '#7ccbff', depth: 0.5 },
        geometry: { opacity: 1, thickness: 0.2 },
      }),
    );
    expect(drawn).toMatchObject({
      thickness: 0.2,
      attenuationDistance: 0.5,
      attenuationColor: '#7ccbff',
    });
  });

  it('a thickness of 0 is thin-walled and stays 0', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({ ...glass, geometry: { opacity: 1, thickness: 0 } }),
    );
    expect(drawn.thickness).toBe(0);
  });

  it('a colour with no depth is OpenPBR`s tint, which three cannot draw: no attenuation', () => {
    const drawn = openpbrToThree(
      hydrateInlineMaterial({ ...glass, transmission: { weight: 1, color: '#7ccbff' } }),
    );
    expect(has(drawn, 'attenuationColor')).toBe(false);
  });
});
