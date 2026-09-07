// The resolver half of `MotionGenerate` (#902) — the only thing that performs a
// generation, and the reason the node's `evaluate` can stay free of I/O.
//
// The division mirrors ComfyUIWorkflow's: the NODE describes the request and
// reads a content-addressed store, and a separate site produces the artefact.
// It lives in `src/app/` rather than in `src/nodes/` because it needs two things
// an evaluator does not have — the graph state that the world seam walks to
// resolve a curve's transform, and the capability boundary.
//
// ── WHAT MAKES THIS SAFE TO CALL REPEATEDLY ──────────────────────────────────
// Every step is keyed on the request hash the NODE computed. The resolver never
// recomputes that hash: it reads it off the evaluated value, so the two cannot
// drift apart the way two copies of one derivation always eventually do. A node
// already `ready` or already `failed` is skipped, and an in-flight hash is held
// so a second call during a slow generation does not issue the same paid request
// twice.
//
// ── THE WORLD OFFSET IS CARRIED, NOT DROPPED ────────────────────────────────
// Generation canonicalises frame 0 to the origin and hands back the offset
// needed to put the motion where the curve actually is. Nothing here applies it
// — placement belongs to whatever binds the clip to a character, which is the
// node that owns where a thing stands. Dropping it silently is the documented
// defect at this boundary: the motion arrives right in shape and wrong in place,
// which looks entirely correct in a screenshot. So it is recorded on the clip
// and surfaced through the node's generation state for a placement step to read.
//
// REF: src/nodes/MotionGenerate.ts (the node + the hash); src/core/motiongen/
//      generatedClipCache.ts (the store); src/app/asset/motionPathFromCurve.ts
//      (the world seam); src/core/import/bvh.ts (BVH text → clip values);
//      issues #902, #730, #826.

import { bumpEvaluatorContentEpoch, evaluate } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import { parseBvh } from '../../core/import/bvh';
import type { MotionGenerationCapability } from '../../core/motiongen/MotionGenerationCapability';
import {
  lookupGeneratedClip,
  lookupGenerationFailure,
  recordGeneratedClip,
  recordGenerationFailure,
} from '../../core/motiongen/generatedClipCache';
import type { AnimationClipValue } from '../../nodes/types';
import type { MotionGenerateParams } from '../../nodes/MotionGenerate';
import { waypointsFromCurve } from './motionPathFromCurve';

/**
 * Hashes currently being generated.
 *
 * MODULE-LEVEL rather than per-call, because the duplicate this prevents is
 * across calls: a director drags a control point, the resolver starts, and a
 * re-render calls the resolver again before the first request returns. Per-call
 * bookkeeping cannot see the first request and would issue the second.
 */
const inFlight = new Set<string>();

export interface MotionResolution {
  readonly nodeId: string;
  readonly requestHash: string;
  readonly outcome: 'generated' | 'failed' | 'skipped';
  readonly reason?: string;
}

/** Every MotionGenerate node in the graph, with its evaluated clip. */
function pendingGenerations(
  state: DagState,
): { nodeId: string; clip: AnimationClipValue; params: MotionGenerateParams }[] {
  const out: { nodeId: string; clip: AnimationClipValue; params: MotionGenerateParams }[] = [];
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.type !== 'MotionGenerate') continue;
    const clip = evaluate(state, nodeId).value as AnimationClipValue;
    if (clip.generation?.status !== 'pending') continue;
    out.push({ nodeId, clip, params: node.params as MotionGenerateParams });
  }
  return out;
}

/**
 * The world path this node asks for, or null when it wires none.
 *
 * Read through the same world seam the imperative road uses rather than off the
 * evaluated input value: local control points are not waypoints, and reading
 * them directly produces a path of the right shape in the wrong place.
 */
function waypointsFor(state: DagState, nodeId: string) {
  const binding = state.nodes[nodeId]?.inputs?.path;
  if (!binding || Array.isArray(binding)) return null;
  return waypointsFromCurve(state, binding.node);
}

/**
 * Generate every pending MotionGenerate in the graph.
 *
 * Returns one row per node considered, so a caller can report what happened
 * instead of inferring it from a count — a summary that says "2 generated"
 * cannot distinguish two successes from one success and one already-in-flight.
 */
export async function resolvePendingMotionGenerations(
  state: DagState,
  capability: MotionGenerationCapability,
): Promise<MotionResolution[]> {
  const results: MotionResolution[] = [];
  let landed = 0;

  for (const { nodeId, clip, params } of pendingGenerations(state)) {
    const requestHash = clip.generation!.requestHash;

    if (inFlight.has(requestHash)) {
      results.push({ nodeId, requestHash, outcome: 'skipped', reason: 'already generating' });
      continue;
    }
    // Re-checked even though the node reported `pending`: two nodes with
    // identical params share one hash, so the first one's result answers the
    // second and issuing its request again would be paying twice for one clip.
    if (lookupGeneratedClip(requestHash) || lookupGenerationFailure(requestHash) !== undefined) {
      results.push({ nodeId, requestHash, outcome: 'skipped', reason: 'already resolved' });
      continue;
    }

    inFlight.add(requestHash);
    try {
      const waypoints = waypointsFor(state, nodeId);
      const generated = await capability.generate({
        prompt: params.prompt,
        model: params.model,
        seed: params.seed,
        ...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
        ...(waypoints ? { constraints: { waypoints } } : {}),
      });
      const parsed = parseBvh(
        generated.bvh,
        params.name.trim() || params.prompt,
        generated.unitScale,
      );
      recordGeneratedClip(requestHash, {
        duration: parsed.clipParams.duration,
        keyframes: parsed.clipParams.keyframes,
        skeleton: { kind: 'Skeleton', bones: parsed.skeletonParams.bones },
        model: generated.model,
        worldOffsetXZ: generated.worldOffsetXZ,
      });
      landed++;
      results.push({ nodeId, requestHash, outcome: 'generated' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Recorded rather than rethrown: a refusal must be a terminal state the
      // node can report, or the resolver re-enters it on every cook and one
      // unreachable server becomes an unbounded stream of requests.
      recordGenerationFailure(requestHash, reason);
      landed++;
      results.push({ nodeId, requestHash, outcome: 'failed', reason });
    } finally {
      inFlight.delete(requestHash);
    }
  }

  // ONE bump for the whole pass, and only when something actually changed. The
  // node's params and inputs are unchanged by a generation, so its cache key is
  // unchanged too — without this, every evaluator cache keeps serving the
  // `pending` value it already computed and the clip never reaches the screen.
  if (landed > 0) bumpEvaluatorContentEpoch();

  return results;
}
