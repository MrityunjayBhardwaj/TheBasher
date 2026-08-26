// HttpMotionGenerationCapability — talks to an external text-to-motion service.
//
// The service URL is injected at construction, mirroring the ComfyUI capability's
// locked decision: switching hosts, or swapping the generator entirely, is a
// constructor swap and never an edit to a caller. No module outside
// `src/core/motiongen/` may reach the service directly.
//
// The licence check runs BEFORE the request is issued. Refusing after the call
// has gone out would have already made the use it exists to prevent — and for a
// non-commercial licence the use is the violation, not the distribution.
//
// REF: src/core/comfy/HttpComfyUICapability.ts; docs/EXTERNAL-MODEL-LICENCES.md.

import { assertModelAllowed } from '../licensing/allowedModels';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from './MotionGenerationCapability';

export interface HttpMotionOptions {
  readonly serverUrl: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the ambient fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class HttpMotionGenerationCapability implements MotionGenerationCapability {
  readonly id = 'http-motion-generation';
  readonly kind = 'http' as const;

  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMotionOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.serverUrl}/health`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async generate(request: MotionGenerationRequest): Promise<MotionGenerationResult> {
    assertModelAllowed(request.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.serverUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: request.prompt,
          model: request.model,
          seconds: request.seconds ?? 2,
          fps: request.fps ?? 30,
          seed: request.seed ?? 0,
          constraints: request.constraints ?? null,
          format: 'bvh',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Motion generation failed: ${response.status} ${response.statusText} ` +
            `from ${this.serverUrl}/generate`,
        );
      }
      const payload = (await response.json()) as { jobId?: string; bvh?: string; model?: string };
      if (typeof payload.bvh !== 'string' || payload.bvh.length === 0) {
        throw new Error(
          `Motion generation returned no BVH text. The service must return ` +
            `{ jobId, bvh, model } with bvh as the clip payload.`,
        );
      }
      return {
        jobId: payload.jobId ?? 'unknown',
        bvh: payload.bvh,
        model: payload.model ?? request.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.serverUrl}/cancel/${encodeURIComponent(jobId)}`, {
        method: 'POST',
      });
    } catch {
      // Best-effort, exactly as the ComfyUI capability's cancel is.
    }
  }
}
