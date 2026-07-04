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
import zlib from 'node:zlib';

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
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }],
    },
    {
      name: 'SGCombinedQuad',
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 1 }],
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
    {
      bufferView: 0,
      componentType: 5126,
      count: 4,
      type: 'VEC3',
      min: [-0.5, -0.5, 0],
      max: [0.5, 0.5, 0],
    },
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

/** Pack a glTF JSON + BIN into GLB bytes (glTF 2.0 §4.4): header | JSON chunk
 *  (space-padded) | BIN chunk (zero-padded). */
function packGlb(jsonObj, binBytes) {
  const jb = new TextEncoder().encode(JSON.stringify(jsonObj));
  const pad = (n) => (4 - (n % 4)) % 4;
  const jLen = jb.byteLength + pad(jb.byteLength);
  const bLen = binBytes.byteLength + pad(binBytes.byteLength);
  const total = 12 + 8 + jLen + 8 + bLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let c = 12;
  dv.setUint32(c, jLen, true);
  dv.setUint32(c + 4, 0x4e4f534a, true); // 'JSON'
  out.set(jb, c + 8);
  out.fill(0x20, c + 8 + jb.byteLength, c + 8 + jLen);
  c += 8 + jLen;
  dv.setUint32(c, bLen, true);
  dv.setUint32(c + 4, 0x004e4942, true); // 'BIN\0'
  out.set(binBytes, c + 8);
  return out;
}

const dielectric = packGlb(json, bin);
writeFileSync(join(assets, 'specgloss-quad.glb'), dielectric);
console.log(
  `wrote specgloss-quad.glb (${dielectric.byteLength} bytes; BIN ${bin.byteLength}, image @${imageOffset}+${pngBytes.byteLength})`,
);

// ── Metal variant (#218): a SOLID-GOLD combined specularGlossinessTexture (the
// tint lives in the SPECULAR channel, diffuse is black) → the conversion solves
// to a metal and bakes a base-color map from the specular. Encodes a tiny solid
// PNG so the metallic solve is deterministic (no reliance on the reused image). ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** Encode a solid w×h RGBA PNG (8-bit, color type 6). */
function solidPng(w, h, [r, g, b, a]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const goldPng = new Uint8Array(solidPng(4, 4, [255, 200, 80, 255])); // gold, opaque
const metalBin = new Uint8Array(geomBytes.byteLength + goldPng.byteLength);
metalBin.set(geomBytes, 0);
metalBin.set(goldPng, geomBytes.byteLength);
const metalJson = {
  asset: { version: '2.0', generator: 'basher-specgloss-glb-metal-fixture' },
  extensionsUsed: ['KHR_materials_pbrSpecularGlossiness'],
  extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'SGMetalQuad' }],
  meshes: [
    {
      name: 'SGMetalQuad',
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }],
    },
  ],
  materials: [
    {
      name: 'SGMetal',
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseFactor: [0, 0, 0, 1], // black diffuse — the tint is in specular
          specularGlossinessTexture: { index: 0 },
          specularFactor: [1, 1, 1],
          glossinessFactor: 0.9,
        },
      },
    },
  ],
  images: [{ bufferView: 3, mimeType: 'image/png' }],
  textures: [{ sampler: 0, source: 0 }],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
  accessors: json.accessors,
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 48 },
    { buffer: 0, byteOffset: 48, byteLength: 32 },
    { buffer: 0, byteOffset: 80, byteLength: 12 },
    { buffer: 0, byteOffset: geomBytes.byteLength, byteLength: goldPng.byteLength },
  ],
  buffers: [{ byteLength: metalBin.byteLength }],
};
const metal = packGlb(metalJson, metalBin);
writeFileSync(join(assets, 'specgloss-metal-quad.glb'), metal);
console.log(
  `wrote specgloss-metal-quad.glb (${metal.byteLength} bytes; gold PNG ${goldPng.byteLength})`,
);
