// poseSample — an armature's pose is sampled once per time, whoever asks (#1731, 4.3).
//
// WHY THIS EXISTS. An armature's pose (`PosedSkeletonValue.sample(seconds)`) is read on every
// frame by each mesh it deforms (the GPU skin's bones, or the CPU deform), by each Object parented
// to one of its bones, by the armature helper that draws it, and by the bone lookup a constraint
// aims through. Each called `sample` itself, so a character with a body, two eyes and a prop in
// its hand ran its whole layer stack — every pose layer's keys, IK solve and limits — five times
// a frame, at the same time, for the same answer. Blender evaluates the pose once per armature
// per frame (`BKE_pose_where_is`, into `pose_mat`), and the deform and the bone parent read it.
//
// `sample` is pure given the value (types.ts: "calling twice at the same seconds returns equal
// poses"), and a pose value is built once per graph change and shared by reference
// (`armaturePoseOf` hands back the armature Object's own), so the last answer is kept per value:
// the second reader at a time gets the first reader's array. The array is shared, so a reader
// must not write into it (none does: they read it into three's bones or into matrices).
//
// REF: src/nodes/types.ts (`PosedSkeletonValue.sample`); src/nodes/bonePose.ts (`armaturePoseOf`);
//      issue #1731; plan frame-pipeline §4 (4.3).

import type { BonePose, PosedSkeletonValue } from './types';

const kept = new WeakMap<PosedSkeletonValue, { seconds: number; poses: readonly BonePose[] }>();
let asked = 0;
let sampled = 0;

/** `pose.sample(seconds)`, sampled once per pose value per time. */
export function samplePose(pose: PosedSkeletonValue, seconds: number): readonly BonePose[] {
  asked++;
  const hit = kept.get(pose);
  if (hit && hit.seconds === seconds) return hit.poses;
  sampled++;
  const poses = pose.sample(seconds);
  kept.set(pose, { seconds, poses });
  return poses;
}

/** How often a pose was asked for, and how often that ran the sampler — the instrument for
 *  "once per armature per frame". */
export function poseSampleCounts(): { asked: number; sampled: number } {
  return { asked, sampled };
}
