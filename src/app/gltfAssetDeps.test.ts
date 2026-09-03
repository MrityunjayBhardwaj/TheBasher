import { beforeEach, describe, expect, it } from 'vitest';
import { shallow } from 'zustand/shallow';
import { gltfAssetDepNodes } from './gltfAssetDeps';
import { applyOp } from '../core/dag/ops';
import { emptyDagState } from '../core/dag/state';
import type { DagState, Op } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';

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
    // An unrelated node the asset selector must ignore, and whose `position` the second
    // case edits — so it has to be the half that OWNS a transform, not the geometry half.
    { type: 'addNode', nodeId: 'box', nodeType: 'Object', params: { position: [0, 0, 0] } },
  ];
  for (const op of ops) s = applyOp(s, op).next;
  return s;
}

describe('gltfAssetDepNodes — the GltfAssetR subscription scope (H48 4th occ / B13)', () => {
  beforeEach(() => registerAllNodes());

  it('selects this asset’s GltfChild nodes (and only them)', () => {
    const s = buildScene();
    const deps = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP);
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'gltf']);
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

  // #888 — the clip band's chain. `bakedChannelSamplersForAsset` reaches a
  // retargeted clip by walking GltfAsset → GltfSkeleton → AnimationClip, and
  // the renderer only ever sees what THIS collector returns. Narrowing it back
  // would give the read-side resolver a moving bone and the viewport a still
  // one, silently — both surfaces would still appear to work.
  it('#888 — carries the asset, its GltfSkeleton, and the AnimationClips bound to it', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'skel',
      nodeType: 'GltfSkeleton',
      params: { skinIndex: 0 },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'gltf', socket: 'out' },
      to: { node: 'skel', socket: 'asset' },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'clip',
      nodeType: 'AnimationClip',
      params: {
        name: 'retargeted',
        duration: 2,
        keyframes: [{ bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }],
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'skel', socket: 'out' },
      to: { node: 'clip', socket: 'skeleton' },
    }).next;
    const ids = gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP).map((n) => n.id);
    expect(ids).toContain('gltf');
    expect(ids).toContain('skel');
    expect(ids).toContain('clip');
    // …and still nothing that belongs to no asset of ours.
    expect(ids).not.toContain('box');
  });

  it('#888 — EXCLUDES a clip bound to some other skeleton', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'otherSkel',
      nodeType: 'Skeleton',
      params: { bones: [] },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'foreignClip',
      nodeType: 'AnimationClip',
      params: {
        name: 'source',
        duration: 2,
        keyframes: [{ bone: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }],
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'otherSkel', socket: 'out' },
      to: { node: 'foreignClip', socket: 'skeleton' },
    }).next;
    // The source clip a retarget consumed is not this rig's business — pulling
    // it into the subscription would re-render the asset on every edit to it.
    expect(gltfAssetDepNodes(s.nodes, ASSET, NODE_NAME_MAP).map((n) => n.id)).not.toContain(
      'foreignClip',
    );
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
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'gltf', 'matChan']);
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
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'colChan', 'gltf']);
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
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'gltf']);
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
    expect(deps.map((n) => n.id).sort()).toEqual(['child1', 'gltf']);
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
