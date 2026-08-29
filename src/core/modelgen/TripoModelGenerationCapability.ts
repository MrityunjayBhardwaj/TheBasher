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
// 🔑 TWO API GENERATIONS, ONE CLIENT. Tripo's v2 and v3 differ in paths, a few
// field names, and which key the output URL arrives under — and agree on
// everything that carries risk: Bearer auth, the `{code, data}` envelope,
// poll-until-terminal-status, download-by-URL, and licence-before-request. So
// the version is a VALUE this class holds (`tripoDialect.ts`), not a second
// class. The shared half is written and tested once.
//
// 🔴 THE TWO VERSIONS ARE NOT EQUALLY GROUNDED, and the dialect table says so
// per entry. v2 is source-verified against Tripo's official MIT-licensed Python
// SDK, mirrored at `ref/sources/tripo-python-sdk/`:
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
// v3 is VENDOR-DOCUMENTED ONLY — there is no v3 source to read, and nothing in
// it has been observed against the running service. See `tripoDialect.ts`.
//
// REF: ref/architecture/ai-track.md phase A4; issues #732, #761, #762, #797.

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
import {
  DEFAULT_TRIPO_API_VERSION,
  tripoDialect,
  type TripoApiVersion,
  type TripoDialect,
  type TripoTaskOutput,
  type TripoUploads,
  type UploadedFile,
} from './tripoDialect';

/**
 * The id the SERVICE's licence verdict is recorded under. Deliberately not a
 * model version: what governs use here is one agreement covering the endpoint.
 *
 * 🔴 Not currently present in `external-models.json`, so every generation
 * refuses. That is the intended state until the terms are read. See #762.
 */
export const TRIPO_SERVICE_ID = 'tripo-api';

/**
 * Statuses from which a task never recovers.
 *
 * A UNION across both versions, on purpose. v2 names all five
 * (models.py:39-48); v3 documents only `failed` and `cancelled`, folding
 * moderation and queue expiry into `failed` with an `error_code`. Treating v2's
 * extra three as terminal under v3 costs nothing — they cannot arrive — while
 * dropping them would strand a v2 poll loop on a status it can never leave.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'banned', 'expired', 'unknown']);

export interface TripoOptions {
  /**
   * The account key. Its shape is checked only where the shape is DOCUMENTED —
   * v2 states `tsk_`, v3 states nothing — so see `assertTripoKeyShape`.
   */
  readonly apiKey: string;
  /**
   * Which API generation to speak. Defaults to v3, the version Tripo documents
   * today. v2 is retained and source-verified; see `tripoDialect.ts` for why
   * both exist and how differently grounded they are.
   */
  readonly apiVersion?: TripoApiVersion;
  /** Overrides the dialect's own base URL. Injected by tests; a host swap is a
   *  constructor swap and never an edit to a caller. */
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

/**
 * Check a key's shape — but only against a prefix the vendor DOCUMENTS.
 *
 * 🔑 THIS CHECK IS VERSION-SCOPED, and that is the point. v2's `tsk_` rule has
 * two independent citations (the SDK at `client.py:50-51` and the Blender plugin
 * at `operators.py:105`), so refusing a non-`tsk_` key there is a real early
 * error that saves an opaque 401 several seconds later.
 *
 * v3 documents no prefix at all. A rule invented from the one key we happened to
 * observe would refuse every valid key of a form we have not seen, while
 * reporting a confident reason for it — a check that can reject an input over a
 * fact it never reliably knows. So under v3 the only shape requirement is
 * non-emptiness, and the service's own 401 is the authority on validity.
 *
 * An empty key is refused under BOTH, because that one is not a guess: it means
 * nothing was configured.
 */
export function assertTripoKeyShape(
  apiKey: string,
  version: TripoApiVersion = DEFAULT_TRIPO_API_VERSION,
): void {
  const prefix = tripoDialect(version).keyPrefix;
  if (apiKey.trim() === '') {
    throw new TripoApiError('No Tripo API key is configured.');
  }
  if (prefix !== undefined && !apiKey.startsWith(prefix)) {
    throw new TripoApiError(
      `Tripo API key must begin with "${prefix}" for the ${version} API. Copy it from ` +
        'platform.tripo3d.ai/api-keys — a key from another field fails later as an opaque 401.',
    );
  }
}

export class TripoModelGenerationCapability
  implements ModelGenerationCapability, RiggingCapability
{
  readonly id = 'tripo-model-generation';
  readonly kind = 'http' as const;

  private readonly apiKey: string;
  private readonly dialect: TripoDialect;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  /** Task ids the caller asked to abandon. Consulted by the poll loop. */
  private readonly cancelled = new Set<string>();

  constructor(options: TripoOptions) {
    this.apiKey = options.apiKey;
    this.dialect = tripoDialect(options.apiVersion ?? DEFAULT_TRIPO_API_VERSION);
    this.baseUrl = (options.baseUrl ?? this.dialect.baseUrl).replace(/\/+$/, '');
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
      assertTripoKeyShape(this.apiKey, this.dialect.version);
      await this.getBalance();
      return true;
    } catch {
      return false;
    }
  }

  /** Remaining credits, as the Blender plugin shows after key confirmation.
   *  REF: ref/sources/tripo-3d-for-blender/utils.py:112 (`Update_User_balance`). */
  async getBalance(): Promise<{ balance: number; frozen: number }> {
    const data = await this.request<{ balance?: number; frozen?: number }>(
      'GET',
      this.dialect.balancePath,
    );
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
    assertTripoKeyShape(this.apiKey, this.dialect.version);

    const deadline = Date.now() + this.timeoutMs;
    const uploads = await this.uploadSources(request);
    const call = this.dialect.modelCall(request, uploads);
    const created = await this.request<{ task_id?: string }>('POST', call.path, call.body);
    const taskId = created.task_id;
    if (!taskId) {
      throw new TripoApiError('Tripo accepted the task but returned no task_id.');
    }

    const output = await this.pollUntilDone(taskId, deadline, onProgress);
    // WHICH field holds the URL is version-specific — v3 renamed it — so the
    // dialect answers rather than this method guessing across both vocabularies.
    const url = this.dialect.modelUrlOf(output);
    if (!url) {
      throw new TripoApiError(
        `Tripo task ${taskId} succeeded but its output carried no model URL ` +
          `(${this.dialect.version} expects ` +
          `${this.dialect.version === 'v2' ? 'pbr_model, model or base_model' : 'model_url or model_urls'}).`,
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
    assertTripoKeyShape(this.apiKey, this.dialect.version);

    const deadline = Date.now() + this.timeoutMs;
    const call = this.dialect.rigCheckCall(subject.sourceTaskId);
    const created = await this.request<{ task_id?: string }>('POST', call.path, call.body);
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
    assertTripoKeyShape(this.apiKey, this.dialect.version);

    const spec = request.spec ?? DEFAULT_RIG_SPEC;
    const deadline = Date.now() + this.timeoutMs;
    // `out_format` is pinned to glb inside every dialect rather than exposed:
    // the whole contract is that a rigged mesh takes the SAME import road a
    // dropped .glb takes, and fbx would fork it. REF: client.py:1160.
    const call = this.dialect.rigCall({
      sourceTaskId: request.sourceTaskId,
      rigType: request.rigType ?? 'biped',
      spec,
      ...(request.modelVersion !== undefined ? { modelVersion: request.modelVersion } : {}),
    });
    const created = await this.request<{ task_id?: string }>('POST', call.path, call.body);
    const taskId = created.task_id;
    if (!taskId) throw new TripoApiError('Tripo accepted the rig but returned no task_id.');

    const output = await this.pollUntilDone(taskId, deadline, (p) => onProgress?.(p));
    const url = this.dialect.modelUrlOf(output);
    if (!url) {
      throw new TripoApiError(
        `Tripo rig ${taskId} succeeded but its output carried no model URL ` +
          `(${this.dialect.version} expects ` +
          `${this.dialect.version === 'v2' ? 'model, pbr_model or base_model' : 'model_url or model_urls'}).`,
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
      }>('GET', this.dialect.taskPath(taskId));

      const status = task.status ?? 'unknown';
      onProgress?.({ taskId, status, progress: task.progress ?? 0 });

      if (status === 'success') return task.output ?? {};
      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        throw new TripoTaskFailedError(taskId, status);
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  /**
   * Put whatever files the request carries in front of the service, and return
   * them in the shape a task body references.
   *
   * Split out of body-building on purpose: uploading is a real side effect with
   * its own failure mode, while assembling a task body is pure. The dialect gets
   * a pure function of (request, already-uploaded files), which is what makes
   * every wire shape testable without a network.
   */
  private async uploadSources(request: ModelGenerationRequest): Promise<TripoUploads> {
    if (request.source === 'text') return {};
    if (request.source === 'image') return { single: await this.uploadImage(request.image) };

    const { front, left, back, right } = request.views;
    const views = await Promise.all(
      [front, left, back, right].map(async (img) => (img ? await this.uploadImage(img) : null)),
    );
    return { views };
  }

  /**
   * Upload one image with multipart `file` and return the token a task body
   * references it by.
   *
   * BOTH the path and the token's field name are version-specific — v2 posts to
   * `/upload` and answers `data.image_token`, v3 posts to `/files` and answers
   * `data.file_token` — so both come from the dialect. The `{type, file_token}`
   * shape the task body then carries is the same in both.
   *
   * REF: aiohttp_client_impl.py:98-127 and client.py:486-500 (v2);
   *      v3 docs, `POST /files` → FileData.file_token.
   */
  private async uploadImage(image: SourceImage): Promise<UploadedFile> {
    const form = new FormData();
    const ext = mimeToExt(image.mimeType);
    // Copy into a fresh Uint8Array so a view over a larger (or shared) buffer is
    // not sent wholesale — the same detach concern the glTF importer handles.
    const bytes = new Uint8Array(image.bytes.byteLength);
    bytes.set(image.bytes);
    form.append('file', new Blob([bytes], { type: image.mimeType }), `upload.${ext}`);

    const response = await this.fetchImpl(`${this.baseUrl}${this.dialect.uploadPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: Record<string, string | undefined>;
    } | null;
    const token = payload?.data?.[this.dialect.uploadTokenField];
    if (!response.ok || !token) {
      throw new TripoApiError(
        `Tripo image upload failed: ${payload?.message ?? response.statusText}`,
        { code: payload?.code, status: response.status },
      );
    }
    return { type: ext, file_token: token };
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
