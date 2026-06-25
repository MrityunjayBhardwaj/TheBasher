// comfyGraph — the PURE L3 data model for the keyframe-driven ComfyUI compiler
// (COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.1 + §7). It has NO I/O and NO DAG
// dependency: it imports a ComfyUI API-format workflow JSON, derives the
// animatable param manifest, and compiles a per-frame PREVIEW graph by value
// substitution. This is the novel IP (the timeline → schedule compiler's
// authoring half) and — being pure — it is fully snapshot-testable WITHOUT a
// GPU or a running server (design §15: "snapshot the compiled workflow JSON").
//
// Two stages live here:
//   importComfyGraph(apiJson, meta) → { apiJson, params[], meta }
//     Walks every node's inputs; each LITERAL input (not a [nodeId, idx] link)
//     becomes a candidate animatable ComfyParam with an inferred valueKind +
//     a scheduleHint (SCHEDULABLE vs STRUCTURAL — design §7.4; never silently
//     drop a structural param, the consumer logs a demotion).
//   compilePreviewFrame(graph, tracks, frame) → apiJson'
//     Deep-clones the verbatim apiJson and substitutes each baked track's
//     value-at-frame into apiJson[nodeId].inputs[inputName] (design §7.2 — the
//     generalization of stylizedRealism.compile() from {prompt,passes} to
//     arbitrary params). The COMPILED batched path (the bridge node, §7.3) is
//     a later increment; this is the per-frame preview path.
//
// Param addressing (design §6.1): the canonical key is `<nodeId>.<inputName>`;
// when it binds a V57 channel it is namespaced `comfy:<nodeId>.<inputName>`
// (comfyParamPath) so resolvers don't collide with transform/material paths.
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.1, §7.1, §7.2, §7.4;
//      vyapti V81 (ComfyUI epic); src/nodes/ComfyUIWorkflow.ts (the DAG node).

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

export type ComfyValueKind = 'float' | 'int' | 'string' | 'bool' | 'image' | 'enum';

/** Can this param be scheduled IN-GRAPH for the coherent batched path, or only
 *  varied across independent preview runs? (design §7.4). The compiler logs a
 *  demotion for any STRUCTURAL param a user keyframes — never a silent drop. */
export type ScheduleHint = 'schedulable' | 'structural' | 'unknown';

/** One animatable parameter discovered in an imported workflow. */
export interface ComfyParam {
  /** Node id in the API json (e.g. "3"). */
  readonly nodeId: string;
  /** Input name on that node (e.g. "cfg"). */
  readonly inputName: string;
  /** The node's class (for UI grouping + compile dispatch). */
  readonly classType: string;
  readonly valueKind: ComfyValueKind;
  /** The authored literal — the "rest pose" used when no channel is bound. */
  readonly literal: number | string | boolean;
  readonly scheduleHint: ScheduleHint;
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
  // A string that names an image file is an image input; otherwise plain text.
  if (/\.(png|jpe?g|webp|gif)$/i.test(literal)) return 'image';
  return 'string';
}

// ---------------------------------------------------------------------------
// scheduleHint — SCHEDULABLE vs STRUCTURAL (design §7.4).
// ---------------------------------------------------------------------------

/** Params whose change alters graph TOPOLOGY or batch shape — they cannot be a
 *  per-batch schedule, so the compiled path can't animate them (only the
 *  preview path's independent runs can). Keyed `classType.inputName`. */
const STRUCTURAL_PARAMS = new Set<string>([
  'CheckpointLoaderSimple.ckpt_name', // swapping the model reloads the graph
  'KSampler.sampler_name', // sampler TYPE is structural; its scalars are not
  'KSampler.scheduler',
  'EmptyLatentImage.width', // resolution changes the latent shape
  'EmptyLatentImage.height',
  'EmptyLatentImage.batch_size', // the batch size IS the schedule length
]);

function scheduleHintFor(
  classType: string,
  inputName: string,
  valueKind: ComfyValueKind,
): ScheduleHint {
  if (STRUCTURAL_PARAMS.has(`${classType}.${inputName}`)) return 'structural';
  // Known schedulable shapes: numeric scalars, prompt text, reference images.
  if (
    valueKind === 'float' ||
    valueKind === 'int' ||
    valueKind === 'string' ||
    valueKind === 'image'
  )
    return 'schedulable';
  return 'unknown';
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
        scheduleHint: scheduleHintFor(node.class_type, inputName, valueKind),
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

// ---------------------------------------------------------------------------
// preview compile (per-frame value substitution, design §7.2)
// ---------------------------------------------------------------------------

/** A param's curve baked to one value per frame over the batch range (design
 *  §7.1). Image values are referenced by their (already-uploaded) filename. */
export interface BakedTrack {
  readonly nodeId: string;
  readonly inputName: string;
  readonly values: readonly (number | string | boolean)[];
}

/**
 * Compile ONE preview frame: deep-clone the verbatim graph and substitute each
 * baked track's value-at-`frame` into `apiJson[nodeId].inputs[inputName]`. A
 * track whose node/input no longer exists, or whose `frame` index is out of
 * range, is skipped (the graph keeps its authored literal). Returns a fresh
 * graph — the input is never mutated, so N frames compile independently.
 *
 * This is the per-frame PREVIEW path (N independent /prompt graphs). The
 * coherent batched path (one workflow + schedule bridge nodes) is design §7.3,
 * a later increment.
 */
export function compilePreviewFrame(
  graph: ComfyGraph,
  tracks: readonly BakedTrack[],
  frame: number,
): ComfyApiJson {
  // structuredClone is available in the browser + Node 17+ (the test runtime).
  const out = structuredClone(graph.apiJson) as ComfyApiJson;
  for (const track of tracks) {
    if (frame < 0 || frame >= track.values.length) continue;
    const node = out[track.nodeId];
    if (!node || !node.inputs || isComfyLink(node.inputs[track.inputName])) continue;
    (node.inputs as Record<string, ComfyInputValue>)[track.inputName] = track.values[frame];
  }
  return out;
}
