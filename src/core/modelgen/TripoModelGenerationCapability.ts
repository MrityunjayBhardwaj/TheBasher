// TripoModelGenerationCapability — talks to Tripo AI's public API.
//
// The base URL is injected at construction, mirroring the ComfyUI and motion
// capabilities' locked decision: switching hosts, or swapping the generator
// entirely, is a constructor swap and never an edit to a caller. No module
// outside `src/core/modelgen/` may reach the service directly.
//
// 🔴 THE LICENCE CHECK RUNS BEFORE ANY REQUEST IS ISSUED, and today it REFUSES.
// `TRIPO_SERVICE_ID` has no recorded verdict, because Tripo's Terms of Service
// could not be read from the dev environment — `www.tripo3d.ai/terms` and its
// siblings return HTTP 403 and `platform.tripo3d.ai/terms` is an SPA shell, so
// the only reachable material was marketing copy, which is a claim and not an
// agreement. `assertModelAllowed` default-denies an unrecorded id, so this class
// is complete and inert: every call fails with a message naming exactly what is
// missing, and recording the verdict switches it on with no code change.
//
// That is deliberate, and it is A0's rule expressed as behaviour rather than as a
// promise to remember. It is also the honest reading of "nothing designed in
// before its terms are known": the CODE may be written — writing an HTTP client
// uses nobody's service — but the CALL may not be made.
//
// The licence unit is the SERVICE, not `modelVersion`. See the interface header:
// a hosted API ships no weights, so a version is a menu choice inside one
// agreement rather than a separately-licensed artefact.
//
// Grounded, not guessed. Every endpoint, header, field name and status string
// below is read from Tripo's official MIT-licensed Python SDK, mirrored at
// `ref/sources/tripo-python-sdk/`:
//   - BASE_URL                          tripo3d/client.py:25
//   - POST /task   → data.task_id       tripo3d/client.py:200-216
//   - GET  /task/{id} → data.{status,progress,output}
//                                       tripo3d/client.py:177-198
//   - GET  /user/balance                tripo3d/client.py:217-230
//   - POST /upload (multipart `file`) → data.image_token
//                                       tripo3d/client_impl/aiohttp_client_impl.py:98-127
//   - Authorization: Bearer <key>       tripo3d/client_impl/aiohttp_client_impl.py:32
//   - TaskStatus values                 tripo3d/models.py:39-48
//   - output.{model,base_model,pbr_model}
//                                       tripo3d/models.py:65-72
//
// REF: ref/architecture/ai-track.md phase A4; issues #732, #761, #762.

import { assertModelAllowed } from '../licensing/allowedModels';
import { parseGltfContainer } from '../import/glb';
import {
  DEFAULT_RIG_SPEC,
  RIG_TYPES,
  assertValidRigRequest,
  classifyRigSpec,
  type RigProgress,
  type RigRequest,
  type RigResult,
  type RigSubject,
  type RiggableCheck,
  type RigType,
  type RiggingCapability,
} from '../rigging/RiggingCapability';
import {
  assertValidModelRequest,
  type ModelGenerationCapability,
  type ModelGenerationProgress,
  type ModelGenerationRequest,
  type ModelGenerationResult,
  type SourceImage,
} from './ModelGenerationCapability';

/**
 * The id the SERVICE's licence verdict is recorded under. Deliberately not a
 * model version: what governs use here is one agreement covering the endpoint.
 *
 * 🔴 Not currently present in `external-models.json`, so every generation
 * refuses. That is the intended state until the terms are read. See #762.
 */
export const TRIPO_SERVICE_ID = 'tripo-api';

/** REF: ref/sources/tripo-python-sdk/tripo3d/client.py:25. */
export const TRIPO_BASE_URL = 'https://api.tripo3d.ai/v2/openapi';

/** REF: ref/sources/tripo-python-sdk/tripo3d/models.py:39-48. */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'banned', 'expired', 'unknown']);

/** The task output fields this client reads. `riggable` and `rig_type` are what a
 *  pre-rig check answers with. REF: tripo3d/models.py:64-90 (TaskOutput). */
interface TripoTaskOutput {
  model?: string;
  base_model?: string;
  pbr_model?: string;
  riggable?: boolean;
  rig_type?: string;
}

export interface TripoOptions {
  /** `tsk_`-prefixed key. The Blender plugin validates that prefix before use;
   *  so do we, because a key pasted from the wrong field otherwise fails as an
   *  opaque 401 several seconds later.
   *  REF: ref/sources/tripo-3d-for-blender/operators.py:105. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Whole-generation budget, across create + poll + download. */
  readonly timeoutMs?: number;
  /** Gap between task polls. */
  readonly pollIntervalMs?: number;
  /** Injected for tests; defaults to the ambient fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests so polling does not really sleep. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class TripoApiError extends Error {
  readonly code?: number;
  readonly status?: number;
  constructor(message: string, opts: { code?: number; status?: number } = {}) {
    super(message);
    this.name = 'TripoApiError';
    this.code = opts.code;
    this.status = opts.status;
  }
}

/** Thrown when a task reaches a terminal non-success status. Distinct from a
 *  transport error, because the two ask the caller for different things: retry
 *  versus change the request. */
export class TripoTaskFailedError extends Error {
  readonly taskId: string;
  readonly status: string;
  constructor(taskId: string, status: string) {
    super(`Tripo task ${taskId} ended as "${status}".`);
    this.name = 'TripoTaskFailedError';
    this.taskId = taskId;
    this.status = status;
  }
}

export function assertTripoKeyShape(apiKey: string): void {
  if (!apiKey.startsWith('tsk_')) {
    throw new TripoApiError(
      'Tripo API key must begin with "tsk_". Copy it from platform.tripo3d.ai/api-keys — ' +
        'a key from another field fails later as an opaque 401.',
    );
  }
}

export class TripoModelGenerationCapability
  implements ModelGenerationCapability, RiggingCapability
{
  readonly id = 'tripo-model-generation';
  readonly kind = 'http' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Task ids the caller asked to abandon. Consulted by the poll loop. */
  private readonly cancelled = new Set<string>();

  constructor(options: TripoOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? TRIPO_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl =
      options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async isAvailable(): Promise<boolean> {
    // A balance call is the cheapest thing that proves BOTH that the host is up
    // and that the key is accepted — which is what "available" has to mean for a
    // paid service. A reachable host with a rejected key is not availability.
    try {
      assertTripoKeyShape(this.apiKey);
      await this.getBalance();
      return true;
    } catch {
      return false;
    }
  }

  /** Remaining credits, as the Blender plugin shows after key confirmation.
   *  REF: ref/sources/tripo-3d-for-blender/utils.py:112 (`Update_User_balance`). */
  async getBalance(): Promise<{ balance: number; frozen: number }> {
    const data = await this.request<{ balance?: number; frozen?: number }>('GET', '/user/balance');
    return { balance: data.balance ?? 0, frozen: data.frozen ?? 0 };
  }

  async generate(
    request: ModelGenerationRequest,
    onProgress?: (p: ModelGenerationProgress) => void,
  ): Promise<ModelGenerationResult> {
    // Licence BEFORE shape, and both before anything leaves the process — the
    // same ordering and the same reason as the motion capability.
    assertModelAllowed(TRIPO_SERVICE_ID);
    assertValidModelRequest(request);
    assertTripoKeyShape(this.apiKey);

    const deadline = Date.now() + this.timeoutMs;
    const taskData = await this.buildTaskData(request);
    const created = await this.request<{ task_id?: string }>('POST', '/task', taskData);
    const taskId = created.task_id;
    if (!taskId) {
      throw new TripoApiError('Tripo accepted the task but returned no task_id.');
    }

    const output = await this.pollUntilDone(taskId, deadline, onProgress);
    // pbr_model first: it is the textured, PBR-material variant the plugin
    // prefers, and A4's road carries materials through the same glTF chain.
    const url = output.pbr_model ?? output.model ?? output.base_model;
    if (!url) {
      throw new TripoApiError(
        `Tripo task ${taskId} succeeded but its output carried no model URL ` +
          '(expected one of pbr_model, model, base_model).',
      );
    }

    const glb = await this.download(url, deadline);
    return {
      taskId,
      glb,
      modelVersion: request.modelVersion ?? 'unspecified',
    };
  }

  /**
   * Best-effort cancel. The official SDK exposes NO cancel endpoint — `cancelled`
   * appears only as a status the service may report — so inventing one here would
   * be fabricating a contract. What this honestly does is stop OUR polling: the
   * task may still run and may still be billed. Said plainly rather than implied,
   * because a cancel that silently costs money is the worse surprise.
   */
  async cancel(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }

  // ---------------------------------------------------------------------------
  // RiggingCapability. One service, one key, one transport — so this class
  // implements both interfaces rather than duplicating the client. The SEAM is
  // still real: a rigging-only backend (UniRig is already in the manifest) plugs
  // in as its own class without touching generation, because callers take
  // `RiggingCapability` and never this type.
  // ---------------------------------------------------------------------------

  /** REF: ref/sources/tripo-python-sdk/tripo3d/client.py:1126 (`check_riggable`). */
  async checkRiggable(subject: RigSubject): Promise<RiggableCheck> {
    assertModelAllowed(TRIPO_SERVICE_ID);
    assertTripoKeyShape(this.apiKey);

    const deadline = Date.now() + this.timeoutMs;
    const created = await this.request<{ task_id?: string }>('POST', '/task', {
      type: 'animate_prerigcheck',
      original_model_task_id: subject.sourceTaskId,
    });
    const taskId = created.task_id;
    if (!taskId)
      throw new TripoApiError('Tripo accepted the pre-rig check but returned no task_id.');

    const output = await this.pollUntilDone(taskId, deadline);
    return {
      taskId,
      riggable: output.riggable === true,
      // An unrecognised or absent value becomes null, NOT `others`. "I could not
      // tell" and "it is some other body plan" are different answers, and
      // collapsing them turns silence into a positive claim.
      detectedRigType: isRigType(output.rig_type) ? output.rig_type : null,
    };
  }

  /** REF: ref/sources/tripo-python-sdk/tripo3d/client.py:1156 (`rig_model`). */
  async rig(request: RigRequest, onProgress?: (p: RigProgress) => void): Promise<RigResult> {
    assertModelAllowed(TRIPO_SERVICE_ID);
    assertValidRigRequest(request);
    assertTripoKeyShape(this.apiKey);

    const spec = request.spec ?? DEFAULT_RIG_SPEC;
    const deadline = Date.now() + this.timeoutMs;
    const created = await this.request<{ task_id?: string }>('POST', '/task', {
      type: 'animate_rig',
      original_model_task_id: request.sourceTaskId,
      // `out_format` is pinned to glb rather than exposed: the whole contract is
      // that a rigged mesh takes the SAME import road a dropped .glb takes, and
      // fbx would fork it. REF: client.py:1160.
      out_format: 'glb',
      rig_type: request.rigType ?? 'biped',
      spec,
    });
    const taskId = created.task_id;
    if (!taskId) throw new TripoApiError('Tripo accepted the rig but returned no task_id.');

    const output = await this.pollUntilDone(taskId, deadline, (p) => onProgress?.(p));
    const url = output.model ?? output.pbr_model ?? output.base_model;
    if (!url) {
      throw new TripoApiError(
        `Tripo rig ${taskId} succeeded but its output carried no model URL ` +
          '(expected one of model, pbr_model, base_model).',
      );
    }
    const glb = await this.download(url, deadline);

    // READ THE SKELETON THAT ARRIVED. Asking for `mixamo` and being handed the
    // service's own convention is a broken contract that is otherwise invisible:
    // the call succeeded, the request said mixamo, and the retarget downstream
    // silently binds nothing. Refusing here is the right trade because a rig in
    // the wrong vocabulary has no use downstream at all — there is no road it
    // half-works on.
    const joints = jointNamesOf(glb);
    if (spec === 'mixamo' && joints !== null) {
      const arrived = classifyRigSpec(joints);
      if (arrived !== 'mixamo') {
        throw new TripoApiError(
          `Tripo rig ${taskId} was requested with spec "mixamo" but returned a skeleton whose ` +
            `bone names are not Mixamo's. Nothing downstream can drive it: Basher's retarget ` +
            'maps onto Mixamo names. Re-run with spec "tripo" if that skeleton is what you want.',
        );
      }
    }

    return { taskId, glb, requestedSpec: spec };
  }

  private async pollUntilDone(
    taskId: string,
    deadline: number,
    onProgress?: (p: ModelGenerationProgress) => void,
  ): Promise<TripoTaskOutput> {
    for (;;) {
      if (this.cancelled.has(taskId)) {
        this.cancelled.delete(taskId);
        throw new TripoTaskFailedError(taskId, 'cancelled');
      }
      if (Date.now() > deadline) {
        throw new TripoApiError(
          `Tripo task ${taskId} did not finish within ${this.timeoutMs}ms. It may still ` +
            'be running and billed; check platform.tripo3d.ai.',
        );
      }

      const task = await this.request<{
        status?: string;
        progress?: number;
        output?: TripoTaskOutput;
      }>('GET', `/task/${encodeURIComponent(taskId)}`);

      const status = task.status ?? 'unknown';
      onProgress?.({ taskId, status, progress: task.progress ?? 0 });

      if (status === 'success') return task.output ?? {};
      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        throw new TripoTaskFailedError(taskId, status);
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  /** Map Basher's vocabulary onto the service's. THIS is the only place that
   *  knows Tripo's field names — the interface above stays Basher-shaped. */
  private async buildTaskData(request: ModelGenerationRequest): Promise<Record<string, unknown>> {
    const shared: Record<string, unknown> = {};
    const put = (key: string, value: unknown): void => {
      if (value !== undefined) shared[key] = value;
    };
    put('model_version', request.modelVersion);
    put('face_limit', request.faceLimit);
    put('quad', request.quad);
    put('texture', request.texture);
    put('pbr', request.pbr);
    put('texture_quality', request.textureQuality);
    put('geometry_quality', request.geometryQuality);
    put('texture_alignment', request.textureAlignment);
    put('auto_size', request.autoSize);
    put('style', request.style);
    put('orientation', request.orientation);
    put('model_seed', request.modelSeed);
    put('texture_seed', request.textureSeed);

    if (request.source === 'text') {
      const data: Record<string, unknown> = {
        ...shared,
        type: 'text_to_model',
        prompt: request.prompt,
      };
      if (request.negativePrompt !== undefined) data.negative_prompt = request.negativePrompt;
      if (request.pose) {
        // REF: ref/sources/tripo-3d-for-blender/__init__.py — the five ratio props.
        const p = request.pose;
        const spec: Record<string, unknown> = {};
        if (p.headBodyHeightRatio !== undefined)
          spec.head_body_height_ratio = p.headBodyHeightRatio;
        if (p.headBodyWidthRatio !== undefined) spec.head_body_width_ratio = p.headBodyWidthRatio;
        if (p.legsBodyHeightRatio !== undefined)
          spec.legs_body_height_ratio = p.legsBodyHeightRatio;
        if (p.armsBodyLengthRatio !== undefined)
          spec.arms_body_length_ratio = p.armsBodyLengthRatio;
        if (p.spanOfLegs !== undefined) spec.span_of_legs = p.spanOfLegs;
        if (Object.keys(spec).length > 0) data.pose_spec = spec;
      }
      return data;
    }

    if (request.source === 'image') {
      const file = await this.uploadImage(request.image);
      return { ...shared, type: 'image_to_model', file };
    }

    const { front, left, back, right } = request.views;
    // The service takes the four views positionally, front first, with a null
    // hole for a view that was not supplied.
    const files = await Promise.all(
      [front, left, back, right].map(async (img) => (img ? await this.uploadImage(img) : null)),
    );
    return { ...shared, type: 'multiview_to_model', files };
  }

  /** POST /upload with multipart `file`, returning the token the task body wants.
   *  REF: aiohttp_client_impl.py:98-127 (`data.image_token`), client.py:486-500
   *  (the `{type, file_token}` shape a task carries). */
  private async uploadImage(image: SourceImage): Promise<Record<string, unknown>> {
    const form = new FormData();
    const ext = mimeToExt(image.mimeType);
    // Copy into a fresh Uint8Array so a view over a larger (or shared) buffer is
    // not sent wholesale — the same detach concern the glTF importer handles.
    const bytes = new Uint8Array(image.bytes.byteLength);
    bytes.set(image.bytes);
    form.append('file', new Blob([bytes], { type: image.mimeType }), `upload.${ext}`);

    const response = await this.fetchImpl(`${this.baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: { image_token?: string };
    } | null;
    if (!response.ok || !payload?.data?.image_token) {
      throw new TripoApiError(
        `Tripo image upload failed: ${payload?.message ?? response.statusText}`,
        { code: payload?.code, status: response.status },
      );
    }
    return { type: ext, file_token: payload.data.image_token };
  }

  private async download(url: string, deadline: number): Promise<ArrayBuffer> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TripoApiError('Timed out before the model could be downloaded.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new TripoApiError(`Downloading the generated model failed: ${response.statusText}`, {
          status: response.status,
        });
      }
      return await response.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      suggestion?: string;
      data?: T;
    } | null;

    if (!response.ok) {
      throw new TripoApiError(
        `Tripo ${method} ${path} failed: ${payload?.message ?? response.statusText}` +
          (payload?.suggestion ? ` — ${payload.suggestion}` : ''),
        { code: payload?.code, status: response.status },
      );
    }
    if (payload?.data === undefined) {
      throw new TripoApiError(`Tripo ${method} ${path} returned no "data" field.`);
    }
    return payload.data;
  }
}

function mimeToExt(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

function isRigType(value: unknown): value is RigType {
  return typeof value === 'string' && (RIG_TYPES as readonly string[]).includes(value);
}

/**
 * The skin joint names inside a GLB, read from its JSON chunk.
 *
 * Deliberately NOT a full import: this runs at the transport boundary, on every
 * rig, and all it needs is the names. Parsing the container is cheap and the
 * joints are node indices into a list that is already in hand.
 */
function jointNamesOf(glb: ArrayBuffer): string[] | null {
  try {
    const { json } = parseGltfContainer(glb);
    const nodes = (json.nodes ?? []) as { name?: string }[];
    const skins = (json.skins ?? []) as { joints?: number[] }[];
    return skins.flatMap((skin) => (skin.joints ?? []).map((i) => nodes[i]?.name ?? ''));
  } catch {
    // NULL, not an empty list, and the distinction is load-bearing. An empty list
    // is a real answer — a GLB that parsed and carries no skin, which IS a failed
    // rig. Unparseable bytes are a different failure with a different owner, and
    // returning `[]` for them would report a vocabulary mismatch for a file that
    // was never read. Let the ordinary import road name that one.
    return null;
  }
}
