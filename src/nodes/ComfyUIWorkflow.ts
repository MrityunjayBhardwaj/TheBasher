// ComfyUIWorkflow — the impure node that drives ComfyUI-mediated
// stylization. Skeleton-only in Wave A: the evaluator returns metadata
// (an ImageValue with passKind 'stylized') with a sourceHash that
// encodes (workflow file, inputs, time). Actual frame
// production happens in src/render/runComfyUIWorkflow.ts (Wave B); the
// V8 file-rooted dispatch rule keeps this evaluator pure of network /
// filesystem I/O.
//
// pure: false. Sister to RenderJob's pure-flag policy — only impure nodes
// describe side-effecting operations. The evaluator is still bit-exact
// reproducible given (params, inputs, time): the impurity declaration
// only signals "this node's value is the description of an action that
// produces files," not "this evaluator reads clocks."
//
// D-01 (locked): output flows over the existing 'Image' socket; passKind
// is 'stylized'. No new EdgeKind — 'pass-input' is reused for both raw
// and stylized output. H22 isolation rule already proven on this kind.
//
// #1715: no preset. The node runs the workflow FILE it holds (`graph`), and its sockets are
// that file's Basher markers, read by ONE function (`socketsOfWorkflow`) through the
// `instanceSockets` hook: each input marker an input (still image, frames, number or text),
// each output marker an output (still image or frames). Number and text inputs are keyable
// through `controller:<nodeId>`. The old closed preset enum migrated to this node carrying the
// preset's workflow file (format v31, `migratePresetsToWorkflowFiles`).
//
// D-04 (locked): outputPath default formula is
// `renders/${jobId}/stylized_<name>` — but jobId isn't known at
// node-definition time. The Mutator (Wave C) sets the literal path at
// build time; the schema default is empty string + `?? defaultValue`
// guard at any consumer.
//
// REF: THESIS §28, §44; project_p5_context D-01 / D-03 / D-04;
// vyapti V2 (impurity declared) + V8 (no dispatch from src/render/);
// dharana B7/B8 unchanged (no new identifier or Mutator surface).

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import type {
  ImageExtent,
  InputDescriptor,
  InstanceSockets,
  NodeDefinition,
  OutputDescriptor,
  ResolvedInputs,
} from '../core/dag/types';
import type { ComfyApiJson } from '../core/comfy/comfyGraph';
import { socketsOfWorkflow, type WorkflowSockets } from '../core/comfy/workflowSockets';
import { framePath, outputPathOf } from '../core/comfy/workflowPaths';
import { DEFAULT_IMAGE_DESCRIPTOR, type ImageValue, type TimeValue } from './types';
import { widget } from './paramWidget';

/**
 * An imported ComfyUI workflow carried by the node (design §6.2 — the evolution
 * of the preset-only model). Stored as the verbatim API json + meta; the
 * animatable param manifest is DERIVED on read via importComfyGraph (never
 * stored, so it can't go stale against the json). `null` = legacy / preset-only
 * node with no imported graph. apiJson is `unknown`-keyed so we don't lock into a
 * ComfyUI schema version (the format evolves with releases).
 */
export const ComfyGraphParamSchema = z
  .object({
    apiJson: z.record(z.string(), z.unknown()),
    meta: z.object({
      name: z.string(),
      importedAt: z.string(),
      fps: z.number(),
      frames: z.number(),
    }),
  })
  .nullable();
export type ComfyGraphParam = z.infer<typeof ComfyGraphParamSchema>;

export const ComfyUIWorkflowParams = z.object({
  /**
   * #1715 — the workflow FILE this node runs. Its Basher markers are the node's sockets
   * (`workflowSocketsOf`); null = no file picked yet, so no sockets.
   */
  graph: ComfyGraphParamSchema.default(null),
  /**
   * Static image-input bindings (the generic image-source affordance, COMPOSITOR
   * §7.1). A map from a comfy image param key `"<nodeId>.<inputName>"` (an
   * 'image'-valueKind input, e.g. a LoadImage.image) to the OPFS path of a project
   * image (a `MediaClip` mediaKind:'image' src, or one uploaded through the picker).
   * At /prompt submit the decode reads those bytes, uploads them to ComfyUI under a
   * stable filename, and rewrites the bound input to reference it. Default {} so
   * legacy projects load unchanged. Deliberately NOT ControlNet-specific — every
   * image input uses the same generic binding.
   */
  imageBindings: z.record(z.string(), z.string()).default({}),
  /**
   * Inclusive frame range. Defaults match RenderJob's 0..60 @ 30fps so
   * a fresh ComfyUIWorkflow on a fresh RenderJob produces parallel
   * frame counts without per-node coordination.
   */
  frameStart: z.number().int().nonnegative().default(0),
  frameEnd: z.number().int().nonnegative().default(60),
  /**
   * Resume sentinel. -1 means "start from frameStart"; any value >=0
   * means "the next execute pass starts at lastGoodFrame + 1." Wave B's
   * runComfyUIWorkflow reads + writes this field via Op dispatched
   * from a CALLER (V8: never from inside src/render/).
   */
  lastGoodFrame: z.number().int().default(-1),
  /**
   * #1718 — what the node's pictures were made from when they last landed (written by the app's
   * run road, never here). Null until a run lands. A node whose current hash differs is stale
   * (`workflowMadeState`). Since #1717 the hash is the app's `workflowMadeFrom`: the file, the
   * image bindings and every input over EVERY frame the node makes, with render passes read as the
   * render draws them, so an edit upstream (a still's prompt) reaches every workflow it feeds by
   * the wire alone, and a camera move mid-shot reaches the shot. Defaulted, so an older project
   * loads as never made.
   */
  madeFrom: z.string().nullable().default(null),
  /**
   * Storage path prefix. Mutator-authored at build time per D-04. Schema
   * default is empty so legacy projects don't crash; consumers `?? ''`
   * and refuse-with-error when path is missing at execute time.
   */
  outputPath: widget('text', z.string().default('')),
  /**
   * Output descriptor — stylized output dimensions. Defaults to 1280x720
   * rgba8 to match raw passes; ComfyUI-side workflow JSON may upscale.
   */
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type ComfyUIWorkflowParams = z.infer<typeof ComfyUIWorkflowParams>;

/** #1715 — the node id of the WHOLE-WORKFLOW output: a file that declares no Basher output is
 *  collected whole (every image it saves), as Basher has always read such a file
 *  (`hasBasherExports` false → "all output images → one clip"). Not a node of the file. */
export const WHOLE_WORKFLOW_OUTPUT = '*';

const wholeWorkflow = new WeakMap<WorkflowSockets, WorkflowSockets>();

/**
 * #1715 — the sockets of a workflow node holding `params`: its file's Basher markers
 * (`socketsOfWorkflow`). The one door every reader comes through (the node's `instanceSockets`,
 * the runner, the inspector, the agent).
 *
 * One addition, and it is not read off the file: a file that declares NO Basher output still
 * makes pictures (its SaveImage nodes), and Basher collects them whole, as it always has. That
 * file's node has one still output `out` standing for the whole workflow, so a vanilla workflow
 * keeps feeding a compositor layer. It goes the moment the file declares any output.
 */
export function workflowSocketsOf(params: unknown): WorkflowSockets {
  const graph = (params as Partial<ComfyUIWorkflowParams> | null | undefined)?.graph;
  const apiJson = (graph?.apiJson as ComfyApiJson | undefined) ?? null;
  const sockets = socketsOfWorkflow(apiJson);
  if (!apiJson || sockets.outputs.length > 0) return sockets;
  let whole = wholeWorkflow.get(sockets);
  if (!whole) {
    whole = {
      ...sockets,
      outputs: [{ socket: 'out', nodeId: WHOLE_WORKFLOW_OUTPUT, type: 'still' }],
    };
    wholeWorkflow.set(sockets, whole);
  }
  return whole;
}

/** #1716 — a frames output covers frameStart..frameEnd at the project's 30 fps (the cadence the
 *  runner renders at); a still output is one picture. */
function outputExtent(
  type: 'still' | 'frames',
  params: Partial<ComfyUIWorkflowParams>,
): ImageExtent {
  if (type === 'still') return { kind: 'still' };
  return {
    kind: 'frames',
    range: { start: params.frameStart ?? 0, end: params.frameEnd ?? 60, fps: 30 },
  };
}

/** The `instanceSockets` of a workflow node: its markers as Basher sockets. A still image input
 *  takes a still, a frames input frames (#1716's arrival rule), a number a Number, text a String
 *  or a Prompt (whose text it reads). Cached by the derivation (per file). */
const descriptors = new WeakMap<WorkflowSockets, InstanceSockets>();
function workflowInstanceSockets(params: unknown): InstanceSockets {
  const sockets = workflowSocketsOf(params);
  const known = descriptors.get(sockets);
  if (known) return known;
  const inputs: Record<string, InputDescriptor> = {};
  for (const i of sockets.inputs) {
    inputs[i.socket] =
      i.type === 'number'
        ? { type: 'Number', cardinality: 'single' }
        : i.type === 'text'
          ? { type: ['String', 'Prompt'], cardinality: 'single' }
          : { type: 'Image', cardinality: 'single', takes: i.type };
  }
  const outputs: Record<string, OutputDescriptor> = {};
  for (const o of sockets.outputs) outputs[o.socket] = { type: 'Image', cardinality: 'single' };
  const result = { inputs, outputs };
  descriptors.set(sockets, result);
  return result;
}

/** What arrives on a text socket, as text: a String, or a Prompt's `text`. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'Prompt')
    return String((value as { text?: unknown }).text ?? '');
  return null;
}

export const ComfyUIWorkflowNode: NodeDefinition<ComfyUIWorkflowParams, ImageValue> = {
  type: 'ComfyUIWorkflow',
  version: 1,
  pure: false,
  cost: 'expensive',
  paramSchema: ComfyUIWorkflowParams,
  mainInput: null,
  // #1715 — every other input and output comes from the workflow file.
  inputs: {
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: {},
  instanceSockets: workflowInstanceSockets,
  inspectorSections: ['render'],
  home: {
    frameStart: 'render',
    frameEnd: 'render',
    outputPath: 'render',
  },
  evaluate(params, inputs: ResolvedInputs): Record<string, ImageValue> {
    const sockets = workflowSocketsOf(params);
    const time = inputs.time as TimeValue | undefined;
    // Every wired input participates: an image by its source hash (different beauty bytes
    // make different stylized bytes), a number or text by its value. Keyed number/text values
    // live on channels off the graph (`controller:<nodeId>`); they are folded where the file
    // is submitted, not here, since evaluate sees only params + inputs.
    const arrived = sockets.inputs.map((i) => {
      const v = inputs[i.socket];
      if (v === undefined) return [i.socket, null];
      if (i.type === 'still' || i.type === 'frames') {
        const img = v as ImageValue;
        return [i.socket, { passKind: img.passKind, sourceHash: img.sourceHash }];
      }
      return [i.socket, i.type === 'text' ? textOf(v) : v];
    });
    // A still-only workflow is run once, so the time does not pick its picture (#1716): hashing
    // it would make one still a different image at every frame. Any frames output renders
    // each frame from that frame's time.
    const anyFrames = sockets.outputs.some((o) => o.type === 'frames');
    const out: Record<string, ImageValue> = {};
    for (const o of sockets.outputs) {
      out[o.socket] = {
        kind: 'Image',
        passKind: 'stylized',
        descriptor: {
          // V10 guard — a project missing width/height (added post-release) loads.
          width: params.width ?? DEFAULT_IMAGE_DESCRIPTOR.width,
          height: params.height ?? DEFAULT_IMAGE_DESCRIPTOR.height,
          format: 'rgba8',
        },
        sourceHash: hashValue({
          passKind: 'stylized',
          output: o.socket,
          // The file participates whole: a different workflow (or an edited literal) is a
          // different picture.
          graph: params.graph ?? null,
          imageBindings: params.imageBindings ?? {},
          inputs: arrived,
          time: anyFrames ? (time ?? null) : null,
          // frameRange + lastGoodFrame intentionally NOT in the hash: they describe a
          // dispatch plan, not the per-frame value.
        }),
        extent: outputExtent(o.type, params),
        // #1718 — a still lands as one file, at its first frame's path (the runner runs a
        // still-only workflow there, #1946), so a workflow it is wired into reads it from there:
        // one workflow's still into another's still input is just a wire.
        ...(o.type === 'still' && params.outputPath
          ? {
              storedAt: framePath(
                outputPathOf(params.outputPath, sockets, o.socket),
                params.frameStart ?? 0,
              ),
            }
          : {}),
      };
    }
    return out;
  },
};
