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
  ComfyInputs,
  ComfySubmitResult,
  ComfyUICapability,
  ComfyWorkflowJson,
} from './ComfyUICapability';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface HttpComfyOptions {
  /** Per-submit timeout in ms (default 30000). */
  readonly timeoutMs?: number;
  /** Poll interval for /history (default 250ms). */
  readonly pollIntervalMs?: number;
  /** Override fetch (test injection). Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
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
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;

  constructor(url: string, opts: HttpComfyOptions = {}) {
    this.url = url.replace(/\/+$/, '');
    this.id = `http:${this.url}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.clientId = `basher_${Math.floor(Date.now() / 1000)}_${Math.floor(Math.random() * 1e6)}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.url}/system_stats`, {
        method: 'GET',
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
        headers: { 'Content-Type': 'application/json' },
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

  async cancel(jobId: string): Promise<void> {
    // ComfyUI's interrupt is server-wide. We send it best-effort and rely
    // on the server matching by current prompt id internally.
    try {
      await this.fetchImpl(`${this.url}/interrupt`, { method: 'POST' });
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
      signal,
    });
    if (!res.ok) {
      throw new Error(`ComfyUI /view rejected ${image.filename}: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}
