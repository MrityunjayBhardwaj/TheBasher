// Generate public/assets/specgloss-quad.glb — the binary-container twin of
// specgloss-quad.gltf, for the #216 spec/gloss `.glb` ingest conversion e2e.
//
// The crucial difference from the .gltf fixture (which embeds its image as a
// data: URI): here the combined specularGlossinessTexture is stored as a
// bufferView image INSIDE the embedded BIN chunk — the realistic GLB case that
// exercises convertSpecGlossGlb's bufferView image resolver (resolveGlbTextureBytes).
//
// Two materials mirror the .gltf fixture:
//   SGDiffuse  — diffuseTexture + factors (the common case)
//   SGCombined — a combined specularGlossinessTexture (the per-texel bake)
// Both reference the SAME bufferView image (source 0) — enough to drive the
// canvas bake + render parity; the e2e asserts the captured IR == the clone.
//
// Run: node scripts/gen-specgloss-glb-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'public', 'assets');

// Reuse the geometry + image bytes from the .gltf fixture so the two fixtures
// are byte-equivalent content in different containers.
const gltf = JSON.parse(readFileSync(join(assets, 'specgloss-quad.gltf'), 'utf-8'));

function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  const meta = uri.slice('data:'.length, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));
  return new Uint8Array(Buffer.from(decodeURIComponent(payload), 'latin1'));
}

const geomBytes = decodeDataUri(gltf.buffers[0].uri); // 92 bytes: pos|uv|idx
const pngBytes = decodeDataUri(gltf.images[0].uri); // the 64×64 PNG

if (geomBytes.byteLength % 4 !== 0) throw new Error('geometry not 4-aligned');
const imageOffset = geomBytes.byteLength;
const bin = new Uint8Array(imageOffset + pngBytes.byteLength);
bin.set(geomBytes, 0);
bin.set(pngBytes, imageOffset);

const json = {
  asset: { version: '2.0', generator: 'basher-specgloss-glb-fixture' },
  extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
  extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    { mesh: 0, name: 'SGDiffuseQuad' },
    { mesh: 1, name: 'SGCombinedQuad' },
  ],
  meshes: [
    {
      name: 'SGDiffuseQuad',
      primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 },
      ],
    },
    {
      name: 'SGCombinedQuad',
      primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 1 },
      ],
    },
  ],
  materials: [
    {
      name: 'SGDiffuse',
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseFactor: [1, 1, 1, 1],
          diffuseTexture: { index: 0 },
          specularFactor: [0, 0, 0], // dielectric → metallic 0
          glossinessFactor: 0.4,
        },
      },
    },
    {
      name: 'SGCombined',
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseFactor: [1, 1, 1, 1],
          specularGlossinessTexture: { index: 1 },
          specularFactor: [1, 1, 1],
          glossinessFactor: 1,
        },
      },
    },
  ],
  // image 0 is a bufferView image in the embedded BIN (the GLB-realistic case).
  images: [{ bufferView: 3, mimeType: 'image/png' }],
  textures: [
    { sampler: 0, source: 0 },
    { sampler: 0, source: 0 },
  ],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2', min: [0, 0], max: [1, 1] },
    { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 48 },
    { buffer: 0, byteOffset: 48, byteLength: 32 },
    { buffer: 0, byteOffset: 80, byteLength: 12 },
    { buffer: 0, byteOffset: imageOffset, byteLength: pngBytes.byteLength },
  ],
  buffers: [{ byteLength: bin.byteLength }],
};

// Pack the GLB (glTF 2.0 §4.4): header | JSON chunk (space-padded) | BIN chunk.
const enc = new TextEncoder();
const jsonBytes = enc.encode(JSON.stringify(json));
const pad = (n) => (4 - (n % 4)) % 4;
const jsonChunkLen = jsonBytes.byteLength + pad(jsonBytes.byteLength);
const binChunkLen = bin.byteLength + pad(bin.byteLength);
const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

const out = new Uint8Array(total);
const dv = new DataView(out.buffer);
dv.setUint32(0, 0x46546c67, true); // 'glTF'
dv.setUint32(4, 2, true);
dv.setUint32(8, total, true);
let c = 12;
dv.setUint32(c, jsonChunkLen, true);
dv.setUint32(c + 4, 0x4e4f534a, true); // 'JSON'
out.set(jsonBytes, c + 8);
out.fill(0x20, c + 8 + jsonBytes.byteLength, c + 8 + jsonChunkLen); // space pad
c += 8 + jsonChunkLen;
dv.setUint32(c, binChunkLen, true);
dv.setUint32(c + 4, 0x004e4942, true); // 'BIN\0'
out.set(bin, c + 8);
// (BIN tail already zero from Uint8Array init)

const target = join(assets, 'specgloss-quad.glb');
writeFileSync(target, out);
console.log(`wrote ${target} (${out.byteLength} bytes; BIN ${bin.byteLength}, image @${imageOffset}+${pngBytes.byteLength})`);
