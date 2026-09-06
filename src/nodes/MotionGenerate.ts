// MotionGenerate — text-to-motion as a NODE, so a generated clip has a producer
// the graph can re-cook instead of a call whose arguments were thrown away.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A PROVENANCE BRANCH
// ─────────────────────────────────────────────────────────────────────────
// The generation phase refused provenance explicitly: no flag, no separate
// store, nothing downstream able to tell a generated clip from an imported one.
// This node does not reinstate that. `prompt` / `seed` / `path` are ARGUMENTS
// THAT DETERMINE the clip; a "generated" flag would be a LABEL THAT DESCRIBES
// it, and only the second is provenance. A Scatter's output is ordinary
// geometry; this node's output is an ordinary clip that happens to have a
// producer, exactly as the thesis has it for "the user placed three trees" vs
// "the user wrote a rule that produced three trees".
//
// Measured, so it is not merely argued: `boundClipsForAsset` is the ONE edge
// walk every real reader goes through — the render band, the channel mint, the
// dopesheet, the format migration — and all of them read the PARAMS side.
// `AnimationClipValue` has no production consumers outside the nodes that emit
// it. An input edge is invisible to every one of them.
//
// ─────────────────────────────────────────────────────────────────────────
// `pure: true`, AND THE ALTERNATIVE WAS MEASURED BEFORE IT WAS REJECTED
// ─────────────────────────────────────────────────────────────────────────
// The issue originally specified `pure: false, cost: 'expensive'`. Both labels
// were measured against this repo and both were wrong for this node:
//
//   - `cost` has ZERO readers. Every `.cost` access in `src/` is a comment
//     saying so, and `evaluator.ts` says `expensive` "WILL route to a worker in
//     P1+" — future tense. It buys no laziness and no caching today.
//   - `pure: false` is NOT inert. `evaluator.ts` appends `|t:frame.seconds` to
//     the cache key of an impure node, so it gets one cache entry PER FRAME.
//     Probed over ten frames on two node types identical but for the flag:
//     pure → 1 evaluate / 1 entry, impure → 10 / 10. A `pure:false` generator
//     would fire a paid several-second call on every frame of playback.
//
// `ComfyUIWorkflow` is not the precedent here even though it is the only other
// generative node: this repo's own determinism contract records it as the
// BROKEN case ("NOT ACHIEVABLE TODAY: carries no seed param"), and a stylized
// IMAGE is genuinely per-frame while a generated CLIP is one artifact spanning a
// range. The precedent that fits is `Scatter` — generative, `pure: true`, seeded
// through params, which `types.ts` names as the correct handling of a seed.
//
// Purity does not cost re-cook, which is the whole point of the issue: an input
// hash change is what re-cooks, and dragging a control point changes it. What
// purity removes is re-cooking when NOTHING changed.
//
// ─────────────────────────────────────────────────────────────────────────
// THE SEED IS REQUIRED, AND THE ABSENCE OF A DEFAULT IS THE FEATURE
// ─────────────────────────────────────────────────────────────────────────
// A defaulted seed is a seed nobody chose, and it makes "this clip is
// reproducible" true by accident rather than by construction. With no default, a
// MotionGenerate that cannot say which seed produced it has no constructor.
// `prompt` and `model` are required for the same reason — the licence varies per
// checkpoint, so a hidden default would pick one silently.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT `evaluate` DOES NOT DO
// ─────────────────────────────────────────────────────────────────────────
// No I/O. It computes the request's content hash and reads the monotonic
// content-addressed store; the network call belongs to the resolver, which has
// the graph state the world seam needs. Same division as ComfyUIWorkflow, whose
// evaluator returns a descriptor while the bytes are produced elsewhere.
//
// A request with no entry evaluates to a clip in the `pending` state — a WAIT,
// not a dead end, and deliberately NOT an empty clip. An empty clip is a
// well-formed answer meaning "this generated nothing", which is exactly the
// silent-failure shape this track keeps finding; `pending` cannot be mistaken
// for it.
//
// ⚠️ KNOWN LIMIT, PINNED BY A SPEC RATHER THAN LEFT TO BE DISCOVERED. The hash
// covers the path Object's OWN transform and its curve's local points, because
// an evaluator sees resolved inputs and not the graph, and world resolution
// walks the scene. An ANCESTOR's rotation or scale therefore does not enter the
// hash. Translation is provably irrelevant — the server rebases the path to the
// origin and hands the offset back separately — so the exposure is a curve
// parented under a rotated or scaled Group, which no UI road constructs today.
// The same inherited limit `motionPathFromCurve` already documents, at the same
// seam, for the same reason.
//
// REF: src/core/motiongen/generatedClipCache.ts (the replay-or-cache store);
//      src/core/motiongen/MotionGenerationCapability.ts (the boundary);
//      src/app/asset/motionPathFromCurve.ts (the world seam + its inherited
//      limit); src/nodes/ScatterNode.ts (the seeded-generative precedent);
//      src/core/dag/types.ts (the three-clause determinism contract);
//      issues #902, #730, #826.

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import { lookupGeneratedClip, lookupGenerationFailure } from '../core/motiongen/generatedClipCache';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { AnimationClipValue, CurveDataValue, ObjectValue, SkeletonValue } from './types';

/**
 * Upper bound on requested clip length, mirroring the capability's own. Stated
 * here too because a node param is authored by a director and a mutator, not
 * only by the code path that happens to call `generate` — a bound enforced at
 * one of two entrances is a bound with a way around it.
 */
export const MAX_MOTION_SECONDS = 600;

export const MotionGenerateParams = z.object({
  /** What to generate. Required: a generator with no prompt has nothing to do. */
  prompt: z.string().trim().min(1, 'must not be empty'),
  /**
   * Determinism handle. REQUIRED and un-defaulted — see the header. An integer
   * because the backends take one, and finite because `NaN` hashes to a stable
   * string and would silently pin every seedless request to one entry.
   */
  seed: z.number().int().finite(),
  /** The checkpoint to run. Required — the licence varies per checkpoint. */
  model: z.string().trim().min(1, 'must not be empty'),
  /** Requested length. Optional: the generator has its own default. */
  seconds: z.number().positive().finite().max(MAX_MOTION_SECONDS).optional(),
  /**
   * Clip name. Defaults to empty and resolves to the prompt at evaluate, the way
   * an imported clip defaults to its filename.
   *
   * NOT part of the request hash: renaming a clip must not re-run a paid
   * generation, and two clips differing only in name are the same motion.
   */
  name: z.string().default(''),
});
export type MotionGenerateParams = z.infer<typeof MotionGenerateParams>;

/** An empty rig — what a clip carries before any generation has produced one. */
const EMPTY_SKELETON: SkeletonValue = { kind: 'Skeleton', bones: [] };

/**
 * The path's contribution to request identity, or null when no path is wired.
 *
 * `null` and an empty list are NOT the same and are not collapsed: null means no
 * path was asked for (an ordinary generation), while a wired curve that produced
 * no points is a curve that failed. Collapsing them would make "nobody asked"
 * and "it went wrong" share a cache entry.
 */
function pathSignature(path: ObjectValue | undefined): unknown {
  if (!path) return null;
  const data = path.data;
  if (!data || data.kind !== 'CurveData') return null;
  const curve = data as CurveDataValue;
  return {
    // The sampled polyline rather than the control points: resolution changes
    // the path the server is actually given, so it must change the request.
    samples: curve.samples,
    closed: curve.closed,
    // The Object's own placement. Its TRANSLATION is included even though the
    // server rebases to the origin, because a moved path is a different request
    // to everything upstream of that rebase and excluding it would be a claim
    // about the backend rather than about the graph.
    position: path.position,
    rotation: path.rotation,
    scale: path.scale,
  };
}

/** The content address of this generation. The ONLY place it is computed — the
 *  resolver reads it back off the evaluated value rather than recomputing it, so
 *  the two cannot drift apart. */
export function motionRequestHash(
  params: MotionGenerateParams,
  path: ObjectValue | undefined,
): string {
  return hashValue({
    prompt: params.prompt,
    seed: params.seed,
    model: params.model,
    seconds: params.seconds ?? null,
    path: pathSignature(path),
  });
}

export const MotionGenerateNode: NodeDefinition<MotionGenerateParams, AnimationClipValue> = {
  type: 'MotionGenerate',
  version: 1,
  pure: true,
  cost: 'medium',
  paramSchema: MotionGenerateParams,
  /**
   * The path is an EDGE, not an id ref, and that is the structural point of the
   * issue rather than a style choice. `FollowPath` binds its curve by id, which
   * puts only the ID in the cache key — so editing the curve cannot invalidate
   * anything, which is exactly why generation-on-curve-edit "could not be built"
   * before. An edge puts the curve's evaluated CONTENT in the input hash, so
   * moving a control point changes this node's cache key and re-cooks it.
   *
   * `SceneObject` rather than `ObjectData`: placement lives on the Object under
   * the object/data split, and a path's placement is part of the request.
   */
  inputs: { path: { type: 'SceneObject', cardinality: 'single' } },
  outputs: { out: { type: 'AnimationClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): AnimationClipValue {
    const path = inputs.path as ObjectValue | undefined;
    const requestHash = motionRequestHash(params, path);
    const name = params.name.trim() || params.prompt;

    const clip = lookupGeneratedClip(requestHash);
    if (clip) {
      return {
        kind: 'AnimationClip',
        name,
        duration: clip.duration,
        // Generated motion is a finite performance, not a cycle. A clip that
        // claimed to loop would extend a walk past its last key by repeating it,
        // which is a claim about the motion that nothing measured.
        loop: false,
        keyframes: clip.keyframes,
        skeleton: clip.skeleton,
        generation: { status: 'ready', requestHash, worldOffsetXZ: clip.worldOffsetXZ },
      };
    }

    const failure = lookupGenerationFailure(requestHash);
    return {
      kind: 'AnimationClip',
      name,
      // Zero, not the requested `seconds`: nothing has been produced, and a
      // duration borrowed from the request would let a pending clip report a
      // length it does not have to every consumer that reads one.
      duration: 0,
      loop: false,
      keyframes: [],
      skeleton: EMPTY_SKELETON,
      generation:
        failure !== undefined
          ? { status: 'failed', requestHash, reason: failure }
          : { status: 'pending', requestHash },
    };
  },
};
