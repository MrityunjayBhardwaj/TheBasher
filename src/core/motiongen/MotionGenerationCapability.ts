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
  /**
   * Planar waypoints in world XZ, in order, **in metres**.
   *
   * The unit is stated because the receiver states it — Kimodo's
   * `authoring.rebase_to_origin` documents its argument as "(x, z) ground
   * positions in metres, in world space" — and because every silent defect this
   * boundary has produced so far was a unit nobody wrote down. A path in the
   * wrong unit does not fail; it generates a walk of the wrong length, which
   * looks like a model quality problem rather than a contract one.
   *
   * The wire shape is NOT this shape: the server takes `waypoints` as a
   * top-level list of `[x, z]` pairs, and the translation happens in
   * HttpMotionGenerationCapability, where the reason is documented. Sending this
   * object across as-is is the defect #826 records.
   */
  readonly waypoints?: readonly { readonly x: number; readonly z: number }[];
  /**
   * Facing per waypoint, as a ground direction in the SAME frame and units as
   * `waypoints`. One per waypoint, or omitted entirely.
   *
   * Omitted is not "face along the path" — it is "say nothing", and the server's
   * answer to saying nothing is to keep the canonical frame-0 heading for the
   * whole clip, which makes the character travel a non-canonical path SIDEWAYS
   * (#897, measured: a +Z path holds yaw at -1.4° while walking to z=2.07). So
   * `HttpMotionGenerationCapability` derives tangents when a caller supplies
   * waypoints and no headings; this field is for a caller that wants a facing
   * the path does not imply — walking backwards, or watching something while
   * moving past it.
   *
   * The wire shape is `[cos, sin]` per the server's own wording, which measures
   * as (x, z) in this frame — see `pathHeadings.ts`, where the mapping was
   * established against the live service rather than read off the names.
   */
  readonly headings?: readonly { readonly x: number; readonly z: number }[];
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

  /**
   * Where in the world the clip was generated FROM, as `[x, z]`, or null when no
   * world path was asked for.
   *
   * The SECOND thing this result declares that the clip cannot say, and it is
   * here for the same reason `unitScale` is. Generation canonicalises frame 0 to
   * the origin, so a world path cannot be authored directly: the server rebases
   * the waypoints, generates about the origin, and hands back the offset a caller
   * must add to put the motion where it was actually asked for
   * (`serve.py:_build_constraints`, returned as `meta.world_offset_xz`).
   *
   * BVH cannot carry this. Frame 0 of the returned clip sits at the origin and
   * looks entirely correct there, so a consumer that is not told has nothing to
   * notice: the motion arrives right in shape and wrong in place — on the origin
   * rather than on the curve the director drew. That is a plausible result from a
   * silent failure, which is the class this boundary keeps producing.
   *
   * `null` is NOT `[0, 0]`, and the difference is the point: null means no world
   * path was requested and there is nothing to place, while `[0, 0]` means a path
   * was requested and happened to start at the origin. A consumer that collapses
   * them cannot tell "nobody asked" from "it belongs here".
   */
  readonly worldOffsetXZ: readonly [number, number] | null;

  /**
   * The rotation, in radians about the world Y axis in the waypoint frame
   * (+X = 0, +Z = +π/2), that a caller must apply to the clip to put its FACING
   * where it was asked for. `null` when no facing was requested.
   *
   * The THIRD thing this result declares that the clip cannot say, and the exact
   * twin of `worldOffsetXZ`: generation canonicalises frame 0's HEADING to zero
   * as well as its position, so a clip whose character should set off toward +Z
   * comes back setting off toward +X. Where `worldOffsetXZ` is the translation
   * that was rebased away, this is the rotation that was.
   *
   * It differs from `worldOffsetXZ` in ONE way worth stating: the server neither
   * performs nor reports it. The canonical heading is a known constant, so the
   * caller can rotate the request into that frame itself — which is what an
   * implementation returning a non-null value here has done. The value is
   * therefore a promise about the REQUEST that was issued, and a consumer that
   * ignores it gets a character that walks a path rotated off the drawn one.
   *
   * The two are ONE placement and must be applied together, to the same node, in
   * the order rotate-then-translate. Applying only the rotation walks the
   * character down the wrong path; applying only the translation reproduces the
   * defect #897 records.
   *
   * `null` is NOT `0`, for the same reason `worldOffsetXZ`'s null is not
   * `[0, 0]`: null means no facing was requested and there is nothing to apply,
   * while `0` means one was requested and happened to be the canonical direction.
   */
  readonly worldRotationRadians: number | null;
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
        headings: z.array(z.object({ x: z.number().finite(), z: z.number().finite() })).optional(),
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
  // Checked, not merely typed: this arrives from a service nobody in this repo
  // wrote, and the whole reason the field exists is that a wrong value here is
  // invisible in the clip. `undefined` is rejected as firmly as a malformed pair
  // — a producer that stays silent about placement is exactly the state the field
  // was added to end, and treating silence as "no offset" would reinstate it.
  const offset = result.worldOffsetXZ;
  if (offset !== null) {
    if (
      !Array.isArray(offset) ||
      offset.length !== 2 ||
      !offset.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      issues.push(
        `worldOffsetXZ: must be null (no world path requested) or a finite [x, z] pair — got ` +
          `${JSON.stringify(offset)}`,
      );
    }
  }
  // The facing half, checked with the same firmness and for a sharper reason: a
  // rotation is the one placement value whose wrongness is INVISIBLE in a still.
  // A character standing in the right place facing the wrong way reads as a bind
  // or retarget fault and sends the next person to the wrong sector entirely
  // (#897). NaN is the specific value to refuse — it is what an un-normalised or
  // zero-length heading produces, and it would reach a transform as a silent
  // identity.
  const rotation = result.worldRotationRadians;
  if (rotation !== null && !Number.isFinite(rotation)) {
    issues.push(
      `worldRotationRadians: must be null (no facing requested) or a finite angle in ` +
        `radians — got ${JSON.stringify(rotation)}`,
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
