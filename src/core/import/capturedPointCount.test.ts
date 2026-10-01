// #1040 — the point count an import captures, against the buffer the READ DOOR actually holds.
//
// ── WHY THE ORACLE IS THE REAL LOADER AND NOT A FIXTURE OF MY OWN ────────────────────────
//
// The number this capture writes was compared, downstream, against `weldByPosition` of the
// geometry a reader got from the mounted clone. Since #1053 nothing draws the clone, but the
// load converter rebuilds a saved clone import and diffs every param against the save, so the
// capture must still write what it always wrote. The oracle stays the geometry the clone road
// read, produced by the same `GLTFLoader` the app uses. Both sides weld through
// PRODUCTION's `weldByPosition` rather than through two spellings of it — an earlier probe for
// this work hashed coordinates itself and split a sphere's seam column on negative zero, which
// is exactly the disagreement this file exists to rule out.
//
// ── THE ROWS ─────────────────────────────────────────────────────────────────────────────
//
//   1  every fixture child the loader can parse: captured === the read door's weld
//   2  the refusal census — WHICH children get no count, each for a named reason, with the
//      denominator printed, so a shrinking capture population cannot pass as a clean run
//   3  a multi-primitive child is refused, and the falsifier shows why it must be: with
//      DISJOINT primitives the door and a unioning capture genuinely disagree
//   4  absence is not zero
//   5  (retired in #1053: `pointCountOf` read it off the `gltf` descriptor, which is gone)
//
// REF: src/core/import/gltfImportChain.ts (`captureChildPointCount`); src/app/pointIdentity.ts
//      (`pointCountOf`, `weldByPosition`); src/app/importedMeshParity.gate.test.ts (the
//      scoreboard this moved); issue #1040, and #1023/#1025 for the face-count sibling.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLTFLoader } from 'three-stdlib';
import * as THREE from 'three';
import { parseGltfContainer, resolveBuffers, type GltfJson } from './glb';
import { captureChildPointCount } from './gltfImportChain';
import { weldByPosition } from '../../app/pointIdentity';

function fixtureBuffer(name: string): ArrayBuffer {
  const n = readFileSync(resolve(process.cwd(), `public/assets/${name}`));
  return n.buffer.slice(n.byteOffset, n.byteOffset + n.byteLength) as ArrayBuffer;
}

function fixtureNames(): string[] {
  return readdirSync(resolve(process.cwd(), 'public/assets')).filter((f) =>
    /\.(gltf|glb)$/.test(f),
  );
}

/**
 * The app's own loader, BOUNDED — because a textured fixture never settles in node, which has
 * no image decoder. That is a property of this harness and not of the file, and the bound is
 * short on purpose: every fixture that CAN parse does so in single-digit milliseconds, so a
 * generous timeout buys nothing and multiplies across the seven that cannot. Row 1 asserts its
 * own denominator, so a bound set too low to load anything fails loudly rather than quietly
 * reporting a clean run over nothing.
 */
async function loadScene(name: string, bytes?: ArrayBuffer): Promise<THREE.Object3D | null> {
  try {
    const g = await Promise.race([
      new Promise<{ scene: THREE.Object3D }>((res, rej) =>
        new GLTFLoader().parse(bytes ?? fixtureBuffer(name), '', res as never, rej),
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('unsettled')), 600)),
    ]);
    return g.scene;
  } catch {
    return null;
  }
}

/**
 * The geometry the clone road read for a child: the first `isMesh` under the named node, the
 * node itself included. Production's copy (`src/app/firstMeshGeometry.ts`) went with the clone
 * renderer in #1053; it is kept here as the ORACLE's definition, because the capture below was
 * written to agree with exactly this buffer and saved clone imports still carry what it wrote.
 */
function firstMeshGeometry(root: THREE.Object3D | undefined): THREE.BufferGeometry | null {
  if (!root) return null;
  let found: THREE.BufferGeometry | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = (o as THREE.Mesh).geometry;
  });
  return found;
}

async function parsed(name: string, bytes?: ArrayBuffer) {
  const { json, bin } = parseGltfContainer(bytes ?? fixtureBuffer(name));
  const buffers = await resolveBuffers(json, bin);
  return { json: json as GltfJson, buffers };
}

/** Two primitives of ONE mesh at disjoint positions, as a JSON-only glTF. */
function disjointTwoPrimitiveGltf(): ArrayBuffer {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]);
  const idx = new Uint16Array([0, 1, 2, 0, 1, 2]);
  const vBytes = new Uint8Array(verts.buffer);
  const iBytes = new Uint8Array(idx.buffer);
  const total = vBytes.length + iBytes.length + 2;
  const bin = new Uint8Array(total);
  bin.set(vBytes, 0);
  bin.set(iBytes, vBytes.length);
  const b64 = Buffer.from(bin).toString('base64');
  return new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Disjoint', mesh: 0 }],
      meshes: [
        {
          name: 'Disjoint',
          primitives: [
            { attributes: { POSITION: 0 }, indices: 2, mode: 4 },
            { attributes: { POSITION: 1 }, indices: 3, mode: 4 },
          ],
        },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 6 },
      ],
      buffers: [{ byteLength: total, uri: `data:application/octet-stream;base64,${b64}` }],
    }),
  ).buffer as ArrayBuffer;
}

describe('#1040 — a captured point count agrees with the buffer a reader holds', () => {
  it('1 — every parseable fixture child: captured === the read door’s weld', async () => {
    let compared = 0;
    const disagreements: string[] = [];
    for (const f of fixtureNames()) {
      const { json, buffers } = await parsed(f);
      const scene = await loadScene(f);
      if (scene === null) continue;
      for (const node of json.nodes ?? []) {
        const n = node as { mesh?: number; name?: string };
        const captured = captureChildPointCount(n, json, buffers);
        if (captured === undefined || n.name === undefined) continue;
        const door = firstMeshGeometry(scene.getObjectByName(n.name));
        if (!door) continue;
        compared++;
        const truth = weldByPosition(door).points;
        if (truth !== captured)
          disagreements.push(`${f}[${n.name}] captured ${captured} door ${truth}`);
      }
    }
    expect(disagreements).toEqual([]);
    // The denominator, because an empty disagreement list over an empty comparison set is
    // not a finding — a harness that loaded nothing would report exactly the same clean run.
    expect(compared).toBeGreaterThanOrEqual(13);
  }, 180000);

  it('2 — the refusal census: which mesh children get no count, and how many', async () => {
    const refused: Array<{ file: string; name: string; primitives: number }> = [];
    let meshChildren = 0;
    for (const f of fixtureNames()) {
      const { json, buffers } = await parsed(f);
      for (const node of json.nodes ?? []) {
        const n = node as { mesh?: number; name?: string };
        if (typeof n.mesh !== 'number') continue;
        meshChildren++;
        if (captureChildPointCount(n, json, buffers) !== undefined) continue;
        refused.push({
          file: f,
          name: n.name ?? '',
          primitives: (json.meshes?.[n.mesh]?.primitives ?? []).length,
        });
      }
    }
    // Named, not counted: a new refusal has to be justified by whoever adds the fixture.
    expect(refused.map((r) => `${r.file}[${r.name}] prims=${r.primitives}`).sort()).toEqual([
      // Draco hides its bytes behind an extension, so `readAccessor` throws and this is
      // reported as "not captured" rather than failing an otherwise good import.
      'cube-draco.glb[cube] prims=1',
      // Multi-primitive: the read door holds only the first primitive's buffer.
      'two-material-quad.gltf[TwoMatQuad] prims=2',
      'two-material-textured-quad.gltf[TwoMatTexQuad] prims=2',
    ]);
    expect(meshChildren).toBeGreaterThanOrEqual(18);
  }, 180000);

  it('3 — a multi-primitive child is refused, and disjoint primitives show why', async () => {
    const bytes = disjointTwoPrimitiveGltf();
    const { json, buffers } = await parsed('synthetic', bytes);
    const node = (json.nodes ?? [])[0] as { mesh?: number };

    // Refused — the population decision.
    expect(captureChildPointCount(node, json, buffers)).toBeUndefined();

    // And the falsifier: had it unioned the primitives, it would have disagreed with the door.
    // `two-material-quad` cannot show this — its primitives share four corners, so both
    // answers are 4 by accident and the row would pass while proving nothing.
    const scene = await loadScene('synthetic', bytes);
    expect(scene).not.toBeNull();
    const door = firstMeshGeometry(scene!.getObjectByName('Disjoint'));
    expect(door).toBeTruthy();
    expect(weldByPosition(door!).points).toBe(3);
    const union = new THREE.BufferGeometry();
    union.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0]),
        3,
      ),
    );
    expect(weldByPosition(union).points).toBe(6);
  }, 180000);

  it('4 — a node that is not a mesh, and a non-VEC3 POSITION, are both refused', async () => {
    const { json, buffers } = await parsed('cube.gltf');
    expect(captureChildPointCount({}, json, buffers)).toBeUndefined();
    // A POSITION declared VEC2 would weld pairs as triplets and return a plausible wrong
    // number, so the type is checked rather than trusted.
    const bent = JSON.parse(JSON.stringify(json)) as GltfJson;
    const pos = bent.meshes![0].primitives![0].attributes!.POSITION as number;
    (bent.accessors![pos] as { type: string }).type = 'VEC2';
    expect(
      captureChildPointCount(
        bent.nodes!.find((n) => (n as { mesh?: number }).mesh !== undefined) as { mesh?: number },
        bent,
        buffers,
      ),
    ).toBeUndefined();
  }, 120000);
});
