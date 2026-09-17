// #1049 — the native glTF import road: a file becomes stored polygon meshes and stops existing, or
// the whole import is refused by name.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildNativeGltfImportOps,
  primitiveSlots,
  readGltfMesh,
  triangulate,
} from './nativeGltfImport';
import { attributeAt, MATERIAL_INDEX } from '../../nodes/attributes';
import { read as readAttributes } from '../../app/attributeStore';
import { readGeometry } from '../../app/geometryRegistry';
import { parseGltfContainer, resolveBuffers } from './glb';
import { meshGeometryRef, packMeshData, buildMeshGeometry } from '../../app/meshGeometryData';
import { cornerCountOf, faceCountOf } from '../../app/faceCount';
import { pointCountOf } from '../../app/pointIdentity';
import { edgeCountOf } from '../../app/edgeIdentity';
import { polygonLayoutOf } from '../../app/polygonLayout';
import { cornerLayerBufferOf, cornerLayerNamesOf, uvChannelOf } from '../../app/cornerLayerNames';
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

/** The cube's one primitive's attribute table, to add attributes to by accessor index. */
const cubeAttributes = (json: Record<string, unknown>) =>
  (json.meshes as { primitives: { attributes: Record<string, number> }[] }[])[0].primitives[0]
    .attributes;

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
    expect(data.cornerLayers.map((l) => [l.name, l.type, l.data.length])).toEqual([
      ['UVMap', 'float2', 72],
    ]);
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

/**
 * A one-primitive glTF built in memory, so an attribute shape no fixture holds can still be read.
 * Every accessor is FLOAT and tightly packed, which is what the fixtures are too.
 */
function handBuilt(
  attributes: Record<string, { readonly type: string; readonly values: number[] }>,
) {
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const floats: number[] = [];
  const names: Record<string, number> = {};
  for (const [name, { type, values }] of Object.entries(attributes)) {
    const components = ({ VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[type];
    bufferViews.push({ buffer: 0, byteOffset: floats.length * 4, byteLength: values.length * 4 });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: values.length / components,
      type,
    });
    names[name] = accessors.length - 1;
    floats.push(...values);
  }
  const packed = new Float32Array(floats);
  return {
    json: {
      accessors,
      bufferViews,
      meshes: [{ primitives: [{ attributes: names }] }],
    } as unknown as Parameters<typeof readGltfMesh>[0],
    buffers: [new Uint8Array(packed.buffer)],
  };
}

/**
 * A triangle whose COLOR_0 is a normalised UNSIGNED_BYTE VEC4 — glTF's other legal spelling for a
 * colour, and the one whose tightly packed stride (4 bytes) is nothing like a float VEC4's (16).
 * Positions stay float, in their own view, as a real file's would be.
 */
function byteColourTriangle(byteStride: number) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const colours = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128]);
  const bytes = new Uint8Array(positions.byteLength + colours.byteLength);
  bytes.set(new Uint8Array(positions.buffer), 0);
  bytes.set(colours, positions.byteLength);
  const json = {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4', normalized: true },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: colours.byteLength, byteStride },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
  };
  return {
    json: json as unknown as Parameters<typeof readGltfMesh>[0],
    buffers: [bytes],
  };
}

/** The value drawn at each built vertex, keyed by that vertex's position — the file's own frame. */
function drawnByPosition(geometry: THREE.BufferGeometry, name: string, width: number) {
  const position = geometry.getAttribute('position');
  const attribute = geometry.getAttribute(name);
  const out = new Map<string, number[]>();
  for (let v = 0; v < position.count; v++) {
    const key = [position.getX(v), position.getY(v), position.getZ(v)]
      .map((x) => x.toFixed(4))
      .join(',');
    out.set(
      key,
      Array.from({ length: width }, (_, j) => attribute.getComponent(v, j)),
    );
  }
  return out;
}

describe('#1062 — readGltfMesh carries every UV set and the colour as named layers', () => {
  it('a second UV set arrives as UVMap.001, and draws to uv1 with the file’s own values', async () => {
    const { json, bin } = parseGltfContainer(fixture('public/assets/two-uv-quad.gltf'));
    const buffers = await resolveBuffers(json, bin);
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);

    // Two quads' worth of corners: 2 triangles × 3.
    expect(data.cornerLayers.map((l) => [l.name, l.type, l.data.length])).toEqual([
      ['UVMap', 'float2', 12],
      ['UVMap.001', 'float2', 12],
    ]);

    // The values are the FILE's, read through the same accessors by a second path.
    const { readAccessor } = await import('./glb');
    const positions = readAccessor(
      json,
      buffers,
      json.meshes![0].primitives![0].attributes!.POSITION,
    );
    const uv1 = readAccessor(json, buffers, json.meshes![0].primitives![0].attributes!.TEXCOORD_1);
    const drawn = drawnByPosition(buildMeshGeometry(data).geometry, 'uv1', 2);
    expect(drawn.size).toBe(4);
    for (let v = 0; v < 4; v++) {
      const key = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]
        .map((x) => x.toFixed(4))
        .join(',');
      expect(drawn.get(key), `uv1 at vertex ${v}`).toEqual([uv1[v * 2], uv1[v * 2 + 1]]);
    }
  });

  it('COLOR_0 arrives as a float4 Color layer, and draws to color with the file’s own values', async () => {
    const { json, bin } = parseGltfContainer(fixture('public/assets/vertex-color-quad.gltf'));
    const buffers = await resolveBuffers(json, bin);
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);

    expect(data.cornerLayers.map((l) => [l.name, l.type, l.data.length])).toEqual([
      ['Color', 'float4', 24],
    ]);

    const { readAccessor } = await import('./glb');
    const positions = readAccessor(
      json,
      buffers,
      json.meshes![0].primitives![0].attributes!.POSITION,
    );
    const colours = readAccessor(json, buffers, json.meshes![0].primitives![0].attributes!.COLOR_0);
    const drawn = drawnByPosition(buildMeshGeometry(data).geometry, 'color', 4);
    expect(drawn.size).toBe(4);
    for (let v = 0; v < 4; v++) {
      const key = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]
        .map((x) => x.toFixed(4))
        .join(',');
      expect(drawn.get(key), `colour at vertex ${v}`).toEqual([
        colours[v * 4],
        colours[v * 4 + 1],
        colours[v * 4 + 2],
        colours[v * 4 + 3],
      ]);
    }
  });

  it('a VEC3 colour arrives opaque rather than a component short', () => {
    const { json, buffers } = handBuilt({
      POSITION: { type: 'VEC3', values: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
      COLOR_0: { type: 'VEC3', values: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    });
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);
    const colour = data.cornerLayers.find((l) => l.name === 'Color');
    expect(colour?.type).toBe('float4');
    expect(Array.from(colour!.data)).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  });

  it('a tightly packed byte colour is read, not mistaken for interleaved data', () => {
    // Its stride is 4, which is what a VEC4 of bytes tightly packed IS. Sized from the accessor
    // rather than from a per-attribute literal, which could only describe a float colour.
    const { json, buffers } = byteColourTriangle(4);
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);
    const colour = data.cornerLayers.find((l) => l.name === 'Color');
    expect(colour?.type).toBe('float4');
    // Dequantised per the spec: 255 → 1, 128 → 128/255.
    expect(Array.from(colour!.data.slice(0, 4))).toEqual([1, 0, 0, 1]);
    expect(colour!.data[11]).toBeCloseTo(128 / 255, 5);
  });

  it('a genuinely interleaved colour is still refused', () => {
    // Same colour, a stride that is not its element size: `readAccessor` reads contiguously and
    // would misread it, so the file must be refused rather than drawn wrong.
    const { json, buffers } = byteColourTriangle(16);
    const data = readGltfMesh(json, buffers, 0);
    expect('refused' in data && data.refused).toContain('interleaved');
  });

  it('stops at the first TEXCOORD number the file does not have', () => {
    // TEXCOORD_2 with no TEXCOORD_1: the numbers run from 0 without gaps, so reading past the gap
    // would put set 2's values in set 1's slot and draw the wrong map.
    const { json, buffers } = handBuilt({
      POSITION: { type: 'VEC3', values: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
      TEXCOORD_0: { type: 'VEC2', values: [0, 0, 1, 0, 0, 1] },
      TEXCOORD_2: { type: 'VEC2', values: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    });
    const data = readGltfMesh(json, buffers, 0);
    if ('refused' in data) throw new Error(data.refused);
    expect(data.cornerLayers.map((l) => l.name)).toEqual(['UVMap']);
  });
});

/** The params of the one PolyMeshData an import writes. */
function polyMeshParamsOf(ops: readonly Op[]) {
  const data = ops.find(
    (op): op is Extract<Op, { type: 'addNode' }> =>
      op.type === 'addNode' && op.nodeType === 'PolyMeshData',
  )!;
  return PolyMeshDataParams.parse(data.params);
}

// #1052 — the two-material quads: one glTF node, two primitives sharing one POSITION accessor, a red
// and a blue material. Blender's importer makes ONE mesh of them with 2 material slots and
// `material_index` [0, 1] (measured on #1052), and so must this.
const TWO_MATERIAL = 'public/assets/two-material-quad.gltf';
const TWO_MATERIAL_TEXTURED = 'public/assets/two-material-textured-quad.gltf';

type PrimitiveJson = { attributes: Record<string, number>; material?: number; indices: number };
/** The textured two-material quad, edited: its accessors are 0 POSITION, 1 and 2 the two index lists, 3 UV. */
function twoPrimitiveFixture(mutate: (primitives: PrimitiveJson[]) => void) {
  const json = JSON.parse(readFileSync(TWO_MATERIAL_TEXTURED, 'utf8')) as Record<string, unknown>;
  mutate((json.meshes as { primitives: PrimitiveJson[] }[])[0].primitives);
  return json;
}
async function readFirstMesh(json: Record<string, unknown>) {
  const parsed = json as never as Parameters<typeof readGltfMesh>[0];
  // The fixture's one buffer is a data URI, so there is no embedded binary chunk to hand over.
  return readGltfMesh(parsed, await resolveBuffers(parsed, new Uint8Array(0)), 0);
}

describe('#1052 — readGltfMesh reads every primitive into one mesh', () => {
  it('two primitives over one POSITION: 4 welded points, 2 faces, and a material_index of [0, 1]', async () => {
    const data = await readFirstMesh(JSON.parse(readFileSync(TWO_MATERIAL, 'utf8')));
    if ('refused' in data) throw new Error(data.refused);
    expect(data.points.length / 3).toBe(4);
    expect(Array.from(data.faceSizes)).toEqual([3, 3]);
    expect(data.faceLayers.map((l) => [l.name, l.type, Array.from(l.data)])).toEqual([
      ['material_index', 'int', [0, 1]],
    ]);
  });

  it('primitives sharing a material share a slot, and a one-slot mesh writes no face layer', async () => {
    const json = twoPrimitiveFixture((prims) => {
      prims[1].material = 0;
    });
    expect(primitiveSlots(json as never, 0).slotOfPrimitive).toEqual([0, 0]);
    const data = await readFirstMesh(json);
    if ('refused' in data) throw new Error(data.refused);
    expect(data.faceLayers).toEqual([]);
  });

  it('primitives with no material share one slot; vertex colours on one of them make it a slot of its own', () => {
    const json = twoPrimitiveFixture((prims) => {
      delete prims[0].material;
      delete prims[1].material;
    });
    expect(primitiveSlots(json as never, 0).slotOfPrimitive).toEqual([0, 0]);
    const coloured = twoPrimitiveFixture((prims) => {
      delete prims[0].material;
      delete prims[1].material;
      prims[1].attributes.COLOR_0 = 0;
    });
    const slots = primitiveSlots(coloured as never, 0);
    expect(slots.slotOfPrimitive).toEqual([0, 1]);
    expect(slots.slots.map((s) => s.vertexColors)).toEqual([false, true]);
  });

  it('a UV set one primitive lacks is zeros on its corners; a colour it lacks is white', async () => {
    const json = twoPrimitiveFixture((prims) => {
      delete prims[1].attributes.TEXCOORD_0;
      delete prims[1].material; // its material samples UV set 0, which it would no longer carry
      prims[0].attributes.COLOR_0 = 0;
    });
    const data = await readFirstMesh(json);
    if ('refused' in data) throw new Error(data.refused);
    const uv = data.cornerLayers.find((l) => l.name === 'UVMap')!;
    const colour = data.cornerLayers.find((l) => l.name === 'Color')!;
    // Corners 0-2 are the first primitive's, 3-5 the second's.
    expect(Array.from(uv.data.subarray(0, 6)).some((v) => v !== 0)).toBe(true);
    expect(Array.from(uv.data.subarray(6))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(colour.data.subarray(12))).toEqual(Array(12).fill(1));
    expect(Array.from(colour.data.subarray(0, 12))).not.toEqual(Array(12).fill(1));
  });

  it('when only one primitive has normals, the other takes its faces’ own normals and draws flat', async () => {
    const json = twoPrimitiveFixture((prims) => {
      prims[0].attributes.NORMAL = 0;
    });
    const data = await readFirstMesh(json);
    if ('refused' in data) throw new Error(data.refused);
    const second = Array.from(data.cornerNormals!.subarray(9));
    // The quad lies in z = 0, so a face normal is (0, 0, ±1) at every corner.
    for (let c = 0; c < 3; c++) {
      expect(second.slice(c * 3, c * 3 + 3).map(Math.abs)).toEqual([0, 0, 1]);
    }
  });

  it('a map sampling a UV set is asked of the primitive that uses the material, not of the mesh', async () => {
    const json = twoPrimitiveFixture((prims) => {
      delete prims[1].attributes.TEXCOORD_0; // the blue material samples UV set 0; its sibling still has one
    });
    const result = await buildNativeGltfImportOps({
      buffer: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer,
      assetRef: 'user-imports/native/x.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    });
    expect('refused' in result && result.refused).toContain(
      'material 1 pbrMetallicRoughness.metallicRoughnessTexture samples UV set 0, which mesh 0 does not carry',
    );
  });

  it('an attribute no buffer draws is refused on any primitive, not only the first', async () => {
    const json = twoPrimitiveFixture((prims) => {
      prims[1].attributes.TANGENT = 0;
    });
    const result = await buildNativeGltfImportOps({
      buffer: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer,
      assetRef: 'user-imports/native/x.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    });
    expect('refused' in result && result.issue).toBe('#1125');
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

  /** `[what, file, issue, and — where the issue alone cannot tell guards apart — words only that guard says]` */
  const refusals: ReadonlyArray<
    | readonly [string, () => ArrayBuffer, string]
    | readonly [string, () => ArrayBuffer, string, string]
  > = [
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
      '#1123',
    ],
    // A map may sample any UV set its mesh carries (two-uv-quad below); one the mesh does not
    // carry is a malformed file, and the draw would decline the map with nothing said.
    [
      'a texture on a UV set its mesh does not carry',
      () =>
        texturedFixture((json) => {
          (
            materialOf(json).pbrMetallicRoughness.baseColorTexture as Record<string, unknown>
          ).texCoord = 1;
        }),
      '#1063',
      'samples UV set 1, which mesh 0 does not carry',
    ],
    [
      'a texture reference carrying an extension',
      () =>
        texturedFixture((json) => {
          (
            materialOf(json).pbrMetallicRoughness.baseColorTexture as Record<string, unknown>
          ).extensions = { EXT_texture_webp: { source: 0 } };
        }),
      '#1123',
      'uses EXT_texture_webp',
    ],
    // #1123 — a transform is carried, but one that also moves the map onto another UV set is not:
    // the material names its UV set from `texCoord` alone.
    [
      'a texture transform that names its own UV set',
      () =>
        texturedFixture((json) => {
          json.extensionsUsed = ['KHR_texture_transform'];
          (
            materialOf(json).pbrMetallicRoughness.baseColorTexture as Record<string, unknown>
          ).extensions = { KHR_texture_transform: { scale: [2, 2], texCoord: 1 } };
        }),
      '#1123',
      'names its own UV set',
    ],
    [
      'a normal map with a scale',
      () =>
        texturedFixture((json) => {
          materialOf(json).normalTexture = { index: 0, scale: 2 };
        }),
      '#1123',
    ],
    [
      'an occlusion map with a strength',
      () =>
        texturedFixture((json) => {
          materialOf(json).occlusionTexture = { index: 0, strength: 0.5 };
        }),
      '#1123',
    ],
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
    // #1125 — an attribute no render buffer slot draws. Each guard gets a case only it can refuse:
    // the counts come from the slot limits, so a fifth UV set and a second colour are the first
    // numbers past them.
    [
      'a fifth UV set',
      () =>
        jsonFixture((json) => {
          const attributes = cubeAttributes(json);
          for (let n = 1; n <= 4; n++) attributes[`TEXCOORD_${n}`] = attributes.TEXCOORD_0;
        }),
      '#1125',
      'carries TEXCOORD_4,',
    ],
    [
      'a second colour',
      () =>
        jsonFixture((json) => {
          const attributes = cubeAttributes(json);
          attributes.COLOR_0 = attributes.NORMAL;
          attributes.COLOR_1 = attributes.NORMAL;
        }),
      '#1125',
      'carries COLOR_1,',
    ],
    [
      'tangents',
      () =>
        jsonFixture((json) => {
          const attributes = cubeAttributes(json);
          attributes.TANGENT = attributes.NORMAL;
        }),
      '#1125',
      'carries TANGENT,',
    ],
    [
      'a UV set numbered past a gap',
      () =>
        jsonFixture((json) => {
          const attributes = cubeAttributes(json);
          attributes.TEXCOORD_2 = attributes.TEXCOORD_0;
        }),
      '#1063',
      'TEXCOORD_2 without TEXCOORD_1',
    ],
    [
      'a colour that does not hold one value per vertex',
      () =>
        jsonFixture((json) => {
          const accessors = json.accessors as Record<string, unknown>[];
          const attributes = cubeAttributes(json);
          accessors.push({ ...accessors[attributes.NORMAL], count: 12 });
          attributes.COLOR_0 = accessors.length - 1;
        }),
      '#1063',
      'a COLOR_0 that does not hold one value per vertex',
    ],
    [
      'a UV set that does not hold one value per vertex',
      () =>
        jsonFixture((json) => {
          const accessors = json.accessors as Record<string, unknown>[];
          const attributes = cubeAttributes(json);
          accessors.push({ ...accessors[attributes.TEXCOORD_0], count: 12 });
          attributes.TEXCOORD_0 = accessors.length - 1;
        }),
      '#1063',
      'a TEXCOORD_0 that does not hold one value per vertex',
    ],
    [
      'a material extension the native material does not draw',
      () =>
        jsonFixture((json) => {
          json.extensionsUsed = ['KHR_materials_sheen'];
        }),
      '#1123',
    ],
    // Sheen AND a second UV set: still refused, and now for the sheen alone.
    [
      'the sheen quad',
      () => fixture('public/assets/sheen-quad.gltf'),
      '#1123',
      'KHR_materials_sheen',
    ],
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

  it('#1123 — the UV-transform quad arrives native, its placement restated about the centre pivot', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: fixture('public/assets/uv-transform-quad.gltf'),
      assetRef: 'user-imports/native/uvt.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    const data = result.ops.find(
      (op): op is Extract<Op, { type: 'addNode' }> =>
        op.type === 'addNode' && op.nodeType === 'PolyMeshData',
    )!;
    const material = PolyMeshDataParams.parse(data.params).material!;
    // The file: scale [2,3], offset [0.1,0.2], rotation 0, about the UV origin. three's matrix puts
    // `-s·pivot + pivot + offset` in the translation, so about the centre the same draw needs
    // 0.1 + (2 - 1)·0.5 = 0.6 and 0.2 + (3 - 1)·0.5 = 1.2.
    expect(material.uvTransform.tiling).toEqual([2, 3]);
    expect(material.uvTransform.rotation).toBe(0);
    expect(material.uvTransform.offset[0]).toBeCloseTo(0.6, 12);
    expect(material.uvTransform.offset[1]).toBeCloseTo(1.2, 12);
    expect(material.mapUvTransforms).toBeUndefined();
  });

  it('#1123 — a per-map transform is restated slot by slot, and an untransformed slot stays identity', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: texturedFixture((json) => {
        json.extensionsUsed = ['KHR_texture_transform'];
        const material = materialOf(json);
        (material.pbrMetallicRoughness.baseColorTexture as Record<string, unknown>).extensions = {
          KHR_texture_transform: { scale: [4, 4], rotation: Math.PI / 2 },
        };
        material.emissiveTexture = { index: 0 };
        material.emissiveFactor = [1, 1, 1];
      }),
      assetRef: 'user-imports/native/permap.gltf',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    const data = result.ops.find(
      (op): op is Extract<Op, { type: 'addNode' }> =>
        op.type === 'addNode' && op.nodeType === 'PolyMeshData',
    )!;
    const material = PolyMeshDataParams.parse(data.params).material!;
    const albedo = material.mapUvTransforms!.albedo!;
    const emission = material.mapUvTransforms!.emissive!;
    const origin = new THREE.Matrix3().setUvTransform(0, 0, 4, 4, Math.PI / 2, 0, 0).toArray();
    const drawn = new THREE.Matrix3()
      .setUvTransform(
        albedo.offset[0],
        albedo.offset[1],
        albedo.tiling[0],
        albedo.tiling[1],
        albedo.rotation,
        0.5,
        0.5,
      )
      .toArray();
    for (let i = 0; i < 9; i++) expect(drawn[i]).toBeCloseTo(origin[i], 12);
    expect(emission).toEqual({ tiling: [1, 1], offset: [0, 0], rotation: 0 });
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

  it('#1062 — the vertex-colour quad arrives native: its colour a layer the material names', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: fixture('public/assets/vertex-color-quad.gltf'),
      assetRef: 'user-imports/native/vertex-color-quad.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    });
    if ('refused' in result) throw new Error(result.refused);
    const params = polyMeshParamsOf(result.ops);
    const layers = cornerLayerNamesOf(meshGeometryRef(params.mesh).descriptor);
    expect(layers).toEqual([{ name: 'Color', type: 'float4' }]);
    // The material names the layer, and that name resolves on THIS mesh to the colour buffer.
    expect(params.material?.geometry.colorLayer).toBe('Color');
    expect(cornerLayerBufferOf(layers, params.material!.geometry.colorLayer!)).toBe('color');
  });

  it('#1062 — the two-UV quad arrives native: its map names the second UV set, which resolves to uv1', async () => {
    const storage = new MemoryStorage();
    const result = await buildNativeGltfImportOps({
      buffer: fixture('public/assets/two-uv-quad.gltf'),
      assetRef: 'user-imports/native/two-uv-quad.gltf',
      sceneNodeId: 'n_scene',
      storeImage: (bytes, mime) => writeProjectImage(storage, 'p', bytes, mime),
    });
    if ('refused' in result) throw new Error(result.refused);
    const params = polyMeshParamsOf(result.ops);
    const layers = cornerLayerNamesOf(meshGeometryRef(params.mesh).descriptor);
    expect(layers.map((l) => l.name)).toEqual(['UVMap', 'UVMap.001']);
    expect(params.material?.mapUvLayers?.albedo).toBe('UVMap.001');
    expect(uvChannelOf(layers, params.material!.mapUvLayers!.albedo!)).toBe(1);
    expect(params.material?.maps.albedo?.store).toBe('project');
  });

  it('#1052 — the two-material quad arrives native: one mesh, a red and a blue slot, each face drawn by its own', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: fixture(TWO_MATERIAL),
      assetRef: 'user-imports/native/two-material-quad.gltf',
      sceneNodeId: 'n_scene',
      storeImage: noImages,
    });
    if ('refused' in result) throw new Error(result.refused);
    const types = result.ops.flatMap((op) => (op.type === 'addNode' ? [op.nodeType] : []));
    expect(types.sort()).toEqual(['Group', 'Object', 'PolyMeshData']);
    const params = polyMeshParamsOf(result.ops);
    expect(params.materialSlots?.map((m) => m?.base.color.toLowerCase())).toEqual([
      '#ff0000',
      '#0000ff',
    ]);
    expect(params.material).toEqual(params.materialSlots![0]);
    const value = PolyMeshDataNode.evaluate(params, {} as never, {} as never) as MeshDataValue;
    const index = attributeAt(readAttributes(value.attributeKey!), MATERIAL_INDEX, 'face');
    expect(Array.from(index!.data)).toEqual([0, 1]);
    const read = readGeometry(value.geometry);
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.geometry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
  });

  it('#1052 — the textured two-material quad stores its image once, and only the blue slot samples it', async () => {
    const storage = new MemoryStorage();
    const result = await buildNativeGltfImportOps({
      buffer: fixture(TWO_MATERIAL_TEXTURED),
      assetRef: 'user-imports/native/two-material-textured-quad.gltf',
      sceneNodeId: 'n_scene',
      storeImage: (bytes, mime) => writeProjectImage(storage, 'p', bytes, mime),
    });
    if ('refused' in result) throw new Error(result.refused);
    const slots = polyMeshParamsOf(result.ops).materialSlots!;
    expect(slots).toHaveLength(2);
    const held = (slot: (typeof slots)[number]) =>
      Object.values(slot!.maps).filter((m) => m !== null && m !== undefined);
    expect(held(slots[0])).toEqual([]);
    expect(held(slots[1]).length).toBeGreaterThan(0);
    expect(held(slots[1]).every((m) => m!.store === 'project')).toBe(true);
    expect(await listProjectImages(storage, 'p')).toHaveLength(1);
  });

  it.each(refusals)(
    'refuses %s whole, naming the issue that brings it across',
    async (_, buffer, issue, says?: string) => {
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
      if (says !== undefined) expect(result.refused).toContain(says);
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
