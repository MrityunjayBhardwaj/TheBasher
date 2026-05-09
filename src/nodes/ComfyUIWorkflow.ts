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

export const ComfyUIWorkflowParams = z.object({
  presetId: z.enum(STYLIZED_PRESET_IDS).default('stylizedRealism'),
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
