// convertSpecGlossGlb — the GLB spec/gloss → metal-rough ingest path (#216).
//
// These tests exercise the CONTAINER + FACTOR conversion, which is pure (no
// canvas): build a spec/gloss GLB, run the conversion, parse the repacked bytes
// back, and assert the materials are normal metal-rough with the required
// extension stripped. The COMBINED specularGlossinessTexture per-texel bake needs
// createImageBitmap/OffscreenCanvas (browser only) → it gracefully degrades to a
// factor-only conversion here (vitest has no canvas) and is observed end-to-end
// by the e2e fixture (gltf-specgloss-glb-capture.spec.ts).

import { describe, it, expect } from 'vitest';
import { convertSpecGlossGlb } from './specGlossIngest';
import { parseGlb, repackGlb, type GltfJson } from '../../core/import/glb';
import type { IngestFile } from './importCommon';

const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

/** A spec/gloss glTF JSON document object: one dielectric material (low
 *  specular, glossiness 0.4) with a diffuse texture, plus a required-extension
 *  declaration so a pre-#216 import would have flat-grayed it. */
function specGlossDoc(): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    extensionsUsed: [SPEC_GLOSS],
    extensionsRequired: [SPEC_GLOSS],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
    buffers: [{ byteLength: 4 }],
    materials: [
      {
        name: 'SG',
        extensions: {
          [SPEC_GLOSS]: {
            diffuseFactor: [0.8, 0.2, 0.1, 1],
            specularFactor: [0.02, 0.02, 0.02], // below dielectric floor → metallic 0
            glossinessFactor: 0.4,
            diffuseTexture: { index: 0 },
          },
        },
      },
    ],
  };
}

function glbEntry(json: unknown, bin: Uint8Array): IngestFile {
  return { relativePath: 'model.glb', bytes: repackGlb({ json, bin }) };
}

/** Parse a conversion result's repacked GLB back to its JSON document. */
function reparse(bytes: Uint8Array): GltfJson & Record<string, unknown> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return parseGlb(buf as ArrayBuffer).json as GltfJson & Record<string, unknown>;
}

describe('convertSpecGlossGlb (#216)', () => {
  it('converts spec/gloss factors → metal-rough and strips the extension', async () => {
    const bin = new Uint8Array([1, 2, 3, 4]);
    const result = await convertSpecGlossGlb(glbEntry(specGlossDoc(), bin));

    expect(result.converted).toBe(true);
    expect(result.extraFiles).toHaveLength(0); // GLB is self-contained

    const doc = reparse(result.entryBytes);
    const mat = (doc.materials as Record<string, unknown>[])[0];
    const pbr = mat.pbrMetallicRoughness as {
      baseColorFactor: number[];
      metallicFactor: number;
      roughnessFactor: number;
      baseColorTexture?: { index: number };
    };
    expect(pbr.metallicFactor).toBe(0); // low specular → dielectric
    expect(pbr.roughnessFactor).toBeCloseTo(0.6, 5); // 1 - glossiness 0.4
    expect(pbr.baseColorTexture).toEqual({ index: 0 }); // diffuseTexture → baseColorTexture
    // The required extension is gone (else GLTFLoader rejects the model).
    expect(mat.extensions).toBeUndefined();
    expect(doc.extensionsRequired).toBeUndefined();
    expect((doc.extensionsUsed as string[] | undefined) ?? []).not.toContain(SPEC_GLOSS);
  });

  it('preserves the BIN chunk through the repack', async () => {
    const bin = new Uint8Array([10, 20, 30, 40]);
    const result = await convertSpecGlossGlb(glbEntry(specGlossDoc(), bin));
    const buf = result.entryBytes.buffer.slice(
      result.entryBytes.byteOffset,
      result.entryBytes.byteOffset + result.entryBytes.byteLength,
    );
    const { bin: outBin } = parseGlb(buf as ArrayBuffer);
    expect(Array.from(outBin.slice(0, 4))).toEqual([10, 20, 30, 40]);
  });

  it('is a no-op for a metal-rough GLB (no spec/gloss)', async () => {
    const metalRough = {
      asset: { version: '2.0' },
      materials: [{ name: 'MR', pbrMetallicRoughness: { metallicFactor: 1 } }],
    };
    const result = await convertSpecGlossGlb(glbEntry(metalRough, new Uint8Array(0)));
    expect(result.converted).toBe(false);
  });

  it('leaves non-GLB bytes verbatim (converted:false)', async () => {
    const notGlb: IngestFile = {
      relativePath: 'model.glb',
      bytes: new TextEncoder().encode('{"asset":{"version":"2.0"}}'),
    };
    const result = await convertSpecGlossGlb(notGlb);
    expect(result.converted).toBe(false);
    expect(result.entryBytes).toBe(notGlb.bytes);
  });
});
