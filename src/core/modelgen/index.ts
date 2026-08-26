// modelgen — text-to-3D / image-to-3D generation, phase A4.
//
// The public face of the module. Nothing outside `src/core/modelgen/` may reach
// a generation service directly; callers take a `ModelGenerationCapability` and
// stay ignorant of which implementation they hold.
//
// REF: ref/architecture/ai-track.md phase A4; src/core/motiongen/index.ts.

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
  TRIPO_BASE_URL,
  TRIPO_SERVICE_ID,
  type TripoOptions,
} from './TripoModelGenerationCapability';
