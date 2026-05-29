// P7.11 Wave B (D-03) — BoneSpec scale round-trip through the THREE adapter.
//
// specToThreeSkeleton must honor optional bind-pose scale (so the retarget
// bind pose stays deform-faithful), and bonesToSpec must read it back losslessly.
// IBM is deliberately NOT round-tripped here (the adapter has no IBM source;
// retarget reconstructs inverses from the bind pose — it rides on GltfSkeleton
// output only). Back-compat: a legacy BoneSpec without scale leaves the Bone's
// default [1,1,1] untouched.

import { describe, it, expect } from 'vitest';
import { Bone } from 'three';
import { specToThreeSkeleton, bonesToSpec } from './threeAdapter';
import type { BoneSpec } from '../../nodes/types';

describe('threeAdapter — BoneSpec scale round-trip (P7.11 D-03)', () => {
  it('specToThreeSkeleton applies optional scale; absent scale stays default [1,1,1]', () => {
    const specs: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 3, 4] },
      { name: 'tip', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const { bones } = specToThreeSkeleton(specs);
    expect([bones[0].scale.x, bones[0].scale.y, bones[0].scale.z]).toEqual([2, 3, 4]);
    expect([bones[1].scale.x, bones[1].scale.y, bones[1].scale.z]).toEqual([1, 1, 1]);
  });

  it('bonesToSpec → specToThreeSkeleton → bonesToSpec is lossless for scale', () => {
    const root = new Bone();
    root.name = 'root';
    root.scale.set(2, 3, 4);
    const tip = new Bone();
    tip.name = 'tip';
    tip.position.set(0, 1, 0);
    root.add(tip);

    const specs = bonesToSpec([root, tip]);
    expect(specs[0].scale).toEqual([2, 3, 4]);
    expect(specs[1].scale).toEqual([1, 1, 1]);

    const { bones } = specToThreeSkeleton(specs);
    const back = bonesToSpec(bones);
    expect(back[0].scale).toEqual([2, 3, 4]);
    expect(back[1].scale).toEqual([1, 1, 1]);
  });

  it('does NOT round-trip inverseBindMatrix through the adapter (retarget reconstructs inverses)', () => {
    const specs: BoneSpec[] = [
      {
        name: 'root',
        parent: -1,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        inverseBindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1],
      },
    ];
    const { bones } = specToThreeSkeleton(specs);
    const back = bonesToSpec(bones);
    // IBM is not an adapter-derived datum — it must not appear on the way back.
    expect(back[0].inverseBindMatrix).toBeUndefined();
  });
});
