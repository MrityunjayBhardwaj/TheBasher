// dispatchRevertGltfChannel — D3 unit tests (Phase 7.12 Wave D, issue #108).
//
// Revert is STRUCTURAL, not value-equality (R-4): deleting the bone's baked
// KeyframeChannel node(s) makes the resolver's presence-based pick fall through
// to the clip on BOTH surfaces — the renderer (C2, bakedChannelSamplersForAsset
// → resolveGltfChildTrs) AND the read-side (C3, resolveEvaluatedTransform).
//
// Load-bearing assertions (PLAN D3 verify):
//   1. revert deletes the baked channel node(s) as ONE atomic undo entry.
//   2. AFTER revert: the renderer path resolves the bone to the CLIP value
//      (presence gone → clip wins).
//   3. AFTER revert: the read-side resolveEvaluatedTransform resolves to the
//      CLIP value too (read-side == renderer, BLOCK-1).
//   4. NO value-equality anywhere — the channel's ABSENCE is the fallback.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../../core/dag';
import { buildDefaultDagState } from '../../core/project/default';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchRevertGltfChannel } from './dispatchMutator';
import { resolveEvaluatedTransform } from '../resolveEvaluatedTransform';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from '../bakedGltfChannels';
import { resolveGltfChildTrs, type ChildTrs } from '../resolveGltfChildTransform';
import { gltfChildDagId, gltfChannelDagId } from '../../core/import/gltfImportChain';

const ASSET = 'asset-d3';
const CHILD = 'bone_1';
const CHILD_ID = gltfChildDagId(ASSET, CHILD);

const BASE_POS: [number, number, number] = [1, 0, 0];
const CLIP_POS: [number, number, number] = [9, 9, 9];
const BAKED_POS: [number, number, number] = [3, 3, 3];

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** GltfAsset(+clip track) → GltfChild + a baked position channel.
 *  Starts from the default project so `outputs.render` exists — the read-side
 *  resolveEvaluatedTransform bails to null without a render anchor (line 94). */
function buildBakedState(): DagState {
  let s = buildDefaultDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET, nodeNameMap: { [CHILD]: CHILD_ID } },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: CHILD_ID,
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: CHILD,
      position: BASE_POS,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      overridden: { position: false, rotation: false, scale: false },
    },
  }).next;
  // The clip track (keyed by childName) — survives the revert (D-02 coexist).
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip',
    nodeType: 'TransformClip',
    params: {
      name: 'anim',
      duration: 1,
      keyframes: [{ targetNodeId: CHILD, time: 0, position: CLIP_POS, rotation: [0, 0, 0] }],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_clip', socket: 'out' },
    to: { node: 'n_gltf', socket: 'transformClip' },
  }).next;
  // The baked position channel (BLOCK-2 dual key, edge-less).
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChannelDagId(ASSET, CHILD, 'position'),
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'baked',
      target: CHILD_ID,
      childName: CHILD,
      assetRef: ASSET,
      paramPath: 'position',
      keyframes: [{ time: 0, value: BAKED_POS, easing: 'linear' }],
    },
  }).next;
  return s;
}

/** Renderer (C2) path: enumerate baked samplers → sample → resolve. */
function rendererResolvePosition(nodes: Record<string, { type: string; params?: unknown }>) {
  const samplers = bakedChannelSamplersForAsset(nodes, { [CHILD]: CHILD_ID });
  const bakedChannel = sampleBakedChannel(samplers[CHILD], 0);
  const childNode = nodes[CHILD_ID]?.params as {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    overridden: { position: boolean; rotation: boolean; scale: boolean };
  };
  const clipTrack: ChildTrs = { position: CLIP_POS, rotation: [0, 0, 0], scale: [1, 1, 1] };
  return resolveGltfChildTrs({
    base: { position: childNode.position, rotation: childNode.rotation, scale: childNode.scale },
    clipTrack,
    childNode: { ...childNode },
    bakedChannel,
  }).position;
}

describe('dispatchRevertGltfChannel (D3 — presence-based fallback)', () => {
  it('pre-revert: BOTH surfaces resolve the bone to the BAKED value (presence wins over clip)', () => {
    const s = buildBakedState();
    // Renderer (C2) path.
    expect(rendererResolvePosition(s.nodes)).toEqual(BAKED_POS);
    // Read-side (C3) path.
    const r = resolveEvaluatedTransform(s, CHILD_ID, ctxAt(0));
    expect(r!.position).toEqual(BAKED_POS);
  });

  it('revert deletes the baked channel as ONE undo; BOTH surfaces fall through to the CLIP', () => {
    useDagStore.getState().hydrate(buildBakedState());
    expect(useDagStore.getState().undoStack).toHaveLength(0);

    const res = dispatchRevertGltfChannel({ assetRef: ASSET, childName: CHILD });
    expect(res).toEqual({ ok: true });

    const after = useDagStore.getState().state;
    // (1) the baked channel node is GONE.
    expect(after.nodes[gltfChannelDagId(ASSET, CHILD, 'position')]).toBeUndefined();
    // ONE atomic undo entry.
    const stack = useDagStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect((stack[0] as { __atomic?: true }).__atomic).toBe(true);

    // (2) renderer path: presence gone → clip wins (NOT base, NOT the stale bake).
    expect(rendererResolvePosition(after.nodes)).toEqual(CLIP_POS);
    // (3) read-side path: same — clip, identical to the renderer (BLOCK-1).
    const r = resolveEvaluatedTransform(after, CHILD_ID, ctxAt(0));
    expect(r!.position).toEqual(CLIP_POS);

    // One undo restores the baked channel (revert is itself undoable).
    useDagStore.getState().undo();
    const restored = useDagStore.getState().state;
    expect(restored.nodes[gltfChannelDagId(ASSET, CHILD, 'position')]).toBeDefined();
    expect(rendererResolvePosition(restored.nodes)).toEqual(BAKED_POS);
  });

  it('revert on a bone with NO baked channel is a no-op (ok, nothing applied)', () => {
    // A scene with the child but no baked channel.
    let s = buildDefaultDagState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_gltf',
      nodeType: 'GltfAsset',
      params: { assetRef: ASSET, nodeNameMap: { [CHILD]: CHILD_ID } },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: CHILD_ID,
      nodeType: 'GltfChild',
      params: {
        assetRef: ASSET,
        childName: CHILD,
        position: BASE_POS,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        overridden: { position: false, rotation: false, scale: false },
      },
    }).next;
    useDagStore.getState().hydrate(s);

    const res = dispatchRevertGltfChannel({ assetRef: ASSET, childName: CHILD });
    expect(res).toEqual({ ok: true });
    expect(useDagStore.getState().undoStack).toHaveLength(0); // nothing applied
  });
});
