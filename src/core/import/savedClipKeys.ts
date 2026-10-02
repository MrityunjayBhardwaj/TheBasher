// A clip's keys as projects saved them before format 20: a key per bone INDEX, XYZ euler radians,
// and the retarget read in that form. Frozen (#1432).
//
// Producers write timed poses (`clipToPoses`), so nothing live makes these keys any more. One reader
// still needs them exactly: the v9 → v10 migration (`eagerChannelKeepReason`) compares a saved
// channel against what a retarget of the saved keys returns, value for value with `!==`. So this road
// keeps the conversions as they ran when those channels were written, both ways: euler → three's
// quaternion on the way in (`keysToThreeClip`), three's quaternion → a continuous euler triple on the
// way out (`threeClipToKeys`). The retarget math between them is the live one (`retargetThree`), as
// it was before this split.
//
// Do not use this for new motion: a pose is the clip's form, and the euler round trip is what #1432
// took out of the producers.
//
// REF: src/core/project/migrations.ts (`eagerChannelKeepReason`); src/app/animate/retargetFromNodes.ts
//      (`retargetClipParamsFromNodes`, `SavedClipKeys`); issues #867, #1227, #1432.

import {
  AnimationClip,
  Euler,
  Quaternion,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three';
import type { AnimationKeyframe, BoneSpec, Quat, Vec3 } from '../../nodes/types';
import { clipLoopOf, type ClipLoop } from '../../nodes/clipLoop';
import { parseTrackName, quaternionToEulerVec3, type ClipShape } from './threeAdapter';
import { retargetThree, type RetargetResult } from './retarget';

/** What `retargetSavedKeys` returns: the retarget's report, and its clip as saved keys. */
export interface SavedKeysRetargetResult extends Omit<RetargetResult, 'clipParams'> {
  readonly clipParams: {
    readonly name: string;
    readonly duration: number;
    readonly loop: ClipLoop;
    readonly keyframes: readonly AnimationKeyframe[];
  };
}

/** `retargetClip`, for a source held as saved keys and answering in them. */
export function retargetSavedKeys(args: {
  readonly sourceBones: readonly BoneSpec[];
  readonly sourceClip: {
    readonly name: string;
    readonly duration: number;
    readonly keyframes: readonly AnimationKeyframe[];
    readonly loop?: ClipLoop;
  };
  readonly targetBones: readonly BoneSpec[];
  readonly nameMap: Readonly<Record<string, string>>;
  readonly outputName?: string;
}): SavedKeysRetargetResult {
  const { keyframes } = args.sourceClip;
  // The clip's FIRST frame is the source's reference pose (#853), converted as it always was.
  const referenceTime = keyframes.reduce(
    (earliest, k) => Math.min(earliest, k.time),
    Number.POSITIVE_INFINITY,
  );
  const referencePose: Record<string, Quat> = {};
  for (const keyframe of keyframes) {
    if (keyframe.time !== referenceTime) continue;
    const bone = args.sourceBones[keyframe.bone];
    if (!bone) continue;
    const r = keyframe.rotation;
    const q = new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'XYZ'));
    referencePose[bone.name] = [q.x, q.y, q.z, q.w];
  }
  const run = retargetThree({
    sourceBones: args.sourceBones,
    sourceClip: keysToThreeClip(
      args.sourceClip.name,
      args.sourceClip.duration,
      keyframes,
      args.sourceBones,
    ),
    referencePose: Number.isFinite(referenceTime) ? referencePose : null,
    targetBones: args.targetBones,
    nameMap: args.nameMap,
  });
  return {
    clipParams: {
      name: args.outputName ?? `${args.sourceClip.name}_retargeted`,
      duration: run.retargeted.duration > 0 ? run.retargeted.duration : args.sourceClip.duration,
      loop: clipLoopOf(args.sourceClip.loop),
      keyframes: threeClipToKeys(run.retargeted, run.targetSpecs),
    },
    unmappedSourceBones: run.unmappedSourceBones,
    unboundTargetBones: run.unboundTargetBones,
    restReconciliation: run.restReconciliation,
  };
}

/**
 * Saved keys as three's clip: grouped by bone, one VectorKeyframeTrack (.position) and one
 * QuaternionKeyframeTrack (.quaternion) per bone that has keys.
 */
export function keysToThreeClip(
  name: string,
  duration: number,
  keyframes: readonly AnimationKeyframe[],
  bones: readonly BoneSpec[],
): AnimationClip {
  type PerBone = { times: number[]; positions: number[]; quats: number[] };
  const grouped = new Map<number, PerBone>();
  // Stable order: by bone, then time.
  const sortedKfs = [...keyframes].sort((a, b) => a.bone - b.bone || a.time - b.time);
  for (const kf of sortedKfs) {
    let entry = grouped.get(kf.bone);
    if (!entry) {
      entry = { times: [], positions: [], quats: [] };
      grouped.set(kf.bone, entry);
    }
    entry.times.push(kf.time);
    entry.positions.push(kf.position[0], kf.position[1], kf.position[2]);
    const q = new Quaternion().setFromEuler(
      new Euler(kf.rotation[0], kf.rotation[1], kf.rotation[2], 'XYZ'),
    );
    entry.quats.push(q.x, q.y, q.z, q.w);
  }

  const tracks = [];
  for (const [boneIdx, entry] of grouped.entries()) {
    const boneName = bones[boneIdx]?.name ?? `bone_${boneIdx}`;
    tracks.push(new VectorKeyframeTrack(`${boneName}.position`, entry.times, entry.positions));
    tracks.push(new QuaternionKeyframeTrack(`${boneName}.quaternion`, entry.times, entry.quats));
  }
  return new AnimationClip(name, duration > 0 ? duration : -1, tracks);
}

/**
 * Three's tracks as saved keys: per bone, merged into flat (bone, time, position, rotation) entries;
 * a bone without a position track at a time takes its rest's, and rotations are chained onto the
 * branch nearest the key before (#867).
 */
export function threeClipToKeys(clip: ClipShape, bones: readonly BoneSpec[]): AnimationKeyframe[] {
  type PerBoneTrack = {
    times: Set<number>;
    positionAt: Map<number, Vec3>;
    rotationAt: Map<number, Vec3>;
  };
  const indexByName = new Map<string, number>();
  bones.forEach((b, i) => indexByName.set(b.name, i));
  const perBone = new Map<number, PerBoneTrack>();
  const ensureBone = (idx: number): PerBoneTrack => {
    let entry = perBone.get(idx);
    if (!entry) {
      entry = { times: new Set(), positionAt: new Map(), rotationAt: new Map() };
      perBone.set(idx, entry);
    }
    return entry;
  };

  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name);
    if (!parsed) continue;
    const boneIdx = indexByName.get(parsed.bone);
    if (boneIdx === undefined) continue;

    if (parsed.property === 'position') {
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const v: Vec3 = [track.values[i * 3 + 0], track.values[i * 3 + 1], track.values[i * 3 + 2]];
        const entry = ensureBone(boneIdx);
        entry.times.add(t);
        entry.positionAt.set(t, v);
      }
    } else if (parsed.property === 'quaternion') {
      for (let i = 0; i < track.times.length; i++) {
        const t = track.times[i];
        const q = new Quaternion(
          track.values[i * 4 + 0],
          track.values[i * 4 + 1],
          track.values[i * 4 + 2],
          track.values[i * 4 + 3],
        );
        const entry = ensureBone(boneIdx);
        entry.times.add(t);
        entry.rotationAt.set(t, quaternionToEulerVec3(q));
      }
    }
  }

  const out: AnimationKeyframe[] = [];
  for (const [boneIdx, track] of perBone.entries()) {
    const bind = bones[boneIdx];
    const times = Array.from(track.times).sort((a, b) => a - b);
    // #867: walk this bone's own frames in time order and keep each rotation on
    // the branch nearest the one before it. The chain runs only across frames
    // that actually carry a rotation — a frame falling back to the bind pose is
    // left exactly as it was, so bones with position-only tracks are untouched.
    let previousRotation: Vec3 | null = null;
    for (const t of times) {
      const sampled = track.rotationAt.get(t);
      let rotation: Vec3;
      if (sampled === undefined) {
        rotation = bind.rotation;
      } else {
        rotation = continuousEuler(sampled, previousRotation);
        previousRotation = rotation;
      }
      out.push({
        bone: boneIdx,
        time: t,
        position: track.positionAt.get(t) ?? bind.position,
        rotation,
      });
    }
  }
  out.sort((a, b) => a.time - b.time || a.bone - b.bone);
  return out;
}

const TWO_PI = Math.PI * 2;

/** Shift each component by whole turns to sit as close to `prev` as it can. */
function snapTurns(cand: Vec3, prev: Vec3): Vec3 {
  return [
    cand[0] + TWO_PI * Math.round((prev[0] - cand[0]) / TWO_PI),
    cand[1] + TWO_PI * Math.round((prev[1] - cand[1]) / TWO_PI),
    cand[2] + TWO_PI * Math.round((prev[2] - cand[2]) / TWO_PI),
  ] as const;
}

const spread = (a: Vec3, b: Vec3): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * The representation of the SAME rotation that sits nearest `prev` (#867).
 *
 * `Euler.setFromQuaternion` returns a CANONICAL triple — in XYZ order the middle
 * angle is confined to [-pi/2, pi/2], so a smooth rotation sweeping through that
 * boundary lands on the far side of it and the other two components jump by pi.
 * Nothing about the rotation changed; only the way it is written down. A sampler
 * that interpolated these components LINEARLY, as clips did while they stored
 * euler keys, made a pair of keyframes written on opposite branches travel the
 * long way round — measured at 361 degrees between two keys 1.4 degrees apart.
 *
 * Two families describe one rotation: the triple plus any whole turns per
 * component, and the flip `(x+pi, pi-y, z+pi)` plus whole turns. Both are
 * generated and the closer one wins. The flip identity is not assumed — it is
 * proven over random rotations in `threeAdapterContinuity.test.ts`.
 *
 * This is a representation change ONLY. Every keyframe still holds the rotation
 * it held before, which is the property the tests pin.
 */
export function continuousEuler(e: Vec3, prev: Vec3 | null): Vec3 {
  if (!prev) return e;
  const direct = snapTurns(e, prev);
  const flipped = snapTurns([e[0] + Math.PI, Math.PI - e[1], e[2] + Math.PI] as const, prev);
  return spread(flipped, prev) < spread(direct, prev) ? flipped : direct;
}
