// Text-to-3D / image-to-3D — the road from a request to a model in the scene, through a
// `ModelGenerate` node that keeps the request (#1720).
//
//     mint ModelGenerate ─► run variants ─► keep one
//     (one undo entry)      (bytes to        └── ingestSingleFile → buildGltfImportOpsFromOpfs
//                            model-variants/,     the same ingest and import a dropped .glb takes,
//                            a row on the node)   plus generation.json beside the asset
//
// 🔑 THE MESH STILL ENTERS BY THE IMPORT ROAD, UNMODIFIED. Phase A4's claim — a generated mesh
// takes the identical path an imported GLB takes — is kept: keeping a variant calls the same two
// functions a file drop calls. What #1720 adds is upstream of that road and beside it, never in
// it: the node that holds the request, and the record beside the kept asset that names the node.
//
// WHY VARIANTS LIVE OUTSIDE THE LIBRARY UNTIL KEPT. A run asks for several (design board 13b:
// "4 variants arrive; Keep places one and saves it"). Written into `user-imports/` they would all
// appear in Your imports before anyone chose one. They are written to `model-variants/<node>/`
// instead — kept, because they were paid for — and only the kept one is ingested into the library.
//
// WHERE THE PROVENANCE LIVES. On the node (the request, each variant's seed and task) and in
// `generation.json` beside the kept asset (which node, which seed, which provider). The asset's
// record is what the Library's details read: the library is shared by every project, so the
// record travels with the asset, and it survives a rename (the folder moves whole) where a path
// on the node would go stale. A scene Object reaches it through its `assetRef`.
//
// ONE ROAD FOR BOTH SURFACES. The director's Keep and the agent's `model.generate` build their
// ops with `buildKeepVariantOps`; the agent's tool mints, runs one variant and keeps it in one
// Diff (`buildGenerateAndKeepOps`), and never dispatches (V7).
//
// Invariants honored:
//   - V8: no `src/viewport/` imports. App-layer module.
//   - K6: one dispatchAtomic per user-visible step (mint, each variant's row, keep).
//   - silent-failure: a refusal, a malformed request or an unreachable service reaches the
//     banner, never console-only.
//
// REF: src/nodes/ModelGenerate.ts (the node); src/app/asset/importGltf.ts (the chokepoint);
//      src/app/asset/generateRiggedCharacter.ts (`runRiggedGeneration`, the rigged bytes);
//      src/agent/tools/modelGenerate.ts (the agent half); issues #1720, #837, #806.

import { getModelCapability, getStorage } from '../boot';
import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import type {
  SourceImage,
  ModelGenerationCapability,
  ModelGenerationProgress,
  ModelGenerationRequest,
} from '../../core/modelgen';
import { projectImagePath, writeProjectImage } from '../../core/project/projectImages';
import { useProjectStore } from '../../core/project/store';
import {
  DEFAULT_MODEL_VARIANTS,
  MODEL_GENERATE_TYPE,
  ModelGenerateParams,
  nextVariantSeed,
  type ModelVariant,
} from '../../nodes/ModelGenerate';
import { useSettingsStore } from '../stores/settingsStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import { useImportRefreshStore } from '../stores/importRefreshStore';
import { useModelGenerationStore } from '../stores/modelGenerationStore';
import { ingestSingleFile, USER_IMPORTS_ROOT } from './importCommon';
import { buildGltfImportOpsFromOpfs, leftBehindNotice, refusalNotice } from './importGltf';
import { chooseSeed } from './mintMotionGenerate';
import { runRiggedGeneration } from './generateRiggedCharacter';

/** Where a variant's bytes wait until a director keeps it. Not under `user-imports/`, so the
 *  library does not list a variant nobody chose. */
export const MODEL_VARIANTS_ROOT = 'model-variants';

/** The record a kept asset carries beside its file, naming the node that made it. */
export const GENERATION_RECORD_FILE = 'generation.json';

/** What the record says. Everything the Library's details show, and the node to regenerate. */
export interface GenerationRecord {
  /** The `ModelGenerate` node that made it. */
  readonly nodeId: string;
  /** The project that node lives in, when one was open. The library is shared across projects,
   *  so "Regenerate" is only possible from the project that holds the node. */
  readonly projectId: string | null;
  readonly prompt: string;
  readonly references: readonly string[];
  readonly seed: number;
  readonly provider: string;
  readonly rig: boolean;
  readonly taskId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The mint
// ─────────────────────────────────────────────────────────────────────────────

export interface MintModelGenerateArgs {
  readonly prompt: string;
  readonly references?: readonly string[];
  readonly seed: number;
  readonly provider: string;
  readonly rig?: boolean;
  readonly count?: number;
  readonly variants?: readonly ModelVariant[];
  /** The service's own knobs — absent lets the service decide. */
  readonly knobs?: ModelGenerationKnobs;
  /** An explicit id, so a caller can address the node it just made. */
  readonly nodeId?: string;
}

let mintCounter = 0;
function mintNodeId(): string {
  mintCounter += 1;
  return `modelgen_${Date.now().toString(36)}_${mintCounter}`;
}

/** The params a mint writes, parsed by the node's own schema — a request the node would refuse
 *  is refused here, before anything is dispatched or billed. */
export function modelGenerateParamsOf(args: MintModelGenerateArgs): ModelGenerateParams {
  return ModelGenerateParams.parse({
    prompt: args.prompt,
    references: [...(args.references ?? [])],
    seed: args.seed,
    provider: args.provider,
    rig: args.rig ?? false,
    count: args.count ?? DEFAULT_MODEL_VARIANTS,
    variants: [...(args.variants ?? [])],
    ...(args.knobs ?? {}),
  });
}

/** The service knobs a node can carry (`ModelGenerate`'s optional params). */
export type ModelGenerationKnobs = Partial<
  Pick<ModelGenerateParams, 'negativePrompt' | 'faceLimit' | 'quad' | 'texture' | 'pbr'>
>;

/** The op that adds a `ModelGenerate`. Returns ops rather than dispatching, like every mint. */
export function mintModelGenerateOps(args: MintModelGenerateArgs): {
  readonly ops: Op[];
  readonly nodeId: string;
} {
  const nodeId = args.nodeId ?? mintNodeId();
  return {
    nodeId,
    ops: [
      {
        type: 'addNode',
        nodeId,
        nodeType: 'ModelGenerate',
        params: modelGenerateParamsOf(args),
      },
    ],
  };
}

/** A node's params, parsed, or null when it is not a `ModelGenerate` (or absent). */
export function modelGenerateParamsOfNode(
  node: { readonly type: string; readonly params?: unknown } | undefined,
): ModelGenerateParams | null {
  if (!node || node.type !== MODEL_GENERATE_TYPE) return null;
  const parsed = ModelGenerateParams.safeParse(node.params);
  return parsed.success ? parsed.data : null;
}

/** `nodeId`'s params in `state`, or null when it is not a `ModelGenerate` there. */
export function modelGenerateParamsIn(state: DagState, nodeId: string): ModelGenerateParams | null {
  return modelGenerateParamsOfNode(state.nodes[nodeId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// One variant
// ─────────────────────────────────────────────────────────────────────────────

/** A short name for what the node asks for — the asset's name and the banner's subject. */
export function subjectOf(params: {
  readonly prompt: string;
  readonly references: readonly string[];
}): string {
  const prompt = params.prompt.trim();
  if (prompt) return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
  return params.references.length > 0 ? 'image-to-3D' : 'model';
}

/**
 * The service request for one variant of `params`. A reference image REPLACES the prompt: the
 * service cannot take both (#837), and sending the prompt beside it would be a field it drops.
 */
export async function requestForVariant(
  params: ModelGenerateParams,
  seed: number,
  modelVersion: string | undefined,
): Promise<ModelGenerationRequest> {
  const version = modelVersion !== undefined ? { modelVersion } : {};
  const knobs = {
    ...(params.faceLimit !== undefined ? { faceLimit: params.faceLimit } : {}),
    ...(params.quad !== undefined ? { quad: params.quad } : {}),
    ...(params.texture !== undefined ? { texture: params.texture } : {}),
    ...(params.pbr !== undefined ? { pbr: params.pbr } : {}),
  };
  const [reference] = params.references;
  if (reference !== undefined) {
    const projectId = useProjectStore.getState().current?.id;
    if (!projectId) throw new Error('there is no open project to read the reference image from');
    const storage = await getStorage();
    const bytes = await storage.read(projectImagePath(projectId, reference));
    const ext = reference.split('.').pop()?.toLowerCase();
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext ?? 'png'}`;
    return { source: 'image', image: { bytes, mimeType }, modelSeed: seed, ...knobs, ...version };
  }
  return {
    source: 'text',
    prompt: params.prompt.trim(),
    ...(params.negativePrompt !== undefined ? { negativePrompt: params.negativePrompt } : {}),
    modelSeed: seed,
    ...knobs,
    ...version,
  };
}

/**
 * Store a picked reference image in the open project and return its key — what the node holds,
 * so a Regenerate reads the same image again. The project's image store is the road every image
 * an import brings already takes (`storeImageInOpenProject`), content-addressed, so picking the
 * same picture twice stores it once.
 */
export async function storeReferenceImage(image: SourceImage): Promise<string> {
  const projectId = useProjectStore.getState().current?.id;
  if (!projectId) throw new Error('there is no open project to store the reference image in');
  return writeProjectImage(await getStorage(), projectId, image.bytes, image.mimeType);
}

/** Where one variant's bytes are stored. */
export function variantPath(nodeId: string, seed: number): string {
  return `${MODEL_VARIANTS_ROOT}/${nodeId}/seed-${seed}.glb`;
}

/**
 * Run ONE variant of `params` with `seed` and store its bytes. Throws on failure; the caller
 * reports. A rigged request runs the rigged road; a rig the service refuses still yields the mesh
 * it generated (and billed for), with the refusal on the banner.
 */
export async function produceVariant(
  nodeId: string,
  params: ModelGenerateParams,
  seed: number,
  capability: ModelGenerationCapability,
  options: {
    readonly modelVersion?: string;
    readonly onProgress?: (p: { label: string; percent: number }) => void;
  } = {},
): Promise<ModelVariant> {
  const request = await requestForVariant(params, seed, options.modelVersion);
  let glb: ArrayBuffer;
  let taskId: string;
  if (params.rig) {
    const run = await runRiggedGeneration(request, {
      onProgress: (p) =>
        options.onProgress?.({ label: RIG_PHASE_LABEL[p.phase], percent: p.percent }),
    });
    taskId = run.taskId;
    if (run.outcome === 'rigged') {
      glb = run.glb;
    } else {
      glb = await run.collectGlb();
      useAssetErrorStore
        .getState()
        .report(subjectOf(params), `generated, but not rigged: ${run.reason}`);
    }
  } else {
    const result = await capability.generate(request, (p: ModelGenerationProgress) =>
      options.onProgress?.({ label: p.status, percent: p.progress }),
    );
    glb = result.glb;
    taskId = result.taskId;
  }
  const path = variantPath(nodeId, seed);
  const storage = await getStorage();
  await storage.write(path, new Uint8Array(glb));
  return { seed, path, taskId, kept: false };
}

const RIG_PHASE_LABEL: Record<string, string> = {
  generating: 'Generating mesh',
  checking: 'Checking it can be rigged',
  rigging: 'Building skeleton',
  importing: 'Importing',
};

// ─────────────────────────────────────────────────────────────────────────────
// Keep
// ─────────────────────────────────────────────────────────────────────────────

export interface KeepVariantOps {
  /** The import's ops — what a dropped `.glb` adds. The caller adds the node's own row. */
  readonly importOps: Op[];
  /** The node's variants with this one marked kept. */
  readonly variants: ModelVariant[];
  /** Where the kept asset now lives in the library. */
  readonly opfsPath: string;
  readonly notices: readonly string[];
}

/**
 * Save a variant to the library and build the ops that place it, without dispatching.
 *
 * Writes before it returns — the asset and its record — for the reason `model.generate` already
 * gave: the ops name the asset by path, so the bytes must exist for them to mean anything.
 * Throws when the import road refuses the file; nothing is placed then.
 */
export async function buildKeepVariantOps(
  state: DagState,
  nodeId: string,
  params: ModelGenerateParams,
  seed: number,
  /** The asset's name in the library; defaults to what the node asks for. */
  name?: string,
): Promise<KeepVariantOps> {
  const variant = params.variants.find((v) => v.seed === seed);
  if (!variant) throw new Error(`the node has no variant with seed ${seed}`);
  const storage = await getStorage();
  const bytes = await storage.read(variant.path);

  // The SAME ingest a single dropped file takes — naming, collision suffixing, the write.
  const opfsPath = await ingestSingleFile(
    { relativePath: params.rig ? 'character.glb' : 'model.glb', bytes },
    name ?? subjectOf(params),
  );
  const record: GenerationRecord = {
    nodeId,
    projectId: useProjectStore.getState().current?.id ?? null,
    prompt: params.prompt,
    references: params.references,
    seed: variant.seed,
    provider: params.provider,
    rig: params.rig,
    taskId: variant.taskId,
  };
  await storage.write(
    `${assetFolderOf(opfsPath)}/${GENERATION_RECORD_FILE}`,
    new TextEncoder().encode(JSON.stringify(record, null, 2)),
  );

  // The SAME import a dropped file takes.
  const chain = await buildGltfImportOpsFromOpfs(opfsPath, state);
  if (chain.road === 'refused') throw new Error(refusalNotice(chain.nativeRefusal));
  return {
    importOps: chain.ops,
    variants: params.variants.map((v) => (v.seed === seed ? { ...v, kept: true } : v)),
    opfsPath,
    notices: chain.notices,
  };
}

/** `user-imports/<folder>` for any path inside that import. */
export function assetFolderOf(path: string): string {
  const parts = path.split('/');
  return parts.slice(0, 2).join('/');
}

/** The record beside an asset, or null when it has none (an ordinary import) or it is unreadable. */
export async function readGenerationRecord(assetPath: string): Promise<GenerationRecord | null> {
  if (!assetPath.startsWith(`${USER_IMPORTS_ROOT}/`)) return null;
  try {
    const storage = await getStorage();
    const recordPath = `${assetFolderOf(assetPath)}/${GENERATION_RECORD_FILE}`;
    if (!(await storage.exists(recordPath))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(await storage.read(recordPath))) as unknown;
    return isGenerationRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isGenerationRecord(v: unknown): v is GenerationRecord {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.nodeId === 'string' &&
    typeof r.prompt === 'string' &&
    typeof r.seed === 'number' &&
    typeof r.provider === 'string' &&
    Array.isArray(r.references)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The director's road — dispatches
// ─────────────────────────────────────────────────────────────────────────────

export type ModelGenerationOutcome =
  | { readonly ok: true; readonly nodeId: string; readonly added: number }
  | { readonly ok: false; readonly reason: string; readonly nodeId?: string };

export interface ModelGenerationAsk {
  readonly prompt: string;
  readonly references?: readonly string[];
  readonly rig?: boolean;
  readonly count?: number;
  readonly seed?: number;
  readonly knobs?: ModelGenerationKnobs;
  /** The kept asset's name in the library; defaults to what the node asks for. */
  readonly name?: string;
}

/** Mint a `ModelGenerate` for `ask` (one undo entry) and run its variants. Never throws. */
export async function startModelGeneration(
  ask: ModelGenerationAsk,
): Promise<ModelGenerationOutcome> {
  const subject = subjectOf({ prompt: ask.prompt, references: ask.references ?? [] });
  let nodeId: string;
  try {
    const capability = await getModelCapability();
    const minted = mintModelGenerateOps({
      prompt: ask.prompt.trim(),
      references: ask.references ?? [],
      seed: ask.seed ?? chooseSeed(),
      provider: capability.id,
      rig: ask.rig ?? false,
      count: ask.count ?? DEFAULT_MODEL_VARIANTS,
      ...(ask.knobs ? { knobs: ask.knobs } : {}),
    });
    nodeId = minted.nodeId;
    useDagStore.getState().dispatchAtomic(minted.ops, 'user', `generate model: ${subject}`);
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generation failed: ${reason}`);
    return { ok: false, reason };
  }
  useModelGenerationStore.getState().setActive(nodeId);
  return runModelVariants(nodeId);
}

/** Regenerate: one more variant from the SAME node, with a seed it has not used. */
export function regenerateModel(nodeId: string): Promise<ModelGenerationOutcome> {
  return runModelVariants(nodeId, { count: 1 });
}

/**
 * Run `count` variants (default: the node's own `count`) of an existing node, adding a row to
 * the node as each arrives, so a slow run shows its variants one at a time. Never throws.
 */
export async function runModelVariants(
  nodeId: string,
  options: { readonly count?: number } = {},
): Promise<ModelGenerationOutcome> {
  const store = useModelGenerationStore.getState();
  const initial = modelGenerateParamsIn(useDagStore.getState().state, nodeId);
  if (!initial) return { ok: false, reason: `no Model generate node ${nodeId}`, nodeId };
  if (store.run) return { ok: false, reason: 'a generation is already running', nodeId };
  const total = options.count ?? initial.count;
  const subject = subjectOf(initial);
  store.startRun(nodeId, total);
  let added = 0;
  try {
    const capability = await getModelCapability();
    const { modelGenVersion } = useSettingsStore.getState();
    for (let i = 0; i < total; i += 1) {
      // Read fresh each time: an undo or an edit between variants is the graph's truth.
      const params = modelGenerateParamsIn(useDagStore.getState().state, nodeId);
      if (!params) throw new Error('the Model generate node was removed');
      const seed = nextVariantSeed(params);
      const variant = await produceVariant(nodeId, params, seed, capability, {
        modelVersion: modelGenVersion,
        onProgress: (p) => useModelGenerationStore.getState().progress(p),
      });
      const latest = modelGenerateParamsIn(useDagStore.getState().state, nodeId);
      if (!latest) throw new Error('the Model generate node was removed');
      useDagStore.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId,
            paramPath: 'variants',
            value: [...latest.variants, variant],
          },
        ],
        'user',
        `model variant: ${subject}`,
      );
      added += 1;
      useModelGenerationStore.getState().progress({ done: added, percent: 0 });
    }
    return { ok: true, nodeId, added };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `generation failed: ${reason}`);
    return { ok: false, reason, nodeId };
  } finally {
    useModelGenerationStore.getState().finishRun();
  }
}

/** Keep a variant: save it to the library and place it, as ONE undo entry. Never throws. */
export async function keepModelVariant(
  nodeId: string,
  seed: number,
): Promise<{ ok: true; opfsPath: string } | { ok: false; reason: string }> {
  const state = useDagStore.getState().state;
  const params = modelGenerateParamsIn(state, nodeId);
  const subject = params ? subjectOf(params) : nodeId;
  try {
    if (!params) throw new Error(`no Model generate node ${nodeId}`);
    if (!state.outputs.scene) throw new Error('the project has no scene output to place it in');
    const keep = await buildKeepVariantOps(state, nodeId, params, seed);
    useDagStore
      .getState()
      .dispatchAtomic(
        [
          { type: 'setParam', nodeId, paramPath: 'variants', value: keep.variants },
          ...keep.importOps,
        ],
        'user',
        `keep model: ${subject}`,
      );
    if (keep.notices.length > 0)
      console.warn(`kept model (${keep.opfsPath}):${leftBehindNotice(keep.notices)}`);
    useImportRefreshStore.getState().bump();
    return { ok: true, opfsPath: keep.opfsPath };
  } catch (err) {
    const reason = formatAssetError(err);
    useAssetErrorStore.getState().report(subject, `keep failed: ${reason}`);
    return { ok: false, reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The agent's road — returns ops, never dispatches (V7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a `ModelGenerate`, run ONE variant and keep it — all as ops for one Diff. The node is
 * added already holding the kept variant, so accepting the Diff lands the node and the model
 * together, and rejecting it lands neither (the bytes stay in the store, paid for).
 */
export async function buildGenerateAndKeepOps(
  state: DagState,
  capability: ModelGenerationCapability,
  ask: ModelGenerationAsk & { readonly modelVersion?: string },
): Promise<{ readonly ops: Op[]; readonly nodeId: string } & KeepVariantOps> {
  const seed = ask.seed ?? chooseSeed();
  const nodeId = mintNodeId();
  const params = modelGenerateParamsOf({
    prompt: ask.prompt.trim(),
    references: ask.references ?? [],
    seed,
    provider: capability.id,
    rig: ask.rig ?? false,
    count: 1,
    ...(ask.knobs ? { knobs: ask.knobs } : {}),
  });
  const variant = await produceVariant(nodeId, params, seed, capability, {
    modelVersion: ask.modelVersion,
  });
  const withVariant: ModelGenerateParams = { ...params, variants: [variant] };
  const keep = await buildKeepVariantOps(state, nodeId, withVariant, seed, ask.name);
  const addNode: Op = {
    type: 'addNode',
    nodeId,
    nodeType: 'ModelGenerate',
    params: { ...withVariant, variants: keep.variants },
  };
  return { ...keep, nodeId, ops: [addNode, ...keep.importOps] };
}
