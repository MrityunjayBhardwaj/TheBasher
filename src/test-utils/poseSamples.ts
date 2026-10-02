// Timed poses flattened for tests that compare two clips sample by sample: one entry per bone a pose
// holds, in pose order, bones in the order the pose lists them. And a quaternion brought onto
// another's hemisphere, since q and -q are one rotation and a component-wise compare must not care
// which of the two a road wrote (#1432).

import type { MotionPose, Quat, Vec3 } from '../nodes/types';

export interface PoseSample {
  readonly time: number;
  readonly bone: string;
  readonly position?: Vec3;
  readonly quaternion?: Quat;
}

export function poseSamples(poses: readonly MotionPose[]): PoseSample[] {
  return poses.flatMap((pose) =>
    Object.entries(pose.bones).map(([bone, held]) => ({
      time: pose.time,
      bone,
      ...(held.position ? { position: held.position } : {}),
      ...(held.quaternion ? { quaternion: held.quaternion } : {}),
    })),
  );
}

/** `q`, negated when that puts it on `like`'s side: the same rotation, comparable per component. */
export function alignedQuat(q: Quat, like: Quat): Quat {
  const dot = q[0] * like[0] + q[1] * like[1] + q[2] * like[2] + q[3] * like[3];
  return dot < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}
