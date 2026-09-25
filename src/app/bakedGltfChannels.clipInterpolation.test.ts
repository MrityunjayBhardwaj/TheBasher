// #1225 — the clone road's baked band reads a clip's interpolation as the clip's own pose does:
// a `constant` clip steps on a refused-file character too, instead of ramping between its keys.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { gltfChildDagId } from '../core/import/gltfImportChain';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from './bakedGltfChannels';

const REF = 'asset://interp.glb';
const BONES = ['Hips', 'Spine'];

function nodes(interpolation?: 'linear' | 'constant') {
  return {
    n_asset: {
      type: 'GltfAsset',
      params: {
        assetRef: REF,
        nodeNameMap: Object.fromEntries(BONES.map((b) => [b, gltfChildDagId(REF, b)])),
        skins: [
          {
            jointKeys: BONES,
            bindTRS: BONES.map(() => ({
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            })),
            parentJointIndex: [-1, 0],
            inverseBindMatrices: BONES.map(() => Array(16).fill(0)),
          },
        ],
      },
      inputs: {},
    },
    n_skel: {
      type: 'GltfSkeleton',
      params: { skinIndex: 0 },
      inputs: { asset: { node: 'n_asset', socket: 'out' } },
    },
    n_clip: {
      type: 'AnimationClip',
      params: {
        name: 'step',
        duration: 1,
        loop: 'hold',
        ...(interpolation ? { interpolation } : {}),
        keyframes: [
          { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
          { bone: 1, time: 1, position: [0, 3, 0], rotation: [0, 0, 0] },
        ],
      },
      inputs: { skeleton: { node: 'n_skel', socket: 'out' } },
    },
  };
}

function spineAt(interpolation: 'linear' | 'constant' | undefined, seconds: number) {
  const n = nodes(interpolation);
  const s = bakedChannelSamplersForAsset(
    n as never,
    n.n_asset.params.nodeNameMap as Record<string, string>,
    REF,
  );
  return sampleBakedChannel(s.Spine, seconds)?.position;
}

describe('the baked band honours the clip’s interpolation', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('constant steps; linear, and a clip saved before the choice, ramp', () => {
    expect(spineAt('constant', 0.5)).toEqual([0, 1, 0]);
    expect(spineAt('constant', 1)).toEqual([0, 3, 0]);
    expect(spineAt('linear', 0.5)).toEqual([0, 2, 0]);
    expect(spineAt(undefined, 0.5)).toEqual([0, 2, 0]);
  });
});
