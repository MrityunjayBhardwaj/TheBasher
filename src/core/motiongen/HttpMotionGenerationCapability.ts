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
import { assertValidMotionRequest, assertValidMotionResult } from './MotionGenerationCapability';
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
    // Licence BEFORE shape — same ordering and the same reason as the stub. Both
    // land before the request is issued, which is the property that matters here.
    assertValidMotionRequest(request);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // `?format=json` ASKS for the envelope this client parses, rather than
      // assuming it. A generator may reasonably default to returning the clip as
      // a raw body — the local Kimodo server does — and the failure when it does
      // is `response.json()` throwing a parse error, which reads as a transport
      // fault rather than as "we never said which envelope we wanted".
      //
      // Note this is a DIFFERENT question from `format` in the body below: that
      // one names the CLIP payload (bvh), this one names the HTTP envelope.
      const response = await this.fetchImpl(`${this.serverUrl}/generate?format=json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 🔴 `waypoints` GOES AT THE TOP LEVEL, NOT INSIDE `constraints` (#826).
        //
        // This client used to send `constraints: { waypoints: [...] }`, an
        // object. The server reads two different things:
        //   - `constraints` — a LIST of already-built constraint dicts, handed
        //     straight to `authoring.validate(list, n)` (serve.py:78)
        //   - `waypoints` — a SEPARATE TOP-LEVEL key, rebased to the origin and
        //     turned into a `root_path` constraint (serve.py:81-93)
        //
        // So the road the server actually implements was unreachable from here,
        // and the key we did send landed in a validator expecting another type.
        // A dict is truthy, so the `or []` guard did not skip it: it either
        // raised or iterated the dict's KEYS as if they were constraints. Both
        // ends were internally consistent and every real defect was between them
        // — the same shape as the four mismatches in #775, and none of it
        // visible to a unit tier that only ever checks our own side.
        //
        // `constraints` is no longer sent at all. We have no hand-built
        // constraint dicts to offer, and an empty list is what the server
        // defaults to; sending a key we cannot populate correctly is what caused
        // this.
        body: JSON.stringify({
          prompt: request.prompt,
          model: request.model,
          seconds: request.seconds ?? 2,
          seed: request.seed ?? 0,
          ...(request.constraints?.waypoints?.length
            ? { waypoints: request.constraints.waypoints.map((w) => [w.x, w.z]) }
            : {}),
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
      const payload = (await response.json()) as {
        jobId?: string;
        bvh?: string;
        model?: string;
        unitScale?: number;
        // The server states the world offset it rebased away, in its `meta`
        // block (serve.py:202). We read it because the clip cannot carry it —
        // see MotionGenerationResult.worldOffsetXZ.
        meta?: { world_offset_xz?: unknown };
      };
      if (typeof payload.bvh !== 'string' || payload.bvh.length === 0) {
        throw new Error(
          `Motion generation returned no BVH text. The service must return ` +
            `{ jobId, bvh, model, unitScale } with bvh as the clip payload.`,
        );
      }
      // Licence BEFORE the rest of the payload's shape, the same ordering the
      // request checks use and for the same reason: a blocked checkpoint must
      // report its verdict rather than whichever other field also happened to be
      // missing. Both refuse before the clip is handed back, so the ordering costs
      // nothing and decides only which fact gets named.
      //
      // The check above guarded what we ASKED for. This one guards what the
      // service says it actually ran — a fallback, a routing rule or a
      // misconfiguration can answer with a different checkpoint, and the licence
      // varies per checkpoint inside a single release. Accepting the substitution
      // would reintroduce exactly the silent pick that naming `model` explicitly
      // exists to prevent, and for these terms the USE is the violation, so the
      // refusal has to land before the clip is handed back.
      const ran = payload.model ?? request.model;
      if (ran !== request.model) {
        // Licence first, so a BLOCKED substitution reports its verdict rather
        // than a generic mismatch. Then refuse regardless: an allowed but
        // unrequested checkpoint is still not the one that was cleared here.
        assertModelAllowed(ran);
        throw new Error(
          `Motion generation ran "${ran}" but "${request.model}" was requested and ` +
            `licence-checked. Refusing the result: a substituted checkpoint has not been ` +
            `cleared for this use.`,
        );
      }
      // REQUIRED, never defaulted. BVH carries no unit, so a service that does not
      // say leaves us with a number we would have to invent — and the plausible
      // invention, metres, is wrong for every real generator measured so far. A
      // default here would turn "nobody knows the scale" into "everybody agrees
      // it is 1", which is the same silence with more confidence behind it.
      if (typeof payload.unitScale !== 'number') {
        throw new Error(
          `Motion generation returned no unitScale. BVH declares no unit, so the ` +
            `service must state metres-per-BVH-unit (1 for metres, 0.01 for ` +
            `centimetres) — a clip whose scale nobody states imports at whatever ` +
            `scale the consumer assumes.`,
        );
      }
      // The world offset, normalised to the contract's shape. Absent, null, or
      // an empty offset all mean the same thing HERE — no world path was
      // requested, so there is nothing to place — but a MALFORMED one does not:
      // it is a service telling us where the motion belongs in a way we cannot
      // read, and silently treating that as "no offset" would put the clip at
      // the origin with full confidence. `assertValidMotionResult` refuses it.
      const rawOffset = payload.meta?.world_offset_xz;
      const worldOffsetXZ =
        rawOffset === undefined || rawOffset === null
          ? null
          : (rawOffset as readonly [number, number]);

      const result = {
        jobId: payload.jobId ?? 'unknown',
        bvh: payload.bvh,
        model: ran,
        unitScale: payload.unitScale,
        worldOffsetXZ,
      };
      assertValidMotionResult(result);
      return result;
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
