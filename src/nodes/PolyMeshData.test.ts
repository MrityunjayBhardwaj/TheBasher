// #1049 — the stored-mesh data node: it refuses a malformed mesh at the door, and evaluates to the
// same MeshData value a box does. #1117 — version 2 keeps corner data as a named list, and a
// version-1 mesh migrates into it.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  migrateAddFaceLayers,
  migrateCornerUVsToLayers,
  PolyMeshDataNode,
  PolyMeshDataParams,
} from './PolyMeshData';
import { read as readAttributes } from '../app/attributeStore';
import { attributeAt, MATERIAL_INDEX } from './attributes';
import { openpbrMaterialSchema } from './materialSchema';
import { packMeshData } from '../app/meshGeometryData';
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

  it('is at version 3, with a migration from each earlier version', () => {
    expect(PolyMeshDataNode.version).toBe(3);
    expect(PolyMeshDataNode.migrations?.[1]).toBe(migrateCornerUVsToLayers);
    expect(PolyMeshDataNode.migrations?.[2]).toBe(migrateAddFaceLayers);
  });

  it('moves a version-1 cornerUVs string into cornerLayers as UVMap, byte for byte', () => {
    const uvs = tetraWithUVs().cornerLayers[0].data;
    const migrated = migrateCornerUVsToLayers(v1(uvs)) as { mesh: Record<string, unknown> };
    expect('cornerUVs' in migrated.mesh).toBe(false);
    expect(migrated.mesh.cornerLayers).toEqual([{ name: 'UVMap', type: 'float2', data: uvs }]);
    // And the result, carried on through the version-3 step the ladder runs next, draws a uv buffer.
    const value = evaluate(migrateAddFaceLayers(migrated));
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
    expect(PolyMeshDataParams.safeParse(migrateAddFaceLayers(migrated)).success).toBe(true);
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
    const before = { mesh: v2mesh, material: null };
    const migrated = migrateAddFaceLayers(before) as { mesh: Record<string, unknown> };
    expect(migrated.mesh.faceLayers).toEqual([]);
    expect(migrated.mesh.points).toBe(v2mesh.points);
    expect(migrated.mesh.cornerLayers).toBe(v2mesh.cornerLayers);
    expect(PolyMeshDataParams.safeParse(migrated).success).toBe(true);
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

function decodeTetra() {
  return {
    points: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    faceSizes: Uint32Array.from([3, 3, 3, 3]),
    cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    cornerLayers: [],
    cornerNormals: null,
    faceLayers: [],
  };
}
