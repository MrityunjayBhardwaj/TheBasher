// Keys → timed poses: the ONE conversion from the import layer's sample form (a key per bone INDEX,
// XYZ euler radians, no scale) to what a clip is — timed poses holding bones by NAME, each with a
// quaternion (the `MotionPose` shape, Houdini's MotionClip).
//
// A clip's stored params and its value are both the poses (#1227), and the producers write poses
// directly (#1432): the parsers and the retarget read three's quaternion tracks as quaternions. The
// index + euler key survives only as projects saved it before format 20, so its one product caller
// is the format migration that moved saved clips to poses (`migrateClipKeysToPoses`). Tests that
// state motion as keys use it too, so their poses are what that migration would make of them.
//
// REF: src/nodes/AnimationClip.ts (the params and the value); src/core/project/migrations.ts
//      (`migrateClipKeysToPoses`); src/core/import/threeAdapter.ts (`clipToPoses`); issues #1225,
//      #1227, #1432.

import type { AnimationKeyframe, MotionBonePose, MotionPose } from '../../nodes/types';
import { quatFromEulerXYZ } from '../../nodes/bonePose';

/**
 * Keys at one time become one pose; poses leave sorted by time. A key whose index the rig does not
 * have names no bone and is left out, as an index-keyed sampler never reached it either.
 */
export function posesFromKeyframes(
  keyframes: readonly AnimationKeyframe[],
  bones: readonly { readonly name: string }[],
): MotionPose[] {
  const byTime = new Map<number, Record<string, MotionBonePose>>();
  for (const k of keyframes) {
    const name = bones[k.bone]?.name;
    if (name === undefined) continue;
    let held = byTime.get(k.time);
    if (!held) byTime.set(k.time, (held = {}));
    held[name] = { position: k.position, quaternion: quatFromEulerXYZ(k.rotation) };
  }
  return [...byTime].sort(([a], [b]) => a - b).map(([time, held]) => ({ time, bones: held }));
}
