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

function requestKey(request: MotionGenerationRequest): string {
  return JSON.stringify({
    prompt: request.prompt,
    model: request.model,
    seconds: request.seconds ?? 2,
    fps: request.fps ?? 30,
    seed: request.seed ?? 0,
    constraints: request.constraints ?? null,
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
 */
export function synthesiseBvh(request: MotionGenerationRequest): string {
  const seedHash = digest(requestKey(request));
  const fps = request.fps ?? 30;
  const seconds = request.seconds ?? 2;
  const frames = Math.max(2, Math.round(fps * seconds));
  const frameTime = (1 / fps).toFixed(7);

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

    const queued = this.options.errorQueue?.shift();
    if (queued) throw queued;

    if (this.options.perGenerateDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.perGenerateDelayMs));
    }

    this.jobCounter += 1;
    return {
      jobId: `stub-motion-${this.jobCounter}`,
      bvh: synthesiseBvh(request),
      model: request.model,
    };
  }

  async cancel(): Promise<void> {
    // Nothing to cancel — generation is synchronous and local.
  }
}
