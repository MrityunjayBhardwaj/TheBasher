// The motion-generation capability's public surface, and the runtime pick that
// mirrors `pickComfyUI` exactly: HTTP when a service answers at the configured
// URL, Stub otherwise. Same shape, same fallback, same reason — the unit tier and
// an offline director both get a working generator without a GPU.
//
// REF: src/core/comfy/index.ts (the pattern); ref/architecture/ai-track.md A1.

import { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
import { StubMotionGenerationCapability } from './StubMotionGenerationCapability';
import type { MotionGenerationCapability } from './MotionGenerationCapability';

/** Where a self-hosted motion generator is expected to answer. A placeholder in
 *  the honest sense: NO such service exists yet, and the `/generate` contract is
 *  one this track defined rather than one anybody implements. Kept distinct from
 *  ComfyUI's 8188 so the two are never confused for one another. */
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
  assertValidMotionRequest,
} from './MotionGenerationCapability';
export { StubMotionGenerationCapability, synthesiseBvh } from './StubMotionGenerationCapability';
export { HttpMotionGenerationCapability } from './HttpMotionGenerationCapability';
export { buildGeneratedMotionOps } from './generatedMotionChain';
export type { GeneratedMotionArgs, GeneratedMotionResult } from './generatedMotionChain';
