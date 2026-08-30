// The motion-generation capability's public surface, and the runtime pick that
// mirrors `pickComfyUI` exactly: HTTP when a service answers at the configured
// URL, Stub otherwise. Same shape, same fallback, same reason — the unit tier and
// an offline director both get a working generator without a GPU.
//
// REF: src/core/comfy/index.ts (the pattern); ref/architecture/ai-track.md A1.

import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { StubMotionGenerationCapability } from './StubMotionGenerationCapability';
import type { MotionGenerationCapability } from './MotionGenerationCapability';

/** Where a self-hosted motion generator answers. Kept distinct from ComfyUI's
 *  8188 so the two are never confused for one another.
 *
 *  🟢 A service now implements this contract (#775) — the local Kimodo server in
 *  the `auto-animate` working area, which loads the SOMA checkpoint and returns
 *  BVH. It is a LOCAL DEV server, run by hand; nothing ships it, and an absent
 *  server remains the ordinary case that falls back to the stub.
 *
 *      cd <auto-animate>/kimodo
 *      HF_HOME=$PWD/hf-cache TEXT_ENCODERS_DIR=$PWD/text_encoders \
 *      TEXT_ENCODER_MODE=local TEXT_ENCODER_DEVICE=mps KIMODO_DEVICE=mps \
 *      ./.venv/bin/python serve.py --port 8600 --model nvidia/Kimodo-SOMA-RP-v1.1
 *
 *  🔴 `--model` must be the ORG-QUALIFIED id, matching DEFAULT_MOTIONGEN_MODEL
 *  below. The server echoes back whatever it was started with, and this client
 *  refuses a result whose model differs from the one it licence-checked — so a
 *  server started with the bare `Kimodo-SOMA-RP-v1.1` names the same checkpoint
 *  and is still refused, correctly, as a substitution. */
export const DEFAULT_MOTIONGEN_URL = 'http://127.0.0.1:8600';

/**
 * The checkpoint a fresh install generates with, in the ORG-QUALIFIED form the
 * service actually addresses. This constant is the reason the licence gate had to
 * resolve that form first: a default nobody types is still a default everybody
 * uses, and one that resolved to nothing would have refused every request while
 * pointing at the licence record instead of at the name.
 *
 * ALLOWED_WITH_CONDITIONS — see external-models.json. The conditions are recorded
 * against the record this id resolves to.
 */
export const DEFAULT_MOTIONGEN_MODEL = 'nvidia/Kimodo-SOMA-RP-v1.1';

/**
 * Pick the best available motion-generation capability for this runtime.
 *
 *   HTTP (a service answers at the configured URL)  →  Stub (offline / tests)
 *
 * Never throws: an unreachable service is the ordinary case, not an error.
 */
export async function pickMotionGeneration(
  url: string = DEFAULT_MOTIONGEN_URL,
  opts: { readonly timeoutMs?: number } = {},
): Promise<MotionGenerationCapability> {
  const http = new HttpMotionGenerationCapability({ serverUrl: url, ...opts });
  if (await http.isAvailable()) return http;
  return new StubMotionGenerationCapability();
}

export type {
  MotionConstraints,
  MotionGenerationCapability,
  MotionGenerationRequest,
  MotionGenerationResult,
} from './MotionGenerationCapability';
export {
  MAX_MOTION_FPS,
  MAX_MOTION_SECONDS,
  MotionGenerationRequestSchema,
  MotionRequestInvalidError,
  MotionResultInvalidError,
  assertValidMotionRequest,
  assertValidMotionResult,
} from './MotionGenerationCapability';
export {
  StubMotionGenerationCapability,
  synthesiseBvh,
  STUB_MOTION_FPS,
  STUB_UNIT_SCALE,
} from './StubMotionGenerationCapability';
export { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
export { buildGeneratedMotionOps } from './generatedMotionChain';
export type { GeneratedMotionArgs, GeneratedMotionResult } from './generatedMotionChain';
