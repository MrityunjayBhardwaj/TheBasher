// Prompt — pure data node carrying the user's stylization intent for a
// ComfyUIWorkflow downstream consumer. Same shape as BoneNameMap (no
// inputs, params verbatim out). One Prompt may feed many workflows.
//
// All three params (`text`, `negative`, `tags`) ship now even though
// stylizedRealism v0.5 only uses `text`. Adding them later would re-trip
// H14 (hydrate seam bypasses zod default-fill); paying for the schema
// breadth up front means projects authored against v0.5 don't crash when
// future presets reach for `negative` or `tags`.
//
// REF: project_p5_context D-01 (Prompt is pure: true; sister to RenderJob's
// pure-flag policy); THESIS §28, §44.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { PromptValue } from './types';

export const PromptParams = z.object({
  text: z.string().default(''),
  negative: z.string().default(''),
  tags: z.array(z.string()).default([]),
});
export type PromptParams = z.infer<typeof PromptParams>;

export const PromptNode: NodeDefinition<PromptParams, PromptValue> = {
  type: 'Prompt',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: PromptParams,
  inputs: {},
  outputs: { out: { type: 'Prompt', cardinality: 'single' } },
  inspectorSections: ['render'],
  evaluate(params) {
    // V10 guard: defensive defaults at the evaluator. The hydrate seam
    // can land params lacking `negative` / `tags` for projects saved
    // before those fields existed; `?? default` keeps load-time crashes
    // out of v0.5.
    return {
      kind: 'Prompt',
      text: params.text ?? '',
      negative: params.negative ?? '',
      tags: params.tags ?? [],
    };
  },
};
