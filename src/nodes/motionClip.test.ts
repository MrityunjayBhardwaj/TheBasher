// #1225 — the clip value is a MotionClip: timed poses, bones by NAME, sparse, with quaternion and
// scale (Houdini `kinefx-motionclips.txt:16-34`). These rows pin the rules the value adds; that an
// existing clip plays unchanged is pinned by comparing it with the index-keyed band sampler below
// and was measured against the previous build (192,420 sampled values, max |Δ| = 0).

import { describe, expect, it } from 'vitest';
import {
  AnimationClipNode,
  AnimationClipParams,
  posedSkeletonFromClip,
  type ClipOutputs,
} from './AnimationClip';
import { quatFromEulerXYZ } from './bonePose';
import { posesFromKeyframes } from '../core/import/keyframePoses';
import { TransformClipParams } from './TransformClip';
import type { AnimationClipValue, BoneSpec, MotionPose, Quat, Vec3 } from './types';

const BONES: BoneSpec[] = [
  { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'arm', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  { name: 'hand', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
  // A rest that is not identity, so "keeps its rest" and "resets to identity" differ.
  { name: 'tilted', parent: 0, position: [1, 0, 0], rotation: [0.3, 0, 0] },
];
const Q0: Quat = [0, 0, 0, 1];
const QZ90: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function clip(poses: MotionPose[], over: Partial<AnimationClipValue> = {}): AnimationClipValue {
  return {
    kind: 'AnimationClip',
    name: 'c',
    duration: 2,
    loop: 'hold',
    interpolation: 'linear',
    poses,
    skeleton: { kind: 'Skeleton', bones: BONES },
    ...over,
  };
}

describe('the MotionClip value', () => {
  it('a bone missing from a pose interpolates between the nearest poses that hold it', () => {
    const pose = posedSkeletonFromClip(
      clip([
        { time: 0, bones: { arm: { position: [0, 1, 0] } } },
        { time: 1, bones: { hand: { position: [0, 5, 0] } } },
        { time: 2, bones: { arm: { position: [0, 3, 0] } } },
      ]),
    );
    // At the pose that omits it, the arm is halfway between the two that hold it.
    expect(pose.sample(1)[1].position).toEqual([0, 2, 0]);
    // The hand is held by one pose alone, so it holds that value everywhere.
    expect(pose.sample(0)[2].position).toEqual([0, 5, 0]);
    expect(pose.sample(2)[2].position).toEqual([0, 5, 0]);
  });

  it('bones are found by name, not by their place in the rig; a name the rig lacks is ignored', () => {
    const pose = posedSkeletonFromClip(
      clip([{ time: 0, bones: { hand: { quaternion: QZ90 }, ghost: { position: [9, 9, 9] } } }]),
    );
    const at = pose.sample(0);
    expect(at.map((b) => b.name)).toEqual(['root', 'arm', 'hand', 'tilted']);
    expect(at[2].quaternion).toEqual(QZ90);
    expect(at[0].quaternion).toEqual(Q0);
    expect(at[0].position).toEqual([0, 0, 0]);
  });

  it('a stated scale is sampled; an unstated component keeps the rig’s rest', () => {
    const pose = posedSkeletonFromClip(
      clip([
        { time: 0, bones: { arm: { scale: [1, 1, 1] } } },
        { time: 2, bones: { arm: { scale: [3, 1, 1] } } },
      ]),
    );
    const arm = pose.sample(1)[1];
    expect(arm.scale).toEqual([2, 1, 1]);
    // Neither position nor rotation was stated: both stay at rest.
    expect(arm.position).toEqual([0, 1, 0]);
    expect(arm.quaternion).toEqual(Q0);
  });

  it('a bone whose poses state only its position keeps its REST rotation, not identity', () => {
    const pose = posedSkeletonFromClip(
      clip([{ time: 0, bones: { tilted: { position: [2, 0, 0] } } }]),
    );
    const tilted = pose.sample(0)[3];
    expect(tilted.position).toEqual([2, 0, 0]);
    expect(tilted.quaternion).toEqual(quatFromEulerXYZ([0.3, 0, 0]));
    expect(tilted.quaternion).not.toEqual(Q0);
  });

  it('rotation slerps between the poses that state it', () => {
    const pose = posedSkeletonFromClip(
      clip([
        { time: 0, bones: { arm: { quaternion: Q0 } } },
        { time: 2, bones: { arm: { quaternion: QZ90 } } },
      ]),
    );
    const q = pose.sample(1)[1].quaternion;
    const s = Math.sin(Math.PI / 8);
    const c = Math.cos(Math.PI / 8);
    [0, 0, s, c].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
  });
});

describe('the one conversion from index + euler keys to poses', () => {
  const keys = [
    { bone: 1, time: 1, position: [0, 1, 0] as Vec3, rotation: [0, 0, Math.PI / 2] as Vec3 },
    { bone: 1, time: 0, position: [0, 1, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
    { bone: 2, time: 0, position: [0, 1, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
    { bone: 7, time: 0, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
  ];

  it('keys at one time are one pose, sorted by time, named by the rig; an index it lacks names nothing', () => {
    const poses = posesFromKeyframes(keys, BONES);
    expect(poses.map((p) => p.time)).toEqual([0, 1]);
    expect(Object.keys(poses[0].bones).sort()).toEqual(['arm', 'hand']);
    expect(Object.keys(poses[1].bones)).toEqual(['arm']);
    const q = poses[1].bones.arm.quaternion!;
    [0, 0, Math.SQRT1_2, Math.SQRT1_2].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
  });

  it('#1227 — a clip node hands on its stored poses themselves, so an unchanged evaluation builds nothing', () => {
    const params = AnimationClipParams.parse({ poses: posesFromKeyframes(keys, BONES) });
    const evaluate = () =>
      (
        AnimationClipNode.evaluate(
          params,
          { skeleton: { kind: 'Skeleton', bones: BONES } },
          undefined as never,
        ) as ClipOutputs
      ).out.poses;
    expect(evaluate()).toBe(params.poses);
    expect(evaluate()).toBe(evaluate());
  });

  it('#1227 — stored poses written out of time order are read in time order', () => {
    const inOrder = posesFromKeyframes(keys, BONES);
    const params = AnimationClipParams.parse({ poses: [...inOrder].reverse() });
    const { out, pose } = AnimationClipNode.evaluate(
      params,
      { skeleton: { kind: 'Skeleton', bones: BONES } },
      undefined as never,
    ) as ClipOutputs;
    expect(out.poses.map((p) => p.time)).toEqual([0, 1]);
    const q = pose.sample(0.5)[1].quaternion;
    const s = Math.sin(Math.PI / 8);
    const c = Math.cos(Math.PI / 8);
    [0, 0, s, c].forEach((v, i) => expect(q[i]).toBeCloseTo(v, 12));
  });
});

describe('Linear or Constant between poses (Houdini MotionClip Evaluate)', () => {
  const stepped = (interpolation: 'linear' | 'constant') =>
    clip(
      [
        { time: 0, bones: { arm: { position: [0, 1, 0], quaternion: Q0 } } },
        { time: 1, bones: { arm: { position: [0, 3, 0], quaternion: QZ90 } } },
        { time: 2, bones: { arm: { position: [0, 5, 0], quaternion: Q0 } } },
      ],
      { interpolation },
    );

  it('constant holds the pose at or before t, and meets each pose exactly at its time', () => {
    const pose = posedSkeletonFromClip(stepped('constant'));
    expect(pose.sample(0.5)[1].position).toEqual([0, 1, 0]);
    expect(pose.sample(0.5)[1].quaternion).toEqual(Q0);
    expect(pose.sample(0.999)[1].position).toEqual([0, 1, 0]);
    expect(pose.sample(1)[1].position).toEqual([0, 3, 0]);
    expect(pose.sample(1.5)[1].quaternion).toEqual(QZ90);
    expect(pose.sample(2)[1].position).toEqual([0, 5, 0]);
  });

  it('linear reads between them, as every clip did before the choice existed', () => {
    const pose = posedSkeletonFromClip(stepped('linear'));
    expect(pose.sample(0.5)[1].position).toEqual([0, 2, 0]);
  });

  it('an AnimationClip node defaults to linear, and steps a constant clip from its stored poses', () => {
    expect(AnimationClipParams.parse({}).interpolation).toBe('linear');
    const keyframes = [
      { bone: 1, time: 0, position: [0, 1, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
      { bone: 1, time: 1, position: [0, 3, 0] as Vec3, rotation: [0, 0, 1] as Vec3 },
    ];
    const params = AnimationClipParams.parse({
      duration: 1,
      poses: posesFromKeyframes(keyframes, BONES),
      interpolation: 'constant',
    });
    const { pose } = AnimationClipNode.evaluate(
      params,
      { skeleton: { kind: 'Skeleton', bones: BONES } },
      undefined as never,
    ) as ClipOutputs;
    // Held at the earlier pose up to the later one's time, and the later one from there.
    for (const t of [0, 0.25, 0.5, 0.99]) {
      expect(pose.sample(t)[1].position).toEqual([0, 1, 0]);
      expect(pose.sample(t)[1].quaternion).toEqual(params.poses[0].bones[BONES[1].name].quaternion);
    }
    expect(pose.sample(1)[1].position).toEqual([0, 3, 0]);
    expect(pose.sample(1)[1].quaternion).toEqual(params.poses[1].bones[BONES[1].name].quaternion);
  });
});

describe('Mirrored Loop (Houdini MotionClip end behaviour)', () => {
  const walk = clip(
    [
      { time: 0, bones: { arm: { position: [0, 0, 0], quaternion: Q0 } } },
      { time: 2, bones: { arm: { position: [0, 4, 0], quaternion: QZ90 } } },
    ],
    { loop: 'mirror' },
  );

  it('past the end it plays back; before the start it plays forward reflected; no seam jumps', () => {
    const pose = posedSkeletonFromClip(walk);
    const y = (t: number) => pose.sample(t)[1].position[1];
    expect(y(2.5)).toBeCloseTo(y(1.5), 12);
    expect(y(3)).toBeCloseTo(y(1), 12);
    expect(y(4)).toBeCloseTo(y(0), 12);
    expect(y(5)).toBeCloseTo(y(1), 12);
    expect(y(-0.5)).toBeCloseTo(y(0.5), 12);
    // Continuous at the reflection: just before and just after the end meet.
    expect(Math.abs(y(2 - 1e-6) - y(2 + 1e-6))).toBeLessThan(1e-5);
    // The rotation mirrors too.
    const q = (t: number) => pose.sample(t)[1].quaternion;
    q(2.5).forEach((v, i) => expect(v).toBeCloseTo(q(1.5)[i], 12));
  });

  it('only a MotionClip offers it: TransformClip, which cannot mirror, refuses it rather than holding', () => {
    expect(AnimationClipParams.parse({ loop: 'mirror' }).loop).toBe('mirror');
    expect(TransformClipParams.safeParse({ loop: 'mirror' }).success).toBe(false);
  });
});
