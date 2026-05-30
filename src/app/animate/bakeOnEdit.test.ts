// bakeOnEdit + dispatchBakeThenRetime — D2 unit tests (Phase 7.12 Wave D, #108).
//
// Load-bearing assertions (PLAN D2 verify):
//   1. parseClipRowId detects the `clip:<childName>:<component>` namespace and
//      rejects real channel ids (the intercept gate).
//   2. hasBakedChannel matches by params.target === GltfChild dagId (BLOCK-2 key,
//      the SAME paramAnimationState:74 uses) → idempotency.
//   3. dispatchBakeThenRetime: the FIRST clip-row edit BAKES the bone's channels
//      AND retimes the dragged key as ONE atomic undo entry (K6). The baked
//      channel materializes with the deterministic id; one undo reverts BOTH.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchBakeThenRetime } from './dispatchMutator';
import { parseClipRowId, hasBakedChannel, assetRefForChild } from './bakeOnEdit';
import { gltfChildDagId, gltfChannelDagId } from '../../core/import/gltfImportChain';

const ASSET = 'asset-d2';
const CHILD = 'bone_1';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const CLIP_KEYFRAMES = [
  { targetNodeId: 'bone_1', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  {
    targetNodeId: 'bone_1',
    time: 1.0,
    position: [0, 2, 0],
    rotation: [0, 90, 0],
    scale: [1, 1, 1],
  },
];

/** GltfAsset → ClipSelect → TransformClip + GltfChild(bone_1). */
function buildScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip',
    nodeType: 'TransformClip',
    params: { name: 'walk', duration: 1, keyframes: CLIP_KEYFRAMES },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_sel',
    nodeType: 'ClipSelect',
    params: { selectedClipName: 'walk' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_clip', socket: 'out' },
    to: { node: 'n_sel', socket: 'clips' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_sel', socket: 'out' },
    to: { node: 'n_gltf', socket: 'transformClip' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET, CHILD),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: CHILD,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overridden: { position: false, rotation: false, scale: false },
    },
  }).next;
  return s;
}

describe('bakeOnEdit pure helpers (D2)', () => {
  it('parseClipRowId detects the clip: namespace and rejects real channel ids', () => {
    expect(parseClipRowId('clip:bone_1:position')).toEqual({
      childName: 'bone_1',
      component: 'position',
    });
    expect(parseClipRowId('clip:bone_1:rotation')).toEqual({
      childName: 'bone_1',
      component: 'rotation',
    });
    // A real channel id is NOT a clip row.
    expect(parseClipRowId('n_gltfChannel_abcd1234')).toBeNull();
    expect(parseClipRowId('clip:bone_1:bogus')).toBeNull();
  });

  it('assetRefForChild resolves a bone childName back to its assetRef', () => {
    const s = buildScene();
    expect(assetRefForChild(s.nodes, CHILD)).toBe(ASSET);
    expect(assetRefForChild(s.nodes, 'no-such-bone')).toBeNull();
  });

  it('hasBakedChannel is false pre-bake, true once a channel targets the GltfChild dagId', () => {
    let s = buildScene();
    expect(hasBakedChannel(s.nodes, ASSET, CHILD)).toBe(false);
    // Add a baked channel whose params.target = the GltfChild dagId (BLOCK-2).
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChannelDagId(ASSET, CHILD, 'position'),
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: gltfChildDagId(ASSET, CHILD),
        childName: CHILD,
        assetRef: ASSET,
        paramPath: 'position',
        keyframes: [],
      },
    }).next;
    expect(hasBakedChannel(s.nodes, ASSET, CHILD)).toBe(true);
  });
});

describe('dispatchBakeThenRetime (D2 — copy-on-write, one undo)', () => {
  it('bakes the bone AND retimes the dragged key as ONE atomic undo entry', () => {
    useDagStore.getState().hydrate(buildScene());
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    // Drag the position row's key at t=1.0 → t=1.5 (the FIRST edit of a
    // clip-backed bone).
    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: CHILD,
      component: 'position',
      fromTime: 1.0,
      toTime: 1.5,
    });
    expect(res).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    // (1) the 3 baked channels materialized with deterministic ids.
    for (const component of ['position', 'rotation', 'scale']) {
      const id = gltfChannelDagId(ASSET, CHILD, component);
      expect(nodes[id]).toBeDefined();
      expect(nodes[id].type).toBe('KeyframeChannelVec3');
    }
    // (2) the dragged component's key moved 1.0 → 1.5 (retime landed on the
    //     now-real baked channel).
    const posId = gltfChannelDagId(ASSET, CHILD, 'position');
    const kfs = (nodes[posId].params as { keyframes: Array<{ time: number }> }).keyframes;
    expect(kfs.map((k) => k.time).sort((a, b) => a - b)).toEqual([0, 1.5]);
    expect(kfs.some((k) => k.time === 1.0)).toBe(false);

    // (3) EXACTLY ONE atomic undo entry for bake + edit (K6).
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);

    // One undo reverts BOTH the bake AND the edit — the baked channels are gone.
    useDagStore.getState().undo();
    const after = useDagStore.getState().state.nodes;
    expect(after[posId]).toBeUndefined();
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });

  it('rejects (mutates nothing) when there is no clip track for the bone', () => {
    // A scene with the GltfChild but no clip.
    let s = emptyDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: gltfChildDagId(ASSET, CHILD),
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: CHILD,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
    useDagStore.getState().hydrate(s);

    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: CHILD,
      component: 'position',
      fromTime: 1.0,
      toTime: 1.5,
    });
    expect(res.ok).toBe(false);
    // Nothing applied.
    expect(useDagStore.getState().undoStack).toHaveLength(0);
  });
});
