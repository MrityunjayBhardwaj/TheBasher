// ComfyUIWorkflow — the impure node that drives ComfyUI-mediated
// stylization. Skeleton-only in Wave A: the evaluator returns metadata
// (an ImageValue with passKind 'stylized') with a sourceHash that
// encodes (presetId, prompt, upstream passes, time). Actual frame
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
// D-03 (locked): presetId is a closed enum. v0.5 ships only
// 'stylizedRealism'; v0.6 widens with meta-prompt-authored presets.
//
// D-04 (locked): outputPath default formula is
// `renders/${jobId}/stylized_${presetId}` — but jobId isn't known at
// node-definition time. The Mutator (Wave C) sets the literal path at
// build time; the schema default is empty string + `?? defaultValue`
// guard at any consumer.
//
// REF: THESIS §28, §44; project_p5_context D-01 / D-03 / D-04;
// vyapti V2 (impurity declared) + V8 (no dispatch from src/render/);
// dharana B7/B8 unchanged (no new identifier or Mutator surface).

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import {
  DEFAULT_IMAGE_DESCRIPTOR,
  type ImageValue,
  type PromptValue,
  type TimeValue,
} from './types';

/**
 * v0.5 ships exactly one preset (D-02 — stylizedRealism only). v0.6
 * widens via meta-prompt authoring; the enum tightens / widens with the
 * preset registry, not on its own.
 */
export const STYLIZED_PRESET_IDS = ['stylizedRealism'] as const;
export type StylizedPresetId = (typeof STYLIZED_PRESET_IDS)[number];

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
  presetId: z.enum(STYLIZED_PRESET_IDS).default('stylizedRealism'),
  /**
   * The imported workflow (design §6.2). Additive over the v0.5 preset model:
   * a node may carry a preset (legacy render path) AND/OR an imported graph (the
   * keyframe-compiler path). Defaults null so legacy projects load unchanged.
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
   * Storage path prefix. Mutator-authored at build time per D-04. Schema
   * default is empty so legacy projects don't crash; consumers `?? ''`
   * and refuse-with-error when path is missing at execute time.
   */
  outputPath: z.string().default(''),
  /**
   * Output descriptor — stylized output dimensions. Defaults to 1280x720
   * rgba8 to match raw passes; ComfyUI-side workflow JSON may upscale.
   */
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type ComfyUIWorkflowParams = z.infer<typeof ComfyUIWorkflowParams>;

export const ComfyUIWorkflowNode: NodeDefinition<ComfyUIWorkflowParams, ImageValue> = {
  type: 'ComfyUIWorkflow',
  version: 1,
  pure: false,
  cost: 'expensive',
  paramSchema: ComfyUIWorkflowParams,
  inputs: {
    prompt: { type: 'Prompt', cardinality: 'single' },
    /** Raw pass results consumed as ControlNet / img2img inputs. Socket
     *  name MUST equal the EdgeKind literal so per-kind closure BFS
     *  isolates pass siblings (H22). */
    'pass-input': { type: 'Image', cardinality: 'list' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  inspectorSections: ['render'],
  evaluate(params, inputs: ResolvedInputs): ImageValue {
    const prompt = inputs.prompt as PromptValue | undefined;
    const passes = (inputs['pass-input'] as ImageValue[] | undefined) ?? [];
    const time = inputs.time as TimeValue | undefined;
    return {
      kind: 'Image',
      passKind: 'stylized',
      descriptor: {
        // V10 guard — destructured fields default at the evaluator so a
        // legacy project missing width/height (added post-release) loads
        // without crash.
        width: params.width ?? DEFAULT_IMAGE_DESCRIPTOR.width,
        height: params.height ?? DEFAULT_IMAGE_DESCRIPTOR.height,
        format: 'rgba8',
      },
      sourceHash: hashValue({
        passKind: 'stylized',
        presetId: params.presetId ?? 'stylizedRealism',
        // The imported graph participates by its json: a different workflow (or
        // an edited literal) produces a different stylized frame. Bound keyframe
        // channels target this node externally (free-floating V57) — they are
        // folded at the decode/render site, not here, since evaluate sees only
        // params + inputs.
        graph: params.graph ?? null,
        // Image bindings participate: a different bound project image (or a cleared
        // binding) produces a different stylized frame. The bytes are uploaded +
        // the input rewritten at the decode/submit site; here only the binding map
        // discriminates the value.
        imageBindings: params.imageBindings ?? {},
        prompt: prompt ?? null,
        // Upstream pass results participate by sourceHash — different
        // beauty bytes produce different stylized bytes (parallels stub
        // capability's content-hash mixing).
        passes: passes.map((p) => ({
          passKind: p.passKind,
          sourceHash: p.sourceHash,
        })),
        time: time ?? null,
        // frameRange + lastGoodFrame intentionally NOT in the hash:
        // they describe a dispatch plan, not the per-frame value. Frame
        // identity is carried by the time socket; resume state is a
        // bookkeeping field on params, not a content discriminator.
      }),
    };
  },
};
