// ClipSelect — pick one TransformClipValue out of N by name (issue #81).
//
// A glTF file frequently carries multiple animations (walk / run / idle).
// The importer (Wave D) emits one TransformClip node per glTF animation;
// ClipSelect is the fan-in that picks one of them by `selectedClipName`
// and exposes it on a single output socket so the rest of the DAG (and
// the renderer) talks to a stable single connection.
//
// Semantics (locked in CONTEXT.md D-06):
//   - Inputs: `clips` is a list of TransformClipValue (cardinality 'list',
//     same shape AnimationLayer uses at AnimationLayer.ts:53).
//   - Output: the matching TransformClipValue, OR `null` when no clip's
//     `name` equals `selectedClipName`. The null-on-miss is a deliberate
//     surface (not a fallback to the first clip) — it makes the
//     "selected clip is gone" state visible to the renderer.
//   - Pure: output is a function of (params, inputs.clips). V2 holds.
//
// Single-clip glTFs still emit a ClipSelect — uniform data-flow shape
// across single-clip and multi-clip imports (no "if N=1, skip the
// selector" special case, which would bite as soon as someone added a
// second animation).
//
// REF: CONTEXT.md D-06; RESEARCH § "ClipSelect node shape"; issue #81.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { TransformClipValue } from './types';

export const ClipSelectParams = z.object({
  selectedClipName: z.string().default(''),
});
export type ClipSelectParams = z.infer<typeof ClipSelectParams>;

export const ClipSelectNode: NodeDefinition<ClipSelectParams, TransformClipValue | null> = {
  type: 'ClipSelect',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ClipSelectParams,
  inputs: {
    clips: { type: 'TransformClip', cardinality: 'list' },
  },
  outputs: { out: { type: 'TransformClip', cardinality: 'single' } },
  inspectorSections: ['animate'],
  evaluate(params, inputs: ResolvedInputs): TransformClipValue | null {
    const input = inputs.clips;
    const candidates: readonly TransformClipValue[] = Array.isArray(input)
      ? (input as TransformClipValue[])
      : input
        ? [input as TransformClipValue]
        : [];
    const found = candidates.find((c) => c.name === params.selectedClipName);
    return found ?? null;
  },
};
