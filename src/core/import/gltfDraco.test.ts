// #1063 — a Draco-compressed file is decoded into ordinary accessors and read natively.
//
// The decoder here is `draco3d` in Node (`src/test-utils/dracoNodeDecoder.ts`); the product's is
// three's DRACOLoader worker, observed end to end in `tests/e2e/p1063-draco-imports-native.spec.ts`.
//
// REF: src/core/import/gltfDraco.ts; src/core/import/nativeGltfImport.ts; issue #1063.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeDracoInNode } from '../../test-utils/dracoNodeDecoder';
import { parseGlb, parseGltfContainer, repackGlb, resolveBuffers } from './glb';
import { decodeDracoPrimitives, DRACO_EXTENSION, type DecodeDraco } from './gltfDraco';
import { buildNativeGltfImportOps, readGltfMesh } from './nativeGltfImport';
import { __resetRegistryForTests } from '../dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';

const DRACO_CUBE = 'public/assets/cube-draco.glb';
const PLAIN_CUBE = 'public/assets/cube.gltf';

function fixture(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function documentOf(path: string) {
  const { json, bin } = parseGltfContainer(fixture(path));
  return { json, buffers: await resolveBuffers(json, bin) };
}

/** The welded points of mesh 0, sorted, so two files' points compare as sets. */
function sortedPoints(points: Float32Array): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < points.length; i += 3) out.push([points[i], points[i + 1], points[i + 2]]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

async function importCube(path: string, decodeDraco?: DecodeDraco) {
  return buildNativeGltfImportOps({
    buffer: fixture(path),
    assetRef: 'user-imports/draco/cube.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => {
      throw new Error('storeImage was reached');
    },
    decodeDraco,
  });
}

describe('decodeDracoPrimitives', () => {
  it('turns the compressed cube into accessors over new buffers, with no Draco left in it', async () => {
    const { json, buffers } = await documentOf(DRACO_CUBE);
    const before = JSON.stringify(json);

    const decoded = await decodeDracoPrimitives(json, buffers, decodeDracoInNode);
    if ('refused' in decoded) throw new Error(decoded.refused);

    expect(JSON.stringify(json), 'the caller’s document is not touched').toBe(before);
    const text = JSON.stringify(decoded.json);
    expect(text).not.toContain(DRACO_EXTENSION);
    const prim = decoded.json.meshes![0].primitives![0];
    const counts = [prim.indices!, ...Object.values(prim.attributes!)].map(
      (a) => decoded.json.accessors![a].count,
    );
    expect(counts).toEqual([36, 24, 24, 24]);
  });

  it('the decoded cube reads as the same mesh the uncompressed one does', async () => {
    const draco = await documentOf(DRACO_CUBE);
    const decoded = await decodeDracoPrimitives(draco.json, draco.buffers, decodeDracoInNode);
    if ('refused' in decoded) throw new Error(decoded.refused);
    const compressed = readGltfMesh(decoded.json, decoded.buffers, 0);
    const plain = await documentOf(PLAIN_CUBE);
    const reference = readGltfMesh(plain.json, plain.buffers, 0);
    if ('refused' in compressed) throw new Error(compressed.refused);
    if ('refused' in reference) throw new Error(reference.refused);

    expect(compressed.faceSizes).toEqual(reference.faceSizes);
    expect(compressed.cornerPoints.length).toBe(reference.cornerPoints.length);
    const a = sortedPoints(compressed.points);
    const b = sortedPoints(reference.points);
    expect(a).toHaveLength(8);
    // Within a quantization step; the file's DECLARED bounds are ±0.50049, the decoded points ±0.5.
    a.forEach((p, i) => p.forEach((v, k) => expect(Math.abs(v - b[i][k])).toBeLessThan(1e-3)));
  });

  it('a primitive that cannot be decoded is refused by name, not imported in part', async () => {
    const { json, buffers } = await documentOf(DRACO_CUBE);
    const broken = buffers.map((b) => new Uint8Array(b.byteLength)); // same size, all zeros
    const result = await decodeDracoPrimitives(json, broken, decodeDracoInNode);
    expect(result).toMatchObject({ issue: '#1063' });
    expect('refused' in result && result.refused).toMatch(
      /^mesh 0 primitive 0 is Draco-compressed and could not be decoded \(/,
    );
  });

  it('a compressed attribute the primitive does not carry is refused', async () => {
    const { json, buffers } = await documentOf(DRACO_CUBE);
    const prim = json.meshes![0].primitives![0] as { attributes: Record<string, number> };
    delete prim.attributes.NORMAL;
    const result = await decodeDracoPrimitives(json, buffers, decodeDracoInNode);
    expect('refused' in result && result.refused).toBe(
      'mesh 0 primitive 0 is Draco-compressed and names NORMAL, which the primitive does not carry',
    );
  });
});

describe('buildNativeGltfImportOps — a Draco file', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('arrives native when a decoder is given', async () => {
    const result = await importCube(DRACO_CUBE, decodeDracoInNode);
    if ('refused' in result) throw new Error(result.refused);
    const types = result.ops.flatMap((op) => (op.type === 'addNode' ? [op.nodeType] : []));
    // #1451 — no wrapper Group: the Object stands under the scene, as Blender's importer stands it.
    expect(types.sort()).toEqual(['Object', 'PolyMeshData']);
    expect(JSON.stringify(result.ops)).not.toContain('GltfAsset');
  });

  it('without a decoder it is refused as undecoded, never as unimplemented', async () => {
    const result = await importCube(DRACO_CUBE);
    expect(result).toEqual({
      refused: 'it is Draco-compressed and no Draco decoder was given to the reader',
      issue: '#1063',
    });
  });

  it('a decoder does not admit any OTHER required extension', async () => {
    const parsed = parseGlb(fixture(DRACO_CUBE));
    const json = parsed.json as unknown as Record<string, unknown>;
    json.extensionsRequired = [DRACO_EXTENSION, 'EXT_meshopt_compression'];
    const out = repackGlb({ json, bin: parsed.bin });
    const result = await buildNativeGltfImportOps({
      buffer: out.slice().buffer as ArrayBuffer,
      assetRef: 'user-imports/draco/cube.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
      decodeDraco: decodeDracoInNode,
    });
    expect(result).toEqual({
      refused: 'it requires extensions this reader does not implement (EXT_meshopt_compression)',
      issue: '#1063',
    });
  });
});
