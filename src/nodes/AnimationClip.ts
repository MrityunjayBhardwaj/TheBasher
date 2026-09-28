// AnimationClip — DESCRIBE a keyframed clip over a Skeleton. The node does not
// sample: it evaluates to an `AnimationClip` value carrying the clip's name,
// duration, loop rule and keyframes, plus the rig those key indices are counted
// against. The consumer that holds a `Time` does the sampling (#920).
//
// Inputs:
//   - skeleton (Skeleton, single)
//
// Output:
//   - out (AnimationClip, single)
//
// Pure: same (params, inputs.skeleton) → same clip. The clip keyframes live in
// params, and nothing here reads `ctx.time`. This is the V3 first-use that
// flips the invariant from NOT YET IMPLEMENTED → ALIGNED.
//
// Sampling: `buildClipBoneSamplers` below exposes the clip's own `sample(t)` so
// a caller can invoke it at its own cadence. It is piecewise-linear between
// adjacent keyframes per bone. Outside the authored key range the per-side
// EXTEND rule decides, per
// component: a looping clip cycles its rotation and cycles its position WITH
// OFFSET, so a root that travels keeps travelling instead of teleporting home
// once per period (#924); a non-looping clip holds both endpoints. Bones
// without keyframes inherit their bind-pose from the input skeleton.
//
// Discipline: NO three.js AnimationMixer (it secretly clocks). NO useFrame.
// All math is the local interpolator below.
//
// REF: THESIS.md §40, §49, vyapti V2, V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type {
  AnimationClipValue,
  AnimationKeyframe,
  BonePose,
  MotionBonePose,
  MotionInterpolation,
  MotionPose,
  PosedSkeletonValue,
  Quat,
  SkeletonValue,
  Vec3,
  WireClipInfo,
} from './types';
import {
  sampleQuatKeyframesExtended,
  sampleVec3KeyframesExtended,
  type QuatKey,
  type Vec3Key,
} from './keyframeInterp';
import { quatFromEulerXYZ, restBonePose } from './bonePose';
import { MotionClipLoopSchema, clipExtendRules, type ClipLoop } from './clipLoop';
import { nameParam } from './paramWidget';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const AnimationClipParams = z.object({
  name: nameParam('clip'),
  duration: z.number().positive().default(2),
  /** What the clip does past its authored range — see `clipLoop.ts`. Was a
   *  boolean whose `true` meant cycle-WITH-OFFSET, which made cycle-in-place
   *  unreachable and disagreed with TransformClip's opposite default (#930). */
  loop: MotionClipLoopSchema,
  /**
   * Is this the clip the director most recently bound to its rig? (#907)
   *
   * ── WHY A FLAG AND NOT AN UNBIND ──────────────────────────────────────
   * Binding a second motion used to leave BOTH clips bound, and
   * `boundClipsForAsset` sorts by clip id — so which motion played was decided
   * by the alphabetical order of the two source filenames. Deterministic, and
   * arbitrary from where the director stands.
   *
   * The reference's answer is that an animated data-block has ONE active action,
   * and assigning a new one auto-stashes the previous onto a MUTED track: "unmute
   * it again or delete it". So the predecessor is DEACTIVATED, not destroyed —
   * a director may well want two clips on a rig once there is a way to say which
   * one is playing, and unbinding would throw that away to fix an ordering bug.
   *
   * ── WHY THE DEFAULT IS `false` AND WHY THAT NEEDS NO MIGRATION ─────────
   * A stored project has no active clip, so every clip compares equal and the
   * walk falls back to the id order it has always used — byte-identical
   * behaviour for every project that exists today. The flag only starts
   * deciding once a bind sets one, which is exactly when the ambiguity appears.
   * Nothing here changes what a project already does, so there is no format
   * version to move.
   *
   * Edits survive a rebind untouched: an authored channel outranks the clip, so
   * the case that looks like it needs a confirmation prompt cannot lose work.
   */
  active: z.boolean().default(false),
  /**
   * #1225 — how the clip reads between its keys: `linear` (rotation slerps) or `constant`, the key
   * at or before the time — Houdini's MotionClip Evaluate Interpolation (Linear / Constant,
   * `kinefx--motionclipevaluate.txt:26-35`). Linear is what every clip did before the choice
   * existed, so a saved clip without it plays as it did and needs no migration.
   */
  interpolation: z.enum(['linear', 'constant']).default('linear'),
  keyframes: z
    .array(
      z.object({
        bone: z.number().int().nonnegative(),
        time: z.number().nonnegative(),
        position: Vec3Schema.default([0, 0, 0]),
        rotation: Vec3Schema.default([0, 0, 0]),
      }),
    )
    .default([]),
  /**
   * Which producer request these params were baked from, or `''` when nothing
   * produced them (every clip that arrived as a file).
   *
   * It is a PARAM and not a derived value because it is the only thing that can
   * tell a baked clip from a stale one after a reload: the producer's request
   * hash moves when its inputs move, and comparing the two is what makes a
   * dragged control point read as "stale" rather than as "gone". Deriving it
   * would mean re-deriving the generation, which is the paid call.
   *
   * NOT part of any behaviour. Nothing samples it, and a clip with a stale hash
   * plays exactly as it did before the producer's inputs moved -- that is the
   * lock/freeze policy, and it is why a drag does not blank the motion.
   */
  sourceHash: z.string().default(''),
});
export type AnimationClipParams = z.infer<typeof AnimationClipParams>;

/** Group keyframes by bone, sorted ascending by time. Pure given (keyframes). */
function groupByBone(keyframes: readonly AnimationKeyframe[]): Map<number, AnimationKeyframe[]> {
  const map = new Map<number, AnimationKeyframe[]>();
  for (const k of keyframes) {
    const list = map.get(k.bone) ?? [];
    list.push(k);
    map.set(k.bone, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.time - b.time);
  return map;
}

// `clipExtendRules` MOVED to `./clipLoop.ts` at #930, unchanged in behaviour for
// the two states a boolean could reach and extended with the third it could not.
// It is shared because it is now the ONE mapping from transport intent to
// per-component extend, and both clip carriers must agree about it — the whole
// defect #930 records is two carriers disagreeing about this concept.
//
// THE one rule still: `evaluate` and the exported per-bone samplers both go
// through it, so a clip sampled by the band and the same clip sampled by the
// node cannot disagree about what happens outside the authored range. It MUST
// still match `cycleModifierFor` in agent/mutators/builders/bakeChannelOps.ts,
// which makes the same split for a channel minted from a clip.

/** A bone's pose as a function of wall-clock time — the clip's own sampling. */
export type ClipBoneSampler = (seconds: number) => { position: Vec3; quaternion: Quat };

/**
 * A clip, viewed as a posed rig — the ONE clip→pose adapter (#992, rung 2 of #900).
 *
 * Every clip's pose — an `AnimationClip`'s, a `RetargetClip`'s, a generation's — comes through
 * here, sampling each bone through the one `clipTrackSampler` the baked band also uses, so two
 * readers cannot hold two answers to where a bone is at t (#888).
 *
 * #1225 — it reads the MotionClip value: each bone's track is built from the timed poses BY NAME
 * (`tracksOfPoses`). A bone no pose holds keeps its rest, and so does any component a bone's poses
 * never state (scale, on every clip whose params cannot yet spell one), so the returned array pairs
 * index-for-index with `skeleton.bones`.
 *
 * The samplers are built ONCE and closed over. That is what the function-of-time
 * shape buys: grouping and sorting happens per graph change, not per frame.
 *
 * #1237 — built on the FIRST `sample`, not here. Every `AnimationClip` evaluates to its pose as well
 * as its keys (#1224), and building here cost ~893 µs per evaluation on `walk.bvh` against ~0.2 µs
 * without, on every graph change that reaches the clip, whether or not anything reads the pose.
 * An unsampled pose costs nothing, as `PosedSkeleton` and `PoseOverride` already promise.
 */
export function posedSkeletonFromClip(clip: AnimationClipValue): PosedSkeletonValue {
  const known = posedByClip.get(clip);
  if (known) return known;
  const { skeleton } = clip;
  const rest = skeleton.bones.map(restBonePose);
  let samplers: Map<string, ClipTrackSampler> | null = null;
  const range = clipInfoOf(clip);
  const posed: PosedSkeletonValue = {
    kind: 'PosedSkeleton',
    skeleton,
    ...(range ? { clip: range } : {}),
    sample: (seconds: number): readonly BonePose[] => {
      if (samplers === null) {
        samplers = new Map();
        for (const [name, track] of tracksOfPoses(clip.poses, clip.interpolation)) {
          samplers.set(name, clipTrackSampler(track, clip.duration, clip.loop));
        }
        samplerBuilds++;
      }
      const built = samplers;
      // By NAME: a bone the poses never hold keeps the rig's rest, and each component a bone's
      // poses never state keeps its rest too.
      return rest.map((at) => {
        const sampler = built.get(at.name);
        if (!sampler) return at;
        const got = sampler(seconds);
        return {
          name: at.name,
          position: got.position ?? at.position,
          quaternion: got.quaternion ?? at.quaternion,
          scale: got.scale ?? at.scale,
        };
      });
    },
  };
  posedByClip.set(clip, posed);
  return posed;
}

/**
 * #1225 — a clip's range and rate on the wire: `[0, duration]` at the densest bone's key count over
 * the duration, three's own rule (`SkeletonUtils.js:204`), so a retarget reading the wire samples a
 * clip exactly where it sampled the clip's keys. Nothing on a clip with no duration or no keys.
 */
export function clipInfoOf(clip: {
  readonly name: string;
  readonly duration: number;
  readonly loop: ClipLoop;
  readonly poses: readonly MotionPose[];
}): WireClipInfo | undefined {
  if (!(clip.duration > 0)) return undefined;
  const densest = densestBoneOf(clip.poses);
  if (densest === 0) return undefined;
  return {
    start: 0,
    end: clip.duration,
    rate: densest / clip.duration,
    name: clip.name,
    loop: clip.loop,
  };
}

/**
 * The most poses any one bone appears in. Memoised on the poses' identity (they are themselves
 * memoised per params, `motionPosesFromKeyframes`), so an evaluation whose params did not change
 * does not walk them: measured on the 78-bone, 9360-key walk.bvh, a re-evaluation with unchanged
 * params costs ~7 µs memoised against ~0.22 ms walked (#1237's promise, kept). The first evaluation
 * after the keys change pays the conversion, ~1.3 ms there.
 */
function densestBoneOf(poses: readonly MotionPose[]): number {
  const known = densestMemo.get(poses);
  if (known !== undefined) return known;
  const perBone = new Map<string, number>();
  for (const pose of poses) {
    for (const name of Object.keys(pose.bones)) perBone.set(name, (perBone.get(name) ?? 0) + 1);
  }
  let densest = 0;
  for (const n of perBone.values()) densest = Math.max(densest, n);
  densestMemo.set(poses, densest);
  return densest;
}
const densestMemo = new WeakMap<readonly MotionPose[], number>();

let samplerBuilds = 0;
/** How many times a clip's pose has built its samplers, since load — for tests of #1237. */
export function __clipPoseSamplerBuildsForTests(): number {
  return samplerBuilds;
}

/**
 * #1223 — each clip value's pose, built once. A clip value is made once per graph change (the
 * evaluator caches it), so every reader of the same clip — the deform, the bone draw, bone
 * parenting — shares one set of samplers instead of rebuilding them per call: measured at ~383 µs
 * a frame rebuilt against ~32 µs sampled on the 78-bone `walk.bvh` (#1222). An overlay on a
 * keyed Object copies only the paths it writes (`cloneForOverlay`, #1236), so the clip under a
 * keyed armature Object is the same value and this memo hits there too.
 */
const posedByClip = new WeakMap<AnimationClipValue, PosedSkeletonValue>();

/** #1225 — one bone's motion: a key list per component it states, each sorted by time. */
export interface ClipBoneTrack {
  readonly position: readonly Vec3Key[];
  readonly quaternion: readonly QuatKey[];
  readonly scale: readonly Vec3Key[];
}

/** One bone's local transform at a time: each component its track states, and only those. */
export type ClipTrackSampler = (seconds: number) => {
  position?: Vec3;
  quaternion?: Quat;
  scale?: Vec3;
};

/**
 * #1225 — THE per-bone sampler every clip samples through: the node's pose (by bone name) and the
 * baked band's (by bone index, `buildClipBoneSamplers`) alike, so a bone cannot be in two places
 * at t depending on who asked.
 *
 * Linear between keys (`easing: 'linear'` states what a clip does rather than choosing for it; the
 * mint makes the identical call, bakeChannelOps.ts). Rotation slerps (#1202, #1223): glTF's rule for
 * a LINEAR rotation (`Specification.adoc:3579`); lerping the angles instead drifted up to 24.79° at
 * a midpoint (#1202). Past the keys the clip's `loop` decides, per component (`clipExtendRules`):
 * position may cycle WITH OFFSET so a root that travels keeps travelling (#924); rotation and scale
 * never offset, being bounded.
 */
export function clipTrackSampler(
  track: ClipBoneTrack,
  duration: number,
  loop: ClipLoop,
): ClipTrackSampler {
  const { position: posRule, rotation: rotRule } = clipExtendRules(loop);
  const first = Math.min(
    track.position[0]?.time ?? Infinity,
    track.quaternion[0]?.time ?? Infinity,
    track.scale[0]?.time ?? Infinity,
  );
  return (seconds: number) => {
    // A non-positive or NaN duration has no time domain to extend over, so every time collapses to
    // the first key rather than producing a pose of NaNs. The schema forbids it, but params are
    // read straight off saved files by the baked band (#888), where nothing re-validated them.
    const t = duration > 0 ? seconds : first;
    return {
      ...(track.position.length > 0
        ? { position: sampleVec3KeyframesExtended(track.position, t, posRule, posRule) }
        : {}),
      ...(track.quaternion.length > 0
        ? { quaternion: sampleQuatKeyframesExtended(track.quaternion, t, rotRule, rotRule) }
        : {}),
      ...(track.scale.length > 0
        ? { scale: sampleVec3KeyframesExtended(track.scale, t, rotRule, rotRule) }
        : {}),
    };
  };
}

/**
 * #1225 — each bone's track, from poses sorted by time: every pose that states a component adds a
 * key to that component. A bone missing from a pose simply has no key there, so it interpolates
 * between the nearest poses that hold it (Houdini's MotionClip rule, `kinefx-motionclips.txt:16-34`).
 */
export function tracksOfPoses(
  poses: readonly MotionPose[],
  interpolation: MotionInterpolation = 'linear',
): Map<string, ClipBoneTrack> {
  // Each key carries how it leaves: the clip's interpolation, the samplers' own `constant` easing
  // for a stepped clip (a hold until the next key, as Houdini's Constant evaluates).
  const easing = interpolation;
  const out = new Map<string, { position: Vec3Key[]; quaternion: QuatKey[]; scale: Vec3Key[] }>();
  for (const pose of poses) {
    for (const [name, bone] of Object.entries(pose.bones)) {
      let track = out.get(name);
      if (!track) out.set(name, (track = { position: [], quaternion: [], scale: [] }));
      const time = pose.time;
      if (bone.position) track.position.push({ time, value: bone.position, easing });
      // No hemisphere bookkeeping: the slerp takes the short arc itself.
      if (bone.quaternion) track.quaternion.push({ time, value: bone.quaternion, easing });
      if (bone.scale) track.scale.push({ time, value: bone.scale, easing });
    }
  }
  return out;
}

/**
 * #1225 — the ONE adapter from a clip's params (keys by bone INDEX, XYZ euler radians, no scale)
 * to the MotionClip value (timed poses, bones by NAME, quaternions): keys at one time become one
 * pose. A key whose index the rig does not have names no bone and is left out, as the index-keyed
 * sampler never reached it either. Step 8 of #1233 moves the params to this shape and deletes this.
 *
 * Memoised on the identity of the keys and the rig: an evaluation whose params did not change pays
 * nothing, the promise #1237 made for the samplers.
 */
export function motionPosesFromKeyframes(
  keyframes: readonly AnimationKeyframe[],
  bones: readonly { readonly name: string }[],
): readonly MotionPose[] {
  const known = posesMemo.get(keyframes)?.get(bones);
  if (known) return known;
  const byTime = new Map<number, Record<string, MotionBonePose>>();
  for (const k of keyframes) {
    const name = bones[k.bone]?.name;
    if (name === undefined) continue;
    let held = byTime.get(k.time);
    if (!held) byTime.set(k.time, (held = {}));
    held[name] = { position: k.position, quaternion: quatFromEulerXYZ(k.rotation) };
  }
  const poses = [...byTime]
    .sort(([a], [b]) => a - b)
    .map(([time, held]) => ({ time, bones: held }));
  let inner = posesMemo.get(keyframes);
  if (!inner) posesMemo.set(keyframes, (inner = new WeakMap()));
  inner.set(bones, poses);
  return poses;
}
const posesMemo = new WeakMap<object, WeakMap<object, readonly MotionPose[]>>();

/**
 * A per-bone-INDEX sampler over a clip's params, for the baked band (#888), which reaches a clip's
 * keys by bone index against the joints of a glTF asset. Every bone samples through the one
 * `clipTrackSampler`, so a bone the band draws and the same bone the clip's pose draws agree.
 * Bones with no keys are ABSENT from the map, so the caller can fall through to the bands below.
 * Callers writing into a degrees-valued euler band convert at that boundary (app/bakedGltfChannels.ts).
 *
 * ⚠️ The copy-on-first-edit mint (`bakeChannelOps`) copies these keys into an euler channel, which
 * lerps its angles, so an edited bone can differ from an unedited one BETWEEN keys (at most 0.10°
 * walk, 1.29° run, 0.12° jump on the dense BVH clips) and agrees at every key. That copy retires in
 * step 6 of #1233 (bake). It also always writes LINEAR keys, so a bone edited on a `constant` clip
 * (#1225) ramps between keys where the clip steps; not taught, since the copy is what retires.
 */
export function buildClipBoneSamplers(params: {
  readonly keyframes: readonly AnimationKeyframe[];
  readonly duration: number;
  readonly loop: ClipLoop;
  /** #1225 — the clip's interpolation; absent is linear, what a clip without it always did. */
  readonly interpolation?: MotionInterpolation;
}): Map<number, ClipBoneSampler> {
  const out = new Map<number, ClipBoneSampler>();
  const easing = params.interpolation ?? 'linear';
  for (const [bone, keys] of groupByBone(params.keyframes)) {
    if (keys.length === 0) continue;
    const sampler = clipTrackSampler(
      {
        position: keys.map((k) => ({ time: k.time, value: k.position, easing })),
        quaternion: keys.map((k) => ({
          time: k.time,
          value: quatFromEulerXYZ(k.rotation),
          easing,
        })),
        scale: [],
      },
      params.duration,
      params.loop,
    );
    out.set(bone, (seconds) => {
      const got = sampler(seconds);
      return { position: got.position!, quaternion: got.quaternion! };
    });
  }
  return out;
}

/**
 * #1224 — both views of one clip: the keys (`out`), and the same keys as the pose wire (`pose`),
 * which is what an armature Object takes. The RetargetClip shape (`both`), through the one adapter,
 * so the two outputs cannot disagree.
 */
export type ClipOutputs = { readonly out: AnimationClipValue; readonly pose: PosedSkeletonValue };

function withPose(out: AnimationClipValue): ClipOutputs {
  return { out, pose: posedSkeletonFromClip(out) };
}

export const AnimationClipNode: NodeDefinition<AnimationClipParams, ClipOutputs> = {
  type: 'AnimationClip',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: AnimationClipParams,
  // TIME-FREE, like `RetargetClip` (#920). A node named for a CLIP evaluated to a
  // POSE — a function of the current frame — which is the shape the
  // per-frame-re-render invariant exists to forbid. The clip is a description;
  // sampling it at an instant is the consumer's job, and only a consumer with a
  // `Time` input can do it honestly.
  inputs: {
    skeleton: { type: 'Skeleton', cardinality: 'single' },
    /**
     * The node that PRODUCED this clip's keys, when one did (#935).
     *
     * ─────────────────────────────────────────────────────────────────────
     * WHY THIS EDGE EXISTS AND WHY `evaluate` DOES NOT READ IT
     * ─────────────────────────────────────────────────────────────────────
     * Every clone-rig reader went through `boundClipsForAsset`, which
     * is deliberately pure over PARAMS -- no evaluator, because the format
     * migration calls it on raw saved JSON long before one exists. So a
     * producer whose motion lives in an evaluated VALUE was invisible to the
     * render band (retired, #1053), the channel mint, the dopesheet and the migration alike.
     * Measured: the same graph with a `MotionGenerate` in the source slot
     * instead of an `AnimationClip` gives the band `boundClips=0`.
     *
     * The cook therefore writes the produced keys into THESE params, and this
     * socket is what it walks to find where to write. Downstream reads params
     * and cannot tell the result from a dropped `.bvh`, because there is no
     * difference -- the same shape ComfyUIWorkflow uses one domain over, where
     * the node describes the request and a separate pass lands the artefact.
     *
     * `evaluate` ignoring it is therefore not a socket that lies: the params
     * ARE the producer's landed output, kept current by the cook. What the
     * edge buys is that the relation is visible in the graph, survives a save,
     * and undoes with the ops that made it.
     *
     * REF: src/app/asset/bakeGeneratedClip.ts (the cook that walks this edge);
     *      src/app/animate/boundClipsForAsset.ts (the params-only read band);
     *      src/nodes/MotionGenerate.ts; issues #935, #902.
     */
    source: { type: 'AnimationClip', cardinality: 'single' },
  },
  outputs: {
    out: { type: 'AnimationClip', cardinality: 'single' },
    pose: { type: 'PosedSkeleton', cardinality: 'single' },
  },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): ClipOutputs {
    const skeleton = inputs.skeleton as SkeletonValue | undefined;

    if (!skeleton) {
      return withPose({
        kind: 'AnimationClip',
        name: params.name,
        duration: params.duration,
        loop: params.loop,
        interpolation: params.interpolation,
        // No rig, so no key names a bone.
        poses: [],
        skeleton: { kind: 'Skeleton', bones: [] },
      });
    }

    return withPose({
      kind: 'AnimationClip',
      name: params.name,
      duration: params.duration,
      loop: params.loop,
      interpolation: params.interpolation,
      // #1225 — the keys as timed poses by bone name, through the one adapter.
      poses: motionPosesFromKeyframes(params.keyframes, skeleton.bones),
      // The rig the poses name bones on, travelling WITH them so a consumer
      // cannot pair one character's motion with another's rest (#901).
      skeleton,
    });
  },
};
