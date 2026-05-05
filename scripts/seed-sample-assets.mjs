#!/usr/bin/env node
// One-shot generator for the Asset Library's sample GLBs. Runs locally /
// in CI (`npm run seed:assets`); the resulting binaries are committed under
// `public/assets/`. Three primitive shapes (cube, sphere, cone) are enough
// to demo Library + drag-drop + ScatterNode in P1. Each is sub-2KB, MIT-
// licensed (we own them), and rebuildable from this script.
//
// Three.js' GLTFExporter requires a DOM `FileReader` only when emitting
// binary GLB. We emit JSON-encoded `.gltf` instead — drei's useGLTF accepts
// both. JSON-only path is dependency-free at runtime in Node ≥18.
//
// REF: THESIS.md §14, P1 Wave B (NEXT_SESSION.md).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

// GLTFExporter's data-URI path uses FileReader. Node has Blob globally but
// not FileReader. Tiny polyfill: synchronous-on-microtask readAsDataURL.
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
}
globalThis.FileReader = NodeFileReader;

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'public/assets');
mkdirSync(OUT_DIR, { recursive: true });

/** Build a Scene with a single named mesh, then export to GLB. */
async function exportPrimitive(name, geometry, color) {
  const scene = new THREE.Scene();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  scene.add(mesh);
  const exporter = new GLTFExporter();
  return await new Promise((resolveExport, rejectExport) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          rejectExport(new Error(`expected JSON for ${name}, got ArrayBuffer`));
          return;
        }
        resolveExport(Buffer.from(JSON.stringify(result)));
      },
      (err) => rejectExport(err),
      { binary: false },
    );
  });
}

const targets = [
  { name: 'cube', geometry: new THREE.BoxGeometry(1, 1, 1), color: '#5af07a' },
  { name: 'sphere', geometry: new THREE.SphereGeometry(0.6, 24, 16), color: '#7aaaff' },
  { name: 'cone', geometry: new THREE.ConeGeometry(0.6, 1.2, 24), color: '#ff8a5a' },
];

for (const t of targets) {
  const buf = await exportPrimitive(t.name, t.geometry, t.color);
  const out = resolve(OUT_DIR, `${t.name}.gltf`);
  writeFileSync(out, buf);
  console.log(`  wrote ${out} (${buf.byteLength} bytes)`);
}
console.log('✓ seed-sample-assets done');
