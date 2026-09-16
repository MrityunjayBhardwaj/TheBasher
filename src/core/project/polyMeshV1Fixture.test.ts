// #1117 — a REAL save holding version-1 stored meshes, and the gate that keeps it drawing the same.
//
// ── WHY THIS EXISTS, AND WHY IT WAS CAPTURED BEFORE THE CHANGE ────────────────────────────────
//
// #1117 moves a stored mesh's corner data out of two fixed fields and into a named, typed list. A
// change to a shape that lives in saved data fails silently: an old project does not error, its
// mesh simply loads without UVs. `pre-ns1Fixture.test.ts` states the defence, and it applies here
// word for word: a save captured BEFORE the change, never regenerated, because a fixture written
// after the shape moved agrees with the new code by construction and tests nothing.
//
// So `__fixtures__/polymesh-v1-project.json` is the byte output of the running app on `bf2816fb`:
// two glTF files imported through the product's own ingest road, saved by the app's autosave
// (which calls `saveCurrent()`), read back out of OPFS. It holds both old-save branches:
//   - `cube.gltf`         → `cornerUVs` and `cornerNormals` both stored
//   - the cube, stripped  → `TEXCOORD_0` and `NORMAL` removed, so both are `null`
//
// ── WHY THE ORACLE IS THE DRAWN BUFFER, DECODED INDEPENDENTLY ─────────────────────────────────
//
// The assertion must say the same thing before and after the representation changes, so it names
// neither representation. It decodes the raw v1 strings with `Buffer` — not with the code under
// test — and checks that, for every corner, the vertex the built index buffer draws carries that
// corner's position, UV and normal. That is what a user sees, and it is indifferent to where the
// loaded mesh keeps its layers.
//
// REF: tools/gates/polyMeshV1Fixture.ts (the reader); src/core/project/preNs1Fixture.test.ts (the
//      precedent); src/app/meshGeometryData.ts (`buildMeshGeometry`); issues #1117, #1062.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { MemoryStorage } from '../storage';
import { loadProject, projectPath } from './io';
import { PROJECT_FORMAT_VERSION } from './schema';
import { PolyMeshDataNode, type PolyMeshDataParams } from '../../nodes/PolyMeshData';
import type { MeshDataValue } from '../../nodes/types';
import { buildMeshGeometry } from '../../app/meshGeometryData';
import { readPolyMeshV1FixtureBytes } from '../../../tools/gates/polyMeshV1Fixture';

interface RawV1Mesh {
  readonly points: string;
  readonly faceSizes: string;
  readonly cornerPoints: string;
  readonly cornerUVs: string | null;
  readonly cornerNormals: string | null;
}

interface RawProject {
  readonly id: string;
  readonly formatVersion: number;
  readonly state: {
    readonly nodes: Record<string, { type: string; version: number; params: { mesh?: RawV1Mesh } }>;
  };
}

function raw(): RawProject {
  return JSON.parse(readPolyMeshV1FixtureBytes().toString('utf8')) as RawProject;
}

/** Decoded with `Buffer`, never with the code under test. */
function floats(text: string): Float32Array {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}
function uints(text: string): Uint32Array {
  const bytes = Buffer.from(text, 'base64');
  return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function storedMeshes(project: RawProject) {
  return Object.entries(project.state.nodes)
    .filter(([, n]) => n.type === 'PolyMeshData')
    .map(([id, n]) => ({ id, version: n.version, mesh: n.params.mesh as RawV1Mesh }));
}

async function loaded() {
  const storage = new MemoryStorage();
  const bytes = readPolyMeshV1FixtureBytes();
  await storage.write(projectPath(raw().id), new Uint8Array(bytes));
  return loadProject(storage, raw().id);
}

describe('#1117 version-1 stored-mesh fixture', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('was captured at version 1, at a format version no newer than the current one', () => {
    const project = raw();
    // If either reds, the fixture was regenerated against newer code — the exact failure it
    // exists to prevent. Do not "fix" it by re-capturing.
    expect(project.formatVersion).toBeLessThanOrEqual(PROJECT_FORMAT_VERSION);
    const meshes = storedMeshes(project);
    expect(meshes.map((m) => m.version)).toEqual([1, 1]);
  });

  it('holds both old-save branches: a mesh with UVs and normals, and one with neither', () => {
    const branches = storedMeshes(raw())
      .map((m) => `uvs=${m.mesh.cornerUVs !== null} normals=${m.mesh.cornerNormals !== null}`)
      .sort();
    expect(branches).toEqual(['uvs=false normals=false', 'uvs=true normals=true']);
  });

  it('loads through the real loadProject seam and draws every corner exactly as the old save held it', async () => {
    const project = await loaded();
    expect(project.formatVersion).toBe(PROJECT_FORMAT_VERSION);

    for (const before of storedMeshes(raw())) {
      const node = project.state.nodes[before.id];
      expect(node?.type, `${before.id} survives the load`).toBe('PolyMeshData');

      const points = floats(before.mesh.points);
      const faceSizes = uints(before.mesh.faceSizes);
      const cornerPoints = uints(before.mesh.cornerPoints);
      const uvs = before.mesh.cornerUVs === null ? null : floats(before.mesh.cornerUVs);
      const normals = before.mesh.cornerNormals === null ? null : floats(before.mesh.cornerNormals);
      // The corner → drawn-vertex oracle below reads the index buffer in corner order, which is
      // exact for triangles. Both captured meshes are triangles; say so rather than assume it.
      expect(
        Array.from(faceSizes).every((s) => s === 3),
        `${before.id} is all triangles`,
      ).toBe(true);

      const value = PolyMeshDataNode.evaluate(
        node!.params as PolyMeshDataParams,
        {} as never,
        {} as never,
      ) as MeshDataValue;
      const descriptor = value.geometry.descriptor;
      if (descriptor.kind !== 'mesh')
        throw new Error(`${before.id} evaluates to ${descriptor.kind}`);
      const { geometry } = buildMeshGeometry(descriptor.data);
      const index = geometry.getIndex()!.array;
      const position = geometry.getAttribute('position').array;
      const uv = geometry.getAttribute('uv');
      const normal = geometry.getAttribute('normal').array;

      expect(index.length, `${before.id} draws every corner`).toBe(cornerPoints.length);
      expect(uv === undefined, `${before.id} draws a uv buffer iff the save held UVs`).toBe(
        uvs === null,
      );
      for (let c = 0; c < cornerPoints.length; c++) {
        const v = index[c];
        const p = cornerPoints[c];
        expect(
          [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]],
          `${before.id} corner ${c} position`,
        ).toEqual([points[p * 3], points[p * 3 + 1], points[p * 3 + 2]]);
        if (uvs !== null) {
          expect([uv.array[v * 2], uv.array[v * 2 + 1]], `${before.id} corner ${c} uv`).toEqual([
            uvs[c * 2],
            uvs[c * 2 + 1],
          ]);
        }
        if (normals !== null) {
          expect(
            [normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]],
            `${before.id} corner ${c} normal`,
          ).toEqual([normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]]);
        }
      }
    }
  });
});
