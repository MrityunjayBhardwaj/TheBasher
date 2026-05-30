import { describe, it, expect } from 'vitest';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from './bakedGltfChannels';

// P7.12 #108 (C2/C3) — the shared baked-channel enumerator. Both the renderer
// (SceneFromDAG useFrame) and the read-side resolver (resolveEvaluatedTransform)
// consume THIS, so its key (childName, BLOCK-2) + membership (nodeNameMap) +
// presence (R-4) semantics are asserted once here.

// Minimal node shape (the enumerator reads only type + params).
function channelNode(params: Record<string, unknown>) {
  return { type: 'KeyframeChannelVec3', params };
}

const NODE_NAME_MAP = {
  bone_1: 'n_gltfChild_aaa',
  bone_2: 'n_gltfChild_bbb',
};

describe('bakedChannelSamplersForAsset', () => {
  it('keys by childName and groups components by paramPath (BLOCK-2)', () => {
    const nodes = {
      ch_pos: channelNode({
        childName: 'bone_1',
        target: 'n_gltfChild_aaa',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [10, 0, 0], easing: 'linear' },
        ],
      }),
      ch_rot: channelNode({
        childName: 'bone_1',
        target: 'n_gltfChild_aaa',
        paramPath: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [0, 90, 0], easing: 'linear' },
        ],
      }),
    };
    const out = bakedChannelSamplersForAsset(nodes, NODE_NAME_MAP);
    expect(Object.keys(out)).toEqual(['bone_1']);
    expect(out.bone_1.position).toBeTypeOf('function');
    expect(out.bone_1.rotation).toBeTypeOf('function');
    expect(out.bone_1.scale).toBeUndefined();
    // function-of-time: midpoint of a linear ramp.
    expect(out.bone_1.position!(1)).toEqual([5, 0, 0]);
    expect(out.bone_1.rotation!(1)).toEqual([0, 45, 0]);
  });

  it('excludes a channel whose target dagId disagrees with nodeNameMap (membership)', () => {
    const nodes = {
      // childName maps to n_gltfChild_aaa, but target says ...zzz → NOT this asset.
      ch: channelNode({
        childName: 'bone_1',
        target: 'n_gltfChild_zzz',
        paramPath: 'position',
        keyframes: [{ time: 0, value: [1, 2, 3], easing: 'linear' }],
      }),
    };
    expect(bakedChannelSamplersForAsset(nodes, NODE_NAME_MAP)).toEqual({});
  });

  it('ignores ordinary authored channels with no childName', () => {
    const nodes = {
      authored: channelNode({
        // no childName — an addChannel-authored channel, not a bake.
        target: 'some_box',
        paramPath: 'position',
        keyframes: [{ time: 0, value: [1, 1, 1], easing: 'linear' }],
      }),
      nonChannel: { type: 'BoxMesh', params: { childName: 'bone_1' } },
    };
    expect(bakedChannelSamplersForAsset(nodes, NODE_NAME_MAP)).toEqual({});
  });

  it('ignores an unknown paramPath', () => {
    const nodes = {
      ch: channelNode({
        childName: 'bone_1',
        target: 'n_gltfChild_aaa',
        paramPath: 'color',
        keyframes: [{ time: 0, value: [1, 1, 1], easing: 'linear' }],
      }),
    };
    expect(bakedChannelSamplersForAsset(nodes, NODE_NAME_MAP)).toEqual({});
  });
});

describe('sampleBakedChannel', () => {
  it('returns undefined for an absent child (falls through to clip/base)', () => {
    expect(sampleBakedChannel(undefined, 0)).toBeUndefined();
  });

  it('samples only the present components at the given seconds (presence, R-4)', () => {
    const samplers = {
      position: (s: number) => [s, 0, 0] as [number, number, number],
    };
    const baked = sampleBakedChannel(samplers, 3);
    expect(baked).toEqual({ position: [3, 0, 0] });
    // rotation/scale ABSENT (keys do not exist) → resolver falls through for them.
    expect('rotation' in baked!).toBe(false);
    expect('scale' in baked!).toBe(false);
  });
});
