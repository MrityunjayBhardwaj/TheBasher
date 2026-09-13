// #1049 — the stored-mesh data node: it refuses a malformed mesh at the door, and evaluates to the
// same MeshData value a box does.
import { beforeEach, describe, expect, it } from 'vitest';
import { PolyMeshDataNode, PolyMeshDataParams } from './PolyMeshData';
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
    cornerUVs: null,
    cornerNormals: null,
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

function decodeTetra() {
  return {
    points: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    faceSizes: Uint32Array.from([3, 3, 3, 3]),
    cornerPoints: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    cornerUVs: null,
    cornerNormals: null,
  };
}
