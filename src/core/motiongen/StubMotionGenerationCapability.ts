// StubMotionGenerationCapability — deterministic, dependency-free, offline.
//
// Shape parity with StubComfyUICapability: hash the request into a digest, then
// synthesise from that digest. Two generates with an identical request return
// identical BVH text; two with different prompts return different motion. That is
// what lets the unit tier assert real behaviour without a GPU or a network.
//
// It emits REAL BVH — the same grammar parseBvh accepts — rather than a
// placeholder string. A stub that returned a token would let every test pass
// while proving nothing about whether generated motion can travel the import
// road, which is the one claim this phase makes.
//
// REF: src/core/comfy/StubComfyUICapability.ts; src/core/import/bvh.ts.

import { assertModelAllowed } from '../licensing/allowedModels';
import { BVH_UNIT_SCALE_METRES } from '../import/bvh';
import { assertValidMotionRequest, assertValidMotionResult } from './MotionGenerationCapability';
import type {
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from './MotionGenerationCapability';

export interface StubMotionOptions {
  /** Fixed delay per generate, for tests that need a predictable duration. */
  readonly perGenerateDelayMs?: number;
  /** Test-only: each generate consumes one entry and rejects with it. */
  readonly errorQueue?: Error[];
}

/** FNV-1a. Small, deterministic, and stable across runs — no crypto needed. */
function digest(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The rate the stub samples at. A CONSTANT of this implementation, not a default
 * filled in for an absent request field: the stub is a generator, and a generator
 * decides its own rate. It is written into the `Frame Time` header like any other
 * producer's, so every consumer reads it from the clip rather than from here.
 */
export const STUB_MOTION_FPS = 30;

/**
 * The stub authors its rig in METRES — a 1-unit hip and a 2-unit figure — so it
 * declares a scale of 1.
 *
 * Worth stating rather than assuming, because the stub and the real backend
 * disagree here: a Kimodo clip is in centimetres. Two implementations of one
 * capability emitting lengths 100x apart is fine as long as each says which; it is
 * only fatal when neither does, which is the state this replaced.
 */
export const STUB_UNIT_SCALE = BVH_UNIT_SCALE_METRES;

/**
 * What the synthesised motion is a function of — and, more importantly, what it
 * is NOT.
 *
 * 🔴 `constraints` is deliberately ABSENT. It used to be here, and while it was,
 * moving one waypoint changed the digest and therefore every frame of the output
 * — which is exactly the observation phase A2 uses to show that a curve is an
 * INPUT to the generator rather than a path the result was fitted to. The stub
 * satisfied it with a hash, so A2 could have been closed green on a claim nobody
 * had tested (#775).
 *
 * A stub that cannot walk a path must not appear to walk one. Leaving the field
 * out makes the stub's output INVARIANT under constraints, so "the waypoint
 * moved and the motion changed" is unconstructible here and can only be produced
 * by a generator that actually honours the constraint. The cost is that an
 * offline director dragging a waypoint sees no change, which is the truth.
 */
function requestKey(request: MotionGenerationRequest): string {
  return JSON.stringify({
    prompt: request.prompt,
    model: request.model,
    seconds: request.seconds ?? 2,
    seed: request.seed ?? 0,
  });
}

/** A tiny two-joint rig — enough to be retargeted and layered, small enough to read. */
const HIERARCHY = `HIERARCHY
ROOT Hips
{
  OFFSET 0.0 1.0 0.0
  CHANNELS 6 Xposition Yposition Zposition Xrotation Yrotation Zrotation
  JOINT Spine
  {
    OFFSET 0.0 0.5 0.0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site
    {
      OFFSET 0.0 0.5 0.0
    }
  }
}`;

/**
 * Synthesise BVH whose motion is a function of the request digest. Deterministic
 * by construction: no clock, no randomness, no ambient state.
 *
 * Validates too, and not only because `generate` already did. It is exported from
 * the barrel, so guarding only the two call sites that were in mind leaves the
 * door that actually produces the bytes standing open.
 *
 * The header it used to be able to produce — `Frame Time: Infinity`, `Frames: NaN`
 * — is now unconstructible from here: the rate is this implementation's own
 * constant rather than a caller's number. What the check still buys is the other
 * half, `seconds`: unbounded, it decides the row count on its own.
 */
export function synthesiseBvh(request: MotionGenerationRequest): string {
  assertValidMotionRequest(request);
  const seedHash = digest(requestKey(request));
  const fps = STUB_MOTION_FPS;
  const seconds = request.seconds ?? 2;
  const frames = Math.max(2, Math.round(fps * seconds));
  // FULL precision, not a rounded 7 places. The rate is derived from this header
  // rather than reported beside the clip, so the header has to carry enough digits
  // to derive it: `(1/30).toFixed(7)` reads back as 30.00003, and a producer whose
  // own rate is not recoverable from its own file has not really stated it. The
  // real exporter writes 0.03333333333333333 for the same reason.
  const frameTime = String(1 / fps);

  // A phase and amplitude drawn from the digest, so different prompts move
  // differently and the same prompt always moves the same way.
  const phase = ((seedHash % 360) * Math.PI) / 180;
  const amplitude = 10 + (seedHash % 30);
  const stride = 0.01 + ((seedHash >>> 8) % 100) / 2000;

  const rows: string[] = [];
  for (let f = 0; f < frames; f += 1) {
    const t = f / fps;
    const swing = amplitude * Math.sin(phase + t * Math.PI * 2);
    const spine = (amplitude / 2) * Math.cos(phase + t * Math.PI * 2);
    const z = stride * f;
    rows.push(
      [0, 1, z, 0, swing, 0, 0, spine, 0].map((n) => Number(n.toFixed(4)).toString()).join(' '),
    );
  }

  return `${HIERARCHY}
MOTION
Frames: ${frames}
Frame Time: ${frameTime}
${rows.join('\n')}
`;
}

export class StubMotionGenerationCapability implements MotionGenerationCapability {
  readonly id = 'stub-motion-generation';
  readonly kind = 'stub' as const;

  private readonly options: StubMotionOptions;
  private jobCounter = 0;

  constructor(options: StubMotionOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: MotionGenerationRequest): Promise<MotionGenerationResult> {
    // Refuse first, before anything that resembles doing the work. The stub
    // enforces the same licence rule as the HTTP impl on purpose: a stub that
    // skipped it would let a test prove a blocked model "works".
    assertModelAllowed(request.model);
    // Licence BEFORE shape, so a blocked checkpoint reports its verdict rather
    // than whichever field also happened to be malformed. Both refuse before any
    // work, so the ordering costs nothing and decides only which fact is named.
    assertValidMotionRequest(request);

    const queued = this.options.errorQueue?.shift();
    if (queued) throw queued;

    if (this.options.perGenerateDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.perGenerateDelayMs));
    }

    this.jobCounter += 1;
    const result = {
      jobId: `stub-motion-${this.jobCounter}`,
      bvh: synthesiseBvh(request),
      model: request.model,
      unitScale: STUB_UNIT_SCALE,
      // ALWAYS null, on the same principle that keeps `constraints` out of the
      // digest above: this stub does not walk a path, so it has no world path to
      // have been rebased from, and reporting an offset it never applied would
      // be the fabrication that reasoning exists to prevent. `null` here is a
      // true statement — nobody asked for a world path — not a placeholder.
      worldOffsetXZ: null,
    };
    // Check the way out too, and for the same reason the licence check runs here
    // rather than only in the HTTP impl: a stub exempt from a rule lets a test
    // prove the rule holds when it does not.
    assertValidMotionResult(result);
    return result;
  }

  async cancel(): Promise<void> {
    // Nothing to cancel — generation is synchronous and local.
  }
}
