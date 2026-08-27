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
