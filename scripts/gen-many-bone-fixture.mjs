#!/usr/bin/env node
// Generator for the MANY-BONE glTF fixture (#91 Wave E / D-05 DAG-explosion
// observation). The 2-bone skinned-bar.glb cannot reveal the node-flood cost a
// real Mixamo-style character incurs: P7.7 materializes one GltfChild DAG node
// per scene child, so a ~65-bone humanoid rig becomes ~65 addNodes + ~65
// outliner rows + a save-size bump. This fixture is a single SkinnedMesh skinned
// to a deep chain of bones (a serpentine "spine") so the drop produces a
// realistic node count to OBSERVE (not a hand-counted guess).
//
// Mirrors gen-skinned-fixture.mjs (Chesterton — same NodeFileReader polyfill,
// same GLTFExporter binary path, same public/assets output). The bone count is
// a CLI arg (default 64) so the observation can be re-run at other scales.
//
// Output: public/assets/many-bone-rig.glb  (single binary buffer, V21 tracked).
// Run: `node scripts/gen-many-bone-fixture.mjs [boneCount]`

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

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

const BONE_COUNT = Math.max(2, Number(process.argv[2] ?? 64));

function buildManyBoneRig(boneCount) {
  // A tall ribbon along +Y: boneCount rows of 2 verts, each row weighted to its
  // own bone. Vertices follow the bone chain so a per-bone rotation deforms.
  const positions = [];
  const skinIndices = [];
  const skinWeights = [];
  const indices = [];
  for (let i = 0; i < boneCount; i++) {
    positions.push(-0.2, i, 0, 0.2, i, 0);
    skinIndices.push(i, 0, 0, 0, i, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0, 1, 0, 0, 0);
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(skinIndices), 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(skinWeights), 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // A serpentine bone chain: bone0 at origin, each child offset +1 in local Y.
  const bones = [];
  for (let i = 0; i < boneCount; i++) {
    const b = new THREE.Bone();
    b.name = `Bone_${String(i).padStart(2, '0')}`;
    if (i > 0) {
      b.position.set(0, 1, 0);
      bones[i - 1].add(b);
    }
    bones.push(b);
  }

  const mat = new THREE.MeshStandardMaterial({ color: '#7aa6f0', roughness: 0.6, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(geometry, mat);
  mesh.name = 'ManyBoneRibbon';
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);

  // A simple wave clip so the rig animates (mid bones rotate about Z).
  const tracks = [];
  for (let i = 1; i < boneCount; i += 4) {
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 12);
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bones[i].name}.quaternion`,
        [0, 1],
        [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w],
      ),
    );
  }
  const clip = new THREE.AnimationClip('wave', 1, tracks);
  return { mesh, clip };
}

async function main() {
  const { mesh, clip } = buildManyBoneRig(BONE_COUNT);
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
  const out = resolve(OUT_DIR, 'many-bone-rig.glb');
  writeFileSync(out, Buffer.from(ab));
  // scene nodes = boneCount bones + 1 SkinnedMesh.
  console.log(
    `wrote ${out} (${ab.byteLength} bytes); ${BONE_COUNT} bones + 1 mesh = ${BONE_COUNT + 1} scene nodes`,
  );
}

main().catch((err) => {
  console.error('gen-many-bone-fixture failed:', err);
  process.exit(1);
});
