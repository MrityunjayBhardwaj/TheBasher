// ComfyUICapability — the V6 boundary between Basher and an external
// ComfyUI server. Two impls ship in P5:
//
//   HttpComfyUICapability — POSTs the workflow JSON to ComfyUI's HTTP API,
//     polls for completion, fetches result bytes.
//   StubComfyUICapability — deterministic synthesis (sourceHash-keyed PNG)
//     for tests + offline development. Mirrors `stubEncoder` from P4.
//
// V6 (capability interfaces): no caller outside `src/core/comfy/` may
// import `fetch` to hit the ComfyUI server, nor reach into network plumbing
// directly. Switching to a remote ComfyUI host or a different stylizer is
// a constructor swap.
//
// D-07 (locked): URL is injected at construction. The boot wiring resolves
// `settings.get('comfyui.serverUrl') ?? 'http://127.0.0.1:8188'`.
//
// REF: project_p5_context D-07; vyapti V6; THESIS §28, §44.

/**
 * ComfyUI workflow JSON. Opaque to Basher — the preset registry owns the
 * shape; the capability just forwards it. Typed `unknown` so we don't lock
 * in to a specific ComfyUI workflow schema (the format evolves with
 * ComfyUI releases).
 */
export type ComfyWorkflowJson = unknown;

/**
 * Inputs to substitute into the workflow JSON before submission.
 *
 * `images` maps a placeholder name (e.g. `'beauty'`, `'depth'`,
 * `'prev_frame_image'`) to PNG bytes. The capability uploads each image
 * via ComfyUI's `/upload/image` endpoint and rewrites the workflow to
 * reference the uploaded filename.
 *
 * `scalars` maps a placeholder name to a primitive value (prompt text,
 * frame number, seed). Substitution is the preset's responsibility — the
 * capability just passes them through.
 */
export interface ComfyInputs {
  readonly images: Record<string, Uint8Array>;
  readonly scalars: Record<string, string | number>;
}

export interface ComfySubmitResult {
  /** Server-assigned prompt id. Used by `cancel(jobId)`. */
  readonly jobId: string;
  /** PNG bytes of the produced frame. Single-frame return — caller loops. */
  readonly frame: Uint8Array;
}

/**
 * The result of a BATCHED submit (the compiled coherent path, design §8). One
 * `/prompt` runs a whole animated sequence as a single batch, so the result is N
 * frames (or a muxed video from a VideoCombine-style node) — not one. This is the
 * hard contract change single-frame `submit` could not express; the coherent
 * compiled render (Inc 4) needs it.
 */
export interface ComfyBatchResult {
  /** Server-assigned prompt id (parity with ComfySubmitResult). */
  readonly jobId: string;
  /** PNG bytes per frame, in batch-index order. Collected from ALL output nodes
   *  of the batched workflow (not just the first), so a SaveImage emitting N
   *  images yields N frames. Empty only if the workflow produced no images. */
  readonly frames: readonly Uint8Array[];
  /** A muxed video blob, when the workflow ends in a video-combine node that
   *  emits a single file instead of a frame batch. Mutually exclusive with a
   *  populated `frames` in practice; the caller prefers `video` when present. */
  readonly video?: Uint8Array;
}

export interface ComfyUICapability {
  readonly id: string;
  readonly kind: 'http' | 'stub';

  /** True iff the capability can produce frames in the current environment. */
  isAvailable(): Promise<boolean>;

  /**
   * Submit a workflow + inputs and return the produced PNG bytes for one
   * frame. Multi-frame execution is the caller's loop concern (P5 D-04 +
   * krama K10 in the execution layer).
   *
   * Implementations may throw on transport failure, timeout, or workflow
   * validation rejection. Callers translate exceptions into
   * `lastGoodFrame` writebacks (V8: writeback Op dispatched from caller,
   * never from `src/core/comfy/`).
   */
  submit(workflowJson: ComfyWorkflowJson, inputs: ComfyInputs): Promise<ComfySubmitResult>;

  /**
   * Submit a COMPILED BATCHED workflow + inputs and return ALL the frames it
   * produced (the coherent path, design §8). One `/prompt` runs the whole batch;
   * the result collects every output image (a SaveImage emitting N images → N
   * frames), or a muxed video blob from a video-combine node. Distinct from
   * `submit` so the per-frame preview path stays a clean single-frame contract.
   *
   * Implementations may throw on transport failure, timeout, or workflow
   * validation rejection (same as `submit`).
   */
  submitBatch(workflowJson: ComfyWorkflowJson, inputs: ComfyInputs): Promise<ComfyBatchResult>;

  /**
   * Best-effort cancel. Implementations may no-op when the job has
   * already produced its result. Throws only on transport failure.
   */
  cancel(jobId: string): Promise<void>;
}
