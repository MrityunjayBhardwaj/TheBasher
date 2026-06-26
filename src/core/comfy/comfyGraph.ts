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

// ---------------------------------------------------------------------------
// compiled batched path (the coherent path, design §7.3) — the bridge nodes
// ---------------------------------------------------------------------------

/** The custom ComfyUI node types Basher's compiler emits to carry a baked
 *  per-frame array IN-GRAPH (design §7.3). These are a SEPARATE GPL/MIT ComfyUI
 *  extension (`custom_nodes/BasherSchedule/`) installed in the user's ComfyUI —
 *  NEVER vendored into Basher's proprietary core (design §3). Basher only emits
 *  their JSON shape (type name + inputs) and detects their presence via
 *  `/object_info`; the Python is authored arm's-length. Keyed by the param's
 *  valueKind so the compiler dispatches the right batch-aware variant. */
export const BASHER_SCHEDULE_NODE_TYPES = {
  float: 'BasherValueSchedule',
  int: 'BasherValueSchedule',
  string: 'BasherPromptSchedule',
  image: 'BasherImageSchedule',
} as const satisfies Partial<Record<ComfyValueKind, string>>;

/** The full set of node-type names the bridge extension must provide — used by
 *  presence detection (`hasBasherScheduleNodes`, design §16 Q-E). */
export const BASHER_SCHEDULE_NODE_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(BASHER_SCHEDULE_NODE_TYPES),
);

/** A param's curve baked to a value PER FRAME over the whole batch range (design
 *  §7.1), plus the node-class + valueKind needed to pick the schedule variant and
 *  decide whether it can be scheduled in-graph at all. Length of `values` = N. */
export interface BatchedTrack {
  readonly nodeId: string;
  readonly inputName: string;
  readonly classType: string;
  readonly valueKind: ComfyValueKind;
  readonly values: readonly (number | string | boolean)[];
}

/** A param the compiled path could NOT schedule in-graph, with the reason. The
 *  compiler keeps its first-frame literal (the rest pose) and NEVER silently
 *  drops it — the caller logs every demotion (design §7.4: "silent truncation
 *  reads as 'it all animates' when it doesn't"). */
export interface ScheduleDemotion {
  readonly nodeId: string;
  readonly inputName: string;
  readonly reason: 'structural' | 'unsupported-kind' | 'wired-input';
}

export interface CompiledBatch {
  /** The compiled batched workflow: schedule nodes inserted, animated inputs
   *  rewired to read them, batch size set to N. Openable in ComfyUI (the schedule
   *  nodes are right there — design §12 milestone). The source graph is untouched. */
  readonly apiJson: ComfyApiJson;
  /** Params demoted to preview-only (kept as literal) — never silent (§7.4). */
  readonly demotions: readonly ScheduleDemotion[];
  /** The schedule node ids inserted, in track order (for tests/inspection). */
  readonly scheduleNodeIds: readonly string[];
  /** The batch length N (frameEnd - frameStart + 1). */
  readonly frameCount: number;
}

/** A stable, ComfyUI-safe id for the schedule node injected for one param.
 *  Deterministic (not a counter) so the compiled JSON snapshots reproducibly and
 *  the node is recognisable when the workflow opens in ComfyUI. */
function scheduleNodeId(nodeId: string, inputName: string): string {
  return `bsched_${nodeId}_${inputName}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Compile the COHERENT BATCHED path (design §7.3): bake each animated param into
 * one workflow that ComfyUI runs as a single batch, so an in-graph temporal model
 * (AnimateDiff context windows for SD1.5, native video models for modern stacks)
 * can keep the sequence coherent — unlike the preview path's N independent runs.
 *
 * For each SCHEDULABLE float/int track: insert a `BasherValueSchedule` carrying
 * the baked array and rewire the param's input to read it (`inputs[name] =
 * [scheduleId, 0]`) — the FizzNodes BatchValueSchedule model, except the schedule
 * is baked by Basher's curve editor, not a text DSL (§7.3). The batch size of
 * every `EmptyLatentImage` is set to N so the latent batch length matches.
 *
 * What is NOT scheduled in-graph here (kept as the first-frame literal + reported
 * in `demotions`, NEVER silently dropped — §7.4):
 *   - STRUCTURAL params (resolution / ckpt / sampler type) — can't be a per-batch
 *     value; only the preview path's separate runs can vary them.
 *   - string (prompt-travel) + image (reference-travel) — these are genuine
 *     producer-replacement rewires (a CONDITIONING / IMAGE batch must replace the
 *     CLIPTextEncode / LoadImage output and every consumer of it), validated
 *     against a real AnimateDiff+IPAdapter workflow (needs models); the node-type
 *     dispatch table is in place (`BASHER_SCHEDULE_NODE_TYPES`) for that increment.
 *   - tracks pointing at a now-wired input (the graph was edited) — `wired-input`.
 *
 * PURE: deep-clones the graph; the input is never mutated. The IP, GPU-free and
 * fully snapshot-testable (design §15).
 */
export function compileBatchedWorkflow(
  graph: ComfyGraph,
  tracks: readonly BatchedTrack[],
  opts: { readonly frameCount: number },
): CompiledBatch {
  const out = structuredClone(graph.apiJson) as ComfyApiJson;
  const frameCount = Math.max(1, Math.floor(opts.frameCount));
  const demotions: ScheduleDemotion[] = [];
  const scheduleNodeIds: string[] = [];

  for (const track of tracks) {
    const target = out[track.nodeId];
    // The graph was edited and this input is now wired — keep the wired link.
    if (!target || !target.inputs || isComfyLink(target.inputs[track.inputName])) {
      demotions.push({ nodeId: track.nodeId, inputName: track.inputName, reason: 'wired-input' });
      continue;
    }
    const hint = scheduleHintFor(track.classType, track.inputName, track.valueKind);
    if (hint === 'structural') {
      demotions.push({ nodeId: track.nodeId, inputName: track.inputName, reason: 'structural' });
      continue;
    }
    // Only float/int get an in-graph schedule in this increment (the validated
    // FizzNodes input-literal-rewire). string/image are producer-replacement — a
    // later increment; demote them honestly rather than emit a node that won't run.
    if (track.valueKind !== 'float' && track.valueKind !== 'int') {
      demotions.push({
        nodeId: track.nodeId,
        inputName: track.inputName,
        reason: 'unsupported-kind',
      });
      continue;
    }
    // A CONSTANT track (unbound param, or a channel holding a flat value) needs no
    // schedule node — substitute the literal and move on. This keeps an un-animated
    // render a PLAIN workflow that runs WITHOUT the BasherSchedule extension installed
    // (only a genuinely-animated param requires the bridge node — design §16 Q-E).
    if (track.values.length > 0 && track.values.every((v) => v === track.values[0])) {
      (target.inputs as Record<string, ComfyInputValue>)[track.inputName] = track.values[0];
      continue;
    }
    const schedId = scheduleNodeId(track.nodeId, track.inputName);
    out[schedId] = {
      class_type: BASHER_SCHEDULE_NODE_TYPES[track.valueKind],
      inputs: {
        values_json: JSON.stringify(track.values),
        frame_count: frameCount,
      },
      _meta: { title: `Basher Schedule: ${track.nodeId}.${track.inputName}` },
    };
    (target.inputs as Record<string, ComfyInputValue>)[track.inputName] = [schedId, 0];
    scheduleNodeIds.push(schedId);
  }

  // Match the latent batch length to N so the scheduled arrays line up with the
  // batch index. EmptyLatentImage.batch_size is the canonical knob; an img2img /
  // video workflow with no EmptyLatentImage supplies its own batch dimension (the
  // temporal/context node) and is left untouched.
  for (const nodeId of Object.keys(out)) {
    const node = out[nodeId];
    if (
      node?.class_type === 'EmptyLatentImage' &&
      node.inputs &&
      !isComfyLink(node.inputs.batch_size)
    )
      (node.inputs as Record<string, ComfyInputValue>).batch_size = frameCount;
  }

  return { apiJson: out, demotions, scheduleNodeIds, frameCount };
}
