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
  type TripoOptions,
} from './TripoModelGenerationCapability';
import type { ModelGenerationCapability } from './ModelGenerationCapability';

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
): Promise<ModelGenerationCapability> {
  if (!apiKey?.trim()) return new StubModelGenerationCapability();
  // `apiVersion` rides along in `opts` and defaults inside the client, so the
  // API generation is one constructor argument rather than a branch here.
  const tripo = new TripoModelGenerationCapability({ apiKey: apiKey.trim(), ...opts });
  if (await tripo.isAvailable()) return tripo;
  return new StubModelGenerationCapability();
}

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
  TRIPO_SERVICE_ID,
  type TripoOptions,
} from './TripoModelGenerationCapability';

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
