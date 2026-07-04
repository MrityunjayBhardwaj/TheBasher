// Unit tests for the spec/gloss → metal-rough converter (#214, V53).
// Grounded in the REAL gas_station material shapes observed on disk:
//   - 74/74 materials are spec-gloss, 0 carry pbrMetallicRoughness
//   - typical: diffuseFactor [1,1,1,1] + diffuseTexture, specularFactor [0,0,0]
//     (dielectric), glossinessFactor 0.4
//   - a few metals: specularFactor up to [0.97, 0.21, 0]
//   - exactly 1 material carries a combined specularGlossinessTexture

import { describe, it, expect } from 'vitest';
import {
  SPEC_GLOSS_EXTENSION,
  hasSpecGlossMaterials,
  solveMetallic,
  specGlossFactorsToMetalRough,
  specGlossPixelsToMetalRough,
  specGlossPixelsToMetalRoughAndBase,
  convertSpecGlossDocument,
  type GltfDoc,
} from './specGlossToMetalRough';
import { detectUnsupportedGltfFeatures } from './gltfImportChain';

describe('solveMetallic', () => {
  it('returns 0 when specular is below the dielectric floor (0.04)', () => {
    expect(solveMetallic(0.8, 0.0, 1)).toBe(0);
    expect(solveMetallic(0.5, 0.03, 0.97)).toBe(0);
  });

  it('returns a high metallic for a bright specular with a dark diffuse', () => {
    // A pure metal: bright specular, no diffuse albedo.
    const m = solveMetallic(0.0, 0.9, 0.1);
    expect(m).toBeGreaterThan(0.9);
  });

  it('clamps to [0,1]', () => {
    const m = solveMetallic(0.0, 1.0, 0.0);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThanOrEqual(1);
  });
});

describe('specGlossFactorsToMetalRough', () => {
  it('converts the common dielectric gas_station material (white diffuse, no specular, gloss 0.4)', () => {
    const f = specGlossFactorsToMetalRough([1, 1, 1, 1], [0, 0, 0], 0.4);
    expect(f.metallicFactor).toBe(0); // specular 0 → dielectric
    expect(f.roughnessFactor).toBeCloseTo(0.6, 5); // 1 - 0.4
    // White diffuse with zero specular reconstructs to ~white base color.
    expect(f.baseColorFactor[0]).toBeCloseTo(1, 2);
    expect(f.baseColorFactor[1]).toBeCloseTo(1, 2);
    expect(f.baseColorFactor[2]).toBeCloseTo(1, 2);
    expect(f.baseColorFactor[3]).toBe(1); // opacity preserved
  });

  it('preserves diffuse alpha as opacity', () => {
    const f = specGlossFactorsToMetalRough([0.5, 0.5, 0.5, 0.25], [0, 0, 0], 1);
    expect(f.baseColorFactor[3]).toBe(0.25);
    expect(f.roughnessFactor).toBe(0); // gloss 1 → roughness 0
  });

  it('detects a metal from a bright specular factor', () => {
    // gas_station's brightest metal: specularFactor [0.97, 0.21, 0].
    const f = specGlossFactorsToMetalRough([0.05, 0.05, 0.05, 1], [0.97, 0.21, 0], 0.6);
    expect(f.metallicFactor).toBeGreaterThan(0.5);
    expect(f.roughnessFactor).toBeCloseTo(0.4, 5);
  });

  it('applies glTF spec defaults when factors are omitted', () => {
    const f = specGlossFactorsToMetalRough(); // all defaults
    // Default specular [1,1,1] is a full metal, so base derives from specular
    // (≈ white) and opacity (diffuse alpha default) is exactly 1.
    expect(f.baseColorFactor[0]).toBeCloseTo(1, 5);
    expect(f.baseColorFactor[3]).toBe(1);
    expect(f.metallicFactor).toBeGreaterThan(0);
    expect(f.roughnessFactor).toBe(0); // default gloss 1
  });
});

function gasStationLikeDoc(): GltfDoc {
  return {
    extensionsUsed: [SPEC_GLOSS_EXTENSION],
    extensionsRequired: [SPEC_GLOSS_EXTENSION],
    materials: [
      {
        name: 'dielectric-textured',
        doubleSided: true,
        extensions: {
          [SPEC_GLOSS_EXTENSION]: {
            diffuseFactor: [1, 1, 1, 1],
            diffuseTexture: { index: 0 },
            glossinessFactor: 0.4,
            specularFactor: [0, 0, 0],
          },
        },
      },
      {
        name: 'combined-texture',
        extensions: {
          [SPEC_GLOSS_EXTENSION]: {
            diffuseFactor: [1, 1, 1, 1],
            diffuseTexture: { index: 2 },
            specularGlossinessTexture: { index: 3 },
            glossinessFactor: 1,
            specularFactor: [1, 1, 1],
          },
        },
      },
    ],
  };
}

describe('convertSpecGlossDocument', () => {
  it('converts each material to metal-rough and strips the extension', () => {
    const { doc } = convertSpecGlossDocument(gasStationLikeDoc());
    const m0 = doc.materials![0];
    expect(m0.extensions).toBeUndefined(); // ext removed; bag dropped when empty
    expect(m0.pbrMetallicRoughness!.metallicFactor).toBe(0);
    expect(m0.pbrMetallicRoughness!.roughnessFactor).toBeCloseTo(0.6, 5);
    // diffuseTexture → baseColorTexture (same index, reused sRGB color texture).
    expect(m0.pbrMetallicRoughness!.baseColorTexture).toEqual({ index: 0 });
    expect(m0.doubleSided).toBe(true); // non-extension fields pass through
  });

  it('strips the extension from extensionsUsed / extensionsRequired', () => {
    const { doc } = convertSpecGlossDocument(gasStationLikeDoc());
    // Lists held only spec-gloss → removed entirely.
    expect(doc.extensionsUsed).toBeUndefined();
    expect(doc.extensionsRequired).toBeUndefined();
  });

  it('keeps other extensions in the document lists', () => {
    const input = gasStationLikeDoc();
    input.extensionsUsed = [SPEC_GLOSS_EXTENSION, 'KHR_materials_ior'];
    const { doc } = convertSpecGlossDocument(input);
    expect(doc.extensionsUsed).toEqual(['KHR_materials_ior']);
  });

  it('flags combined-texture materials with the info the pixel pass needs', () => {
    const { doc, combinedTextureMaterials } = convertSpecGlossDocument(gasStationLikeDoc());
    expect(combinedTextureMaterials).toHaveLength(1);
    const c = combinedTextureMaterials[0];
    expect(c.materialIndex).toBe(1);
    expect(c.specGlossTextureIndex).toBe(3);
    expect(c.diffuseTextureIndex).toBe(2);
    expect(c.glossinessFactor).toBe(1);
    const m1 = doc.materials![1];
    // diffuseTexture is converted to baseColorTexture in the factor pass...
    expect(m1.pbrMetallicRoughness!.baseColorTexture).toEqual({ index: 2 });
    // ...the combined MR map is left for the per-pixel pass (app orchestrator).
    expect(m1.pbrMetallicRoughness!.metallicRoughnessTexture).toBeUndefined();
  });

  it('does not mutate the input document (pure)', () => {
    const input = gasStationLikeDoc();
    const before = JSON.stringify(input);
    convertSpecGlossDocument(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is a no-op clone for a metal-rough document (no spec-gloss)', () => {
    const mr: GltfDoc = {
      materials: [
        { name: 'mr', pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0.5 } },
      ],
    };
    const { doc, combinedTextureMaterials } = convertSpecGlossDocument(mr);
    expect(doc).toEqual(mr);
    expect(combinedTextureMaterials).toEqual([]);
  });
});

describe('no-silent-drop reconciliation (#214 increment 4)', () => {
  it('a CONVERTED .gltf no longer flags spec/gloss as unsupported', () => {
    // Pre-conversion: spec/gloss IS flagged (the unconverted .glb case).
    expect(detectUnsupportedGltfFeatures(gasStationLikeDoc())).toContain(SPEC_GLOSS_EXTENSION);
    // After ingest conversion (what render + capture read): stripped, no flag.
    const { doc } = convertSpecGlossDocument(gasStationLikeDoc());
    expect(detectUnsupportedGltfFeatures(doc)).not.toContain(SPEC_GLOSS_EXTENSION);
    expect(detectUnsupportedGltfFeatures(doc)).toEqual([]);
  });
});

describe('hasSpecGlossMaterials', () => {
  it('detects via extensionsUsed', () => {
    expect(hasSpecGlossMaterials({ extensionsUsed: [SPEC_GLOSS_EXTENSION] })).toBe(true);
  });
  it('detects via a material extension', () => {
    expect(
      hasSpecGlossMaterials({ materials: [{ extensions: { [SPEC_GLOSS_EXTENSION]: {} } }] }),
    ).toBe(true);
  });
  it('is false for a metal-rough document', () => {
    expect(hasSpecGlossMaterials({ materials: [{ pbrMetallicRoughness: {} }] })).toBe(false);
  });
});

describe('specGlossPixelsToMetalRough', () => {
  // One texel = 4 bytes RGBA. Output convention: R=AO(255), G=roughness, B=metal.
  it('writes roughness from glossiness alpha (PNG) and metalness from specular', () => {
    // A dielectric texel: black specular (RGB 0), gloss alpha 204 (~0.8).
    const spec = new Uint8ClampedArray([0, 0, 0, 204]);
    const out = specGlossPixelsToMetalRough(spec, null, [1, 1, 1], 1, true);
    expect(out[0]).toBe(255); // R = AO unused
    expect(out[2]).toBe(0); // B = metalness 0 (black specular → dielectric)
    expect(out[1]).toBeCloseTo(Math.round((1 - 204 / 255) * 255), 0); // G = 1-gloss
    expect(out[3]).toBe(255);
  });

  it('uses the glossiness factor when there is no alpha (JPEG)', () => {
    // A genuinely dielectric texel (specular below the 0.04 floor) + gloss factor
    // 0.4 — roughness comes from the factor (no alpha), metalness is 0.
    const spec = new Uint8ClampedArray([5, 5, 5, 255]); // ~0.02 specular < floor
    const out = specGlossPixelsToMetalRough(spec, null, [0.084, 0.055, 0.128], 0.4, false);
    expect(out[1]).toBe(Math.round(0.6 * 255)); // roughness = 1 - 0.4 (factor)
    expect(out[2]).toBe(0); // below dielectric floor → metalness 0
  });

  it('detects a metal from a bright specular texel', () => {
    const spec = new Uint8ClampedArray([240, 240, 240, 255]); // bright spec
    const out = specGlossPixelsToMetalRough(spec, null, [0.05, 0.05, 0.05], 1, false);
    expect(out[2]).toBeGreaterThan(128); // high metalness
  });

  it('processes multiple texels independently', () => {
    const spec = new Uint8ClampedArray([0, 0, 0, 255, 240, 240, 240, 255]);
    const out = specGlossPixelsToMetalRough(spec, null, [0.05, 0.05, 0.05], 1, false);
    expect(out[2]).toBeLessThan(30); // texel 0: dielectric
    expect(out[6]).toBeGreaterThan(128); // texel 1: metal
  });

  it('uses per-texel diffuse when a resampled diffuse texture is supplied', () => {
    // A dielectric spec texel; the diffuse term comes from the resampled diffuse
    // texture (not the factor). Roughness still tracks gloss; metalness stays low.
    const spec = new Uint8ClampedArray([10, 10, 10, 255]); // ~0.04 specular
    const diffuse = new Uint8ClampedArray([200, 50, 25, 255]);
    const out = specGlossPixelsToMetalRough(spec, diffuse, [1, 1, 1], 0.5, false);
    expect(out[1]).toBe(Math.round(0.5 * 255)); // roughness = 1 - gloss
    expect(out[2]).toBeLessThan(40); // near-floor specular → low metalness
  });
});

describe('specGlossPixelsToMetalRoughAndBase — base-color bake (#218)', () => {
  it('a coloured-specular METAL reconstructs base color from the SPECULAR channel', () => {
    // Gold: bright coloured specular, ~black diffuse (the tint lives in specular).
    const spec = new Uint8ClampedArray([255, 200, 80, 255]);
    const diffuse = new Uint8ClampedArray([0, 0, 0, 255]);
    const { base, maxMetallic } = specGlossPixelsToMetalRoughAndBase(
      spec,
      diffuse,
      [0, 0, 0],
      1,
      false,
    );
    expect(maxMetallic).toBeGreaterThan(0.9); // solves to a metal
    // base ≈ the specular colour (gold), NOT the black diffuse the old path kept.
    expect(base[0]).toBeGreaterThan(200); // R high
    expect(base[1]).toBeGreaterThan(150); // G mid-high
    expect(base[2]).toBeLessThan(140); // B lower (gold tint)
  });

  it('a DIELECTRIC keeps base ≈ diffuse and reports ~0 metallic (no base bake)', () => {
    // Low specular (below the 0.04 floor) + a red diffuse → dielectric.
    const spec = new Uint8ClampedArray([6, 6, 6, 255]);
    const diffuse = new Uint8ClampedArray([200, 40, 40, 255]);
    const { base, maxMetallic } = specGlossPixelsToMetalRoughAndBase(
      spec,
      diffuse,
      [1, 1, 1],
      0.5,
      false,
    );
    expect(maxMetallic).toBe(0); // sub-floor specular → fully dielectric
    expect(base[0]).toBeGreaterThan(180); // base ≈ the red diffuse
    expect(base[1]).toBeLessThan(80);
    expect(base[2]).toBeLessThan(80);
  });

  it('maxMetallic is the PEAK across texels (mixed metal + dielectric)', () => {
    // Texel 0 dielectric (low spec), texel 1 metal (bright spec).
    const spec = new Uint8ClampedArray([5, 5, 5, 255, 240, 240, 240, 255]);
    const { maxMetallic } = specGlossPixelsToMetalRoughAndBase(
      spec,
      null,
      [0.5, 0.5, 0.5],
      1,
      false,
    );
    expect(maxMetallic).toBeGreaterThan(0.5); // the metal texel drives the peak
  });

  it('the .mr output matches the back-compat specGlossPixelsToMetalRough wrapper', () => {
    const spec = new Uint8ClampedArray([200, 180, 60, 255]);
    const diffuse = new Uint8ClampedArray([20, 20, 20, 255]);
    const { mr } = specGlossPixelsToMetalRoughAndBase(spec, diffuse, [1, 1, 1], 0.8, false);
    const legacy = specGlossPixelsToMetalRough(spec, diffuse, [1, 1, 1], 0.8, false);
    expect(Array.from(mr)).toEqual(Array.from(legacy));
  });
});
