// Generate public/assets/orphan-material-quad.gltf — a textured quad whose single
// mesh primitive has NO `material`, while the file DEFINES one textured material
// (M_Orphan) that no primitive references. This reproduces the 3dripper export bug
// (#221): a spec-compliant viewer renders the DEFAULT white material, so the model
// imports untextured until the ingest rebind binds the orphan to the unbound prim.
//
// Reuses specgloss-quad.gltf's geometry buffer + PNG image so the fixture is a
// minimal, self-contained (data-URI) quad.
//
// Run: node scripts/gen-orphan-material-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'public', 'assets');
const src = JSON.parse(readFileSync(join(assets, 'specgloss-quad.gltf'), 'utf-8'));

const doc = {
  asset: { version: '2.0', generator: 'basher gen-orphan-material-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'OrphanQuad' }],
  meshes: [
    {
      name: 'OrphanQuad',
      // The bug: a primitive with geometry + UVs but NO `material` reference.
      primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }],
    },
  ],
  materials: [
    {
      name: 'M_Orphan',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        baseColorFactor: [1, 1, 1, 1],
      },
    },
  ],
  textures: [{ sampler: 0, source: 0 }],
  images: [{ uri: src.images[0].uri }],
  samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
  buffers: [{ uri: src.buffers[0].uri, byteLength: src.buffers[0].byteLength }],
  bufferViews: src.bufferViews,
  accessors: src.accessors,
};

const out = join(assets, 'orphan-material-quad.gltf');
writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(`wrote ${out} (${JSON.stringify(doc).length} bytes)`);
