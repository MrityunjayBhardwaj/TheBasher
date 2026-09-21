// Generate public/assets/anim-cubic-rot.gltf — nested-cube.gltf with ONE clip whose ROTATION is
// sampled CUBICSPLINE (#1157):
//
//   Cube   rotation    CUBICSPLINE  tangents far from any automatic handle, unequal spans
//                                   t = 0, 0.4, 1.5
//
// A rotation sampled this way is the one thing the native import used to refuse, because a
// quaternion channel had nowhere to hold the file's tangents. The spec defines the curve as a
// Hermite over the four components, normalized afterwards (Appendix C.5, `:3615-3638`, `:3628`),
// which is not the arc a slerp draws — so a reader that quietly slerped these keys, or dropped
// the tangents the way Blender's importer does (`animation_node.py:67-69`), lands somewhere else.
// The tangents below are chosen to make that difference large enough to see on screen.
//
// Only the cube rotates here: the pivot holds still, so the drawn matrix isolates the rotation.
//
// Run: node scripts/gen-anim-cubic-rot-fixture.mjs

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
const times = [0, 0.4, 1.5];
// Per key, in the spec's order: [in-tangent, value, out-tangent], tangents per second. The first
// in-tangent and the last out-tangent are the ones the spec leaves unused (`:3638`).
const keys = [
  [[0, 0, 0, 0], axisAngle([0, 1, 0], 0), [0.8, 0.4, -0.2, 0.6]],
  [[0.3, -0.9, 0.2, 0.4], axisAngle([0, 1, 0], 45), [-0.25, 0.7, 0.45, 0.1]],
  [[-0.7, 0.25, 0.8, -0.3], axisAngle([1, 1, 1], 120), [0, 0, 0, 0]],
].flat(2);

const samplers = [
  { input: add(times, 'SCALAR'), output: add(keys, 'VEC4'), interpolation: 'CUBICSPLINE' },
];
const channels = [{ sampler: 0, target: { node: cube, path: 'rotation' } }];
doc.animations = [{ name: 'SplineSpin', samplers, channels }];

while (bytes.length % 4) bytes.push(0);
doc.buffers[0] = { byteLength: bytes.length, uri: prefix + Buffer.from(bytes).toString('base64') };
doc.asset.generator = 'basher gen-anim-cubic-rot-fixture';
writeFileSync(join(assets, 'anim-cubic-rot.gltf'), JSON.stringify(doc));
console.log('wrote public/assets/anim-cubic-rot.gltf');
