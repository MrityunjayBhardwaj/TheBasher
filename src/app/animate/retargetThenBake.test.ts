// dispatchRetargetThenBake — the composite behind the drop road (#807).
//
// The load-bearing case is the SECOND bind. A baked channel's id is
// content-addressed on assetRef + bone + component and NOT on the clip, and the
// shared emitter skips a channel that already exists. That guard is right for the
// sibling consumer (re-baking a bone from the asset's own embedded clip really is
// a no-op) and wrong here, where the source can be a completely different motion.
//
// Measured in a browser before the guard below existed: a second, different clip
// left the channel count at 46 and the rendered pose byte-identical at five bones
// across three times, while the action reported success. This pins the fix.
//
// 🔴 WHAT THIS FILE GATES, AND WHAT IT DOES NOT — read before trusting its green.
//
// This file gates WIRING, not VALUES. Its central assertion is
// `expect(JSON.stringify(after)).toBe(before)`: a self-comparison, which is the
// right instrument for the second-bind guard (the claim IS "nothing changed") and
// is structurally incapable of gating "the value is right". Any corruption present
// in both terms cancels exactly. Measured: dropping the rad→deg conversion in
// `bakeClipOntoRig` — a defect that scales every bone rotation by π/180 — leaves
// every row here GREEN.
//
// The name reads end-to-end, so its green invites an inference it does not
// support. What actually covers the values:
//   - bakeClipOntoRig.test.ts       — the conversion and the emitted values
//   - bakedClipParity.gate.test.ts  — bake vs clip BETWEEN keyframes (#877)
//   - gltfEulerContinuity.gate.test.ts — the representative choice (#876)
//
// REF: issue #883.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDagStore } from '../../core/dag/store';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchRetargetThenBake } from './dispatchMutator';
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

const bind = (clipId: string, out: string) =>
  dispatchRetargetThenBake({
    sourceClipId: clipId,
    sourceSkeletonId: 'n_src_skel',
    targetSkeletonId: SKEL,
    mapPresetId: null,
    customMap: Object.fromEntries(BONES.map((b) => [b, b])),
    outputClipId: out,
    outputName: 'bound motion',
  });

describe('dispatchRetargetThenBake', () => {
  it('binds a clip and emits the baked channels the renderer reads', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });

    const nodes = useDagStore.getState().state.nodes;
    expect(nodes['n_out_a']?.type).toBe('AnimationClip');
    expect(nodes[gltfChannelDagId(ASSET, 'mixamorig_Spine', 'rotation')]).toBeDefined();
  });

  it('lands both mutators as ONE undo entry', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });
    // One entry, not two — a single undo must not leave a retargeted clip that
    // poses the rig while nothing renders it.
    expect(useDagStore.getState().undoStack).toHaveLength(1);
  });

  it('REFUSES a second bind instead of reporting a success that changed nothing', () => {
    useDagStore.getState().hydrate(buildScene('n_clip_a', 60));
    expect(bind('n_clip_a', 'n_out_a')).toEqual({ ok: true });

    const channelId = gltfChannelDagId(ASSET, 'mixamorig_Spine', 'rotation');
    const before = JSON.stringify(useDagStore.getState().state.nodes[channelId].params);

    // A DIFFERENT motion onto the same rig. Every channel id it would emit
    // already exists, so the emitter skips them all.
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

    const result = bind('n_clip_b', 'n_out_b');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('already carries baked motion');
    // #813 — the refusal must NAME the way out. Before the character-level clear
    // existed this said "remove the existing baked channels first", an instruction
    // with no affordance behind it at that granularity.
    expect(result.reason).toContain('Clear baked motion');

    // And it mutated NOTHING — not a half-applied retarget, not a changed curve.
    const after = useDagStore.getState().state.nodes[channelId].params;
    expect(JSON.stringify(after)).toBe(before);
    expect(useDagStore.getState().state.nodes['n_out_b']).toBeUndefined();
  });
});
