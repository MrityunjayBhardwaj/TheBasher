// comfyGraph — the PURE L3 data model for a Mode-B (vanilla) ComfyUI workflow. It has
// NO I/O and NO DAG dependency: it imports a ComfyUI API-format workflow JSON and
// enumerates its authored inputs as an animatable param manifest. This is a LEAN
// ENUMERATOR, not the retired inference compiler — it does NOT classify
// schedulable-vs-structural, inject schedule nodes, or rewire a foreign graph (that
// inference brittleness is gone, docs/COMFYUI-BASHER-NODES.md). A keyframed param is
// rendered by auto-injecting a basher_controller at submit time
// (basherControllers.injectBasherControllers) — the SAME transport an author-placed
// controller uses.
//
//   importComfyGraph(apiJson, meta) → { apiJson, params[], meta }
//     Walks every node's inputs; each LITERAL input (not a [nodeId, idx] link) becomes a
//     ComfyParam with an inferred valueKind. The Controls panel renders these: float/int/
//     string → keyframeable rows (whose keys auto-inject a controller); image/video →
//     media bind pickers; enum/bool/structural → read-only (isStructuralParam).
//
// Param addressing: the canonical key is `<nodeId>.<inputName>`; when it binds a V57
// channel it is namespaced `comfy:<nodeId>.<inputName>` (comfyParamPath) so resolvers
// don't collide with transform/material paths.
//
// REF: docs/COMFYUI-BASHER-NODES.md (the two-node contract); vyapti V81 (ComfyUI epic);
//      src/core/comfy/basherControllers.ts (the controller transport + auto-inject);
//      src/nodes/ComfyUIWorkflow.ts (the DAG node).

/** A single node in ComfyUI's API (`/prompt`) format. `inputs` values are
 *  either a LITERAL (number/string/bool) or a LINK `[nodeId, outputIdx]`. */
export interface ComfyNodeJson {
  readonly class_type: string;
  readonly inputs: Record<string, ComfyInputValue>;
  /** ComfyUI carries optional UI metadata (`_meta.title`); kept verbatim. */
  readonly _meta?: { title?: string };
}

/** An input is a literal value or a link `[nodeId, outputIndex]`. */
export type ComfyInputValue = number | string | boolean | ComfyLink;
export type ComfyLink = readonly [string, number];

/** The verbatim API-format graph, keyed by node id. */
export type ComfyApiJson = Record<string, ComfyNodeJson>;

/** A link is a 2-tuple `[nodeId, outputIdx]`: first element a string id,
 *  second a number. Distinguishes a link from a literal value. */
export function isComfyLink(v: ComfyInputValue): v is ComfyLink {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

export type ComfyValueKind = 'float' | 'int' | 'string' | 'bool' | 'image' | 'video' | 'enum';

/** One animatable parameter discovered in an imported workflow. */
export interface ComfyParam {
  /** Node id in the API json (e.g. "3"). */
  readonly nodeId: string;
  /** Input name on that node (e.g. "cfg"). */
  readonly inputName: string;
  /** The node's class (for UI grouping + the controller kind on auto-inject). */
  readonly classType: string;
  readonly valueKind: ComfyValueKind;
  /** The authored literal — the "rest pose" used when no channel is bound. */
  readonly literal: number | string | boolean;
}

export interface ComfyGraphMeta {
  readonly name: string;
  readonly importedAt: string;
  readonly fps: number;
  readonly frames: number;
}

export interface ComfyGraph {
  /** Verbatim API json — the compile substrate (deep-cloned on compile). */
  readonly apiJson: ComfyApiJson;
  /** The derived animatable manifest (every literal input). */
  readonly params: readonly ComfyParam[];
  readonly meta: ComfyGraphMeta;
}

// ---------------------------------------------------------------------------
// valueKind inference — JS type first, refined by a small node-schema table.
// ---------------------------------------------------------------------------

/** `classType.inputName` → a fixed valueKind, overriding the JS-type guess.
 *  Seeded from the SD1.5/SDXL core nodes; grows by observation. */
const PARAM_KIND_TABLE: Record<string, ComfyValueKind> = {
  'KSampler.seed': 'int',
  'KSampler.steps': 'int',
  'KSampler.cfg': 'float',
  'KSampler.denoise': 'float',
  'KSampler.sampler_name': 'enum',
  'KSampler.scheduler': 'enum',
  'CLIPTextEncode.text': 'string',
  'CheckpointLoaderSimple.ckpt_name': 'enum',
  'EmptyLatentImage.width': 'int',
  'EmptyLatentImage.height': 'int',
  'EmptyLatentImage.batch_size': 'int',
  'LoadImage.image': 'image',
  // LoadVideo (the io.ComfyNode v3 node, comfy_extras) takes a `file` input + emits
  // VIDEO — a media bind, like LoadImage.image, so the inferred manifest gives it a
  // project-video picker (the Mode-B video-in path, docs/COMFYUI-BASHER-NODES.md).
  'LoadVideo.file': 'video',
  'ControlNetApply.strength': 'float',
  'ControlNetApplyAdvanced.strength': 'float',
};

function inferValueKind(
  classType: string,
  inputName: string,
  literal: number | string | boolean,
): ComfyValueKind {
  const tabled = PARAM_KIND_TABLE[`${classType}.${inputName}`];
  if (tabled) return tabled;
  if (typeof literal === 'boolean') return 'bool';
  if (typeof literal === 'number') return Number.isInteger(literal) ? 'int' : 'float';
  // A string that names a video container is a video input; an image file an image
  // input (a media bind in both cases); otherwise plain text. Video sniffs first so a
  // `.mp4` isn't mis-read as plain text.
  if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(literal)) return 'video';
  if (/\.(png|jpe?g|webp|gif)$/i.test(literal)) return 'image';
  return 'string';
}

// ---------------------------------------------------------------------------
// structural-param hint — a pure UI read-only marker (NOT a compile decision).
// ---------------------------------------------------------------------------

/** Params whose change alters graph TOPOLOGY or batch shape — they can't be driven as
 *  a per-frame channel, so the Controls panel shows them read-only. Keyed
 *  `classType.inputName`. */
const STRUCTURAL_PARAMS = new Set<string>([
  'CheckpointLoaderSimple.ckpt_name', // swapping the model reloads the graph
  'KSampler.sampler_name', // sampler TYPE is structural; its scalars are not
  'KSampler.scheduler',
  'EmptyLatentImage.width', // resolution changes the latent shape
  'EmptyLatentImage.height',
  'EmptyLatentImage.batch_size', // the batch size IS the schedule length
]);

/** True iff a param changes graph TOPOLOGY or batch shape (resolution / checkpoint /
 *  sampler type) — it can't be driven as a per-frame channel, so the Controls panel
 *  shows it read-only. A pure UI hint, keyed `classType.inputName`. */
export function isStructuralParam(classType: string, inputName: string): boolean {
  return STRUCTURAL_PARAMS.has(`${classType}.${inputName}`);
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/** Build a ComfyGraph from a verbatim API-format workflow JSON: keep the json
 *  as the compile substrate, and derive the animatable param manifest (every
 *  LITERAL input becomes a candidate, sorted by nodeId then inputName for a
 *  stable, snapshot-friendly order). Links are skipped — they are wired, not
 *  authored. */
export function importComfyGraph(apiJson: ComfyApiJson, meta: ComfyGraphMeta): ComfyGraph {
  const params: ComfyParam[] = [];
  for (const nodeId of Object.keys(apiJson)) {
    const node = apiJson[nodeId];
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    for (const inputName of Object.keys(node.inputs)) {
      const value = node.inputs[inputName];
      if (isComfyLink(value)) continue; // wired input — not an authored literal
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean')
        continue;
      const valueKind = inferValueKind(node.class_type, inputName, value);
      params.push({
        nodeId,
        inputName,
        classType: node.class_type,
        valueKind,
        literal: value,
      });
    }
  }
  params.sort((a, b) =>
    a.nodeId === b.nodeId
      ? a.inputName.localeCompare(b.inputName)
      : a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }),
  );
  return { apiJson, params, meta };
}

// ---------------------------------------------------------------------------
// param addressing
// ---------------------------------------------------------------------------

/** The namespaced V57 paramPath for a workflow param: `comfy:<nodeId>.<input>`
 *  (design §6.3). Distinct from transform/material paths so resolvers don't
 *  collide. */
export function comfyParamPath(nodeId: string, inputName: string): string {
  return `comfy:${nodeId}.${inputName}`;
}

/** Inverse of comfyParamPath. Returns null if the path is not a comfy param. */
export function parseComfyParamPath(path: string): { nodeId: string; inputName: string } | null {
  if (!path.startsWith('comfy:')) return null;
  const rest = path.slice('comfy:'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot >= rest.length - 1) return null;
  return { nodeId: rest.slice(0, dot), inputName: rest.slice(dot + 1) };
}
