// The replay-or-cache seam for generated motion — what makes `MotionGenerate`
// a PURE node whose output is nevertheless produced by a paid network call.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A CACHE OF CONVENIENCE
// ─────────────────────────────────────────────────────────────────────────
// `NodeDefinition.evaluate` is SYNCHRONOUS and generation is a several-second
// HTTP call, so the call cannot happen inside the evaluator. `ComfyUIWorkflow`
// solved the same problem the same way: its evaluator returns a DESCRIPTION
// carrying a content hash and the bytes are produced elsewhere
// (`src/render/runComfyUIWorkflow.ts`). This is that seam for motion.
//
// The store is CONTENT-ADDRESSED and MONOTONIC, and both properties are what
// keep `MotionGenerate` honestly `pure: true`:
//
//   - content-addressed: the key is a hash of everything the generation depends
//     on (prompt, seed, model, seconds, path shape). A different request is a
//     different key, so two requests can never collide on one entry — the exact
//     failure `types.ts` warns about when it explains why a seed belongs in
//     params rather than in `EvalCtx`.
//   - monotonic: an entry APPEARS, and never changes afterwards. So a given
//     (params, inputs) pair returns `pending` and then `ready`, and never two
//     different clips. A pure node is allowed to become answerable; it is not
//     allowed to change its answer.
//
// ⚠️ THE PURITY CLAIM IS A CLAIM ABOUT THE SERVER, NOT ABOUT THIS FILE.
// It holds iff the same (prompt, seed, model, seconds, waypoints) yields the
// same clip. If a backend is nondeterministic under a pinned seed, this store is
// what makes the graph honest anyway: the FIRST result is pinned under the hash
// and replayed forever, which is the reference substrate's lock/freeze snapshot
// rather than a re-roll on every cook. The failure mode it removes is a node
// that silently returns different motion on reload.
//
// REF: src/nodes/MotionGenerate.ts (the only reader); src/core/dag/types.ts
//      (the three-clause determinism contract — this is clause 3 made reachable);
//      src/nodes/ComfyUIWorkflow.ts (the same shape, one lane over); issue #902.

import type { AnimationKeyframe, SkeletonValue } from '../../nodes/types';

/** What a completed generation contributes to the clip the node evaluates to. */
export interface GeneratedClip {
  readonly duration: number;
  readonly keyframes: readonly AnimationKeyframe[];
  readonly skeleton: SkeletonValue;
  /** Echoed from the capability result — the checkpoint that actually ran. */
  readonly model: string;
}

/**
 * A generation that ended in a refusal or a transport failure.
 *
 * Recorded rather than discarded, and that is deliberate: without it a failed
 * request is indistinguishable from one that has not started, so the node sits
 * at `pending` forever and the resolver retries on every cook — turning one
 * unreachable server into an unbounded stream of requests. A recorded failure is
 * a terminal state a director can see and a resolver will not re-enter.
 */
export interface GeneratedClipFailure {
  readonly reason: string;
}

const clips = new Map<string, GeneratedClip>();
const failures = new Map<string, string>();

/** A resolved clip for this request, or undefined when none has been produced. */
export function lookupGeneratedClip(requestHash: string): GeneratedClip | undefined {
  return clips.get(requestHash);
}

/** The recorded reason this request failed, or undefined when it has not. */
export function lookupGenerationFailure(requestHash: string): string | undefined {
  return failures.get(requestHash);
}

/**
 * Record a completed generation.
 *
 * FIRST WRITE WINS, and the refusal is the point rather than an optimisation: a
 * second write under the same hash would change a value the graph has already
 * evaluated and cached, which is precisely the impurity this seam exists to
 * prevent. A backend that returns different bytes for an identical request is a
 * real possibility; letting the second answer overwrite the first would make the
 * node's output depend on WHEN it was asked.
 *
 * Returns the entry now in force, so a caller can tell what the graph will see.
 */
export function recordGeneratedClip(requestHash: string, clip: GeneratedClip): GeneratedClip {
  const existing = clips.get(requestHash);
  if (existing) return existing;
  clips.set(requestHash, clip);
  failures.delete(requestHash);
  return clip;
}

/** Record a terminal failure for this request. First write wins, as above. */
export function recordGenerationFailure(requestHash: string, reason: string): void {
  if (clips.has(requestHash) || failures.has(requestHash)) return;
  failures.set(requestHash, reason);
}

/**
 * Clear a recorded FAILURE so the request may be attempted again.
 *
 * The only sanctioned way back out of the terminal state, and it takes an
 * explicit act — a director pressing retry after starting the server. A resolver
 * cannot call this on its own without recreating the retry storm the failure
 * record exists to stop. Successful clips are NOT clearable: they are the pinned
 * answer, and dropping one would let the same graph produce different motion.
 */
export function clearGenerationFailure(requestHash: string): void {
  failures.delete(requestHash);
}

/** Test-only. Never called from production — the store's whole value is that it
 *  is monotonic within a session, and a reset breaks that for everyone. */
export function __resetGeneratedClipsForTests(): void {
  clips.clear();
  failures.clear();
}
