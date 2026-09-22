// Generate public/assets/mesh-parent.gltf — a mesh node that also holds children (#1152):
//
//   Body    mesh   T(0,1,0) · R(90° about Y) · S(2)       the parent that is BOTH a mesh and a parent
//   ├─ Lamp mesh   T(1,0.5,0) · S(0.25)                   a mesh under a mesh
//   └─ Socket      T(-1,0,0)                              an empty under a mesh
//      └─ Bulb mesh T(0,0.5,0) · S(0.2)                   a mesh under that empty
//
// Before #1152 the native import refused this whole file by name: an Object could not parent.
// Blender makes one object per node and parents object to object (`io_scene_gltf2/blender/imp/
// node.py:105-108`), so a child's world is its parent's world times its own local transform.
// The parent's rotation and scale are there so a reader that drops the parent's transform, or
// applies only its translation, lands somewhere measurably different.
//
// Geometry and material are nested-cube.gltf's cube, shared by all three meshes.
//
// Run: node scripts/gen-mesh-parent-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'public', 'assets');
const doc = JSON.parse(readFileSync(join(assets, 'nested-cube.gltf'), 'utf-8'));

const h = Math.SQRT1_2; // 90° about Y: [0, sin 45°, 0, cos 45°]
doc.nodes = [
  {
    name: 'Body',
    mesh: 0,
    translation: [0, 1, 0],
    rotation: [0, h, 0, h],
    scale: [2, 2, 2],
    children: [1, 2],
  },
  { name: 'Lamp', mesh: 0, translation: [1, 0.5, 0], scale: [0.25, 0.25, 0.25] },
  { name: 'Socket', translation: [-1, 0, 0], children: [3] },
  { name: 'Bulb', mesh: 0, translation: [0, 0.5, 0], scale: [0.2, 0.2, 0.2] },
];
doc.scenes = [{ nodes: [0] }];
doc.scene = 0;
doc.asset.generator = 'basher gen-mesh-parent-fixture';
writeFileSync(join(assets, 'mesh-parent.gltf'), JSON.stringify(doc));
console.log('wrote public/assets/mesh-parent.gltf');
