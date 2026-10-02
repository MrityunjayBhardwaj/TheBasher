#!/usr/bin/env node
// Generator for the more-than-four-influences fixture (#1430).
//
// A stored mesh holds every bone influence its file states, so a glTF vertex with a second joint
// set (`JOINTS_1` / `WEIGHTS_1`) has to arrive whole. three's GLTFExporter writes one set only, so
// this file is written by hand: one buffer, six joints, four vertices.
//
//   Root at the origin, never animated; B1…B5 its children at x = 0.5, 1.0, … 2.5, y = 1.
//   Each Bk turns about Z from 0 to k·15° over t ∈ [0, 1], linear — five different motions, so a
//   reader that drops any one influence moves the vertex somewhere measurably else.
//
//   v0 (0, 2, 0)  FIVE bones:  B1 .30  B2 .25  B3 .20  B4 .15 | B5 .10
//   v1 (1, 2, 0)  SIX bones:   Root .10  B1 .20  B2 .20  B3 .20 | B4 .20  B5 .10
//   v2 (0, 0, 0)  Root 1
//   v3 (1, 0, 0)  B5 1
//
// (`|` is where set 0 ends and set 1 begins.)
//
// Output: public/assets/skinned-many-influences.glb
// Run:    node scripts/gen-many-influence-fixture.mjs

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../public/assets/skinned-many-influences.glb',
);

const bonePositions = [
  [0, 0, 0],
  [0.5, 1, 0],
  [1.0, 1, 0],
  [1.5, 1, 0],
  [2.0, 1, 0],
  [2.5, 1, 0],
];

const chunks = [];
let offset = 0;
const bufferViews = [];
const accessors = [];
function add(typed, type, componentType, extra = {}) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  chunks.push(bytes, Buffer.alloc(pad));
  offset += bytes.length + pad;
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType,
    count: typed.length / width,
    type,
    ...extra,
  });
  return accessors.length - 1;
}
const FLOAT = 5126;
const USHORT = 5123;
const UBYTE = 5121;

const POSITION = add(new Float32Array([0, 2, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0]), 'VEC3', FLOAT, {
  min: [0, 0, 0],
  max: [1, 2, 0],
});
const NORMAL = add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3', FLOAT);
// prettier-ignore
const JOINTS_0 = add(new Uint8Array([1, 2, 3, 4,  0, 1, 2, 3,  0, 0, 0, 0,  5, 0, 0, 0]), 'VEC4', UBYTE);
// prettier-ignore
const WEIGHTS_0 = add(new Float32Array([0.3, 0.25, 0.2, 0.15,  0.1, 0.2, 0.2, 0.2,  1, 0, 0, 0,  1, 0, 0, 0]), 'VEC4', FLOAT);
// prettier-ignore
const JOINTS_1 = add(new Uint8Array([5, 0, 0, 0,  4, 5, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0]), 'VEC4', UBYTE);
// prettier-ignore
const WEIGHTS_1 = add(new Float32Array([0.1, 0, 0, 0,  0.2, 0.1, 0, 0,  0, 0, 0, 0,  0, 0, 0, 0]), 'VEC4', FLOAT);
const INDICES = add(new Uint16Array([0, 2, 3, 0, 3, 1]), 'SCALAR', USHORT);

// Inverse bind: each bone's world is a translation (Root at the origin, the rest its children).
const inverseBind = new Float32Array(16 * bonePositions.length);
bonePositions.forEach(([x, y, z], j) => {
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], j * 16);
});
const IBM = add(inverseBind, 'MAT4', FLOAT);

const TIMES = add(new Float32Array([0, 1]), 'SCALAR', FLOAT, { min: [0], max: [1] });
const samplers = [];
const channels = [];
for (let k = 1; k <= 5; k++) {
  const half = (k * 15 * Math.PI) / 360;
  const output = add(
    new Float32Array([0, 0, 0, 1, 0, 0, Math.sin(half), Math.cos(half)]),
    'VEC4',
    FLOAT,
  );
  samplers.push({ input: TIMES, output, interpolation: 'LINEAR' });
  // Node k + 1: node 0 is the mesh, node 1 the Root.
  channels.push({ sampler: samplers.length - 1, target: { node: k + 1, path: 'rotation' } });
}

const json = {
  asset: { version: '2.0', generator: 'basher gen-many-influence-fixture' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    { name: 'Fan', mesh: 0, skin: 0 },
    { name: 'Root', children: [2, 3, 4, 5, 6] },
    ...bonePositions.slice(1).map((translation, i) => ({ name: `B${i + 1}`, translation })),
  ],
  meshes: [
    {
      name: 'Fan',
      primitives: [
        {
          attributes: { POSITION, NORMAL, JOINTS_0, WEIGHTS_0, JOINTS_1, WEIGHTS_1 },
          indices: INDICES,
        },
      ],
    },
  ],
  skins: [{ joints: [1, 2, 3, 4, 5, 6], inverseBindMatrices: IBM, skeleton: 1 }],
  animations: [{ name: 'fan', samplers, channels }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: offset }],
};

const jsonBytes = Buffer.from(JSON.stringify(json));
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
const binChunk = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(
  OUT,
  Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, 0x4e4f534a),
    jsonChunk,
    chunkHeader(binChunk.length, 0x004e4942),
    binChunk,
  ]),
);
console.log(`wrote ${OUT} (${12 + 16 + jsonChunk.length + binChunk.length} bytes)`);
