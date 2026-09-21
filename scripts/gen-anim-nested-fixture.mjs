// Generate public/assets/anim-nested.gltf — nested-cube.gltf (a cube at (1,0,0) under an empty
// "Pivot" at (0,3,0)) with ONE clip that uses every interpolation on every path (#1051):
//
//   Pivot  translation LINEAR       (0,3,0) → (0,4,0)                t = 0, 2
//          rotation    STEP         id → 90° about Z → id            t = 0, 1, 2
//   Cube   rotation    LINEAR       id → 170° about (1,1,0) → 90° Z  t = 0, 1, 2  (slerp and a
//                                   component lerp part by 7°+ here)
//          scale       STEP         1 → 2 → 1                        t = 0, 1, 2
//          translation CUBICSPLINE  tangents far from any auto handle, unequal spans t = 0, 0.5, 2
//
// The same clip was measured through Blender 4.5.9 and 5.1.1's own importer (#1051 Stage B).
// Refusal variants (a CUBICSPLINE rotation, a second clip) are built from this file in the tests.
//
// Run: node scripts/gen-anim-nested-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'public', 'assets');
const doc = JSON.parse(readFileSync(join(assets, 'nested-cube.gltf'), 'utf-8'));
const prefix = 'data:application/octet-stream;base64,';
const bytes = [...Buffer.from(doc.buffers[0].uri.slice(prefix.length), 'base64')];

/** Append float32 data as a new view + accessor; returns the accessor index. */
function add(floats, type) {
  while (bytes.length % 4) bytes.push(0);
  const byteOffset = bytes.length;
  const buf = Buffer.alloc(floats.length * 4);
  floats.forEach((f, i) => buf.writeFloatLE(f, i * 4));
  bytes.push(...buf);
  doc.bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length });
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const accessor = {
    bufferView: doc.bufferViews.length - 1,
    componentType: 5126,
    count: floats.length / width,
    type,
  };
  if (type === 'SCALAR')
    Object.assign(accessor, { min: [Math.min(...floats)], max: [Math.max(...floats)] });
  doc.accessors.push(accessor);
  return doc.accessors.length - 1;
}

/** A unit quaternion [x, y, z, w] of `deg` about `axis`. */
function axisAngle(axis, deg) {
  const l = Math.hypot(...axis);
  const h = (deg * Math.PI) / 360;
  return [...axis.map((a) => (a / l) * Math.sin(h)), Math.cos(h)];
}

const cube = doc.nodes.findIndex((n) => n.name === 'Cube');
const pivot = doc.nodes.findIndex((n) => n.name === 'Pivot');
const t2 = add([0, 2], 'SCALAR');
const t3 = add([0, 1, 2], 'SCALAR');
const tc = add([0, 0.5, 2], 'SCALAR');
// CUBICSPLINE: per key [in-tangent, value, out-tangent], tangents in units per second.
const cubic = [
  [
    [0, 0, 0],
    [1, 0, 0],
    [6, 5, -3],
  ],
  [
    [8, -6, 2],
    [2, 1, 0],
    [-4, 7, 1],
  ],
  [
    [-5, 4, 9],
    [1, 0, 1],
    [0, 0, 0],
  ],
].flat(2);

const samplers = [];
const channels = [];
function channel(node, path, input, output, interpolation) {
  samplers.push({ input, output, interpolation });
  channels.push({ sampler: samplers.length - 1, target: { node, path } });
}
channel(pivot, 'translation', t2, add([0, 3, 0, 0, 4, 0], 'VEC3'), 'LINEAR');
channel(
  pivot,
  'rotation',
  t3,
  add(
    [...axisAngle([0, 0, 1], 0), ...axisAngle([0, 0, 1], 90), ...axisAngle([0, 0, 1], 0)],
    'VEC4',
  ),
  'STEP',
);
channel(
  cube,
  'rotation',
  t3,
  add(
    [...axisAngle([0, 1, 0], 0), ...axisAngle([1, 1, 0], 170), ...axisAngle([0, 0, 1], 90)],
    'VEC4',
  ),
  'LINEAR',
);
channel(cube, 'scale', t3, add([1, 1, 1, 2, 2, 2, 1, 1, 1], 'VEC3'), 'STEP');
channel(cube, 'translation', tc, add(cubic, 'VEC3'), 'CUBICSPLINE');
doc.animations = [{ name: 'Spin', samplers, channels }];

while (bytes.length % 4) bytes.push(0);
doc.buffers[0] = { byteLength: bytes.length, uri: prefix + Buffer.from(bytes).toString('base64') };
doc.asset.generator = 'basher gen-anim-nested-fixture';
writeFileSync(join(assets, 'anim-nested.gltf'), JSON.stringify(doc));
console.log('wrote public/assets/anim-nested.gltf');
