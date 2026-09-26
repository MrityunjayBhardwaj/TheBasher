import { beforeEach, describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { gltfAssetDepNodes } from './gltfAssetDeps';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { importedChildOps } from '../test-utils/importedChildFixture';

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
    ...importedChildOps('child1', { assetRef: ASSET, childName: 'Body' }),
    // An unrelated node the asset selector must ignore, and whose `position` the second
    // case edits — so it has to be the half that OWNS a transform, not the geometry half.
    { type: 'addNode', nodeId: 'box', nodeType: 'Object', params: { position: [0, 0, 0] } },
  ];
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('gltfAssetDepNodes — the GltfAssetR subscription scope (H48 4th occ / B13)', () => {
  beforeEach(() => registerAllNodes());

  it('selects this asset’s imported children — BOTH halves — and only them', () => {
    const s = buildScene();
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    // #389 — the data half is in scope too, and that is the load-bearing half here:
    // a recolour writes `material` on it, and if it were not subscribed the asset would
    // not re-render and the clone would keep painting the old colour (the H40 freeze).
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'child1__data', 'gltf']);
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
    const byId = (a: typeof after, id: string) => a.find((n) => n.id === id);
    expect(byId(after, 'child1')).toBe(byId(before, 'child1')); // identical reference
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
    // Compared BY ID, not by index: since #888 the asset node leads the array and
    // is unchanged by a child edit, so an index-0 check would assert the wrong
    // element and pass or fail for a reason unrelated to the guard.
    const byId = (a: typeof after, id: string) => a.find((n) => n.id === id);
    expect(byId(after, 'child1')).not.toBe(byId(before, 'child1')); // H40 freeze guard fires
  });

  // #188 (v0.7 Phase 3) — material channels target the child's DATA node directly
  // (`target === dataId`, `paramPath` starts `material.` — #389 moved both). They MUST be in the
  // subscription scope or editing one would not re-render the asset (H40 freeze) and
  // the per-frame overlay would never see it.
  function withMaterialChannel(s: DagState): DagState {
    return applyOp(s, {
      type: 'addNode',
      nodeId: 'matChan',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'metalness',
        target: 'child1__data', // the child's DATA node id, directly (#389)
        paramPath: 'material.base.metalness',
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
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'child1__data', 'gltf', 'matChan']);
  });

  it('#188 — selects a material channel (Color) targeting this asset’s child dagId', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'colChan',
      nodeType: 'KeyframeChannelColor',
      params: {
        name: 'base color',
        target: 'child1__data',
        paramPath: 'material.base.color',
        keyframes: [{ time: 0, value: '#ff0000' }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'child1__data', 'colChan', 'gltf']);
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
        paramPath: 'material.base.metalness',
        keyframes: [{ time: 0, value: 0 }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'child1__data', 'gltf']);
  });

  it('#188 — EXCLUDES a non-material channel (a plain scalar channel on the child) from the material path', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'scalarChan',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'foo',
        target: 'child1__data',
        paramPath: 'foo.bar', // not a material path
        keyframes: [{ time: 0, value: 0 }],
      },
    }).next;
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'child1__data', 'gltf']);
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
