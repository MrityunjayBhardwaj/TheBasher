// tripoDialect — everything that differs between Tripo's v2 and v3 APIs, in one
// table, so the client that talks to them exists once.
//
// WHY A DIALECT AND NOT A SECOND CLIENT. The two API generations share the parts
// that carry the risk and the parts that carry the tests: Bearer auth, the
// `{code, data}` response envelope, poll-until-terminal-status, download-by-URL,
// and the rule that the licence check runs before anything leaves the process.
// They differ only in paths, a handful of field names, and which key the output
// URL arrives under. Duplicating the client would duplicate the tested half and
// leave the copy untested, and every later fix to polling or download would have
// to be made twice — the diminishing-returns signal, visible already at two
// implementations. So: one client, and the version is a value it holds.
//
// 🔴 GROUNDING STATUS DIFFERS BY VERSION, AND THAT IS THE MOST IMPORTANT THING
// ON THIS PAGE.
//
//   v2 — SOURCE-VERIFIED. Every path, field and status below was read out of
//        Tripo's official MIT-licensed Python SDK, mirrored at
//        `ref/sources/tripo-python-sdk/`, and cross-checked against its Blender
//        plugin. That SDK (`tripo3d` 0.4.2) is still the latest release on PyPI.
//
//   v3 — VENDOR-DOCUMENTED ONLY. There is no v3 source to read: Tripo's own SDK
//        is v2, and `openapi.tripo3d.ai/openapi.json` answers 401 rather than
//        404 — a schema exists, published behind authentication. The fullest
//        description reachable without a key is a third-party OpenAPI file whose
//        own `info.description` states it is "locally maintained from
//        https://developers.tripo3d.ai/en/docs because Tripo does not publish an
//        unauthenticated OpenAPI schema". That is a transcription of the vendor's
//        prose, not an independent witness of the wire.
//
// So NOTHING in the v3 dialect has been observed against the real service. The
// gap has a known closing move, and it should be taken before any billable run:
// fetch the authenticated schema with a working key and re-verify this table
// against it. Until then, treat a v3 field name as a claim.
//
// REF: ref/sources/tripo-python-sdk/tripo3d/client.py (v2, all of it);
//      https://developers.tripo3d.ai/en/docs (v3, prose); issue #797.

import type { ModelGenerationRequest } from './ModelGenerationCapability';

export type TripoApiVersion = 'v2' | 'v3';
export const TRIPO_API_VERSIONS: readonly TripoApiVersion[] = ['v2', 'v3'];

/** One HTTP call, as this dialect wants it written. */
export interface TripoWireCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** A file the service already holds, in the shape a task body references it. */
export interface UploadedFile {
  readonly type: string;
  readonly file_token: string;
}

export interface TripoUploads {
  /** For image-to-model: the one uploaded image. */
  readonly single?: UploadedFile;
  /** For multiview: front, left, back, right — positional, with holes. */
  readonly views?: readonly (UploadedFile | null)[];
}

export interface TripoRigWireArgs {
  readonly sourceTaskId: string;
  readonly rigType: string;
  readonly spec: string;
}

/** The task fields this client reads. A superset across both versions: each
 *  dialect knows which of them its own service actually populates. */
export interface TripoTaskOutput {
  // v2 output URLs. REF: tripo3d/models.py:65-72.
  model?: string;
  base_model?: string;
  pbr_model?: string;
  // v3 output URLs. REF: v3 docs, TaskOutput.
  model_url?: string;
  model_urls?: string[];
  // Both versions, same names — which is why the rig road needs no dialect.
  riggable?: boolean;
  rig_type?: string;
}

export interface TripoDialect {
  readonly version: TripoApiVersion;
  readonly baseUrl: string;
  /**
   * The prefix this version's console issues, when it is DOCUMENTED.
   *
   * `undefined` means "no prefix is documented for this version" and the client
   * must then accept any non-empty key. That is not laziness — see `v3` below.
   */
  readonly keyPrefix: string | undefined;
  readonly balancePath: string;
  readonly uploadPath: string;
  /** The field an upload response carries its token under. */
  readonly uploadTokenField: string;
  /**
   * Whether the service REQUIRES a model version on a generation request. v3
   * marks `model` required; v2 treats it as optional.
   */
  readonly requiresModelVersion: boolean;
  /** Used only where `requiresModelVersion` is true and the caller supplied none. */
  readonly defaultModelVersion: string;

  taskPath(taskId: string): string;
  modelCall(request: ModelGenerationRequest, uploads: TripoUploads): TripoWireCall;
  rigCheckCall(sourceTaskId: string): TripoWireCall;
  rigCall(args: TripoRigWireArgs): TripoWireCall;
  /** Which URL the finished task's output carries its model under. */
  modelUrlOf(output: TripoTaskOutput): string | undefined;
}

/** Drop `undefined` rather than sending it — an explicit null and an absent key
 *  mean different things to both versions, and only one of them is "unset". */
function compact(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The generation options both versions spell the same way.
 *
 * Deliberately excludes the model version: v2 calls it `model_version` and v3
 * calls it `model` and requires it, so it is the dialect's business. Also
 * excludes `style`, `texture_alignment` and `orientation`, which the two
 * versions scope differently — each dialect adds back the ones its own
 * documented request schema lists, rather than sending a field to a service
 * whose contract does not name it.
 */
function sharedModelOptions(request: ModelGenerationRequest): Record<string, unknown> {
  return compact({
    face_limit: request.faceLimit,
    quad: request.quad,
    texture: request.texture,
    pbr: request.pbr,
    texture_quality: request.textureQuality,
    geometry_quality: request.geometryQuality,
    auto_size: request.autoSize,
    model_seed: request.modelSeed,
    texture_seed: request.textureSeed,
  });
}

// ---------------------------------------------------------------------------
// v2 — source-verified against the official Python SDK.
// ---------------------------------------------------------------------------

/** REF: ref/sources/tripo-python-sdk/tripo3d/client.py:25. */
export const TRIPO_V2_BASE_URL = 'https://api.tripo3d.ai/v2/openapi';

export const TRIPO_V2_DIALECT: TripoDialect = {
  version: 'v2',
  baseUrl: TRIPO_V2_BASE_URL,
  // Asserted by the SDK itself (client.py:50-51) AND by the Blender plugin
  // (operators.py:105). Two independent citations, so the check has teeth.
  keyPrefix: 'tsk_',
  balancePath: '/user/balance',
  uploadPath: '/upload',
  uploadTokenField: 'image_token',
  requiresModelVersion: false,
  defaultModelVersion: 'v2.5-20250123',

  taskPath: (taskId) => `/task/${encodeURIComponent(taskId)}`,

  modelCall(request, uploads) {
    // v2 posts every task to ONE path and discriminates on a `type` field.
    const shared = {
      ...sharedModelOptions(request),
      ...compact({
        model_version: request.modelVersion,
        style: request.style,
        texture_alignment: request.textureAlignment,
        orientation: request.orientation,
      }),
    };

    if (request.source === 'text') {
      const body: Record<string, unknown> = {
        ...shared,
        type: 'text_to_model',
        prompt: request.prompt,
      };
      if (request.negativePrompt !== undefined) body.negative_prompt = request.negativePrompt;
      const pose = poseSpecOf(request);
      if (pose) body.pose_spec = pose;
      return { path: '/task', body };
    }

    if (request.source === 'image') {
      return { path: '/task', body: { ...shared, type: 'image_to_model', file: uploads.single } };
    }

    // The service takes the four views positionally, front first, with a null
    // hole for a view that was not supplied.
    return {
      path: '/task',
      body: { ...shared, type: 'multiview_to_model', files: uploads.views ?? [] },
    };
  },

  rigCheckCall: (sourceTaskId) => ({
    path: '/task',
    body: { type: 'animate_prerigcheck', original_model_task_id: sourceTaskId },
  }),

  rigCall: ({ sourceTaskId, rigType, spec }) => ({
    path: '/task',
    body: {
      type: 'animate_rig',
      original_model_task_id: sourceTaskId,
      // `out_format` is pinned rather than exposed: the contract is that a
      // rigged mesh takes the SAME import road a dropped .glb takes, and fbx
      // would fork it. REF: client.py:1160.
      out_format: 'glb',
      rig_type: rigType,
      spec,
    },
  }),

  // pbr_model first: the textured PBR variant the plugin prefers, and this
  // road carries materials through the same glTF chain.
  modelUrlOf: (output) => output.pbr_model ?? output.model ?? output.base_model,
};

// ---------------------------------------------------------------------------
// v3 — vendor-documented only. Every line here is a claim, not an observation.
// ---------------------------------------------------------------------------

/** REF: v3 docs, `servers:`. */
export const TRIPO_V3_BASE_URL = 'https://openapi.tripo3d.ai/v3';

/**
 * The newest model version the v3 documentation lists. Needed because v3 marks
 * `model` REQUIRED, so a request that omits it is malformed rather than
 * defaulted by the service.
 *
 * REF: v3 docs, TextToModelRequest.model — "Supported values are v3.1-20260211,
 * v3.0-20250812, v2.5-20250123, and P1-20260311."
 */
export const TRIPO_V3_DEFAULT_MODEL_VERSION = 'v3.1-20260211';

export const TRIPO_V3_DIALECT: TripoDialect = {
  version: 'v3',
  baseUrl: TRIPO_V3_BASE_URL,
  /**
   * 🔴 DELIBERATELY UNDEFINED — no prefix is asserted for v3, and that is a
   * decision rather than an omission.
   *
   * v2's `tsk_` check is worth having because two independent sources state it.
   * For v3 the documentation says nothing about key format at all. The only
   * evidence available is a single key observed from the console, which begins
   * `tcli_` — and inventing a shape rule from one sample would refuse every
   * valid key of a form we happen not to have seen, while reporting a confident
   * reason. A check must not be able to reject an input over a fact it never
   * reliably knows. The service's own 401 is the correct authority here.
   */
  keyPrefix: undefined,
  balancePath: '/account/balance',
  uploadPath: '/files',
  uploadTokenField: 'file_token',
  requiresModelVersion: true,
  defaultModelVersion: TRIPO_V3_DEFAULT_MODEL_VERSION,

  taskPath: (taskId) => `/tasks/${encodeURIComponent(taskId)}`,

  modelCall(request, uploads) {
    // v3 gives each source its own path and carries no `type` discriminator.
    const shared = {
      ...sharedModelOptions(request),
      // Required, never absent. `??` and not a merge, so an explicit caller
      // choice always wins over the default.
      model: request.modelVersion ?? TRIPO_V3_DEFAULT_MODEL_VERSION,
    };

    if (request.source === 'text') {
      const body: Record<string, unknown> = { ...shared, prompt: request.prompt };
      if (request.negativePrompt !== undefined) body.negative_prompt = request.negativePrompt;
      // NOTE: v3's documented TextToModelRequest lists no `style`,
      // `texture_alignment`, `orientation` or `pose_spec`. They are dropped
      // rather than forwarded — sending a field the contract does not name is
      // how a request gets rejected wholesale, or worse, silently ignored.
      return { path: '/generation/text-to-model', body };
    }

    if (request.source === 'image') {
      return {
        path: '/generation/image-to-model',
        body: {
          ...shared,
          file: uploads.single,
          // v3's image request DOES list these two.
          ...compact({
            texture_alignment: request.textureAlignment,
            orientation: request.orientation,
          }),
        },
      };
    }

    return {
      path: '/generation/multiview-to-model',
      body: {
        ...shared,
        // The documented legacy four-slot array, front/left/back/right. v3 wants
        // an EMPTY OBJECT for an omitted view where v2 wanted null.
        files: (uploads.views ?? []).map((view) => view ?? {}),
        ...compact({
          texture_alignment: request.textureAlignment,
          orientation: request.orientation,
        }),
      },
    };
  },

  rigCheckCall: (sourceTaskId) => ({
    path: '/animations/rig-check',
    body: { input: sourceTaskId },
  }),

  rigCall: ({ sourceTaskId, rigType, spec }) => ({
    path: '/animations/rig',
    body: { input: sourceTaskId, rig_type: rigType, spec, out_format: 'glb' },
  }),

  // v3 renamed the output URL. Reading v2's names here would find nothing and
  // report "no model URL" on a task that ran, succeeded and billed.
  modelUrlOf: (output) => output.model_url ?? output.model_urls?.[0],
};

const DIALECTS: Record<TripoApiVersion, TripoDialect> = {
  v2: TRIPO_V2_DIALECT,
  v3: TRIPO_V3_DIALECT,
};

export function tripoDialect(version: TripoApiVersion): TripoDialect {
  return DIALECTS[version];
}

/**
 * Basher's default API version.
 *
 * v3 is what Tripo documents today and what its console appears to issue keys
 * for. v2 is kept because the v3 contract itself still carries
 * `original_model_task_id` fields it describes as "V2-compatible", which is the
 * vendor saying v2 is legacy rather than removed — and because removing a
 * transport nothing has proven dead is a separate decision with its own evidence.
 */
export const DEFAULT_TRIPO_API_VERSION: TripoApiVersion = 'v3';

/** The five pose ratios, v2 only. REF: ref/sources/tripo-3d-for-blender/__init__.py. */
function poseSpecOf(request: ModelGenerationRequest): Record<string, unknown> | null {
  if (request.source !== 'text' || !request.pose) return null;
  const p = request.pose;
  const spec = compact({
    head_body_height_ratio: p.headBodyHeightRatio,
    head_body_width_ratio: p.headBodyWidthRatio,
    legs_body_height_ratio: p.legsBodyHeightRatio,
    arms_body_length_ratio: p.armsBodyLengthRatio,
    span_of_legs: p.spanOfLegs,
  });
  return Object.keys(spec).length > 0 ? spec : null;
}
