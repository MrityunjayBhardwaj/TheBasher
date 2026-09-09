// The two-UV fixture must actually carry two DIFFERENT UV sets, and its control must not.
//
// 🔴 THIS GATE EXISTS BECAUSE THE ONLY PRE-EXISTING "SECOND UV SET" ASSET DOES NOT HAVE ONE.
// `sheen-quad.gltf` declares `TEXCOORD_1` pointing at accessor 1 — the SAME accessor as
// `TEXCOORD_0` — and its material declares no textures at all. It trips the importer's
// `'secondary UV set (TEXCOORD_1+)'` notice by ATTRIBUTE NAME while carrying nothing a second
// set could be told apart by, so anything asserted against it passes identically with the
// feature absent. A fixture that cannot discriminate is not a fixture; this gate is what stops
// these two from decaying into that.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectUnsupportedGltfFeatures } from './gltfImportChain';

const ASSETS = path.resolve(__dirname, '../../../public/assets');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ASSETS, f), 'utf8'));

// 🔴 DECODED FROM THE JSON RATHER THAN LOADED THROUGH `GLTFLoader`, AND THE REASON IS MEASURED:
// the loader HANGS in node on any asset whose material references a texture — it waits on an
// image decode that never resolves headless (observed as a 5 s timeout here, and on
// `albedo-textured-quad.gltf` before that, while texture-free `sheen-quad.gltf` parses fine).
// The texture is load-bearing for this fixture, so the gate reads the accessors itself. What
// the loader would add — that `TEXCOORD_1` surfaces as `uv1` — is a three.js mapping
// (`GLTFLoader.js:2228`), not a property of these files, and belongs to a browser test.
function uvSetsOf(file: string): { readonly uv0: number[]; readonly uv1: number[] | null } {
  const json = read(file);
  const attrs = json.meshes[0].primitives[0].attributes as Record<string, number>;
  const decode = (accessorIndex: number): number[] => {
    const a = json.accessors[accessorIndex];
    const bv = json.bufferViews[a.bufferView];
    const uri: string = json.buffers[bv.buffer ?? 0].uri;
    const bin = Buffer.from(uri.slice(uri.indexOf('base64,') + 7), 'base64');
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const out: number[] = [];
    for (let i = 0; i < a.count * 2; i++)
      out.push(dv.getFloat32((bv.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * 4, true));
    return out;
  };
  return {
    uv0: decode(attrs.TEXCOORD_0),
    uv1: attrs.TEXCOORD_1 === undefined ? null : decode(attrs.TEXCOORD_1),
  };
}

describe('the two-UV fixture is real', () => {
  it('the subject carries two UV sets and they DIFFER at every vertex', () => {
    const { uv0, uv1 } = uvSetsOf('two-uv-quad.gltf');
    expect(uv1).not.toBeNull();
    expect(uv0).toHaveLength(8);
    expect(uv1).toHaveLength(8);
    // The two sets must also be backed by DIFFERENT accessors — `sheen-quad.gltf` points both
    // names at accessor 1, which is the exact decay this gate exists to catch.
    const attrs = read('two-uv-quad.gltf').meshes[0].primitives[0].attributes;
    expect(attrs.TEXCOORD_1).not.toBe(attrs.TEXCOORD_0);
    // Not merely "not deep-equal" — no vertex may share a value, or a renderer binding the
    // wrong set could still look right at some corner and the fixture would under-report.
    for (let v = 0; v < 4; v++)
      expect([uv0[v * 2], uv0[v * 2 + 1]]).not.toEqual([uv1![v * 2], uv1![v * 2 + 1]]);
  });

  it('the subject binds its base-colour map to TEXCOORD_1, the control to the default', () => {
    const subj = read('two-uv-quad.gltf');
    const ctrl = read('one-uv-quad.gltf');
    expect(subj.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord).toBe(1);
    // Absent, not 0 — glTF's default. A fixture that spells the default explicitly would not
    // exercise the "no texCoord stated" path the importer actually takes for every other asset.
    expect(ctrl.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord).toBeUndefined();
  });

  it('the CONTROL carries exactly one UV set — so a passing assertion means something', () => {
    const { uv0, uv1 } = uvSetsOf('one-uv-quad.gltf');
    expect(uv0).toHaveLength(8);
    expect(uv1).toBeNull();
  });

  it('the importer flags the subject and stays silent on the control', () => {
    expect(detectUnsupportedGltfFeatures(read('two-uv-quad.gltf'))).toContain(
      'secondary UV set (TEXCOORD_1+)',
    );
    expect(detectUnsupportedGltfFeatures(read('one-uv-quad.gltf'))).not.toContain(
      'secondary UV set (TEXCOORD_1+)',
    );
  });
});
