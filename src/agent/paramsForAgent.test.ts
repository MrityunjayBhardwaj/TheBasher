// #1049 — an agent is shown a stored mesh as its counts, never as megabytes of packed bytes.
import { beforeEach, describe, expect, it } from 'vitest';
import { paramsForAgent } from './paramsForAgent';
import { packMeshData } from '../app/meshGeometryData';
import { dagInspectTool } from './tools/dagInspect';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';

const grid = (n: number) => {
  const points: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) points.push(x, y, 0);
  const faceSizes: number[] = [];
  const cornerPoints: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = y * (n + 1) + x;
      faceSizes.push(4);
      cornerPoints.push(p, p + 1, p + n + 2, p + n + 1);
    }
  }
  return packMeshData({
    points: Float32Array.from(points),
    faceSizes: Uint32Array.from(faceSizes),
    cornerPoints: Uint32Array.from(cornerPoints),
    cornerLayers: [
      { name: 'UVMap', type: 'float2', data: new Float32Array(cornerPoints.length * 2) },
    ],
    cornerNormals: null,
  });
};

describe('paramsForAgent', () => {
  it('replaces a packed mesh with its element counts and layer names, wherever it sits', () => {
    const mesh = grid(10);
    const shown = paramsForAgent({ mesh, material: { base: { color: '#ff0000' } }, list: [mesh] });
    const counts = {
      storedMesh: {
        points: 121,
        faces: 100,
        corners: 400,
        layers: [{ name: 'UVMap', type: 'float2' }],
        normals: false,
      },
    };
    expect(shown).toEqual({
      mesh: counts,
      material: { base: { color: '#ff0000' } },
      list: [counts],
    });
  });

  it('leaves params with no mesh untouched', () => {
    const params = { size: [1, 2, 3], material: { base: { color: '#00ff00' } }, name: 'box' };
    expect(paramsForAgent(params)).toEqual(params);
  });

  describe('dag.inspect', () => {
    beforeEach(() => {
      __resetRegistryForTests();
      registerAllNodes();
    });

    it('shows a stored mesh node as counts, and none of its bytes', () => {
      const mesh = grid(20);
      const state = applyOp(emptyDagState(), {
        type: 'addNode',
        nodeId: 'n_grid',
        nodeType: 'PolyMeshData',
        params: { mesh, material: null },
      }).next;
      const ctx = { dagState: state } as never;
      for (const args of [
        { scope: 'all' as const },
        { scope: 'node' as const, nodeId: 'n_grid' },
      ]) {
        const { text } = dagInspectTool.handler(args, ctx);
        expect(text).toContain('"storedMesh"');
        expect(text).toContain('"faces": 400');
        expect(text).not.toContain(mesh.points.slice(0, 64));
        // Control: the packed form really is large, so its absence above means something.
        expect(mesh.points.length).toBeGreaterThan(1024);
      }
    });
  });
});
