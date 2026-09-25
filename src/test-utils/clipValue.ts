// #1225 — a clip VALUE built from keys, for tests. The value carries timed poses by bone name; a test
// that states its motion as keys (bone index, XYZ euler radians) gets them through the product's
// own adapter, `motionPosesFromKeyframes`, so the poses are exactly what an `AnimationClip` node
// would evaluate to. The keys ride along too, for tests that also feed the index-keyed band sampler.

import { motionPosesFromKeyframes } from '../nodes/AnimationClip';
import type { AnimationClipValue, AnimationKeyframe } from '../nodes/types';

export type KeyedClipValue = AnimationClipValue & {
  readonly keyframes: readonly AnimationKeyframe[];
};

export function clipValueFromKeys(
  clip: Omit<AnimationClipValue, 'poses'> & { readonly keyframes: readonly AnimationKeyframe[] },
): KeyedClipValue {
  return { ...clip, poses: motionPosesFromKeyframes(clip.keyframes, clip.skeleton.bones) };
}
