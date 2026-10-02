// FBX integration tests — synthetic THREE.Group with a SkinnedMesh +
// embedded clip. Avoids needing a real .fbx fixture by exercising the
// extractBones + threeAdapter conversion paths via constructed THREE
// objects. The real FBXLoader.parse() road, on the committed ASCII
// `rig.fbx`, is covered in fbxUnit.test.ts (the declared unit, #1086).
//
// Why this approach: FBX files are binary or massive ASCII; bundling a
// minimal valid one in the repo adds heft without much coverage. The
// load-bearing logic for our pipeline is "given THREE.Skeleton +
// THREE.AnimationClip, project to POJOs" — that's what these tests
// exercise.

import { describe, expect, it } from 'vitest';
import {
  AnimationClip,
  Bone,
  Group,
  QuaternionKeyframeTrack,
  SkinnedMesh,
  Skeleton,
  VectorKeyframeTrack,
} from 'three';
import { bonesToSpec, clipToPoses } from './threeAdapter';
import { quatFromEulerXYZ } from '../../nodes/bonePose';

function makeSkinnedGroup(): Group {
  const root = new Bone();
  root.name = 'Hips';
  root.position.set(0, 1, 0);
  const child = new Bone();
  child.name = 'Spine';
  child.position.set(0, 0.5, 0);
  root.add(child);

  const skeleton = new Skeleton([root, child]);
  const mesh = new SkinnedMesh();
  mesh.skeleton = skeleton;
  mesh.add(root);

  const group = new Group();
  group.add(mesh);
  return group;
}

describe('threeAdapter via FBX-shaped input', () => {
  it('extracts a SkinnedMesh skeleton into BoneSpec[] with parent indices', () => {
    const group = makeSkinnedGroup();
    let bones: Bone[] = [];
    group.traverse((o) => {
      const sm = o as unknown as SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton?.bones?.length) bones = [...sm.skeleton.bones];
    });
    const spec = bonesToSpec(bones);
    expect(spec).toHaveLength(2);
    expect(spec[0].name).toBe('Hips');
    expect(spec[0].parent).toBe(-1);
    expect(spec[1].name).toBe('Spine');
    expect(spec[1].parent).toBe(0);
  });

  it('clipToPoses merges position + quaternion tracks into one pose per time (#1432)', () => {
    const bones = bonesToSpec([
      ((): Bone => {
        const b = new Bone();
        b.name = 'Hips';
        b.rotation.set(0, 0.5, 0);
        return b;
      })(),
      ((): Bone => {
        const b = new Bone();
        b.name = 'Spine';
        b.position.set(0, 0.5, 0);
        return b;
      })(),
    ]);
    const positionTrack = new VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 2, 0]);
    const rotationTrack = new QuaternionKeyframeTrack(
      'Spine.quaternion',
      [0, 1],
      [0, 0, 0, 1, 0, 0.7071, 0, 0.7071],
    );
    const clip = new AnimationClip('test', 1, [positionTrack, rotationTrack]);
    const poses = clipToPoses(clip, bones);
    // One pose per time, in time order, each holding both bones.
    expect(poses.map((p) => p.time)).toEqual([0, 1]);
    for (const p of poses) expect(Object.keys(p.bones).sort()).toEqual(['Hips', 'Spine']);
    // Hips at t=1 has position [0,2,0], and its rest's rotation (it has no quaternion track).
    expect(poses[1].bones.Hips.position).toEqual([0, 2, 0]);
    expect(poses[1].bones.Hips.quaternion).toEqual(quatFromEulerXYZ(bones[0].rotation));
    expect(bones[0].rotation[1]).toBeCloseTo(0.5, 12);
    // Spine keeps its rest offset, and its quaternion is the track's, read as a unit quaternion
    // (three holds track values as float32).
    expect(poses[1].bones.Spine.position).toEqual([0, 0.5, 0]);
    const q = poses[1].bones.Spine.quaternion!;
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    expect(q[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('clipToPoses reads a zero quaternion as no rotation, not as NaN', () => {
    const bones = bonesToSpec([
      ((): Bone => {
        const b = new Bone();
        b.name = 'Hips';
        return b;
      })(),
    ]);
    const clip = new AnimationClip('test', 1, [
      new QuaternionKeyframeTrack('Hips.quaternion', [0], [0, 0, 0, 0]),
    ]);
    expect(clipToPoses(clip, bones)[0].bones.Hips.quaternion).toEqual([0, 0, 0, 1]);
  });

  it('clipToPoses names bones as the caller spells its rig, found by three’s spelling', () => {
    // three's spelling replaces `:`; the caller's rig keeps it, index for index.
    const bones = bonesToSpec([
      ((): Bone => {
        const b = new Bone();
        b.name = 'mixamorig:Hips';
        return b;
      })(),
    ]);
    const clip = new AnimationClip('test', 1, [
      new VectorKeyframeTrack('mixamorig_Hips.position', [0], [1, 2, 3]),
    ]);
    expect(Object.keys(clipToPoses(clip, bones)[0].bones)).toEqual(['mixamorig_Hips']);
    const named = clipToPoses(clip, bones, [{ name: 'mixamorig:Hips' }]);
    expect(named[0].bones['mixamorig:Hips'].position).toEqual([1, 2, 3]);
  });
});
