import { beforeEach, describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { gltfAssetDepNodes } from './gltfAssetDeps';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, Op } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

const ASSET = 'assets/cicada.glb';
const NODE_NAME_MAP = { Body: 'child1' };

function buildScene(): DagState {
  let s = emptyDagState();
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: 'gltf',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET, nodeNameMap: NODE_NAME_MAP },
    },
    {
      type: 'addNode',
      nodeId: 'child1',
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: 'Body',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
    { type: 'addNode', nodeId: 'box', nodeType: 'BoxMesh', params: { size: [1, 1, 1] } },
  ];
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('gltfAssetDepNodes — the GltfAssetR subscription scope (H48 4th occ / B13)', () => {
  beforeEach(() => __reseedAllNodesForTests());

  it('selects this asset’s GltfChild nodes (and only them)', () => {
    const s = buildScene();
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id)).toEqual(['child1']);
  });

  it('is shallow-EQUAL across an UNRELATED edit (structural sharing → no re-render)', () => {
    let s = buildScene();
    const before = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    // Edit the unrelated box.
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'box',
      paramPath: 'position',
      value: [9, 0, 0],
    }).next;
    const after = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    // Same node refs preserved by ops.ts structural sharing → zustand `shallow`
    // sees no change → GltfAssetR does NOT re-render.
    expect(shallow(before, after)).toBe(true);
    expect(after[0]).toBe(before[0]); // identical reference
  });

  it('is shallow-DIFFERENT after a RELEVANT edit (the asset’s own child) → re-render fires', () => {
    let s = buildScene();
    const before = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'child1',
      paramPath: 'position',
      value: [5, 0, 0],
    }).next;
    const after = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(shallow(before, after)).toBe(false);
    expect(after[0]).not.toBe(before[0]); // ref flipped → the H40 freeze guard still fires
  });
});
