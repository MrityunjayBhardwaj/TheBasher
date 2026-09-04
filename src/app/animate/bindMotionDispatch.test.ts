// The dispatch behind the drop road — what binding a motion to a character
// actually puts in the graph (#807, #889).
//
// ─────────────────────────────────────────────────────────────────────────
// 🔑 THIS FILE EXISTS TO PIN AN ABSENCE
// ─────────────────────────────────────────────────────────────────────────
// Until #889 slice 3 this dispatched retarget AND `bakeClipOntoRig` as one
// composite, and `bakeClipOntoRig` emitted a `KeyframeChannelVec3` for every
// bone on the rig. The read band reaches a bound clip directly (#888), so those
// channels were a duplicate of what the clip already produced — measured on
// `Robot-Walk.basher`: 46 channels for 23 bones, and stripping all 46 leaves the
// same 23 bones driven with the sampled rotations agreeing to 6e-14.
//
// So the central assertion here is a ZERO. A bind that quietly started emitting
// channels again would be invisible in the viewport (the values would match) and
// would restore every staleness defect #877 catalogued, so the count is the only
// thing that can catch it.
//
// ─────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS FILE GATES, AND WHAT IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────
// WIRING, not VALUES. It asserts which nodes exist after a bind, never what a
// bone's rotation is at a given time. What covers the values:
//   - ensureChannelForBone.test.ts     — the mint's seed and its rad→deg boundary
//   - bakedClipParity.gate.test.ts     — band vs clip BETWEEN keyframes (#877)
//   - gltfEulerContinuity.gate.test.ts — the representative choice (#876)
//
// REF: issues #883, #807, #889.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { gltfChannelDagId, gltfSkeletonDagId } from '../../core/import/gltfImportChain';
import type { GltfSkinMetadata } from '../../nodes/types';

const ASSET = 'assets/char.glb';
const BONES = ['mixamorig_Hips', 'mixamorig_Spine'];
const SKEL = gltfSkeletonDagId(ASSET, 0);

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

function skin(names: string[]): GltfSkinMetadata {
  return {
    jointKeys: names,
    bindTRS: names.map(() => ({
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    })),
    parentJointIndex: names.map((_, i) => (i === 0 ? -1 : 0)),
    inverseBindMatrices: [],
  };
}

/** A character with a rig, a TimeSource, and one imported motion clip. */
function buildScene(clipId: string, rotationAtEnd: number): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'n_time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_asset',
    nodeType: 'GltfAsset',
    params: { assetRef: ASSET, nodeNameMap: {}, childHierarchy: {}, skins: [skin(BONES)] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: SKEL,
    nodeType: 'GltfSkeleton',
    params: { skinIndex: 0 },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_asset', socket: 'out' },
    to: { node: SKEL, socket: 'asset' },
  }).next;
  // The imported motion's OWN skeleton — same names here, so the shared-name
  // bridge applies and the retarget is not the thing under test.
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_src_skel',
    nodeType: 'Skeleton',
    params: {
      bones: BONES.map((name, i) => ({
        name,
        parent: i === 0 ? -1 : 0,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
      })),
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: clipId,
    nodeType: 'AnimationClip',
    params: {
      name: 'motion',
      duration: 2,
      keyframes: [
        { bone: 1, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
        { bone: 1, time: 2, position: [0, 0, 0], rotation: [0, rotationAtEnd, 0] },
      ],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_src_skel', socket: 'out' },
    to: { node: clipId, socket: 'skeleton' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'n_time', socket: 'out' },
    to: { node: clipId, socket: 'time' },
  }).next;
  return s;
}

/** The same call `bindMotionToCharacter` makes once it has chosen the character
 *  and the bone-name bridge. */
const bind = (clipId: string, out: string) =>
  dispatchMutatorFromUI(
    'mutator.animation.retarget',
    {
      sourceClipId: clipId,
      sourceSkeletonId: 'n_src_skel',
      targetSkeletonId: SKEL,
      customMap: Object.fromEntries(BONES.map((b) => [b, b])),
      outputClipId: out,
      outputName: 'bound motion',
    },
    'Bind motion to rig: bound motion',
  );

/** Every baked/minted channel node in the graph, whatever bone it is for. */
const channelIds = () =>
  Object.values(useDagStore.getState().state.nodes)
    .filter((n) => n.type === 'KeyframeChannelVec3')
    .map((n) => n.id);

describe('binding a motion to a character', () => {
  it('creates the retargeted clip and NOT ONE channel', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    expect(nodes['n_out_a']?.type).toBe('AnimationClip');
    // THE ASSERTION. Copy-on-write: the clip drives every bone through the read
    // band, and a channel appears only when a director edits one.
    expect(channelIds()).toEqual([]);
    // Named as well as counted — a zero can be satisfied by a bind that failed,
    // and the clip above proves this one did not.
    expect(nodes[gltfChannelDagId(ASSET, 'mixamorig_Spine', 'rotation')]).toBeUndefined();
  });

  it('lands as ONE undo entry', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });
    expect(useDagStore.getState().undoStack).toHaveLength(1);
  });

  it('ACCEPTS a second, different motion — there is no longer anything to destroy', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });

    // A DIFFERENT motion onto the same rig. Under the eager bake this was
    // REFUSED, because every channel id the second bind would emit already
    // existed and the emitter skipped them all — so it reported success having
    // changed nothing (measured in a browser: channel count stayed 46 and the
    // rendered pose was byte-identical at five bones across three times). With
    // no channels to collide with, the refusal has nothing left to protect.
    let s = useDagStore.getState().state;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_clip_b',
      nodeType: 'AnimationClip',
      params: {
        name: 'other motion',
        duration: 2,
        keyframes: [
          { bone: 1, time: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 2, position: [0, 0, 0], rotation: [0, -140, 0] },
        ],
      },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_src_skel', socket: 'out' },
      to: { node: 'n_clip_b', socket: 'skeleton' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_time', socket: 'out' },
      to: { node: 'n_clip_b', socket: 'time' },
    }).next;
    useDagStore.getState().hydrate(s);

    expect(bind('n_clip_b', 'n_out_b')).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    expect(nodes['n_out_a']?.type).toBe('AnimationClip');
    expect(nodes['n_out_b']?.type).toBe('AnimationClip');
    expect(channelIds()).toEqual([]);
  });
});
