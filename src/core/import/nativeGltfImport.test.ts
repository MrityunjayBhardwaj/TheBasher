// #1049 — the native glTF import road: a file becomes stored polygon meshes and stops existing, or
// the whole import is refused by name.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildNativeGltfImportOps, readGltfMesh, triangulate } from './nativeGltfImport';
import { parseGltfContainer, resolveBuffers } from './glb';
import { meshGeometryRef, packMeshData, buildMeshGeometry } from '../../app/meshGeometryData';
import { cornerCountOf, faceCountOf } from '../../app/faceCount';
import { pointCountOf } from '../../app/pointIdentity';
import { edgeCountOf } from '../../app/edgeIdentity';
import { polygonLayoutOf } from '../../app/polygonLayout';
import { __resetRegistryForTests } from '../dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from '../dag/ops';
import { emptyDagState, type DagState } from '../dag/state';
import { PolyMeshDataNode, PolyMeshDataParams } from '../../nodes/PolyMeshData';
import type { Op } from '../dag/types';
import type { MeshDataValue } from '../../nodes/types';
import { join } from 'node:path';
import * as THREE from 'three';
import { MemoryStorage } from '../storage';
import { listProjectImages, projectImagePath, writeProjectImage } from '../project/projectImages';

/** A store an import must never reach: a file with no images, or one refused before storing. */
async function noImages(): Promise<string> {
  throw new Error('storeImage was reached');
}

function fixture(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jsonFixture(mutate: (json: Record<string, unknown>) => void): ArrayBuffer {
  const json = JSON.parse(readFileSync('public/assets/cube.gltf', 'utf8')) as Record<
    string,
    unknown
  >;
  mutate(json);
  return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
}

const CUBE = 'public/assets/cube.gltf';
const TEXTURED = 'public/assets/albedo-textured-quad.gltf';

/** The textured quad, edited. Its one material samples texture 0 as base colour. */
function texturedFixture(mutate: (json: Record<string, unknown>) => void): ArrayBuffer {
  const json = JSON.parse(readFileSync(TEXTURED, 'utf8')) as Record<string, unknown>;
  mutate(json);
  return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer;
}

type MaterialJson = Record<string, unknown> & { pbrMetallicRoughness: Record<string, unknown> };
const materialOf = (json: Record<string, unknown>) => (json.materials as MaterialJson[])[0];

describe('readGltfMesh — the cube', () => {
  it('reads 8 welded points, 12 triangles and a corner each for UVs and normals', async () => {
    const { json, bin } = parseGltfContainer(fixture(CUBE));
    const buffers = await resolveBuffers(json, bin);
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);
    expect(data.points.length / 3).toBe(8);
    expect(data.faceSizes.length).toBe(12);
    expect(data.cornerPoints.length).toBe(36);
    expect(data.cornerUVs?.length).toBe(72);
    expect(data.cornerNormals?.length).toBe(108);
  });

  it('answers the model like a box does, and builds back to the file’s own 24 vertices', async () => {
    const { json, bin } = parseGltfContainer(fixture(CUBE));
    const buffers = await resolveBuffers(json, bin);
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);
    const { descriptor } = meshGeometryRef(packMeshData(data));
    expect(faceCountOf(descriptor)).toBe(12);
    expect(cornerCountOf(descriptor)).toBe(36);
    expect(pointCountOf(descriptor)).toEqual({ kind: 'counted', count: 8 });
    // A triangulated cube: 12 box edges plus one diagonal per side.
    expect(edgeCountOf(descriptor)).toEqual({ kind: 'counted', count: 18 });
    expect(polygonLayoutOf(descriptor).kind).toBe('laid-out');

    // Nothing lost: the built buffer splits back to the file's 24 vertices, at the file's positions.
    const built = buildMeshGeometry(data).geometry;
    expect(built.getAttribute('position').count).toBe(24);
    expect(built.getIndex()!.count).toBe(36);
    const key = (a: ArrayLike<number>, i: number) =>
      [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]].map((x) => x.toFixed(4)).join(',');
    const fileBytes = await import('./glb').then((m) => m.readAccessor(json, buffers, 0));
    const fileSet = new Set(Array.from({ length: 24 }, (_, i) => key(fileBytes, i)));
    const builtArray = built.getAttribute('position').array;
    const builtSet = new Set(Array.from({ length: 24 }, (_, i) => key(builtArray, i)));
    expect(builtSet).toEqual(fileSet);
  });
});

describe('buildNativeGltfImportOps', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('writes a Group over one Object + PolyMeshData pair, and nothing that points at the file', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: fixture(CUBE),
      assetRef: 'user-imports/native/cube.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    });
    if ('refused' in result) throw new Error(result.refused);

    const types = result.ops.flatMap((op) => (op.type === 'addNode' ? [op.nodeType] : []));
    expect(types.sort()).toEqual(['Group', 'Object', 'PolyMeshData']);
    expect(JSON.stringify(result.ops)).not.toContain('GltfAsset');
    expect(JSON.stringify(result.ops)).not.toContain('GltfData');
    expect(result.objectIds).toHaveLength(1);

    // The ops apply as the DAG validates them; the last one wires the Group into the scene.
    const last = result.ops[result.ops.length - 1] as Extract<Op, { type: 'connect' }>;
    expect(last.to).toEqual({ node: 'n_scene', socket: 'children' });
    let state: DagState = emptyDagState();
    for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
    const objectId = result.objectIds[0];
    const dataEdge = state.nodes[objectId].inputs.data as { node: string } | undefined;
    expect(dataEdge?.node).toBeDefined();
    const dataNode = state.nodes[dataEdge!.node];
    expect(dataNode.type).toBe('PolyMeshData');

    // And the data node evaluates to a mesh the model can answer about, in the file's colour.
    const value = PolyMeshDataNode.evaluate(
      PolyMeshDataParams.parse(dataNode.params),
      {} as never,
      {} as never,
    ) as MeshDataValue;
    expect(faceCountOf(value.geometry.descriptor)).toBe(12);
    expect(value.material?.base.color.toLowerCase()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is deterministic: the same file imports to the same op stream', async () => {
    const args = {
      buffer: fixture(CUBE),
      assetRef: 'user-imports/native/cube.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    };
    expect(JSON.stringify(await buildNativeGltfImportOps(args))).toBe(
      JSON.stringify(await buildNativeGltfImportOps(args)),
    );
  });

  const refusals: ReadonlyArray<readonly [string, () => ArrayBuffer, string]> = [
    // Lifting this refusal gives a native Object one slot per primitive, and that is the day a
    // MaterialOverride's `slotIndex` needs a native meaning: today only the clone road reads it
    // (#1090). The row's name carries the issue so the red that retires it says what else is owed.
    [
      'a mesh with two primitives (lifting it makes #1090 reachable)',
      () => fixture('public/assets/two-material-quad.gltf'),
      '#1052',
    ],
    // #1050 — a texture comes across only as the native material holds it; each guard gets a case
    // only it can refuse.
    [
      'a texture in a slot the native material does not hold',
      () =>
        texturedFixture((json) => {
          json.extensionsUsed = ['KHR_materials_clearcoat'];
          materialOf(json).extensions = {
            KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0 } },
          };
        }),
      '#1062',
    ],
    [
      'a texture on a second UV set',
      () =>
        texturedFixture((json) => {
          (
            materialOf(json).pbrMetallicRoughness.baseColorTexture as Record<string, unknown>
          ).texCoord = 1;
        }),
      '#1062',
    ],
    [
      'a texture reference carrying an extension',
      () =>
        texturedFixture((json) => {
          (
            materialOf(json).pbrMetallicRoughness.baseColorTexture as Record<string, unknown>
          ).extensions = { KHR_texture_transform: { offset: [0.5, 0] } };
        }),
      '#1062',
    ],
    [
      'a normal map with a scale',
      () =>
        texturedFixture((json) => {
          materialOf(json).normalTexture = { index: 0, scale: 2 };
        }),
      '#1062',
    ],
    [
      'an occlusion map with a strength',
      () =>
        texturedFixture((json) => {
          materialOf(json).occlusionTexture = { index: 0, strength: 0.5 };
        }),
      '#1062',
    ],
    ['the UV-transform quad', () => fixture('public/assets/uv-transform-quad.gltf'), '#1062'],
    [
      'an image that is neither PNG nor JPEG',
      () =>
        texturedFixture((json) => {
          json.images = [{ uri: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAw' }];
        }),
      '#1063',
    ],
    [
      'a texture whose image lives only inside an extension',
      () =>
        texturedFixture((json) => {
          json.textures = [{ sampler: 0, extensions: { KHR_texture_basisu: { source: 0 } } }];
        }),
      '#1063',
    ],
    [
      'an image in a buffer view that does not exist',
      () =>
        texturedFixture((json) => {
          json.images = [{ bufferView: 99, mimeType: 'image/png' }];
        }),
      '#1063',
    ],
    ['a skinned, animated rig', () => fixture('public/assets/skinned-bar.glb'), '#393'],
    [
      'a nested hierarchy',
      () =>
        jsonFixture((json) => {
          const nodes = json.nodes as Record<string, unknown>[];
          nodes.push({ name: 'holder', children: [0], mesh: 0 });
          json.scenes = [{ nodes: [1] }];
        }),
      '#1051',
    ],
    [
      'a mesh drawn as lines',
      () =>
        jsonFixture((json) => {
          const meshes = json.meshes as { primitives: { mode?: number }[] }[];
          meshes[0].primitives[0].mode = 1;
        }),
      '#1063',
    ],
    // #1062 — each guard gets a case only it can refuse, then the real files that tripped it.
    [
      'a mesh with vertex colours',
      () =>
        jsonFixture((json) => {
          const meshes = json.meshes as { primitives: { attributes: Record<string, number> }[] }[];
          meshes[0].primitives[0].attributes.COLOR_0 = meshes[0].primitives[0].attributes.NORMAL;
        }),
      '#1062',
    ],
    [
      'a mesh with a second UV set',
      () =>
        jsonFixture((json) => {
          const meshes = json.meshes as { primitives: { attributes: Record<string, number> }[] }[];
          const attributes = meshes[0].primitives[0].attributes;
          attributes.TEXCOORD_1 = attributes.TEXCOORD_0;
        }),
      '#1062',
    ],
    [
      'a material extension the native material does not draw',
      () =>
        jsonFixture((json) => {
          json.extensionsUsed = ['KHR_materials_sheen'];
        }),
      '#1062',
    ],
    ['the vertex-colour quad', () => fixture('public/assets/vertex-color-quad.gltf'), '#1062'],
    ['the sheen quad', () => fixture('public/assets/sheen-quad.gltf'), '#1062'],
    [
      'two nodes sharing one mesh',
      () =>
        jsonFixture((json) => {
          const nodes = json.nodes as Record<string, unknown>[];
          nodes.push({ name: 'twin', mesh: 0, translation: [3, 0, 0] });
          (json.scenes as { nodes: number[] }[])[0].nodes.push(1);
        }),
      '#1061',
    ],
    [
      'a mesh with morph targets',
      () =>
        jsonFixture((json) => {
          const meshes = json.meshes as {
            primitives: { attributes: Record<string, number>; targets?: unknown[] }[];
          }[];
          const prim = meshes[0].primitives[0];
          prim.targets = [{ POSITION: prim.attributes.POSITION }];
        }),
      '#1060',
    ],
  ];

  it('#1050 — a textured quad arrives native: its image stored in the project, its map sampled as the file asks', async () => {
    const storage = new MemoryStorage();
    const result = await buildNativeGltfImportOps({
      buffer: fixture(TEXTURED),
      assetRef: 'user-imports/native/albedo.gltf',
      sceneNodeId: 'n_scene',
      storeImage: (bytes, mime) => writeProjectImage(storage, 'p', bytes, mime),
    });
    if ('refused' in result) throw new Error(result.refused);

    // One image, byte for byte the PNG the file embeds.
    const keys = await listProjectImages(storage, 'p');
    expect(keys).toHaveLength(1);
    const embedded = (JSON.parse(readFileSync(TEXTURED, 'utf8')) as { images: { uri: string }[] })
      .images[0].uri;
    const png = Buffer.from(embedded.slice(embedded.indexOf(',') + 1), 'base64');
    expect(Buffer.from(await storage.read(projectImagePath('p', keys[0])))).toEqual(png);

    // The material names that file, sampled NEAREST and repeating as the file's sampler says, and
    // nothing in the ops still speaks glTF or carries the pixels.
    const data = result.ops.find(
      (op): op is Extract<Op, { type: 'addNode' }> =>
        op.type === 'addNode' && op.nodeType === 'PolyMeshData',
    )!;
    const albedo = PolyMeshDataParams.parse(data.params).material?.maps.albedo;
    expect(albedo).toEqual({
      hash: keys[0],
      store: 'project',
      colorSpace: 'srgb',
      flipY: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
    });
    const ops = JSON.stringify(result.ops);
    expect(ops).not.toContain('gltfTexture');
    expect(ops).not.toContain('data:image');
  });

  it('#1050 — a multi-file glTF reads the image beside it', async () => {
    const entry = 'public/fixtures/multifile/spaced/scene.gltf';
    const storage = new MemoryStorage();
    const result = await buildNativeGltfImportOps({
      buffer: fixture(entry),
      assetRef: 'user-imports/spaced/scene.gltf',
      sceneNodeId: 'n_scene',
      resolveBuffer: async (uri) =>
        readFileSync(join('public/fixtures/multifile/spaced', decodeURIComponent(uri))),
      storeImage: (bytes, mime) => writeProjectImage(storage, 'p', bytes, mime),
    });
    expect('refused' in result ? result.refused : 'native').toBe('native');
    expect(await listProjectImages(storage, 'p')).toHaveLength(1);
  });

  it('#1050 — one image sampled by two slots is stored once', async () => {
    const entry = 'public/fixtures/multifile/metal/scene.gltf';
    const stored: string[] = [];
    const storage = new MemoryStorage();
    const result = await buildNativeGltfImportOps({
      buffer: fixture(entry),
      assetRef: 'user-imports/metal/scene.gltf',
      sceneNodeId: 'n_scene',
      resolveBuffer: async (uri) =>
        readFileSync(join('public/fixtures/multifile/metal', decodeURIComponent(uri))),
      storeImage: async (bytes, mime) => {
        const key = await writeProjectImage(storage, 'p', bytes, mime);
        stored.push(key);
        return key;
      },
    });
    if ('refused' in result) throw new Error(result.refused);
    expect(stored).toHaveLength(1);
    const data = result.ops.find(
      (op): op is Extract<Op, { type: 'addNode' }> =>
        op.type === 'addNode' && op.nodeType === 'PolyMeshData',
    )!;
    const maps = PolyMeshDataParams.parse(data.params).material?.maps;
    expect(maps?.albedo?.hash).toBe(stored[0]);
    expect(maps?.roughness?.hash).toBe(stored[0]);
    expect(maps?.metalness?.hash).toBe(stored[0]);
  });

  it.each(['cube', 'cone', 'sphere'])(
    '%s.gltf, which carries only what a stored mesh holds, still imports natively',
    async (name) => {
      const result = await buildNativeGltfImportOps({
        buffer: fixture(`public/assets/${name}.gltf`),
        assetRef: `user-imports/native/${name}.gltf`,
        sceneNodeId: 'n_scene',
        storeImage: noImages,
      });
      expect('refused' in result ? result.refused : 'native').toBe('native');
    },
  );

  it.each(refusals)(
    'refuses %s whole, naming the issue that brings it across',
    async (_, buffer, issue) => {
      const result = await buildNativeGltfImportOps({
        buffer: buffer(),
        assetRef: 'user-imports/native/x.gltf',
        sceneNodeId: 'n_scene',
        // A refused file stores nothing: every refusal is read before the first image is written.
        storeImage: noImages,
      });
      expect('refused' in result).toBe(true);
      if (!('refused' in result)) return;
      expect(result.issue).toBe(issue);
      expect(result.refused.length).toBeGreaterThan(10);
    },
  );
});

describe('triangulate — three’s toTrianglesDrawMode rule', () => {
  it('passes triangles through, and refuses a count that is not whole triangles', () => {
    expect(Array.from(triangulate(Uint32Array.from([0, 1, 2, 2, 3, 0]), 4)!)).toEqual([
      0, 1, 2, 2, 3, 0,
    ]);
    expect(triangulate(Uint32Array.from([0, 1, 2, 3]), 4)).toBeNull();
  });

  it('fans from the first vertex', () => {
    expect(Array.from(triangulate(Uint32Array.from([0, 1, 2, 3]), 6)!)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('alternates a strip’s winding so every triangle faces the same way', () => {
    expect(Array.from(triangulate(Uint32Array.from([0, 1, 2, 3]), 5)!)).toEqual([0, 1, 2, 3, 2, 1]);
  });

  it('refuses a mode that is not a triangle mode', () => {
    expect(triangulate(Uint32Array.from([0, 1]), 1)).toBeNull();
  });
});
