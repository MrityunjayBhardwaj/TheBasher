#!/usr/bin/env node
// Generator for the skinned-glTF e2e fixture (#88). Builds a minimal but
// loader-VALID skinned mesh — a 2-bone bar that bends when the upper bone
// rotates — and exports it as a binary `.glb` to `public/assets/`. The
// binary is committed; this script makes it reproducible (Chesterton).
//
// Why a generated fixture via three's own GLTFExporter (not hand-authored
// base64): the binary skin layout (JOINTS_0 ubyte VEC4, WEIGHTS_0 float VEC4,
// skins[].inverseBindMatrices MAT4, the joints[] index list) is error-prone by
// hand, and a malformed skin makes GLTFLoader silently build a plain Mesh —
// then there is nothing to deform and #88's bug is untestable. Exporting from
// a real THREE.SkinnedMesh + Skeleton guarantees a loader-valid file.
//
// Geometry: a thin bar along +Y from y=0 to y=2, six vertices in three rows.
//   row y=0 (verts 0,1) and y=1 (verts 2,3) → weighted to Bone0 (the base).
//   row y=2 (verts 4,5) → weighted to Bone1 (the tip).
// Bone1 sits at (0,1,0) and the animation rotates it about Z over t∈[0,1], so
// the tip row swings — vertex 4/5 is the far-end vertex the e2e samples.
//
// Output: public/assets/skinned-bar.glb  (single binary buffer, no external
// .bin — V21: tracked, prettier-exempt via the public/assets/*.glb rule).
//
// Run: `node scripts/gen-skinned-fixture.mjs` (or via npm run seed:assets if wired).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

// GLTFExporter touches FileReader on some paths; Node lacks it. Same tiny
// polyfill the sample-asset seeder uses (scripts/seed-sample-assets.mjs:21).
class NodeFileReader {
  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        this.result = `data:application/octet-stream;base64,${b64}`;
        this.onload?.();
        this.onloadend?.();
      })
      .catch((err) => {
        this.onerror?.(err);
        this.onloadend?.();
      });
  }

  // Binary GLB export reads the blob as an ArrayBuffer (GLTFExporter.js:582).
  readAsArrayBuffer(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = buf;
        this.onload?.();
        this.onloadend?.();
      })
      .catch((err) => {
        this.onerror?.(err);
        this.onloadend?.();
      });
  }
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'public/assets');
mkdirSync(OUT_DIR, { recursive: true });

// The far-end vertex the deform e2e samples (fully weighted to Bone1).
export const TIP_VERTEX_INDEX = 4;

function buildSkinnedBar() {
  // --- geometry: 6 vertices in 3 rows along +Y ---
  const positions = new Float32Array([
    -0.2,
    0,
    0,
    0.2,
    0,
    0, // row y=0  → Bone0  (verts 0,1)
    -0.2,
    1,
    0,
    0.2,
    1,
    0, // row y=1  → Bone0  (verts 2,3)
    -0.2,
    2,
    0,
    0.2,
    2,
    0, // row y=2  → Bone1  (verts 4,5)
  ]);
  // JOINTS_0 / WEIGHTS_0 — each vertex bound 100% to one bone.
  const skinIndices = new Uint16Array([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // verts 0,1 → bone 0
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // verts 2,3 → bone 0
    1,
    0,
    0,
    0,
    1,
    0,
    0,
    0, // verts 4,5 → bone 1
  ]);
  const skinWeights = new Float32Array([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
  ]);
  // two quads (bottom + top) → 4 triangles
  const indices = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // --- skeleton: Bone0 (base) → Bone1 (tip), Bone1 local at (0,1,0) ---
  const bone0 = new THREE.Bone();
  bone0.name = 'Bone0';
  const bone1 = new THREE.Bone();
  bone1.name = 'Bone1';
  bone1.position.set(0, 1, 0);
  bone0.add(bone1);

  const mat = new THREE.MeshStandardMaterial({ color: '#f0a85a', roughness: 0.6, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(geometry, mat);
  mesh.name = 'SkinnedBar';
  mesh.add(bone0);
  mesh.updateMatrixWorld(true); // bones get world matrices before inverse calc
  const skeleton = new THREE.Skeleton([bone0, bone1]); // computes boneInverses now
  mesh.bind(skeleton);

  // --- animation: rotate Bone1 about Z, 0 → ~85° over t∈[0,1] ---
  const q0 = new THREE.Quaternion(); // identity
  const q1 = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    (85 * Math.PI) / 180,
  );
  const track = new THREE.QuaternionKeyframeTrack(
    'Bone1.quaternion',
    [0, 1],
    [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w],
  );
  const clip = new THREE.AnimationClip('bend', 1, [track]);

  return { mesh, clip };
}

async function main() {
  const { mesh, clip } = buildSkinnedBar();
  const exporter = new GLTFExporter();
  const ab = await new Promise((res, rej) => {
    exporter.parse(
      mesh,
      (result) => {
        if (!(result instanceof ArrayBuffer)) {
          rej(new Error('expected ArrayBuffer for binary GLB export'));
          return;
        }
        res(result);
      },
      (err) => rej(err),
      { binary: true, animations: [clip] },
    );
  });
  const out = resolve(OUT_DIR, 'skinned-bar.glb');
  writeFileSync(out, Buffer.from(ab));
  console.log(
    `wrote ${out} (${ab.byteLength} bytes); tip vertex index = ${TIP_VERTEX_INDEX} (weighted to Bone1)`,
  );
}

main().catch((err) => {
  console.error('gen-skinned-fixture failed:', err);
  process.exit(1);
});
