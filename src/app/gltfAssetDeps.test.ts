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

  // #188 (v0.7 Phase 3) — material channels target a GltfChild dagId DIRECTLY
  // (`target === childDagId`, `paramPath` starts `materials.`). They MUST be in the
  // subscription scope or editing one would not re-render the asset (H40 freeze) and
  // the per-frame overlay would never see it.
  function withMaterialChannel(s: DagState): DagState {
    return applyOp(s, {
      type: 'addNode',
      nodeId: 'matChan',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metalness',
        target: 'child1', // the GltfChild dagId, directly
        paramPath: 'materials.0.base.metalness',
        keyframes: [
          { time: 0, value: 0 },
          { time: 1, value: 1 },
        ],
      },
    }).next;
  }

  it('#188 — selects a material channel (Number) targeting this asset’s child dagId', () => {
    const s = withMaterialChannel(buildScene());
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'matChan']);
  });

  it('#188 — selects a material channel (Color) targeting this asset’s child dagId', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'colChan',
      nodeType: 'KeyframeChannelColor',
      params: {
        name: 'base color',
        target: 'child1',
        paramPath: 'materials.0.base.color',
        keyframes: [{ time: 0, value: '#ff0000' }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'colChan']);
  });

  it('#188 — EXCLUDES a material channel targeting a DIFFERENT asset’s child', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'foreignChan',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metalness',
        target: 'someOtherChild', // not in this asset's nodeNameMap values
        paramPath: 'materials.0.base.metalness',
        keyframes: [{ time: 0, value: 0 }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id)).toEqual(['child1']);
  });

  it('#188 — EXCLUDES a non-material channel (a plain scalar channel on the child) from the material path', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'scalarChan',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'foo',
        target: 'child1',
        paramPath: 'foo.bar', // not a materials.* path
        keyframes: [{ time: 0, value: 0 }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id)).toEqual(['child1']);
  });

  it('#188 — editing a material channel flips its ref → re-render fires (H40 freeze guard)', () => {
    let s = withMaterialChannel(buildScene());
    const before = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'matChan',
      paramPath: 'name',
      value: 'renamed',
    }).next;
    const after = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(shallow(before, after)).toBe(false);
  });
});
