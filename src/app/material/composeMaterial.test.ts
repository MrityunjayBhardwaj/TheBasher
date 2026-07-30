// composeMaterial — the IR-lane and baked-lane forms of the ONE override
// composition rule (#394 S3b).
//
// THE POINT OF THESE TESTS is the pair of claims the extraction rests on:
//   1. composition is FOLDABLE — IR in, IR out, so an operator stack can chain it;
//   2. the DECISION is not re-spelled — both representations reach the same answer
//      about the same question, so a map defends its channel on the native and
//      baked roads exactly as it does on the glTF one.
//
// Every fixture gives the base and the override DIFFERENT values, so a compose
// that silently returned the base (or the override) goes red rather than passing
// on a coincidence.

import { describe, it, expect } from 'vitest';
import { composeBakedMaterial, composeMaterial } from './composeMaterial';
import { hydrateInlineMaterial } from '../../nodes/materialSchema';
import { openpbrToThree } from './openpbrToThree';
import type { BakedMaterialSpec, BakedTextureRef, MaterialValue } from '../../nodes/types';

const TEX: BakedTextureRef = {
  hash: 'deadbeef',
  colorSpace: 'srgb-linear',
  flipY: false,
  wrapS: 1000,
  wrapT: 1000,
};

/** A base IR whose every composed channel differs from the override below. */
function baseIR(maps: Partial<Record<'roughness' | 'metalness', BakedTextureRef | null>> = {}) {
  const ir = hydrateInlineMaterial({
    name: 'base',
    base: { color: '#112233', metalness: 0.25 },
    specular: { roughness: 0.75, ior: 1.7 },
    coat: { weight: 0.4, roughness: 0.2 },
    transmission: { weight: 0 },
    emission: { color: '#010203', luminance: 3 },
    geometry: { opacity: 0.9 },
  });
  return { ...ir, maps: { ...ir.maps, ...maps } };
}

const OVERRIDE: MaterialValue = {
  kind: 'Material',
  name: 'override',
  color: '#ff0000',
  roughness: 0.1,
  metalness: 0.8,
  opacity: 0.5,
  emissive: '#00ff00',
  emissiveIntensity: 7,
};

describe('composeMaterial — the IR lane', () => {
  it('writes the override onto every channel it has an opinion about', () => {
    const out = composeMaterial(baseIR(), OVERRIDE);
    expect(out.base.color).toBe('#ff0000');
    expect(out.base.metalness).toBe(0.8);
    expect(out.specular.roughness).toBe(0.1);
    expect(out.geometry.opacity).toBe(0.5);
    expect(out.emission.color).toBe('#00ff00');
    expect(out.emission.luminance).toBe(7);
  });

  it('leaves every channel the override has NO opinion about on the base', () => {
    // ior / coat / transmission / maps / uvTransform: a MaterialValue carries no
    // field for them, so inventing one would be an opinion nobody expressed.
    const base = baseIR();
    const out = composeMaterial(base, OVERRIDE);
    expect(out.specular.ior).toBe(1.7);
    expect(out.coat).toEqual({ weight: 0.4, roughness: 0.2 });
    expect(out.transmission).toEqual({ weight: 0 });
    expect(out.maps).toEqual(base.maps);
    expect(out.uvTransform).toEqual(base.uvTransform);
  });

  it('is FOLDABLE — the output is a legal input, and the last op wins', () => {
    // This is the property the operator lane (#394 S3c) folds on. A compose that
    // returned a flat three.js bag could be applied once and never chained.
    const second: MaterialValue = { ...OVERRIDE, color: '#0000ff', roughness: 0.9 };
    const folded = [OVERRIDE, second].reduce(composeMaterial, baseIR());
    expect(folded.base.color).toBe('#0000ff');
    expect(folded.specular.roughness).toBe(0.9);
    // …and the untouched channels survive the whole fold, not just one step.
    expect(folded.specular.ior).toBe(1.7);
  });

  it('does not mutate the base (a fold must not corrupt a shared upstream)', () => {
    const base = baseIR();
    composeMaterial(base, OVERRIDE);
    expect(base.base.color).toBe('#112233');
    expect(base.specular.roughness).toBe(0.75);
  });

  describe('map-awareness — the behaviour #394 S3b brought to the native road', () => {
    it('a roughness map defends its channel; the base scalar survives', () => {
      const out = composeMaterial(baseIR({ roughness: TEX }), OVERRIDE);
      expect(out.specular.roughness).toBe(0.75); // base, NOT the override's 0.1
      expect(out.base.metalness).toBe(0.8); // unmapped ⇒ the override still wins
    });

    it('a metalness map defends its channel independently', () => {
      const out = composeMaterial(baseIR({ metalness: TEX }), OVERRIDE);
      expect(out.base.metalness).toBe(0.25); // base
      expect(out.specular.roughness).toBe(0.1); // unmapped ⇒ override
    });

    it('an explicitly authored field FORCES the scalar over its map (#124)', () => {
      const out = composeMaterial(baseIR({ roughness: TEX, metalness: TEX }), {
        ...OVERRIDE,
        overridden: { roughness: true },
      });
      expect(out.specular.roughness).toBe(0.1); // forced past the map
      expect(out.base.metalness).toBe(0.25); // not authored ⇒ map still defends
    });

    it('the always-applied tint channels ignore maps entirely', () => {
      const out = composeMaterial(baseIR({ roughness: TEX, metalness: TEX }), OVERRIDE);
      expect(out.base.color).toBe('#ff0000');
      expect(out.emission.color).toBe('#00ff00');
      expect(out.geometry.opacity).toBe(0.5);
    });
  });

  it('leaves `transparent` to the compile, which reads transmission too', () => {
    // The wholesale spellings this replaced each re-derived `transparent` as
    // `opacity < 1`, dropping transparency from an overridden transmissive
    // material. Composing into the IR and compiling restores the one derivation.
    const transmissive = { ...baseIR(), transmission: { weight: 0.6 } };
    const opaqueOverride: MaterialValue = { ...OVERRIDE, opacity: 1 };
    expect(openpbrToThree(composeMaterial(transmissive, opaqueOverride)).transparent).toBe(true);
  });
});

describe('composeBakedMaterial — the baked lane, same decision', () => {
  const spec: BakedMaterialSpec = {
    materialClass: 'standard',
    color: '#112233',
    roughness: 0.75,
    metalness: 0.25,
    opacity: 0.9,
    transparent: false,
    emissive: '#010203',
    emissiveIntensity: 3,
    map: null,
    normalMap: null,
    roughnessMap: null,
    metalnessMap: null,
    aoMap: null,
    emissiveMap: null,
  };

  it('writes the override onto an unmapped spec', () => {
    expect(composeBakedMaterial(spec, OVERRIDE)).toEqual({
      color: '#ff0000',
      roughness: 0.1,
      metalness: 0.8,
      opacity: 0.5,
      emissive: '#00ff00',
      emissiveIntensity: 7,
      transparent: true, // opacity 0.5 < 1
    });
  });

  it('a captured map defends its channel — the old applyOverride forced it', () => {
    const mapped = { ...spec, roughnessMap: TEX };
    expect(composeBakedMaterial(mapped, OVERRIDE).roughness).toBe(0.75);
    expect(composeBakedMaterial(mapped, OVERRIDE).metalness).toBe(0.8);
  });

  it('reaches the SAME answer as the IR lane on the same question', () => {
    // The claim the extraction rests on: two representations, one decision. If a
    // future edit re-answers "may this scalar be written" in either lane, this
    // goes red — which is the drift guard the S4 one-composer gate formalises.
    const mappedSpec = { ...spec, roughnessMap: TEX };
    const mappedIR = baseIR({ roughness: TEX });
    const baked = composeBakedMaterial(mappedSpec, OVERRIDE);
    const ir = composeMaterial(mappedIR, OVERRIDE);
    expect(baked.roughness).toBe(ir.specular.roughness);
    expect(baked.metalness).toBe(ir.base.metalness);
    expect(baked.color).toBe(ir.base.color);
    expect(baked.opacity).toBe(ir.geometry.opacity);
    expect(baked.emissiveIntensity).toBe(ir.emission.luminance);
  });
});
