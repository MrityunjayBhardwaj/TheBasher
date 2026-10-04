// #1225 — the pose wire says what time range it covers (Houdini's `clipinfo`) and, since #1456, the
// times that read every pose it holds, so a consumer that samples the wire — a retarget, a bake —
// needs nothing but the wire.
//
// A linear clip's times are its keys: checked here against the times three keys from the same poses,
// so a retarget that reads the range samples where three samples the keys. The fills a curve needs
// between keys are pinned in `wireSampleTimes.gate.test.ts`.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { parseBvh } from '../core/import/bvh';
import { posesToThreeClip } from '../core/import/threeAdapter';
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
  // soma-walk.bvh: 78 bones, 31 keys over 1 s, so 31 samples, one per key.
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
    const three = posesToThreeClip(
      clipParams.name,
      clipParams.duration,
      clipParams.poses,
      skeletonParams.bones,
    );
    // #1456 — a linear clip is sampled at its keys: the times three's tracks key, both ends
    // included, and nothing between them (a slerp between keys is what its keys reproduce).
    const keyTimes = [...new Set(three.tracks.flatMap((t) => [...t.times]))].sort((a, b) => a - b);

    expect(pose.clip).toEqual({
      start: 0,
      end: clipParams.duration,
      times: keyTimes,
      name: 'soma-walk',
      loop: clipParams.loop,
    });
    // The samples land on the keys: as many samples as the densest bone has keys.
    const densest = Math.max(...three.tracks.map((t) => t.times.length));
    expect(pose.clip!.times).toHaveLength(densest);
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
    const { members } = state.nodes[baseId].params as { members: unknown[] };
    const expected = poseLayerClipInfo(
      channels as Parameters<typeof poseLayerClipInfo>[0],
      members as Parameters<typeof poseLayerClipInfo>[1],
    );
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
