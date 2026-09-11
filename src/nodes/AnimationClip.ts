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
  PosedSkeletonValue,
  SkeletonValue,
  Vec3,
} from './types';
import { sampleVec3KeyframesExtended, type Vec3Key } from './keyframeInterp';
import { ClipLoopSchema, clipExtendRules, type ClipLoop } from './clipLoop';
import { nameParam } from './paramWidget';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const AnimationClipParams = z.object({
  name: nameParam('clip'),
  duration: z.number().positive().default(2),
  /** What the clip does past its authored range — see `clipLoop.ts`. Was a
   *  boolean whose `true` meant cycle-WITH-OFFSET, which made cycle-in-place
   *  unreachable and disagreed with TransformClip's opposite default (#930). */
  loop: ClipLoopSchema,
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
// which makes the same split for a channel minted from a clip;
// `ensureChannelForBone`'s spec asserts they agree past the duration.

/** A bone's pose as a function of wall-clock time — the clip's own sampling. */
export type ClipBoneSampler = (seconds: number) => { position: Vec3; rotation: Vec3 };

/**
 * Build a per-bone-INDEX sampler over a clip's keyframes: the clip's own
 * `sample(t)`, exposed as closures so a caller can invoke it at its own cadence.
 *
 * WHY THIS IS EXPORTED (#888). The baked band needs to reach a retargeted clip
 * for a bone that has no channel node, and it must produce the value the CLIP
 * would produce.
 *
 * It samples through the CHANNEL sampler (`sampleVec3KeyframesExtended`) while
 * naming the clip's own interpolation explicitly. The earlier note here warned
 * that rebuilding a clip's keys as channel params "forces a DEFAULT to be chosen
 * for properties the source never described", and that warning still stands for
 * EASING — which is why `easing: 'linear'` is stated at the call site rather than
 * inherited: it records what the clip does, it is not a default being picked.
 *
 * What changed (#924) is that the EXTEND rule is not such a property. A clip that
 * is sampled outside its key range must answer somehow, and `t % duration` was an
 * answer chosen by omission — one that cannot express travel, because it replays
 * identical frames. The extend vocabulary is where this project already keeps
 * that answer, so the clip band now speaks it instead of folding time itself.
 *
 * Grouping happens once, per DAG change; the returned closures are invoked per
 * frame. Bones with no keyframes are ABSENT from the map rather than mapped to
 * a zero pose — the caller must be able to fall through to the bands below,
 * and a bone the clip never touched has no opinion to contribute.
 *
 * Rotation is in the clip's own units (RADIANS). Callers writing into a
 * degrees-valued band convert at that boundary; see
 * app/animate/ensureChannelForBone.ts, which is where that unit change is
 * documented, and app/bakedGltfChannels.ts, which makes the same conversion for
 * the read band.
 */
/**
 * A clip, viewed as a posed rig — the ONE clip→pose adapter (#992, rung 2 of #900).
 *
 * Lives beside `buildClipBoneSamplers` because it is that factory's only pose-shaped
 * consumer, and having one home is the point: `LocomotionState` and `RetargetClip`
 * both need "this clip, as a pose at t", and two copies would be two answers to
 * where a bone is at t that drift silently — the same reason the factory itself was
 * shared in the first place (#888).
 *
 * The samplers are built ONCE and closed over. That is what the function-of-time
 * shape buys: grouping and sorting every keyframe by bone happens per graph change,
 * not per frame. A bone the clip does not touch holds its rest pose, so the returned
 * array pairs index-for-index with `skeleton.bones`.
 */
export function posedSkeletonFromClip(clip: AnimationClipValue): PosedSkeletonValue {
  const { skeleton } = clip;
  const samplers = buildClipBoneSamplers(clip);
  return {
    kind: 'PosedSkeleton',
    skeleton,
    sample: (seconds: number): readonly BonePose[] => {
      const poses: BonePose[] = [];
      for (let i = 0; i < skeleton.bones.length; i++) {
        const sampler = samplers.get(i);
        if (!sampler) {
          poses.push({
            bone: i,
            position: skeleton.bones[i].position,
            rotation: skeleton.bones[i].rotation,
          });
          continue;
        }
        const { position, rotation } = sampler(seconds);
        poses.push({ bone: i, position, rotation });
      }
      return poses;
    },
  };
}

export function buildClipBoneSamplers(
  // Widened to READONLY keys (#920) so the same factory serves both a node's
  // params and an `AnimationClipValue`, which is where the sampling now happens.
  // It only ever reads them — `groupByBone` already declared readonly.
  //
  // `loop` is a `ClipLoop`, not a boolean (#930): the two carriers spelled one
  // concept two ways, and this factory is the shared road both of them sample
  // through, so it takes the shared vocabulary.
  params: {
    readonly keyframes: readonly AnimationKeyframe[];
    readonly duration: number;
    readonly loop: ClipLoop;
  },
): Map<number, ClipBoneSampler> {
  const { duration, loop } = params;
  const { position: posRule, rotation: rotRule } = clipExtendRules(loop);
  const out = new Map<number, ClipBoneSampler>();
  for (const [bone, track] of groupByBone(params.keyframes)) {
    if (track.length === 0) continue;
    // `groupByBone` already returns each track sorted ascending by time, which is
    // what the sampler requires; re-sorting here would be a second answer to a
    // question already answered.
    const sorted = track;
    // `easing: 'linear'` STATES what the clip does rather than choosing for it —
    // a clip keyframe carries no easing field and interpolates linearly. The mint
    // makes the identical call for the identical reason (bakeChannelOps.ts), so an
    // edited bone and an unedited one cannot disagree about the curve between two
    // keys. Measured on the real fixture: 94,068 in-range scalars over 78 bones,
    // worst delta exactly 0 against the clip's own lerp.
    const posKeys: Vec3Key[] = sorted.map((k) => ({
      time: k.time,
      value: k.position,
      easing: 'linear',
    }));
    const rotKeys: Vec3Key[] = sorted.map((k) => ({
      time: k.time,
      value: k.rotation,
      easing: 'linear',
    }));
    out.set(bone, (seconds: number) => {
      // A non-positive or NaN duration has no time domain to extend over, so every
      // time collapses to the first key rather than producing a pose of NaNs. The
      // schema forbids it, but these params are read straight off saved files by
      // the baked band (#888), where nothing has re-validated them.
      const t = duration > 0 ? seconds : sorted[0].time;
      return {
        position: sampleVec3KeyframesExtended(posKeys, t, posRule, posRule),
        rotation: sampleVec3KeyframesExtended(rotKeys, t, rotRule, rotRule),
      };
    });
  }
  return out;
}

export const AnimationClipNode: NodeDefinition<AnimationClipParams, AnimationClipValue> = {
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
     * Every reader that drives pixels goes through `boundClipsForAsset`, which
     * is deliberately pure over PARAMS -- no evaluator, because the format
     * migration calls it on raw saved JSON long before one exists. So a
     * producer whose motion lives in an evaluated VALUE is invisible to the
     * render band, the channel mint, the dopesheet and the migration alike.
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
  outputs: { out: { type: 'AnimationClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs) {
    const skeleton = inputs.skeleton as SkeletonValue | undefined;

    if (!skeleton) {
      return {
        kind: 'AnimationClip',
        name: params.name,
        duration: params.duration,
        loop: params.loop,
        keyframes: params.keyframes,
        skeleton: { kind: 'Skeleton', bones: [] },
      };
    }

    return {
      kind: 'AnimationClip',
      name: params.name,
      duration: params.duration,
      loop: params.loop,
      keyframes: params.keyframes,
      // The rig the keys are indexed against, travelling WITH them so a consumer
      // cannot pair one source's indices with another's spine (#901).
      skeleton,
    };
  },
};
