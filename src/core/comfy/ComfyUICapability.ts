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
   * Best-effort cancel. Implementations may no-op when the job has
   * already produced its result. Throws only on transport failure.
   */
  cancel(jobId: string): Promise<void>;
}
