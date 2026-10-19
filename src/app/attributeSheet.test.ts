// #1556 — the Spreadsheet reads every attribute of the selected node's mesh, per domain, from
// wherever it lives: the stored mesh, the attribute store, or the UV road.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { applyOps } from '../core/dag/ops';
import type { DagState } from '../core/dag/state';
import { cylinderMesh } from '../test-utils/cylinderMesh';
import { packMeshData } from './meshGeometryData';
import { attributeSheetOf as sheetOf, type AttributeSheet } from './attributeSheet';
import { createEvaluatorCache } from '../core/dag/evaluator';

const attributeSheetOf = (state: DagState, id: string | null) =>
  sheetOf(state, id, createEvaluatorCache());

beforeAll(() => registerAllNodes());

type Ok = Extract<AttributeSheet, { status: 'ok' }>;
const ok = (s: AttributeSheet): Ok => {
  if (s.status !== 'ok') throw new Error(s.why);
  return s;
};
const columnsAt = (s: Ok, domain: string) =>
  s.domains.find((d) => d.domain === domain)?.columns.map((c) => `${c.name}:${c.type}:${c.from}`);

/** The default scene plus a stored cylinder (8 sides, 3 rings) carrying a UV set, a face group
 *  and a second material slot on its first face. */
function withStoredMesh(): DagState {
  const base = buildDefaultDagState();
  const mesh = cylinderMesh({ radius: 1, height: 2, radial: 8, rings: 3 });
  const faces = mesh.faceSizes.length;
  const corners = mesh.cornerPoints.length;
  const uv = new Float32Array(corners * 2).map((_, i) => i / (corners * 2));
  const slots = new Int32Array(faces);
  slots[0] = 1;
  const arm = new Int32Array(faces).map((_, i) => (i < 4 ? 1 : 0));
  const data = {
    ...mesh,
    cornerLayers: [{ name: 'UVMap', type: 'float2' as const, data: uv }],
    faceLayers: [
      { name: 'material_index', type: 'int' as const, data: slots },
      { name: 'group:arm', type: 'int' as const, data: arm },
    ],
  };
  const material = (base.nodes.n_box_data.params as { material: unknown }).material;
  return applyOps(base, [
    {
      type: 'addNode',
      nodeId: 'tube_data',
      nodeType: 'PolyMeshData',
      params: { mesh: packMeshData(data), material },
    },
    { type: 'addNode', nodeId: 'tube', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'tube_data', socket: 'out' },
      to: { node: 'tube', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'tube', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ]).next;
}

describe('#1556 — attributeSheetOf', () => {
  it('a stored mesh shows its points, corners and faces, with every layer it holds', () => {
    const s = ok(attributeSheetOf(withStoredMesh(), 'tube'));
    expect(s.domains.map((d) => [d.domain, d.count])).toEqual([
      ['point', 24],
      ['face', 16],
      ['corner', 64],
    ]);
    expect(columnsAt(s, 'point')).toEqual(['P:float3:stored']);
    expect(columnsAt(s, 'corner')).toEqual(['point:int:stored', 'UVMap:float2:stored']);
    expect(columnsAt(s, 'face')).toEqual([
      'corners:int:stored',
      'material_index:int:stored',
      'group:arm:int:stored',
    ]);
    // The values are the mesh's own, element by element.
    const face = s.domains.find((d) => d.domain === 'face')!;
    const slots = face.columns.find((c) => c.name === 'material_index')!.data;
    expect([slots[0], slots[1]]).toEqual([1, 0]);
    const arm = face.columns.find((c) => c.name === 'group:arm')!.data;
    expect(Array.from(arm).slice(0, 6)).toEqual([1, 1, 1, 1, 0, 0]);
    const uv = s.domains.find((d) => d.domain === 'corner')!.columns[1];
    expect(uv.components).toBe(2);
    expect(uv.data[1]).toBeCloseTo(1 / 128);
  });

  it('the data node shows what its Object shows', () => {
    const state = withStoredMesh();
    expect(ok(attributeSheetOf(state, 'tube_data')).domains).toEqual(
      ok(attributeSheetOf(state, 'tube')).domains,
    );
  });

  it('a box shows its material assignment from the store and its UVs from the UV road', () => {
    const s = ok(attributeSheetOf(buildDefaultDagState(), 'n_box'));
    expect(columnsAt(s, 'face')).toEqual(['material_index:int:store']);
    expect(columnsAt(s, 'corner')).toEqual(['UVMap:float2:uv']);
    expect(s.domains.find((d) => d.domain === 'face')!.count).toBe(6);
    expect(s.domains.find((d) => d.domain === 'corner')!.count).toBe(24);
    expect(s.notes).toEqual([]);
  });

  it('it follows the graph: an edit to the mesh is in the next read', () => {
    const before = withStoredMesh();
    const mesh = cylinderMesh({ radius: 1, height: 2, radial: 6, rings: 2 });
    const after = applyOps(before, [
      {
        type: 'setParam',
        nodeId: 'tube_data',
        paramPath: 'mesh',
        value: packMeshData(mesh),
      },
    ]).next;
    expect(ok(attributeSheetOf(after, 'tube')).domains.map((d) => d.count)).toEqual([12, 6, 24]);
  });

  it('says why when there is nothing to show', () => {
    const state = buildDefaultDagState();
    expect(attributeSheetOf(state, null)).toEqual({
      status: 'none',
      why: 'Select a mesh to see its attributes.',
    });
    expect(attributeSheetOf(state, 'n_light')).toEqual({
      status: 'none',
      why: 'n_light puts out no mesh.',
    });
  });
});
