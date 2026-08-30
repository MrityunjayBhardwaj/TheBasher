// ModelGenerationCapability — the boundary between Basher and an external
// text-to-3D / image-to-3D service. Mirrors MotionGenerationCapability exactly,
// which mirrors ComfyUICapability: an interface, an Http implementation, and a
// Stub. The stub is not optional; it is what keeps the unit tier deterministic
// and offline.
//
// The contract returns GLB BYTES, and that choice is the whole phase. A generated
// mesh must take the identical code path an imported GLB takes, so the capability
// produces the same artefact a dropped .glb carries and hands it to the existing
// chokepoint. Returning a bespoke mesh struct would have created exactly the
// provenance branch A4 exists to avoid, and it would have needed a second import
// road to keep in step forever.
//
// 🔴 THE LICENCE UNIT HERE IS THE SERVICE, NOT A CHECKPOINT — and that is a real
// difference from A1, not a detail. Kimodo ships weights whose terms vary per
// checkpoint, so A1 gates on the checkpoint id. A hosted API ships no weights: what
// governs us is an agreement about the SERVICE, and a Tripo `model_version` is a
// menu choice inside it, not a separately-licensed artefact. So the gate is called
// once with the service id, and `modelVersion` is passed through ungated.
//
// The consequence is deliberate: until Tripo's terms are read and recorded, the
// service id is UNRECORDED, `assertModelAllowed` default-denies, and every Http
// generation refuses at the point of use with a message naming what is missing.
// The feature ships complete and inert. Recording the verdict enables it with no
// code change. That is A0's rule — nothing designed in before its terms are known —
// expressed as behaviour rather than as a promise to remember.
//
// REF: ref/architecture/ai-track.md phase A4; issues #732, #761, #762.
//      src/core/motiongen/MotionGenerationCapability.ts (the pattern).
//      ref/sources/tripo-python-sdk/tripo3d/client.py (the grounded contract:
//      BASE_URL :25, text_to_model :552, image_to_model :623, multiview :697).

import { z } from 'zod';

/** A supplied image, environment-agnostic. The Http impl uploads it; the stub
 *  hashes it. Bytes rather than a path because the app is a browser and the
 *  agent surface has no filesystem. */
export interface SourceImage {
  readonly bytes: Uint8Array;
  /** e.g. `image/png`, `image/jpeg`. Sent as the upload's content type. */
  readonly mimeType: string;
}

/**
 * Proportion controls the Blender plugin exposes for a posed humanoid
 * (`text_prompts_with_pose` + the five ratio sliders). Carried here so the
 * surface is a filled field rather than a changed contract later.
 *
 * REF: ref/sources/tripo-3d-for-blender/__init__.py — `use_pose_control`,
 * `head_body_height_ratio`, `head_body_width_ratio`, `legs_body_height_ratio`,
 * `arms_body_length_ratio`, `span_of_legs`.
 */
export interface PoseControl {
  readonly headBodyHeightRatio?: number;
  readonly headBodyWidthRatio?: number;
  readonly legsBodyHeightRatio?: number;
  readonly armsBodyLengthRatio?: number;
  readonly spanOfLegs?: number;
}

/** Options every generation kind accepts. Named in Basher's vocabulary; the Http
 *  implementation maps them to the service's snake_case at the one seam that
 *  knows the service exists. */
export interface ModelGenerationOptions {
  /** Service model version, e.g. `v2.5-20250123`. A menu choice inside the
   *  service agreement, NOT a separately-licensed checkpoint — see the header. */
  readonly modelVersion?: string;
  /** Cap on output triangles. Omitted means the service decides. */
  readonly faceLimit?: number;
  /** Ask for quads rather than triangles. Relevant far beyond A4 — the geometry
   *  track's topology work cares which one arrives. */
  readonly quad?: boolean;
  readonly texture?: boolean;
  readonly pbr?: boolean;
  readonly textureQuality?: 'standard' | 'detailed';
  readonly geometryQuality?: 'standard' | 'detailed';
  readonly textureAlignment?: 'original_image' | 'geometry';
  readonly autoSize?: boolean;
  readonly style?: string;
  readonly orientation?: 'default' | 'align_image';
  /** Determinism handles. The stub keys its output on the whole request. */
  readonly modelSeed?: number;
  readonly textureSeed?: number;
}

export interface TextModelRequest extends ModelGenerationOptions {
  readonly source: 'text';
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly pose?: PoseControl;
}

export interface ImageModelRequest extends ModelGenerationOptions {
  readonly source: 'image';
  readonly image: SourceImage;
}

export interface MultiviewModelRequest extends ModelGenerationOptions {
  readonly source: 'multiview';
  /** Front is required by the service; the other three are optional fills. */
  readonly views: {
    readonly front: SourceImage;
    readonly left?: SourceImage;
    readonly back?: SourceImage;
    readonly right?: SourceImage;
  };
}

export type ModelGenerationRequest = TextModelRequest | ImageModelRequest | MultiviewModelRequest;

/**
 * A task that ran to completion, without its output collected.
 *
 * 🔑 SEPARATE FROM `ModelGenerationResult` BECAUSE ONE CALLER GENUINELY DOES NOT
 * WANT THE MESH. Rigging happens service-side against a task id — `checkRiggable`
 * and `rig` both take `sourceTaskId` — so the rigged road needs the task to have
 * finished and nothing else. When the only way to run a task was to fetch its
 * output too, that road downloaded a 7.4 MB mesh and discarded every byte, and
 * the discarded download was what made the whole feature unreachable from a
 * browser (#832, #833). The narrow result is what makes "just the task" sayable.
 */
export interface ModelTaskResult {
  /** Service-assigned task id. Used by cancel(taskId) and for progress. */
  readonly taskId: string;
  /** The model version that produced it, echoed back for the caller's record. */
  readonly modelVersion: string;
}

export interface ModelGenerationResult extends ModelTaskResult {
  /** GLB bytes — byte-for-byte the kind of payload a dropped .glb carries. */
  readonly glb: ArrayBuffer;
}

/** Coarse progress, mirroring the plugin's progress bar. `progress` is 0..100.
 *  REF: ref/sources/tripo-3d-for-blender/task.py — TaskPropertyGroup. */
export interface ModelGenerationProgress {
  readonly taskId: string;
  readonly status: string;
  readonly progress: number;
}

export interface ModelGenerationCapability {
  readonly id: string;
  readonly kind: 'http' | 'stub';

  /** True iff the capability can produce a mesh in the current environment. */
  isAvailable(): Promise<boolean>;

  /**
   * Generate a mesh. Implementations that reach a SERVICE must refuse before any
   * network call when the service has no usable recorded verdict — a refusal
   * after the request has gone out has already made the use it exists to prevent.
   *
   * The Stub reaches no service and therefore does NOT consult the service
   * verdict: nothing it produces is governed by anyone's terms. That asymmetry is
   * the honest one, and it is why A1's rule ("both implementations call the
   * gate") does not transfer here — A1's licence unit was the checkpoint the stub
   * was standing in for.
   *
   * Throws on transport failure, timeout, an invalid request, or a refusal.
   */
  generate(
    request: ModelGenerationRequest,
    onProgress?: (p: ModelGenerationProgress) => void,
  ): Promise<ModelGenerationResult>;

  /**
   * Run the same task and return WITHOUT collecting its output.
   *
   * Same refusals, same validation, same progress, same billing — the only
   * difference is that the mesh is not fetched. For a caller that needs a task
   * id to hand to another service call, downloading the output is pure cost,
   * and it is cost with a failure mode attached: it was the step that broke
   * rigged generation in a browser entirely (#833).
   *
   * `generate` is defined in terms of this, rather than beside it, so the two
   * cannot disagree about what running a task means.
   */
  generateTaskOnly(
    request: ModelGenerationRequest,
    onProgress?: (p: ModelGenerationProgress) => void,
  ): Promise<ModelTaskResult>;

  /** Best-effort cancel. May no-op when the task already finished. */
  cancel(taskId: string): Promise<void>;
}

/**
 * Upper bound on the output's triangle budget. A resource limit, not taste:
 * `positive and finite` still admits `faceLimit: 1e9`, which asks the service for
 * a mesh no browser will import and bills for the privilege. Chosen generously —
 * well past any real-time asset — so it refuses runaway values without
 * adjudicating anyone's budget.
 */
export const MAX_FACE_LIMIT = 2_000_000;

/** Bound on a supplied image, so a mis-picked file is refused before upload
 *  rather than after. 32 MiB is far past any reference photo. */
export const MAX_SOURCE_IMAGE_BYTES = 32 * 1024 * 1024;

const SourceImageSchema = z.object({
  bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0, 'must not be empty'),
  mimeType: z.string().trim().min(1, 'must not be empty'),
});

const OptionsShape = {
  modelVersion: z.string().trim().min(1).optional(),
  faceLimit: z.number().int().positive().finite().max(MAX_FACE_LIMIT).optional(),
  quad: z.boolean().optional(),
  texture: z.boolean().optional(),
  pbr: z.boolean().optional(),
  textureQuality: z.enum(['standard', 'detailed']).optional(),
  geometryQuality: z.enum(['standard', 'detailed']).optional(),
  textureAlignment: z.enum(['original_image', 'geometry']).optional(),
  autoSize: z.boolean().optional(),
  style: z.string().trim().min(1).optional(),
  orientation: z.enum(['default', 'align_image']).optional(),
  modelSeed: z.number().int().finite().optional(),
  textureSeed: z.number().int().finite().optional(),
};

const RatioSchema = z.number().positive().finite();

/**
 * The request contract, as a runtime schema rather than a bare interface.
 *
 * It rejects rather than clamps, for the reason A1 recorded and measured: a
 * degenerate number here does not fail, it SUCCEEDS into well-formed nonsense
 * that every consumer downstream accepts. A clamp hides the caller's mistake more
 * quietly, and the caller may be a model that would otherwise learn from the
 * refusal.
 */
export const ModelGenerationRequestSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('text'),
    prompt: z.string().trim().min(1, 'must not be empty'),
    negativePrompt: z.string().trim().min(1).optional(),
    pose: z
      .object({
        headBodyHeightRatio: RatioSchema.optional(),
        headBodyWidthRatio: RatioSchema.optional(),
        legsBodyHeightRatio: RatioSchema.optional(),
        armsBodyLengthRatio: RatioSchema.optional(),
        spanOfLegs: RatioSchema.optional(),
      })
      .optional(),
    ...OptionsShape,
  }),
  z.object({
    source: z.literal('image'),
    image: SourceImageSchema.refine(
      (i) => i.bytes.byteLength <= MAX_SOURCE_IMAGE_BYTES,
      `must be at most ${MAX_SOURCE_IMAGE_BYTES} bytes`,
    ),
    ...OptionsShape,
  }),
  z.object({
    source: z.literal('multiview'),
    views: z.object({
      front: SourceImageSchema,
      left: SourceImageSchema.optional(),
      back: SourceImageSchema.optional(),
      right: SourceImageSchema.optional(),
    }),
    ...OptionsShape,
  }),
]);

/** Thrown when a request is malformed. Names the offending field, never clamps. */
export class ModelRequestInvalidError extends Error {
  /** One `field: reason` line per offending field, in the order zod reports them. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Model generation request is invalid — ${issues.join('; ')}.`);
    this.name = 'ModelRequestInvalidError';
    this.issues = issues;
  }
}

/**
 * Validate a request at the entry to `generate`. BOTH implementations call it —
 * unlike the licence gate, which only the Http one owes. A stub that skipped
 * validation would let a test prove a degenerate request "works", which is the
 * failure mode this whole file is shaped against.
 */
export function assertValidModelRequest(request: ModelGenerationRequest): void {
  const parsed = ModelGenerationRequestSchema.safeParse(request);
  if (parsed.success) return;
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '<request>'}: ${issue.message}`,
  );
  throw new ModelRequestInvalidError(issues);
}

/** A short, human-readable subject for a request — the clip/asset name default,
 *  and the label an error is reported under. Mirrors generateMotion's subjectOf. */
export function describeRequest(request: ModelGenerationRequest): string {
  if (request.source === 'text') {
    return request.prompt.length > 40 ? `${request.prompt.slice(0, 40)}…` : request.prompt;
  }
  return request.source === 'image' ? 'image-to-3D' : 'multiview-to-3D';
}
