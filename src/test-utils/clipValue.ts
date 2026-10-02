// #1225 — a clip VALUE built from keys, for tests. The value carries timed poses by bone name; a test
// that states its motion as keys (bone index, XYZ euler radians) gets them through the product's
// own conversion, `posesFromKeyframes`, so the poses are exactly what a producer holding those
// keys would hand on. The keys ride along too, for tests that also feed the index-keyed band sampler.

import { posesFromKeyframes } from '../core/import/keyframePoses';
import type { AnimationClipValue, AnimationKeyframe } from '../nodes/types';

export type KeyedClipValue = AnimationClipValue & {
  readonly keyframes: readonly AnimationKeyframe[];
};

/** `interpolation` may be left out: linear, as every clip read before the choice existed. */
export function clipValueFromKeys(
  clip: Omit<AnimationClipValue, 'poses' | 'interpolation'> & {
    readonly keyframes: readonly AnimationKeyframe[];
    readonly interpolation?: AnimationClipValue['interpolation'];
  },
): KeyedClipValue {
  return {
    ...clip,
    interpolation: clip.interpolation ?? 'linear',
    poses: posesFromKeyframes(clip.keyframes, clip.skeleton.bones),
  };
}
