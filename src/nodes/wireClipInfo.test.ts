// #1225 — the pose wire says what time range it covers and how densely (Houdini's `clipinfo`), so a
// consumer that samples the wire — a retarget — needs nothing but the wire.
//
// The rate rule is three's own (`SkeletonUtils.js:204`): the densest track's key count over the
// duration. A clip's range is checked against three deriving it from the same keys, so a retarget
// that reads the range samples exactly where today's samples the keys.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { parseBvh } from '../core/import/bvh';
import { paramsToThreeClip } from '../core/import/threeAdapter';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { registerAllNodes } from './registerAll';
import { AnimationClipNode, AnimationClipParams, type ClipOutputs } from './AnimationClip';
import { poseLayerClipInfo } from './PoseLayer';
import type { ObjectValue, PosedSkeletonValue } from './types';
import { clipNodeParams } from '../test-utils/bvhClip';

const at = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A node's pose wire: its value, or its value's `pose` when it hands out more than one output. */
function poseOf(state: DagState, id: string): PosedSkeletonValue {
  const value = evaluate(state, id, at).value;
  return (value as { pose?: PosedSkeletonValue }).pose ?? (value as PosedSkeletonValue);
}

describe('a clip puts its range on the wire', () => {
  // soma-walk.bvh: 78 bones, 31 keys over 1 s, so rate 31 and 31 samples, one per key.
  it('soma-walk.bvh: [0, duration] at the rate three derives from the same keys', () => {
    const parsed = parseBvh(
      readFileSync('public/fixtures/anim/soma-walk.bvh', 'utf8'),
      'soma-walk',
    );
    const { skeletonParams, clipParams } = parsed;
    const { pose } = AnimationClipNode.evaluate(
      AnimationClipParams.parse(clipNodeParams(parsed)),
      { skeleton: { kind: 'Skeleton', bones: skeletonParams.bones } },
      at.ctx,
    ) as ClipOutputs;
    const three = paramsToThreeClip(
      clipParams.name,
      clipParams.duration,
      clipParams.keyframes,
      skeletonParams.bones,
    );
    const threeFps = Math.max(...three.tracks.map((t) => t.times.length)) / three.duration;

    expect(pose.clip).toEqual({
      start: 0,
      end: clipParams.duration,
      rate: threeFps,
      name: 'soma-walk',
      loop: clipParams.loop,
    });
    // The samples land on the keys: as many samples as the densest bone has keys.
    const densest = Math.max(...three.tracks.map((t) => t.times.length));
    expect(Math.round((pose.clip!.end - pose.clip!.start) * pose.clip!.rate)).toBe(densest);
    expect(densest).toBe(31);
  });

  it('a clip with no keys has no range', () => {
    const { pose } = AnimationClipNode.evaluate(
      AnimationClipParams.parse({ duration: 2, poses: [] }),
      { skeleton: { kind: 'Skeleton', bones: [] } },
      at.ctx,
    ) as ClipOutputs;
    expect(pose.clip).toBeUndefined();
  });
});

describe('a base layer gives the wire its range; everything above passes it through', () => {
  async function bar(): Promise<{ state: DagState; armatureId: string; baseId: string }> {
    let state = buildDefaultDagState();
    const bytes = readFileSync('public/assets/skinned-bar.glb');
    const result = await buildNativeGltfImportOps({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: state.outputs.scene!.node,
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    for (const op of result.ops) state = applyOp(state, op).next;
    const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
    const armatureId = (state.nodes[modifierId].inputs.armature as { node: string }).node;
    const baseId = (state.nodes[armatureId].inputs.pose as { node: string }).node;
    return { state, armatureId, baseId };
  }

  it('the imported base layer: from its first key to its last, and the Object carries it', async () => {
    const { state, armatureId, baseId } = await bar();
    expect(state.nodes[baseId].type).toBe('PoseLayer');
    const channels = (state.nodes[baseId].params as { channels: unknown[] }).channels;
    const expected = poseLayerClipInfo(channels as Parameters<typeof poseLayerClipInfo>[0]);
    expect(expected).toBeDefined();
    // skinned-bar keys Bone1 from 0 to 1 s (#1211 fixture header).
    expect(expected!.start).toBe(0);
    expect(expected!.end).toBeCloseTo(1, 6);
    // The base layer is named after the file's animation, and names its range too.
    const named = { ...expected, name: (state.nodes[baseId].params as { name: string }).name };
    expect(poseOf(state, baseId).clip).toEqual(named);
    const object = evaluate(state, armatureId, at).value as ObjectValue & {
      pose: PosedSkeletonValue;
    };
    expect(object.pose.clip).toEqual(named);
  });

  it('a layer and an override above the base pass the range through; muted too', async () => {
    const { state: s0, armatureId, baseId } = await bar();
    const range = poseOf(s0, baseId).clip;
    let s = s0;
    for (const [id, type, params] of [
      // Keyed from 5 to 9 s: a layer above the base must not report its own keys' range.
      [
        'lift',
        'PoseLayer',
        {
          mode: 'additive',
          members: [{ bone: 'Bone1' }],
          channels: [
            {
              bone: 'Bone1',
              component: 'position',
              keyframes: [
                { time: 5, value: [0, 0, 0], easing: 'linear' },
                { time: 9, value: [0, 1, 0], easing: 'linear' },
              ],
            },
          ],
        },
      ],
      ['quiet', 'PoseLayer', { mute: true, members: [{ bone: 'Bone1', rotation: [0, 0, 30] }] }],
      ['hold', 'PoseOverride', { bone: 'Bone1', overridden: { rotation: true } }],
    ] as const) {
      const feed = s.nodes[armatureId].inputs.pose as { node: string; socket: string };
      s = applyOp(s, { type: 'addNode', nodeId: id, nodeType: type, params }).next;
      s = applyOp(s, { type: 'connect', from: feed, to: { node: id, socket: 'pose' } }).next;
      s = applyOp(s, {
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: armatureId, socket: 'pose' },
        replace: true,
      }).next;
      expect(poseOf(s, id).clip, id).toEqual(range);
    }
  });

  it('a skeleton at rest has no range, and a base layer with no keys adds none', async () => {
    const { state, baseId } = await bar();
    const skeletonFeed = state.nodes[baseId].inputs.pose as { node: string; socket: string };
    expect(poseOf(state, skeletonFeed.node).clip).toBeUndefined();
    const keyless = applyOp(state, {
      type: 'setParam',
      nodeId: baseId,
      paramPath: 'channels',
      value: [],
    }).next;
    expect(poseOf(keyless, baseId).clip).toBeUndefined();
  });
});
