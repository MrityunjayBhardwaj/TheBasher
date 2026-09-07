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
import { tangentHeadings, headingAngle, rotateGround } from './pathHeadings';
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
    const waypoints = request.constraints?.waypoints;
    // An explicit facing wins; otherwise the path's own tangents. `tangentHeadings`
    // returns null for a path that expresses no direction, and null means the
    // field is not sent at all rather than sent empty.
    const headings =
      waypoints && waypoints.length > 0
        ? (request.constraints?.headings ?? tangentHeadings(waypoints))
        : null;

    // ── THE ROTATE-IN (#897, the facing half) ───────────────────────────────
    // Frame 0's HEADING is canonicalised to zero exactly as its position is, so
    // a requested facing is somewhere the character TURNS TO over the first half
    // of the clip rather than somewhere it starts. #897 asks the server to
    // rotate the path to the canonical heading on the way in and report the
    // angle on the way out; both halves are available here instead, because the
    // canonical heading is a CONSTANT (+X, angle 0) and not something only the
    // server can know.
    //
    // So the request is expressed in the canonical frame — the path and its
    // headings turned by -theta about the path's FIRST waypoint — and `theta`
    // goes back to the caller to turn the result out again.
    //
    // 🔴 ABOUT THE FIRST WAYPOINT, NOT ABOUT THE WORLD ORIGIN. The server rebases
    // the path by subtracting its first point (serve.py:81-93) and returns that
    // point as `world_offset_xz`. Rotating about it leaves it fixed, so the
    // offset that comes back is still the one the caller asked for and the two
    // halves of the placement stay independent. Rotating about the world origin
    // would move it, and the returned offset would then need turning too — a
    // coupling with no reason to exist.
    const rotation = headings?.length ? headingAngle(headings[0]) : null;
    const origin = waypoints?.length ? waypoints[0] : { x: 0, z: 0 };
    const sent =
      rotation === null || !waypoints?.length
        ? waypoints
        : waypoints.map((w) => {
            const r = rotateGround({ x: w.x - origin.x, z: w.z - origin.z }, -rotation);
            return { x: r.x + origin.x, z: r.z + origin.z };
          });
    // Directions rotate about themselves — there is no centre to subtract.
    const sentHeadings =
      rotation === null || !headings ? headings : headings.map((h) => rotateGround(h, -rotation));
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
          // 🔴 BOTH NAMES, DELIBERATELY (#894). `seconds` is this repo's name for
          // the field; `duration` is the server's own. A Kimodo build that reads
          // only `duration` silently defaults to 4 s in the half of itself that
          // lays out the waypoint path, while generating the 2 s that were asked
          // for — and then indexes frame 119 of a 60-frame clip and returns a
          // 500. Measured: `{seconds: 2, waypoints: […]}` → HTTP 500,
          // `{duration: 2, …}` → HTTP 200.
          //
          // The local server has since been patched to honour both, and that is
          // exactly why this is here: the patch lives in a vendored checkout and
          // NOT upstream, so a fresh install brings the defect back and the
          // failure lands on the waypoint road — the one road where the request
          // and the constraint have to agree about length. Sending both names
          // costs a key and removes the dependency on somebody else's local fix.
          seconds: request.seconds ?? 2,
          duration: request.seconds ?? 2,

          seed: request.seed ?? 0,
          ...(sent?.length ? { waypoints: sent.map((w) => [w.x, w.z]) } : {}),
          // 🔴 A PATH WITHOUT A FACING IS WALKED SIDEWAYS (#897).
          //
          // `root_path` constrains position only. With no `headings` the server
          // keeps the canonical frame-0 heading for the whole clip, so a path
          // that does not run along the canonical direction produces a character
          // strafing down it. Measured on the live service, reading Hips yaw:
          //
          //   +X path, no headings    yaw mean  -2.5°   ends (1.91,  0.01)
          //   +Z path, no headings    yaw mean  -1.4°   ends (0.01,  2.07)  <- strafe
          //   +Z path, with headings  yaw mean  59.7°   ends (-0.01, 2.02)
          //
          // The +X case is why this went unnoticed: facing +X IS the canonical
          // heading, so the one direction anybody tested looked correct.
          //
          // Derived rather than required, because every existing caller supplies
          // a path and means "walk along it"; a caller wanting something else
          // passes `constraints.headings`, which this defers to.
          ...(sentHeadings?.length ? { headings: sentHeadings.map((h) => [h.x, h.z]) } : {}),
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
        // Ours, not the service's — this is the angle we rotated the request BY,
        // and the caller undoes it. Null whenever no facing was requested, which
        // is the same set of cases in which nothing was rotated.
        worldRotationRadians: rotation,
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
