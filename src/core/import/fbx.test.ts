// FBX integration tests — synthetic THREE.Group with a SkinnedMesh +
// embedded clip. Avoids needing a real .fbx fixture by exercising the
// extractBones + threeAdapter conversion paths via constructed THREE
// objects. The actual FBXLoader.parse() round-trip is left to manual
// verification (the loader is upstream / well-tested by THREE).
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
import { bonesToSpec, clipToKeyframes } from './threeAdapter';

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

  it('clipToKeyframes merges position + quaternion tracks per bone', () => {
    const bones = bonesToSpec([
      ((): Bone => {
        const b = new Bone();
        b.name = 'Hips';
        return b;
      })(),
      ((): Bone => {
        const b = new Bone();
        b.name = 'Spine';
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
    const kfs = clipToKeyframes(clip, bones);
    // 4 entries: 2 (Hips at t=0, t=1) + 2 (Spine at t=0, t=1)
    expect(kfs.length).toBe(4);
    // Sorted by (time, bone)
    for (let i = 1; i < kfs.length; i++) {
      const prev = kfs[i - 1];
      const cur = kfs[i];
      expect(cur.time === prev.time ? cur.bone >= prev.bone : cur.time > prev.time).toBe(true);
    }
    // Hips at t=1 has position [0,2,0]
    const hipsAt1 = kfs.find((k) => k.bone === 0 && k.time === 1);
    expect(hipsAt1?.position).toEqual([0, 2, 0]);
  });
});
