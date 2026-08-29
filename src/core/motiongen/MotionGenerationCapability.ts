// MotionGenerationCapability — the boundary between Basher and an external
// text-to-motion service. Mirrors ComfyUICapability exactly: an interface, an
// Http implementation, and a Stub implementation. The stub is not optional; it
// is what keeps the unit tier deterministic and offline.
//
// The contract returns BVH TEXT, and that choice is the whole point of the phase.
// A generated clip must be indistinguishable downstream from an imported one, so
// the capability produces the same artefact a .bvh file carries and hands it to
// `buildBvhImportOps` — the identical road an import takes. No new import path
// exists, therefore no code path downstream can ask which one was generated.
// Returning a bespoke motion struct would have created exactly the provenance
// branch this phase exists to avoid.
//
// REF: ref/architecture/ai-track.md phase A1; src/core/comfy/ComfyUICapability.ts
// (the pattern); src/core/import/bvhImportChain.ts (the road).

import { z } from 'zod';
import { readBvhProfile } from '../import/bvhProfile';

/**
 * Constraints the generator accepts alongside the prompt. Kimodo takes 2D paths
 * and 2D waypoints among others; A2 wires an authored CurveData into `waypoints`
 * so editing the curve re-cooks the motion. Declared here now so A2 is a filled
 * field rather than a changed contract.
 */
export interface MotionConstraints {
  /** Planar waypoints in world XZ, in order. */
  readonly waypoints?: readonly { readonly x: number; readonly z: number }[];
}

export interface MotionGenerationRequest {
  readonly prompt: string;
  /**
   * The checkpoint to run. Checked against the licence manifest before any
   * request is issued — see assertModelAllowed. Named explicitly rather than
   * defaulted inside the capability, because the licence varies per checkpoint
   * within a single release and a hidden default would pick one silently.
   */
  readonly model: string;
  readonly seconds?: number;
  // THERE IS NO `fps` FIELD, AND ITS ABSENCE IS PART OF THE CONTRACT.
  //
  // The sampling rate is the generator's to decide, not the caller's to ask for.
  // Measured against the backends this capability names as its successors, two of
  // three cannot honour a requested rate at all: Kimodo's server takes a duration
  // and a frame count and has no fps field, and ARDY's rate is a property of the
  // checkpoint. A field only the stub could honour teaches every caller a false
  // expectation, and the failure is quiet — the clip arrives, gets read at the
  // rate that was ASKED for rather than the rate it was sampled at, and plays
  // mistimed while looking correct.
  //
  // The clip states its own rate in its `Frame Time` header, so nobody has to be
  // told: read it with `readBvhProfile`. A derived value cannot disagree with the
  // artifact it describes; a reported one can, and would still pass every test
  // that read the report.
  /** Determinism handle. The stub keys its output on the whole request. */
  readonly seed?: number;
  readonly constraints?: MotionConstraints;
}

export interface MotionGenerationResult {
  /** Service-assigned job id. Used by cancel(jobId). */
  readonly jobId: string;
  /** BVH text — byte-for-byte the kind of payload an imported .bvh carries. */
  readonly bvh: string;
  /** The checkpoint that produced it, echoed back for provenance in the node. */
  readonly model: string;
  /**
   * Metres per BVH length unit in `bvh`. Required, and the ONLY property this
   * result declares that the clip does not state about itself.
   *
   * BVH has no unit field — the format simply does not carry one — so a consumer
   * that is not told has no way to find out and every existing one assumes
   * metres. Measured: a real Kimodo clip is in CENTIMETRES (it puts the hip 100
   * units off the floor), and this repo's own stub emits metres. Imported at the
   * assumed scale, the Kimodo character's hips land 193 metres up.
   *
   * Everything else worth knowing — the sampling rate, the frame count, which
   * joint carries world translation — IS stated by the clip, and is read from it
   * rather than declared here. Declare only what the artifact cannot say.
   */
  readonly unitScale: number;
}

export interface MotionGenerationCapability {
  readonly id: string;
  readonly kind: 'http' | 'stub';

  /** True iff the capability can produce motion in the current environment. */
  isAvailable(): Promise<boolean>;

  /**
   * Generate a clip. Implementations MUST refuse a model whose licence verdict
   * forbids it, before any network call — a refusal that happens after the
   * request has been issued has already made the use it was meant to prevent.
   *
   * Throws on transport failure, timeout, or a licence refusal.
   */
  generate(request: MotionGenerationRequest): Promise<MotionGenerationResult>;

  /** Best-effort cancel. May no-op when the job already finished. */
  cancel(jobId: string): Promise<void>;
}

/**
 * Upper bound on the requested clip length. A resource limit, not taste: ten
 * minutes is longer than any single generated clip this track has a use for, and
 * with the rate now the generator's to choose, `seconds` is the only number a
 * caller supplies that decides how much motion gets synthesised.
 */
export const MAX_MOTION_SECONDS = 600;

/**
 * Upper bound on a clip's sampling rate, checked on the RESULT rather than on the
 * request — the bound survived the field's removal because its reason did, but it
 * had to be re-aimed rather than patched onto whatever was left.
 *
 * It originally guarded a pair that no longer exists: `fps: 1e6, seconds: 60` asked
 * the stub for 60,000,000 rows and hung the tab. Nothing can ask for that now. What
 * remains is the other half of the same problem, one step downstream — a clip whose
 * `Frame Time` is absurd or degenerate is well-formed-looking BVH that becomes NaN
 * keyframes in the graph with nothing to point at. 240fps is four times
 * film-adjacent playback, so the bound refuses runaway values without adjudicating
 * any real generator's frame rate.
 */
export const MAX_MOTION_FPS = 240;

/**
 * The request contract, as a runtime schema rather than a bare interface.
 *
 * It rejects rather than clamps, and that is the load-bearing choice. Degenerate
 * numbers here do not fail — they SUCCEED into well-formed nonsense. When `fps`
 * was still a field, `fps: 0` produced `Frame Time: Infinity` with `NaN` channel
 * values and `fps: NaN` produced a header claiming `Frames: NaN` over no rows at
 * all; both are valid-looking BVH to every consumer downstream, which then becomes
 * NaN keyframes in the graph with nothing to point at. A clamp would hide the same
 * mistake more quietly, and the caller here may be a model that would otherwise
 * learn from the refusal.
 *
 * STRICT, and for the same reason the field was removed rather than deprecated. A
 * caller that has not caught up — an agent emitting JSON, a saved plan, a tool
 * schema someone forgot — sends `fps` and a permissive object silently STRIPS it,
 * so the request succeeds while quietly ignoring the one thing the caller asked
 * for. Naming the unknown field is the whole point: the caller learns the rate is
 * not theirs to choose instead of believing it was honoured.
 */
export const MotionGenerationRequestSchema = z
  .object({
    prompt: z.string().trim().min(1, 'must not be empty'),
    model: z.string().trim().min(1, 'must not be empty'),
    seconds: z.number().positive().finite().max(MAX_MOTION_SECONDS).optional(),
    seed: z.number().int().finite().optional(),
    constraints: z
      .object({
        waypoints: z.array(z.object({ x: z.number().finite(), z: z.number().finite() })).optional(),
      })
      .optional(),
  })
  .strict();

/** Thrown when a request is malformed. Names the offending field, never clamps. */
export class MotionRequestInvalidError extends Error {
  /** One `field: reason` line per offending field, in the order zod reports them. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Motion generation request is invalid — ${issues.join('; ')}.`);
    this.name = 'MotionRequestInvalidError';
    this.issues = issues;
  }
}

/**
 * Validate a request at the entry to `generate`. Both implementations call it, for
 * the same reason both call `assertModelAllowed`: a stub that skipped the check
 * would let a test prove a degenerate request "works".
 */
export function assertValidMotionRequest(request: MotionGenerationRequest): void {
  const parsed = MotionGenerationRequestSchema.safeParse(request);
  if (parsed.success) return;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '<request>'}: ${issue.message}`,
  );
  throw new MotionRequestInvalidError(issues);
}

/** Thrown when a capability hands back a result the contract does not allow. */
export class MotionResultInvalidError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Motion generation result is invalid — ${issues.join('; ')}.`);
    this.name = 'MotionResultInvalidError';
    this.issues = issues;
  }
}

/**
 * Validate what came BACK, at the exit of `generate`, in every implementation.
 *
 * The request check has a long-standing justification — a caller may be a model
 * that learns from the refusal. This one exists for the mirror-image reason: the
 * PRODUCER may be a service nobody in this repo wrote, and the two things it tells
 * us that we cannot recompute are `unitScale` and `model`. A missing or absurd
 * `unitScale` is not a smaller version of a correct one; it is the difference
 * between a character standing in a room and a character 100x the size of the
 * room, and unchecked it arrives as a plausible number nobody questioned.
 *
 * The rate is bounded here too, read off the clip rather than off a label, so a
 * degenerate `Frame Time` is named at the boundary that produced it instead of
 * becoming NaN keyframes several hops later with nothing to point at.
 */
export function assertValidMotionResult(result: MotionGenerationResult): void {
  const issues: string[] = [];
  if (typeof result.bvh !== 'string' || result.bvh.length === 0) {
    issues.push('bvh: must be a non-empty BVH payload');
  }
  if (!Number.isFinite(result.unitScale) || result.unitScale <= 0) {
    issues.push(
      `unitScale: must be a positive, finite number of metres per BVH unit — got ${result.unitScale}`,
    );
  }
  // Only worth reading the clip's own rate once the payload is known to be there.
  if (issues.length === 0) {
    try {
      const { fps } = readBvhProfile(result.bvh);
      if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_MOTION_FPS) {
        issues.push(`bvh: declares ${fps} fps — outside 0 < fps <= ${MAX_MOTION_FPS}`);
      }
    } catch (err) {
      issues.push(`bvh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (issues.length > 0) throw new MotionResultInvalidError(issues);
}

// The schema and the documented interface must describe the same contract. This
// is a compile-time assertion, not a runtime one: a field added to one and not the
// other stops the build rather than diverging silently.
type SchemaShape = z.infer<typeof MotionGenerationRequestSchema>;
const _schemaMatchesInterface: SchemaShape extends MotionGenerationRequest ? true : never = true;
void _schemaMatchesInterface;
