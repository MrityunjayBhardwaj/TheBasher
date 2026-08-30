// P7.11 Wave B (D-03) — BoneSpec scale round-trip through the THREE adapter.
//
// specToThreeSkeleton must honor optional bind-pose scale (so the retarget
// bind pose stays deform-faithful), and bonesToSpec must read it back losslessly.
// IBM is deliberately NOT round-tripped here (the adapter has no IBM source;
// retarget reconstructs inverses from the bind pose — it rides on GltfSkeleton
// output only). Back-compat: a legacy BoneSpec without scale leaves the Bone's
// default [1,1,1] untouched.

import { describe, it, expect } from 'vitest';
import { Bone, Matrix4 } from 'three';
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

describe('a Skeleton is built with REAL bind inverses, not identity ones (#838)', () => {
  // The defect, measured: `new Skeleton(bones)` calls `calculateInverses()`,
  // which reads each bone's `matrixWorld`. A freshly constructed Object3D has an
  // IDENTITY matrixWorld until something updates it — assigning `position` and
  // `quaternion` does not — so every boneInverse came out identity.
  //
  // That is not dormant. `SkeletonUtils.retarget` calls `skeleton.pose()` on
  // EVERY FRAME, and `pose()` drives each bone from its inverse, so identity
  // inverses actively flatten the skeleton to the origin once per frame.
  //
  // One defect, three symptoms: the character folding into a blob (#828), a
  // corrective root rotation replaced by identity so the character lies down
  // (#838), and a walk that never travels (#839).
  const R = Math.PI / 2;
  /** Round for comparison AND collapse -0 to 0, which a rotation routinely produces. */
  const r4 = (v: readonly number[]) => v.map((n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(4)));
  const deg = (v: readonly number[]) =>
    v.map((n) => {
      const d = (n * 180) / Math.PI;
      return Math.abs(d) < 1e-6 ? 0 : +d.toFixed(2);
    });
  const rig: BoneSpec[] = [
    // A Z-up corrective root, as a real Tripo rig carries: [-90, 0, +90].
    { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [-R, 0, R] },
    { name: 'Hips', parent: 0, position: [0, 0, 0.51], rotation: [0, 0, 0] },
    { name: 'Spine', parent: 1, position: [0, 0.05, 0], rotation: [0, 0, 0] },
  ];

  it('the bind pose SURVIVES skeleton.pose(), which the retarget calls per frame', () => {
    const { skeleton, bones } = specToThreeSkeleton(rig);
    skeleton.pose();
    const after = bonesToSpec(bones);

    // The corrective rotation is the whole reason a Z-up rig stands up inside a
    // Y-up glTF. Identity here rotates the entire character ninety degrees.
    expect(deg(after[0].rotation)).toEqual([-90, 0, 90]);
    // And the limb offsets are the character's proportions.
    expect(r4(after[1].position)).toEqual([0, 0, 0.51]);
    expect(r4(after[2].position)).toEqual([0, 0.05, 0]);
  });

  it('no boneInverse is the identity, which is what made the flattening possible', () => {
    const { skeleton } = specToThreeSkeleton(rig);
    const identity = new Matrix4();
    // Root sits at the origin but carries a rotation, so even ITS inverse is not
    // the identity — an assertion that would pass vacuously on a rig whose root
    // is untransformed, which is exactly why no existing fixture caught this.
    for (const inv of skeleton.boneInverses) expect(inv.equals(identity)).toBe(false);
  });

  it('a FOREST gets every root updated, not just the first', () => {
    // `bones[0].updateMatrixWorld(true)` would leave a second root's subtree with
    // identity inverses — the same defect, surviving in the bones nobody looked at.
    const forest: BoneSpec[] = [
      { name: 'A', parent: -1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'B', parent: -1, position: [0, 0, 2], rotation: [R, 0, 0] },
      { name: 'B_child', parent: 1, position: [0, 0.3, 0], rotation: [0, 0, 0] },
    ];
    const { skeleton, bones } = specToThreeSkeleton(forest);
    skeleton.pose();
    const after = bonesToSpec(bones);
    expect(r4(after[1].position)).toEqual([0, 0, 2]);
    expect(r4(after[2].position)).toEqual([0, 0.3, 0]);
  });
});
