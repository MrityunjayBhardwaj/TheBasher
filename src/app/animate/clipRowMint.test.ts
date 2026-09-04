// #889 slice 3 / #903 — dragging a key on a GENERATED character's clip row.
//
// Before this, `dispatchBakeThenRetime` minted through `bakeGltfChannel`, which
// reads the active TransformClip. A generated / BVH / retargeted motion is an
// AnimationClip, so that mutator refused — "No active clip track for bone" —
// and the drag aborted at the first step, doing nothing at all.

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchBakeThenRetime } from './dispatchMutator';
import { animationClipCarriesBone, clipRowMintOps } from './clipRowMint';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ASSET = 'asset-generated';
const BONE = 'mixamorig_LeftArm';
const OTHER = 'mixamorig_Hips';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** GltfAsset → GltfSkeleton ← AnimationClip, plus the bone. The clip hangs off
 *  the rig by EDGE, which is what makes its bone indices meaningful. */
function generatedScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_gltf',
    nodeType: 'GltfAsset',
    params: {
      assetRef: ASSET,
      skins: [
        {
          jointKeys: [OTHER, BONE],
          bindTRS: [
            { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          ],
          parentJointIndex: [-1, 0],
          inverseBindMatrices: [IDENTITY16, IDENTITY16],
        },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_rig',
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_gltf', socket: 'out' },
    to: { node: 'n_rig', socket: 'asset' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_clip',
    nodeType: 'AnimationClip',
    params: {
      duration: 1,
      loop: true,
      keyframes: [
        { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
        { bone: 1, time: 1, position: [0, 2, 0], rotation: [0, 0, 0] },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_rig', socket: 'out' },
    to: { node: 'n_clip', socket: 'skeleton' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: gltfChildDagId(ASSET, BONE),
    nodeType: 'GltfChild',
    params: {
      assetRef: ASSET,
      childName: BONE,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  }).next;
  return s;
}

describe('which road the bone is on', () => {
  it('recognises a clip bound to the rig by edge', () => {
    expect(animationClipCarriesBone(generatedScene(), ASSET, BONE)).toBe(true);
  });

  it('says no for a bone the bound clip never keys', () => {
    // OTHER is in jointKeys but has no keyframes — a bone the motion does not
    // touch. Answering yes here would mint a channel seeded from nothing.
    expect(animationClipCarriesBone(generatedScene(), ASSET, OTHER)).toBe(false);
  });

  it('picks the AnimationClip mint, and it emits ops', () => {
    const mint = clipRowMintOps(generatedScene(), ASSET, BONE, 'rotation');
    expect(mint.ok).toBe(true);
    if (!mint.ok) return;
    expect(mint.source).toBe('animation-clip');
    expect(mint.ops).toHaveLength(1);
    // The closure DESCRIBES the ops it came with: every node the mint touches
    // is a declared root. Asserting the array literally would pin a shape;
    // asserting coverage pins the property that makes a closure spec worth
    // having. (What it does NOT do is keep the composite's later write legal —
    // each retime step declares its own root, measured by removing this one and
    // watching every drag row stay green.)
    const targets = mint.ops.map((o) => ('nodeId' in o ? o.nodeId : null));
    for (const t of targets) expect(mint.closure.rootSelectors).toContain(t);
    expect(mint.closure.rootSelectors).toContain(gltfChildDagId(ASSET, BONE));
  });

  it('mints nothing when the channel is already there', () => {
    const base = generatedScene();
    const first = clipRowMintOps(base, ASSET, BONE, 'rotation');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let s = base;
    for (const op of first.ops) s = applyOp(s, op).next;
    const second = clipRowMintOps(s, ASSET, BONE, 'rotation');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ops).toHaveLength(0);
  });
});

describe('dragging a key on a generated character’s clip row', () => {
  it('mints the bone’s channel AND retimes the key, as one entry', () => {
    useDagStore.getState().hydrate(generatedScene());
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();

    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: BONE,
      component: 'position',
      fromTime: 1,
      toTime: 0.5,
    });
    expect(res.ok).toBe(true);

    const channel = useDagStore.getState().state.nodes[channelId];
    expect(channel).toBeDefined();
    const keys = (channel!.params as { keyframes: { time: number; value: number[] }[] }).keyframes;
    // The clip's OWN track survived the edit — the key moved from 1 to 0.5 and
    // the key at 0 is still there. A mint that seeded from nothing would leave
    // a single key and still pass an "ok === true" assertion.
    expect(keys.map((k) => k.time)).toEqual([0, 0.5]);
    expect(keys.find((k) => k.time === 0.5)!.value).toEqual([0, 2, 0]);
    expect(keys.find((k) => k.time === 0)!.value).toEqual([0, 1, 0]);
  });

  it('is ONE undo — reverting takes the channel away with the edit', () => {
    useDagStore.getState().hydrate(generatedScene());
    const channelId = gltfChannelDagId(ASSET, BONE, 'position');
    expect(
      dispatchBakeThenRetime({
        assetRef: ASSET,
        childName: BONE,
        component: 'position',
        fromTime: 1,
        toTime: 0.5,
      }).ok,
    ).toBe(true);
    expect(useDagStore.getState().state.nodes[channelId]).toBeDefined();
    useDagStore.getState().undo();
    expect(useDagStore.getState().state.nodes[channelId]).toBeUndefined();
  });

  it('refuses a bone the bound clip never keys, rather than minting from nothing', () => {
    useDagStore.getState().hydrate(generatedScene());
    const res = dispatchBakeThenRetime({
      assetRef: ASSET,
      childName: OTHER,
      component: 'position',
      fromTime: 0,
      toTime: 0.5,
    });
    expect(res.ok).toBe(false);
  });
});
