// HttpComfyUICapability — talks to a real ComfyUI server over HTTP.
//
// Pipeline per submit:
//   1. Upload each input image via POST /upload/image. Each image lands at
//      `${name}.png` inside ComfyUI's input folder.
//   2. POST /prompt with the workflow JSON. The caller's workflow JSON
//      already references the uploaded images by `${name}.png` — the preset
//      compiler in src/agent/strategy/presets/ owns substitution.
//   3. Poll /history/{prompt_id} until the prompt's outputs land.
//   4. Fetch the output image via /view?filename=...&type=output.
//   5. Return { jobId, frame }.
//
// Cancellation routes through /interrupt — best-effort. ComfyUI interrupts
// the current prompt only; if our prompt has already completed, no-op.
//
// 30-second submit timeout (project_p5_prompt locked). Caller catches the
// rejection and writes back lastGoodFrame; resume logic in
// runComfyUIWorkflow picks up from frame N+1 on the next attempt.
//
// REF: project_p5_context D-07; THESIS §28, §44; vyapti V6.

import type {
  ComfyBatchResult,
  ComfyInputs,
  ComfySubmitResult,
  ComfyUICapability,
  ComfyWorkflowJson,
} from './ComfyUICapability';
import { comfyWsUrl, parseComfyWsMessage, type ComfyProgressEvent } from './comfyProgress';

const DEFAULT_TIMEOUT_MS = 30_000;
// A BATCHED render runs N frames through one /prompt — inherently long (seconds per
// frame × N, plus model load). The 30s single-frame budget starves it: a 3-frame
// SD1.5 batch on MPS already takes ~43s, so the abort fires while the SERVER is still
// succeeding (the H125-family trap — server execution_success while the app shows
// nothing ⇒ a client-side timeout). 10 minutes covers realistic batch + model-load.
const DEFAULT_BATCH_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface HttpComfyOptions {
  /** Per-submit timeout in ms (default 30000). */
  readonly timeoutMs?: number;
  /** Per-BATCH-submit timeout in ms (default 600000 — batches are long, §16 Q-F). */
  readonly batchTimeoutMs?: number;
  /** Poll interval for /history (default 250ms). */
  readonly pollIntervalMs?: number;
  /** Override fetch (test injection). Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override the WebSocket ctor (test injection). Defaults to globalThis.WebSocket;
   *  undefined when the runtime has no WebSocket → live progress is silently skipped. */
  readonly webSocketImpl?: typeof WebSocket;
  /** Optional `Authorization` header value sent on every request (a guarded /
   *  tunnelled ComfyUI behind auth). Empty/undefined → no header. */
  readonly authHeader?: string;
}

interface ComfyHistoryEntry {
  outputs?: Record<
    string,
    {
      images?: Array<{
        filename: string;
        subfolder?: string;
        type?: string;
      }>;
    }
  >;
  status?: {
    completed?: boolean;
    status_str?: string;
  };
}

export class HttpComfyUICapability implements ComfyUICapability {
  readonly id: string;
  readonly kind = 'http' as const;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly batchTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketImpl?: typeof WebSocket;
  private readonly clientId: string;
  private readonly authHeader?: string;

  constructor(url: string, opts: HttpComfyOptions = {}) {
    this.url = url.replace(/\/+$/, '');
    this.id = `http:${this.url}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.batchTimeoutMs = opts.batchTimeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // Bind to the global: a bare `globalThis.fetch` stored on the instance and
    // later called as `this.fetchImpl(...)` rebinds `this` to the instance, which
    // the browser rejects with "Illegal invocation". (Tests inject their own fn.)
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // WebSocket is a global constructor (no `this` rebind concern like fetch had —
    // it's invoked with `new`); undefined in a runtime without it → progress skipped.
    this.webSocketImpl =
      opts.webSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    this.clientId = `basher_${Math.floor(Date.now() / 1000)}_${Math.floor(Math.random() * 1e6)}`;
    this.authHeader =
      opts.authHeader && opts.authHeader.trim() ? opts.authHeader.trim() : undefined;
  }

  /** Merge the optional Authorization header into a request's headers — applied
   *  to EVERY call so a guarded server is reachable on all endpoints, not just
   *  the probe. No-op when no auth is configured. */
  private headers(base: Record<string, string> = {}): Record<string, string> {
    return this.authHeader ? { ...base, Authorization: this.authHeader } : base;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}/system_stats`, {
        method: 'GET',
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async submit(workflowJson: ComfyWorkflowJson, inputs: ComfyInputs): Promise<ComfySubmitResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // 1. Upload input images. Each image lands at `${name}.png` inside
      //    ComfyUI's input folder; the workflow JSON references them by
      //    that path (preset compiler's responsibility).
      for (const [name, bytes] of Object.entries(inputs.images)) {
        await this.uploadImage(name, bytes, controller.signal);
      }

      // 2. Queue the prompt. ComfyUI returns the assigned prompt_id we'll
      //    poll on.
      const promptRes = await this.fetchImpl(`${this.url}/prompt`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt: workflowJson, client_id: this.clientId }),
        signal: controller.signal,
      });
      if (!promptRes.ok) {
        const text = await promptRes.text();
        throw new Error(`ComfyUI /prompt rejected: ${promptRes.status} ${text}`);
      }
      const promptBody = (await promptRes.json()) as { prompt_id?: string };
      const jobId = promptBody.prompt_id;
      if (!jobId) throw new Error('ComfyUI /prompt response missing prompt_id');

      // 3. Poll /history until the prompt's outputs appear.
      const outputs = await this.pollUntilComplete(jobId, controller.signal);

      // 4. Fetch the first output image. The preset is expected to pin a
      //    single SaveImage node; if multiple outputs exist, the first
      //    image of the first node wins (deterministic via node id sort).
      const firstNodeId = Object.keys(outputs).sort()[0];
      const firstImage = outputs[firstNodeId]?.images?.[0];
      if (!firstImage) {
        throw new Error(`ComfyUI prompt ${jobId} completed but produced no output image`);
      }
      const frame = await this.fetchImage(firstImage, controller.signal);
      return { jobId, frame };
    } finally {
      clearTimeout(timer);
    }
  }

  async submitBatch(
    workflowJson: ComfyWorkflowJson,
    inputs: ComfyInputs,
    onEvent?: (event: ComfyProgressEvent) => void,
  ): Promise<ComfyBatchResult> {
    const controller = new AbortController();
    // Batches are long — use the generous batch budget, not the 30s single-frame one
    // (else the abort fires while the server is still succeeding — see the constant).
    const timer = setTimeout(() => controller.abort(), this.batchTimeoutMs);
    // Open the live progress socket BEFORE /prompt so no early `executing`/`progress`
    // event is missed. Best-effort: any failure leaves the submit unaffected.
    const ws = onEvent ? this.openProgressSocket(onEvent) : null;
    try {
      // 1. Upload input images (same as submit — the workflow references them by
      //    `${name}.png`).
      for (const [name, bytes] of Object.entries(inputs.images)) {
        await this.uploadImage(name, bytes, controller.signal);
      }

      // 2. Queue the compiled batched prompt.
      const promptRes = await this.fetchImpl(`${this.url}/prompt`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt: workflowJson, client_id: this.clientId }),
        signal: controller.signal,
      });
      if (!promptRes.ok) {
        const text = await promptRes.text();
        throw new Error(`ComfyUI /prompt rejected: ${promptRes.status} ${text}`);
      }
      const promptBody = (await promptRes.json()) as { prompt_id?: string };
      const jobId = promptBody.prompt_id;
      if (!jobId) throw new Error('ComfyUI /prompt response missing prompt_id');

      // 3. Poll until the batched outputs land.
      const outputs = await this.pollUntilComplete(jobId, controller.signal);

      // 4. Collect EVERY output image across ALL output nodes (node-id sorted for
      //    a deterministic batch order) — a batched SaveImage emits N images, so
      //    unlike `submit` (first node → first image) we must gather them all
      //    (design §8). A video-combine node emits a single file with type
      //    'output' too; for now it is collected as a frame (the muxed-video
      //    branch is a later refinement against a real VHS workflow).
      const frames: Uint8Array[] = [];
      for (const nodeId of Object.keys(outputs).sort()) {
        for (const image of outputs[nodeId]?.images ?? []) {
          frames.push(await this.fetchImage(image, controller.signal));
        }
      }
      if (frames.length === 0) {
        throw new Error(`ComfyUI prompt ${jobId} completed but produced no output images`);
      }
      return { jobId, frames };
    } finally {
      clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // already closed / never opened — nothing to release.
        }
      }
    }
  }

  /** Open the `/ws` progress socket bound to this client's id (so it receives only
   *  THIS client's events) and route each parsed message to `onEvent`. Best-effort:
   *  the WebSocket ctor or connection failing leaves the render unaffected (progress
   *  just never arrives). Returns null when no WebSocket impl is available. Note:
   *  browsers can't set an Authorization header on a WebSocket — a header-guarded
   *  server won't stream progress, but the submit still completes over fetch. */
  private openProgressSocket(onEvent: (e: ComfyProgressEvent) => void): WebSocket | null {
    if (!this.webSocketImpl) return null;
    try {
      const ws = new this.webSocketImpl(comfyWsUrl(this.url, this.clientId));
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (ev: MessageEvent) => {
        const parsed = parseComfyWsMessage(ev.data as string | ArrayBuffer);
        if (parsed) onEvent(parsed);
      };
      ws.onerror = () => {
        /* best-effort — swallow; the submit path does not depend on the socket */
      };
      return ws;
    } catch {
      return null;
    }
  }

  async cancel(jobId: string): Promise<void> {
    // ComfyUI's interrupt is server-wide. We send it best-effort and rely
    // on the server matching by current prompt id internally.
    try {
      await this.fetchImpl(`${this.url}/interrupt`, { method: 'POST', headers: this.headers() });
    } catch {
      // best-effort
    }
    // jobId referenced for parity with future per-job cancellation APIs.
    void jobId;
  }

  // ----- helpers --------------------------------------------------------

  private async uploadImage(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const filename = `${name}.png`;
    const form = new FormData();
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: 'image/png' });
    form.append('image', blob, filename);
    form.append('overwrite', 'true');
    const res = await this.fetchImpl(`${this.url}/upload/image`, {
      method: 'POST',
      headers: this.headers(), // no Content-Type: the browser sets the multipart boundary
      body: form,
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI /upload/image rejected ${filename}: ${res.status} ${text}`);
    }
  }

  private async pollUntilComplete(
    jobId: string,
    signal: AbortSignal,
  ): Promise<NonNullable<ComfyHistoryEntry['outputs']>> {
    while (!signal.aborted) {
      const res = await this.fetchImpl(`${this.url}/history/${jobId}`, {
        method: 'GET',
        headers: this.headers(),
        signal,
      });
      if (!res.ok) {
        throw new Error(`ComfyUI /history/${jobId} rejected: ${res.status}`);
      }
      const body = (await res.json()) as Record<string, ComfyHistoryEntry>;
      const entry = body[jobId];
      if (entry?.outputs && Object.keys(entry.outputs).length > 0) {
        return entry.outputs;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(`ComfyUI submit timed out (${this.timeoutMs}ms) for prompt ${jobId}`);
  }

  private async fetchImage(
    image: { filename: string; subfolder?: string; type?: string },
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const params = new URLSearchParams({
      filename: image.filename,
      type: image.type ?? 'output',
    });
    if (image.subfolder) params.set('subfolder', image.subfolder);
    const res = await this.fetchImpl(`${this.url}/view?${params.toString()}`, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      throw new Error(`ComfyUI /view rejected ${image.filename}: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}
