// modelgen — text-to-3D / image-to-3D generation, phase A4.
//
// The public face of the module. Nothing outside `src/core/modelgen/` may reach
// a generation service directly; callers take a `ModelGenerationCapability` and
// stay ignorant of which implementation they hold.
//
// REF: ref/architecture/ai-track.md phase A4; src/core/motiongen/index.ts.

import { StubModelGenerationCapability } from './StubModelGenerationCapability';
import {
  TripoModelGenerationCapability,
  tripoFallbackOf,
  type TripoFallback,
  type TripoOptions,
} from './TripoModelGenerationCapability';
import type { ModelGenerationCapability } from './ModelGenerationCapability';
import { DEFAULT_TRIPO_API_VERSION, type TripoApiVersion } from './tripoDialect';
import { tripoBrowserBaseUrl } from './tripoProxy';

/**
 * The options a call ORIGINATING IN A PAGE needs: a same-origin base URL,
 * because Tripo answers no CORS preflight (#804).
 *
 * 🔑 THE VERSION AND ITS BASE URL ARE ONE FACT AND THIS RETURNS THEM TOGETHER.
 * Passing them separately is exactly how they drift — a v3 base URL under a v2
 * dialect sends v2 paths to a v3 route and fails as a 404, which reads like the
 * service being down rather than like a caller mistake. There is no way to hold
 * one of these without the other.
 *
 * Callers that are NOT a page — a node harness, a test — pass nothing and get
 * the dialect's own address, which is reachable from anywhere.
 */
export function browserTripoOptions(
  version: TripoApiVersion = DEFAULT_TRIPO_API_VERSION,
): Pick<TripoOptions, 'apiVersion' | 'baseUrl'> {
  return { apiVersion: version, baseUrl: tripoBrowserBaseUrl(version) };
}

/**
 * Choose an implementation. Mirrors `pickMotionGeneration`: reach for the real
 * service, fall back to the stub, and never make the caller decide.
 *
 * With no key configured this does not even construct the Tripo client, so the
 * offline default costs nothing and CI stays deterministic. With a key, the
 * availability probe is a balance call — which is the only check that proves
 * BOTH that the host is up and that the key is accepted, and a paid service
 * where the key is rejected is not available in any useful sense.
 *
 * Note that an available service still refuses to generate while its terms are
 * unrecorded: availability and permission are different questions, and this
 * function only answers the first.
 */
export async function pickModelGeneration(
  apiKey: string | undefined,
  opts: Omit<TripoOptions, 'apiKey'> = {},
  onFallback?: (fallback: ModelGenerationFallback) => void,
): Promise<ModelGenerationCapability> {
  if (!apiKey?.trim()) return new StubModelGenerationCapability();
  // `apiVersion` rides along in `opts` and defaults inside the client, so the
  // API generation is one constructor argument rather than a branch here.
  const tripo = new TripoModelGenerationCapability({ apiKey: apiKey.trim(), ...opts });
  const probe = await tripo.probe();
  if (probe.ok) return tripo;
  // 🔑 THE FALL-THROUGH IS ANNOUNCED, BECAUSE THE STUB IS INDISTINGUISHABLE FROM
  // A RESULT. It returns a real GLB that imports and renders, and its own
  // `isAvailable()` is unconditionally true, so nothing downstream can tell that
  // the service was never reached. Silence here is what made a configured key
  // and a synthesised mesh look like a successful generation.
  //
  // Only when a key WAS configured. No key is the documented default — the
  // settings panel already says the offline stub will generate — and announcing
  // an intended state on every boot is noise that teaches people to ignore the
  // surface that matters.
  onFallback?.(tripoFallbackOf(probe));
  return new StubModelGenerationCapability();
}

/** Why the caller is holding a stub rather than the service it asked for.
 *  Shared with `pickRigging` — same service, same key, same report. */
export type ModelGenerationFallback = TripoFallback;

export {
  assertValidModelRequest,
  describeRequest,
  ModelRequestInvalidError,
  ModelGenerationRequestSchema,
  MAX_FACE_LIMIT,
  MAX_SOURCE_IMAGE_BYTES,
  type ImageModelRequest,
  type ModelGenerationCapability,
  type ModelGenerationOptions,
  type ModelGenerationProgress,
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type MultiviewModelRequest,
  type PoseControl,
  type SourceImage,
  type TextModelRequest,
} from './ModelGenerationCapability';

export {
  StubModelGenerationCapability,
  synthesiseGlb,
  DEFAULT_MODEL_VERSION,
} from './StubModelGenerationCapability';

export {
  TripoModelGenerationCapability,
  TripoApiError,
  TripoTaskFailedError,
  assertTripoKeyShape,
  describeTripoUnavailable,
  tripoFallbackOf,
  TRIPO_SERVICE_ID,
  type TripoFallback,
  type TripoOptions,
  type TripoProbeResult,
  type TripoUnavailable,
  type TripoUnavailableCause,
} from './TripoModelGenerationCapability';

export {
  TRIPO_PROXY_PREFIX,
  TRIPO_PROXY_ROUTES,
  rewriteTripoProxyPath,
  tripoBrowserBaseUrl,
  tripoProxyRoute,
  type TripoProxyRoute,
} from './tripoProxy';

export {
  DEFAULT_TRIPO_API_VERSION,
  TRIPO_API_VERSIONS,
  TRIPO_V2_BASE_URL,
  TRIPO_V3_BASE_URL,
  TRIPO_V2_DIALECT,
  TRIPO_V3_DIALECT,
  TRIPO_V3_DEFAULT_MODEL_VERSION,
  tripoDialect,
  type TripoApiVersion,
  type TripoDialect,
  type TripoTaskOutput,
  type TripoUploads,
  type TripoWireCall,
  type UploadedFile,
} from './tripoDialect';
