// dispatchRevertGltfChannel — D3 unit tests (Phase 7.12 Wave D, issue #108).
//
// Revert is STRUCTURAL, not value-equality (R-4): it deletes the bone's baked KeyframeChannel
// node(s) as one atomic undo. (#1053) The rows that read what the clone renderer and the read side
// resolved after a revert are gone with the clone renderer; what is left pins the graph edit.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, type DagState } from '../../core/dag';
import { buildDefaultDagState } from '../../core/project/default';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchRevertGltfChannel } from './dispatchMutator';
import { gltfChildDagId, gltfChannelDagId } from '../../core/import/gltfImportChain';
import { importedChildOps } from '../../test-utils/importedChildFixture';

const ASSET = 'asset-d3';
const CHILD = 'bone_1';
const CHILD_ID = gltfChildDagId(ASSET, CHILD);

const BASE_POS: [number, number, number] = [1, 0, 0];
const CLIP_POS: [number, number, number] = [9, 9, 9];
const BAKED_POS: [number, number, number] = [3, 3, 3];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
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
  for (const op of importedChildOps(CHILD_ID, {
    assetRef: ASSET,
    childName: CHILD,
    position: BASE_POS,
  })) {
    s = applyOp(s, op as Op).next;
  }
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

describe('dispatchRevertGltfChannel (D3 — presence-based fallback)', () => {
  it('component-scoped revert takes ONE channel and leaves the bone\u2019s others (#909)', () => {
    // The dopesheet's Clear points at a ROW, which is one component. Reverting
    // the whole bone from a row would take away a track the director never
    // touched — removal granularity has to match the granularity of the thing
    // that created it, and copy-on-write mints per component.
    let s = buildBakedState();
    const rotId = gltfChannelDagId(ASSET, CHILD, 'rotation');
    s = applyOp(s, {
      type: 'addNode',
      nodeId: rotId,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'baked rotation',
        target: CHILD_ID,
        childName: CHILD,
        assetRef: ASSET,
        paramPath: 'rotation',
        keyframes: [{ time: 0, value: [10, 20, 30], easing: 'linear' }],
      },
    }).next;
    useDagStore.getState().hydrate(s);

    const posId = gltfChannelDagId(ASSET, CHILD, 'position');
    expect(
      dispatchRevertGltfChannel({ assetRef: ASSET, childName: CHILD, component: 'rotation' }),
    ).toEqual({
      ok: true,
    });

    const nodes = useDagStore.getState().state.nodes;
    expect(rotId in nodes).toBe(false);
    // The half that carries the claim: naming a component must not be a
    // decoration on a call that still takes everything.
    expect(posId in nodes).toBe(true);
  });

  it('omitting the component still takes the whole bone — the original caller is unchanged', () => {
    let s = buildBakedState();
    const rotId = gltfChannelDagId(ASSET, CHILD, 'rotation');
    s = applyOp(s, {
      type: 'addNode',
      nodeId: rotId,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'baked rotation',
        target: CHILD_ID,
        childName: CHILD,
        assetRef: ASSET,
        paramPath: 'rotation',
        keyframes: [{ time: 0, value: [10, 20, 30], easing: 'linear' }],
      },
    }).next;
    useDagStore.getState().hydrate(s);

    expect(dispatchRevertGltfChannel({ assetRef: ASSET, childName: CHILD })).toEqual({ ok: true });
    const nodes = useDagStore.getState().state.nodes;
    expect(rotId in nodes).toBe(false);
    expect(gltfChannelDagId(ASSET, CHILD, 'position') in nodes).toBe(false);
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
    for (const op of importedChildOps(CHILD_ID, {
      assetRef: ASSET,
      childName: CHILD,
      position: BASE_POS,
    })) {
      s = applyOp(s, op as Op).next;
    }
    useDagStore.getState().hydrate(s);

    const res = dispatchRevertGltfChannel({ assetRef: ASSET, childName: CHILD });
    expect(res).toEqual({ ok: true });
    expect(useDagStore.getState().undoStack).toHaveLength(0); // nothing applied
  });
});
