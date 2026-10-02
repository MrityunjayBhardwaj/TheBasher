// #1225 — a clip VALUE built from keys, for tests. The value carries timed poses by bone name; a test
// that states its motion as keys (bone index, XYZ euler radians) gets them through the product's
// own conversion, `posesFromKeyframes`, so the poses are exactly what a saved project's keys become.

import { posesFromKeyframes } from '../core/import/keyframePoses';
import { posedSkeletonFromClip } from '../nodes/AnimationClip';
import type { AnimationClipValue, AnimationKeyframe, BoneSpec, Quat, Vec3 } from '../nodes/types';

/** `interpolation` may be left out: linear, as every clip read before the choice existed. */
export function clipValueFromKeys(
  clip: Omit<AnimationClipValue, 'poses' | 'interpolation'> & {
    readonly keyframes: readonly AnimationKeyframe[];
    readonly interpolation?: AnimationClipValue['interpolation'];
  },
): AnimationClipValue {
  const { keyframes, ...value } = clip;
  return {
    ...value,
    interpolation: clip.interpolation ?? 'linear',
    poses: posesFromKeyframes(keyframes, clip.skeleton.bones),
  };
}

/**
 * One bone of a clip stated as keys, sampled the way playback samples it: through the clip's own
 * pose (`posedSkeletonFromClip`), on a rig of unturned bones at the origin, one per index the keys
 * reach (#1433). The clip's params go in as given, unvalidated, as a saved file would hand them.
 */
export function keyedBoneSampler(
  clip: {
    readonly keyframes: readonly AnimationKeyframe[];
    readonly duration: number;
    readonly loop: AnimationClipValue['loop'];
    readonly interpolation?: AnimationClipValue['interpolation'];
  },
  bone: number,
): (seconds: number) => { position: Vec3; quaternion: Quat } {
  const count = Math.max(bone, ...clip.keyframes.map((k) => k.bone)) + 1;
  const bones: BoneSpec[] = Array.from({ length: count }, (_, i) => ({
    name: `b${i}`,
    parent: -1,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }));
  const pose = posedSkeletonFromClip(
    clipValueFromKeys({
      kind: 'AnimationClip',
      name: 'clip',
      duration: clip.duration,
      loop: clip.loop,
      ...(clip.interpolation ? { interpolation: clip.interpolation } : {}),
      keyframes: clip.keyframes,
      skeleton: { kind: 'Skeleton', bones },
    }),
  );
  return (seconds) => {
    const at = pose.sample(seconds)[bone];
    return { position: at.position, quaternion: at.quaternion };
  };
}
