// #1049 — the stored-mesh data node: it refuses a malformed mesh at the door, and evaluates to the
// same MeshData value a box does. #1117 — version 2 keeps corner data as a named list, and a
// version-1 mesh migrates into it.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  migrateAddFaceLayers,
  migrateAddPointLayers,
  migrateCornerUVsToLayers,
  PolyMeshDataNode,
  PolyMeshDataParams,
} from './PolyMeshData';
import { read as readAttributes } from '../app/attributeStore';
import { attributeAt, MATERIAL_INDEX, SKIN_JOINTS, SKIN_WEIGHTS } from './attributes';
import { openpbrMaterialSchema } from './materialSchema';
import { meshGeometryRef, packMeshData, unpackMeshData } from '../app/meshGeometryData';
import { faceCountOf } from '../app/faceCount';
import { readGeometry } from '../app/geometryRegistry';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from './registerAll';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { MeshDataValue } from './types';

const tetra = () =>
  packMeshData({
    points: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    faceSizes: Uint32Array.from([3, 3, 3, 3]),
    cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    cornerLayers: [],
    cornerNormals: null,
    faceLayers: [],
    pointLayers: [],
    vertexGroups: [],
  });

/** The tetrahedron with a UV per corner, so a migration has a real string to move. */
const tetraWithUVs = () =>
  packMeshData({
    ...decodeTetra(),
    cornerLayers: [
      { name: 'UVMap', type: 'float2', data: Float32Array.from({ length: 24 }, (_, i) => i / 24) },
    ],
  });

function evaluate(params: unknown): MeshDataValue {
  return PolyMeshDataNode.evaluate(
    PolyMeshDataParams.parse(params),
    {} as never,
    {} as never,
  ) as MeshDataValue;
}

describe('PolyMeshData', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('evaluates to a MeshData value whose geometry answers from the stored mesh', () => {
    const value = evaluate({ mesh: tetra(), material: null });
    expect(value.kind).toBe('MeshData');
    expect(value.geometry.key.startsWith('mesh|')).toBe(true);
    // The uniform face→slot assignment is folded into the key, as a box's is.
    expect(value.attributeKey).not.toBeNull();
    expect(value.geometry.key.endsWith(`|a:${value.attributeKey}`)).toBe(true);
    expect(faceCountOf(value.geometry.descriptor)).toBe(4);
    expect(readGeometry(value.geometry).status).toBe('ok');
    expect(value.materialKey).toBeNull();
  });

  it('refuses a mesh whose corners disagree with its faces, by reason', () => {
    const bad = {
      ...tetra(),
      faceSizes: packMeshData({ ...decodeTetra(), faceSizes: Uint32Array.from([3, 3, 3, 4]) })
        .faceSizes,
    };
    const parsed = PolyMeshDataParams.safeParse({ mesh: bad, material: null });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(
      /not a mesh: faces declare 13 corners but 12/,
    );
  });

  it('refuses bytes that do not decode', () => {
    const parsed = PolyMeshDataParams.safeParse({
      mesh: { ...tetra(), points: 'AAAA' + 'A' }, // 3.75 bytes: not a whole Float32
      material: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a corner layer type it does not hold, at the door', () => {
    const uv = tetraWithUVs().cornerLayers[0];
    const parsed = PolyMeshDataParams.safeParse({
      mesh: { ...tetra(), cornerLayers: [{ ...uv, type: 'float3' }] },
      material: null,
    });
    expect(parsed.success).toBe(false);
    // Control: the same layer as `float2` parses.
    expect(PolyMeshDataParams.safeParse({ mesh: tetraWithUVs(), material: null }).success).toBe(
      true,
    );
  });

  it('is refused by the op that tries to add it, so a bad mesh never reaches evaluate', () => {
    const bad = {
      ...tetra(),
      cornerPoints: packMeshData({
        ...decodeTetra(),
        cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 9]),
      }).cornerPoints,
    };
    expect(() =>
      applyOp(emptyDagState(), {
        type: 'addNode',
        nodeId: 'n_bad',
        nodeType: 'PolyMeshData',
        params: { mesh: bad, material: null },
      }),
    ).toThrow(/cites point 9 of 4/);
  });
});

describe('PolyMeshData version 1 → 2 (#1117)', () => {
  /** A version-1 params object, spelled as a version-1 save holds it. */
  const v1 = (cornerUVs: string | null) => {
    const { points, faceSizes, cornerPoints, cornerNormals } = tetra();
    return {
      mesh: { points, faceSizes, cornerPoints, cornerUVs, cornerNormals },
      material: null,
    };
  };

  it('is at version 4, with a migration from each earlier version', () => {
    expect(PolyMeshDataNode.version).toBe(4);
    expect(PolyMeshDataNode.migrations?.[1]).toBe(migrateCornerUVsToLayers);
    expect(PolyMeshDataNode.migrations?.[2]).toBe(migrateAddFaceLayers);
    expect(PolyMeshDataNode.migrations?.[3]).toBe(migrateAddPointLayers);
  });

  it('moves a version-1 cornerUVs string into cornerLayers as UVMap, byte for byte', () => {
    const uvs = tetraWithUVs().cornerLayers[0].data;
    const migrated = migrateCornerUVsToLayers(v1(uvs)) as { mesh: Record<string, unknown> };
    expect('cornerUVs' in migrated.mesh).toBe(false);
    expect(migrated.mesh.cornerLayers).toEqual([{ name: 'UVMap', type: 'float2', data: uvs }]);
    // And the result, carried on through the steps the ladder runs next, draws a uv buffer.
    const value = evaluate(migrateAddPointLayers(migrateAddFaceLayers(migrated)));
    const read = readGeometry(value.geometry);
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.geometry.getAttribute('uv')?.count).toBeGreaterThan(0);
  });

  it('turns a version-1 null into no layer, and leaves every other param as it was', () => {
    const before = v1(null);
    const migrated = migrateCornerUVsToLayers(before) as {
      mesh: Record<string, unknown>;
      material: unknown;
    };
    expect(migrated.mesh.cornerLayers).toEqual([]);
    expect(migrated.mesh.points).toBe(before.mesh.points);
    expect(migrated.mesh.faceSizes).toBe(before.mesh.faceSizes);
    expect(migrated.mesh.cornerPoints).toBe(before.mesh.cornerPoints);
    expect(migrated.mesh.cornerNormals).toBe(before.mesh.cornerNormals);
    expect(migrated.material).toBeNull();
    expect(
      PolyMeshDataParams.safeParse(migrateAddPointLayers(migrateAddFaceLayers(migrated))).success,
    ).toBe(true);
  });

  it('returns a mesh already in the version-2 shape as it is', () => {
    const current = { mesh: tetraWithUVs(), material: null };
    expect(migrateCornerUVsToLayers(current)).toBe(current);
  });
});

describe('PolyMeshData version 2 → 3 and material slots (#1052)', () => {
  const material = (color: string) =>
    openpbrMaterialSchema().parse({ name: color, base: { color } });
  /** The tetra with its four faces on slots `index`. */
  const slotted = (index: number[]) =>
    packMeshData({
      ...decodeTetra(),
      faceLayers: [{ name: MATERIAL_INDEX, type: 'int', data: Int32Array.from(index) }],
    });

  it('gives a version-2 mesh an empty face layer list, and leaves everything else as it was', () => {
    const v2mesh: Record<string, unknown> = { ...tetra() };
    delete v2mesh.faceLayers;
    delete v2mesh.pointLayers;
    delete v2mesh.vertexGroups;
    const before = { mesh: v2mesh, material: null };
    const migrated = migrateAddFaceLayers(before) as { mesh: Record<string, unknown> };
    expect(migrated.mesh.faceLayers).toEqual([]);
    expect(migrated.mesh.points).toBe(v2mesh.points);
    expect(migrated.mesh.cornerLayers).toBe(v2mesh.cornerLayers);
    expect(PolyMeshDataParams.safeParse(migrateAddPointLayers(migrated)).success).toBe(true);
    const current = { mesh: tetra(), material: null };
    expect(migrateAddFaceLayers(current)).toBe(current);
  });

  it('draws each face with the slot its material_index names', () => {
    const slots = [material('#ff0000'), material('#0000ff')];
    const value = evaluate({
      mesh: slotted([0, 1, 1, 0]),
      material: slots[0],
      materialSlots: slots,
    });
    expect(value.materialSlots).toEqual(slots);
    const index = attributeAt(readAttributes(value.attributeKey!), MATERIAL_INDEX, 'face');
    expect(Array.from(index!.data)).toEqual([0, 1, 1, 0]);
    // The groups the draw splits by come from that index, on the built instance.
    const read = readGeometry(value.geometry);
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1, 0]);
  });

  it('with no face layers, every face is on slot 0, as before', () => {
    const value = evaluate({ mesh: tetra(), material: null });
    const index = attributeAt(readAttributes(value.attributeKey!), MATERIAL_INDEX, 'face');
    expect(Array.from(index!.data)).toEqual([0, 0, 0, 0]);
    expect(value.materialSlots).toBeUndefined();
  });

  it('refuses a face layer of the wrong length, at the door', () => {
    const short = packMeshData({
      ...decodeTetra(),
      faceLayers: [{ name: MATERIAL_INDEX, type: 'int', data: Int32Array.from([0, 1]) }],
    });
    const parsed = PolyMeshDataParams.safeParse({ mesh: short, material: null });
    expect(parsed.error?.issues[0].message).toContain(
      "face layer 'material_index' holds 2 values for 4 faces",
    );
  });
});

describe('PolyMeshData version 3 → 4 and skin weights (#1196)', () => {
  /** The tetra bound to two joints: point p leans on joint p % 2, with the rest on the other. */
  const bound = (overrides: Record<string, unknown> = {}) => ({
    ...decodeTetra(),
    pointLayers: [
      {
        name: SKIN_JOINTS,
        type: 'int4' as const,
        data: Int32Array.from([0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]),
      },
      {
        name: SKIN_WEIGHTS,
        type: 'float4' as const,
        data: Float32Array.from([0.75, 0.25, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]),
      },
    ],
    vertexGroups: ['Bone0', 'Bone1'],
    ...overrides,
  });
  const refusal = (mesh: Parameters<typeof packMeshData>[0]) =>
    PolyMeshDataParams.safeParse({ mesh: packMeshData(mesh), material: null }).error?.issues[0]
      .message;

  it('gives a version-3 mesh no point layers and no vertex groups, and leaves the rest as it was', () => {
    const v3mesh: Record<string, unknown> = { ...tetra() };
    delete v3mesh.pointLayers;
    delete v3mesh.vertexGroups;
    const before = { mesh: v3mesh, material: null };
    expect(PolyMeshDataParams.safeParse(before).success).toBe(false);
    const migrated = migrateAddPointLayers(before) as { mesh: Record<string, unknown> };
    expect(migrated.mesh.pointLayers).toEqual([]);
    expect(migrated.mesh.vertexGroups).toEqual([]);
    expect(migrated.mesh.points).toBe(v3mesh.points);
    expect(migrated.mesh.faceLayers).toBe(v3mesh.faceLayers);
    expect(PolyMeshDataParams.safeParse(migrated).success).toBe(true);
    const current = { mesh: tetra(), material: null };
    expect(migrateAddPointLayers(current)).toBe(current);
  });

  it('holds joints as integers and weights as fractions, through a save and back', () => {
    const packed = packMeshData(bound());
    const back = unpackMeshData(JSON.parse(JSON.stringify(packed)));
    expect(back.vertexGroups).toEqual(['Bone0', 'Bone1']);
    const [joints, weights] = back.pointLayers;
    expect(joints.data).toBeInstanceOf(Int32Array);
    expect(Array.from(joints.data)).toEqual(Array.from(bound().pointLayers[0].data));
    expect(weights.data).toBeInstanceOf(Float32Array);
    expect(Array.from(weights.data)).toEqual(Array.from(bound().pointLayers[1].data));
    expect(PolyMeshDataParams.safeParse({ mesh: packed, material: null }).success).toBe(true);
  });

  it('a different binding is a different mesh: the weights, the joints and the group names each move the key', () => {
    const key = (mesh: Parameters<typeof packMeshData>[0]) =>
      meshGeometryRef(packMeshData(mesh)).key;
    const base = key(bound());
    expect(key(bound())).toBe(base);
    expect(key(decodeTetra())).not.toBe(base);
    const weights = Float32Array.from(bound().pointLayers[1].data);
    weights[0] = 0.5;
    weights[1] = 0.5;
    expect(
      key(
        bound({
          pointLayers: [
            bound().pointLayers[0],
            { name: SKIN_WEIGHTS, type: 'float4', data: weights },
          ],
        }),
      ),
    ).not.toBe(base);
    const joints = Int32Array.from(bound().pointLayers[0].data);
    joints[0] = 1;
    joints[1] = 0;
    expect(
      key(
        bound({
          pointLayers: [{ name: SKIN_JOINTS, type: 'int4', data: joints }, bound().pointLayers[1]],
        }),
      ),
    ).not.toBe(base);
    expect(key(bound({ vertexGroups: ['Bone1', 'Bone0'] }))).not.toBe(base);
  });

  it('refuses at the door a joint number past the vertex group table', () => {
    expect(refusal(bound({ vertexGroups: ['Bone0'] }))).toContain(
      "point layer 'skin_joints' binds point 0 to joint 1, but the mesh has 1 vertex groups",
    );
  });

  it('refuses half a set: joints with no weights, and weights with no joints', () => {
    expect(refusal(bound({ pointLayers: [bound().pointLayers[0]] }))).toContain(
      'joint numbers and no weights',
    );
    expect(refusal(bound({ pointLayers: [bound().pointLayers[1]] }))).toContain(
      'weights and no joint numbers',
    );
  });

  it('refuses a second set of four, which a stored mesh does not hold', () => {
    const [joints, weights] = bound().pointLayers;
    expect(
      refusal(
        bound({
          pointLayers: [
            joints,
            weights,
            { ...joints, name: 'skin_joints.001' },
            { ...weights, name: 'skin_weights.001' },
          ],
        }),
      ),
    ).toContain('2 joint layers and 2 weight layers, but a stored mesh holds one set of four');
  });

  it('refuses a negative weight, a layer of the wrong length, and two groups of one name', () => {
    const weights = Float32Array.from(bound().pointLayers[1].data);
    weights[5] = -0.25;
    expect(
      refusal(
        bound({
          pointLayers: [
            bound().pointLayers[0],
            { name: SKIN_WEIGHTS, type: 'float4', data: weights },
          ],
        }),
      ),
    ).toContain('gives point 1 the weight -0.25');
    expect(
      refusal(
        bound({
          pointLayers: [
            bound().pointLayers[0],
            { name: SKIN_WEIGHTS, type: 'float4', data: new Float32Array(12) },
          ],
        }),
      ),
    ).toContain("point layer 'skin_weights' holds 12 numbers for 4 points");
    expect(refusal(bound({ vertexGroups: ['Bone0', 'Bone0'] }))).toContain(
      "two vertex groups are both named 'Bone0'",
    );
  });

  it('evaluates like the same mesh unbound: a binding changes nothing a draw reads yet', () => {
    const plain = readGeometry(evaluate({ mesh: tetra(), material: null }).geometry);
    const skinned = readGeometry(
      evaluate({ mesh: packMeshData(bound()), material: null }).geometry,
    );
    if (plain.status !== 'ok' || skinned.status !== 'ok') throw new Error('unbuilt');
    expect(Array.from(skinned.geometry.getAttribute('position').array)).toEqual(
      Array.from(plain.geometry.getAttribute('position').array),
    );
    expect(
      faceCountOf(evaluate({ mesh: packMeshData(bound()), material: null }).geometry.descriptor),
    ).toBe(4);
  });
});

function decodeTetra() {
  return {
    points: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    faceSizes: Uint32Array.from([3, 3, 3, 3]),
    cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    cornerLayers: [],
    cornerNormals: null,
    faceLayers: [],
    pointLayers: [],
    vertexGroups: [],
  };
}
