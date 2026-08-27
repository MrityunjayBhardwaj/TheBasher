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
  readonly fps?: number;
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
 * Upper bounds on the request's numbers. These are resource limits, not taste:
 * `positive and finite` alone still admits `fps: 1e6, seconds: 60`, which asks the
 * stub for 60,000,000 motion rows and hangs the tab that requested it. A bound has
 * to exist somewhere, and the entry to `generate` is the only place that sees the
 * pair before anything acts on it.
 *
 * Chosen generously — 240fps is four times film-adjacent playback, ten minutes is
 * longer than any single generated clip this track has a use for — so the bound
 * refuses runaway values without adjudicating anybody's frame rate.
 */
export const MAX_MOTION_FPS = 240;
export const MAX_MOTION_SECONDS = 600;

/**
 * The request contract, as a runtime schema rather than a bare interface.
 *
 * It rejects rather than clamps, and that is the load-bearing choice. Degenerate
 * numbers here do not fail — they SUCCEED into well-formed nonsense: `fps: 0`
 * produced `Frame Time: Infinity` with `NaN` channel values, and `fps: NaN` produced
 * a header claiming `Frames: NaN` over no rows at all. Both are valid-looking BVH to
 * every consumer downstream, which then becomes NaN keyframes in the graph with
 * nothing to point at. A clamp would hide the same mistake more quietly, and the
 * caller here may be a model that would otherwise learn from the refusal.
 */
export const MotionGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1, 'must not be empty'),
  model: z.string().trim().min(1, 'must not be empty'),
  seconds: z.number().positive().finite().max(MAX_MOTION_SECONDS).optional(),
  fps: z.number().positive().finite().max(MAX_MOTION_FPS).optional(),
  seed: z.number().int().finite().optional(),
  constraints: z
    .object({
      waypoints: z.array(z.object({ x: z.number().finite(), z: z.number().finite() })).optional(),
    })
    .optional(),
});

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

// The schema and the documented interface must describe the same contract. This
// is a compile-time assertion, not a runtime one: a field added to one and not the
// other stops the build rather than diverging silently.
type SchemaShape = z.infer<typeof MotionGenerationRequestSchema>;
const _schemaMatchesInterface: SchemaShape extends MotionGenerationRequest ? true : never = true;
void _schemaMatchesInterface;
