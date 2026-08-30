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
//   v3 — VENDOR-DOCUMENTED. There is no v3 source to read and no machine-
//        readable schema at all: Tripo's own SDK is v2, and with a VALID KEY
//        every schema path (`/openapi.json`, `/v3/openapi.json`, `/docs`,
//        `/swagger.json`) answers 404 "No endpoint found". The earlier 401s on
//        those paths were the blanket auth gate firing ahead of routing, and
//        reading them as "a schema exists behind auth" was an inference, not an
//        observation — measured false 2026-08-29. Prose is all there is. But the
//        critical
//        path is corroborated by TWO first-party documents rather than one
//        third-party transcription, and where they disagreed the migration guide
//        won:
//          - every endpoint path        migration guide's own mapping table
//          - `type` field removed       migration guide, "Request Field Changes"
//          - `input` is a PLAIN STRING  migration guide, "Unified Input Handling"
//          - output.model_url           quick-start's completed-task response
//          - `model` required           quick-start's text-to-model example
//          - the {code,data} envelope   quick-start's completed-task response
//
//        Still uncorroborated, and marked at their site: the multiview `inputs`
//        shape, and the option fields each request schema accepts. Those come
//        from the third-party transcription only.
//
// NOTHING here has yet been observed against the running service, and there is
// no document left to close that gap with — only a live call can. What HAS been
// observed with a valid key: the `{code, status, data}` envelope on
// `/account/balance`, and the error envelope's shape on a refused task
// (`{code, status, message, suggestion, request_id}`, HTTP 403, code 2010 for
// insufficient credit). Both match what this client already reads.
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
  /** The auto-rigging model version. v3 needs one; v2 has no such field. */
  readonly modelVersion?: string;
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

/**
 * 🔴 v2 HAS A PUBLISHED DEATH DATE. Both instants are UTC.
 *
 *   featureFreeze — 2026-10-01 00:00 UTC+8. No further feature updates or
 *                   technical support.
 *   endpointsOff  — 2026-11-01 00:00 UTC+8. "All V2 API endpoints will stop
 *                   accepting requests."
 *
 * This is why the v2 dialect is not simply deleted today: the vendor states v2
 * and v3 operate concurrently until then, and a transport with live callers is
 * removed on evidence rather than on tidiness. The evidence now exists and has a
 * date, so the removal is SCHEDULED rather than forgotten — `tripoV3.test.ts`
 * carries a gate that goes red at the freeze, which is a month before the
 * endpoints go dark. A decision you cannot take yet is a test that reds when it
 * becomes takeable.
 *
 * REF: https://developers.tripo3d.ai/en/docs/migration-v2-to-v3.
 */
export const TRIPO_V2_RETIREMENT = {
  featureFreeze: Date.parse('2026-09-30T16:00:00Z'),
  endpointsOff: Date.parse('2026-10-31T16:00:00Z'),
} as const;

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

  // NOTE: `modelVersion` is DROPPED here — v2's rig call has no such field.
  // Same shape as `style` on v3: a real option one version carries and the other
  // does not, pinned by a test so it reads as a version property rather than an
  // accident.
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

/**
 * The auto-rigging model version — a DIFFERENT menu from the generation one,
 * which must be sent explicitly and whose NEWER option is the wrong choice.
 *
 * 🔑 BOTH FACTS HERE WERE MEASURED AGAINST THE LIVE SERVICE, not read anywhere.
 *
 * FIRST, it cannot be omitted. A rig call with no `model` is refused:
 *
 *   400 code 1004 — invalid model 'v2.5-20250123',
 *                   allowed values: v1.0-20240301, v2.5-20260210
 *
 * on a request that never mentioned `v2.5-20250123` — so the service's own
 * default sits outside its own allowed set, and that error is the most
 * authoritative statement of the allowed set available: the service, about
 * itself, at the moment of refusal.
 *
 * SECOND, and this is the one that matters: **`spec: "mixamo"` is honoured ONLY
 * by `v1.0-20240301`.** Rigging the same mesh twice, changing nothing but this
 * field:
 *
 *   v2.5-20260210 → tripo::Root, tripo::0_Left_Limb_0, …   spec IGNORED
 *   v1.0-20240301 → mixamorig:Hips, mixamorig:Spine, …     spec honoured
 *
 * Both tasks echoed `spec: "mixamo"` back in their own input record. The newer
 * model accepts the parameter, reports it, and disregards it — which is a lying
 * label at the service's own boundary, and exactly why `rig()` reads the bone
 * names out of the returned GLB instead of trusting what it asked for.
 *
 * So the default is the OLDER version, deliberately. Newer-is-better is the
 * normal instinct and here it selects the one option that breaks the only spec
 * anything downstream can drive — the same rule as `DEFAULT_RIG_SPEC` above: a
 * default that produces an unusable rig is worse than one that looks behind.
 *
 * Callers who want the newer topology can pass `modelVersion` and will get a
 * `tripo::` skeleton — which `rig()` then refuses for a `mixamo` request, by
 * design.
 *
 * v2's rig call has no such field at all, which is why mirroring v2 dropped it.
 */
export const TRIPO_V3_DEFAULT_RIG_MODEL = 'v1.0-20240301';

/** The newer auto-rigging model. Named so the one that IGNORES `spec` is a value
 *  a test can point at, rather than a string in a comment. */
export const TRIPO_V3_RIG_MODEL_IGNORING_SPEC = 'v2.5-20260210';

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
          // 🔑 A PLAIN STRING, not v2's `{type, file_token}` object. v3 unified
          // `file` / `file_token` / `url` / `object` under one `input` field and
          // infers the type: `{ "input": "file_token_abc123" }`. Sending v2's
          // wrapper here is the defect this replaced.
          // REF: migration guide, "Unified Input Handling".
          input: uploads.single?.file_token,
          // v3's image request DOES list these two.
          ...compact({
            texture_alignment: request.textureAlignment,
            orientation: request.orientation,
          }),
        },
      };
    }

    // 🔴 A MISSING VIEW IS REFUSED RATHER THAN GUESSED. v3's four-slot array is
    // POSITIONAL — front, left, back, right — and no document reachable from
    // here says how an omitted slot is written. Guessing wrong does not error:
    // it shifts the remaining views up a position, so a left image is read as a
    // back image and the service returns a confidently wrong model. An open gap
    // beats a covered-but-unhonoured one.
    const views = uploads.views ?? [];
    const missing = views.some((view) => view === null);
    if (missing || views.length !== 4) {
      throw new Error(
        'Multiview generation on the v3 API needs all four views (front, left, back, right). ' +
          'How v3 writes an omitted slot in its positional array is not documented, and ' +
          'guessing shifts the remaining views onto the wrong faces rather than failing. ' +
          'Supply four views, or use the v2 API, which takes a null hole.',
      );
    }
    return {
      path: '/generation/multiview-to-model',
      body: {
        ...shared,
        // Plain-string tokens, positional. REF: the transcribed v3 schema's
        // `inputs` (oneOf string | view object) — NOT corroborated first-party.
        inputs: views.map((view) => view!.file_token),
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

  rigCall: ({ sourceTaskId, rigType, spec, modelVersion }) => ({
    path: '/animations/rig',
    body: {
      input: sourceTaskId,
      rig_type: rigType,
      spec,
      out_format: 'glb',
      // Always explicit, because the service's own default is invalid — see the
      // constant. A caller's choice wins; absent one, a version known to work.
      model: modelVersion ?? TRIPO_V3_DEFAULT_RIG_MODEL,
    },
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
