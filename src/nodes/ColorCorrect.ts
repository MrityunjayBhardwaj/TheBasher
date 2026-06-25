// ColorCorrect — the FIRST video EFFECT, the Image half of [[V58]] (epic #235).
// A video effect is a typed `Image → Image` operator spliced onto a Layer's source
// edge (the §5 model): it consumes the upstream Image and produces a colour-graded
// Image. This is the exact pattern shipped for geometry modifiers (ArrayModifier,
// Mesh→Mesh) — the SAME `operatorStack.ts` sub-chain helpers (add/remove/reorder/
// mute = pure re-wire) now serve the Image socket via `EFFECT_NODE_TYPES`. No new
// stack engine; the lift is just the socket type + this NodeDefinition.
//
// Like MediaClip, evaluate is PURE metadata (V2): the ImageValue is lazy P4 data,
// so the actual pixel grade happens at the compositor's decode seam
// (compositeDecode.applyEffects) — evaluate only forwards the upstream descriptor
// and folds the colour params into the `sourceHash` (so a param change invalidates
// the cached frame, and the agent can describe the graded result by its handle).
// `muted` bypasses (passes the source through unchanged) — the V58 stack mute,
// byte-identical to no effect, exactly like a muted modifier.
//
// REF: docs/COMPOSITOR-DESIGN.md §5 (effects = operators); src/app/operatorStack.ts
//      (the shared sub-chain — EFFECT_NODE_TYPES); src/nodes/ArrayModifier.ts (the
//      geometry sibling); src/app/video/compositeDecode.ts (applyEffects, the pixel
//      pass); vyapti V58 + V2 + V83.

import { z } from 'zod';
import { hashValue } from '../core/dag/hash';
import type { NodeDefinition } from '../core/dag/types';
import type { ImageValue } from './types';

export const ColorCorrectParams = z.object({
  /** Brightness multiplier (1 = identity). Maps to canvas `brightness()`. */
  brightness: z.number().min(0).default(1),
  /** Contrast multiplier (1 = identity). Maps to canvas `contrast()`. */
  contrast: z.number().min(0).default(1),
  /** Saturation multiplier (1 = identity, 0 = greyscale). Maps to `saturate()`. */
  saturation: z.number().min(0).default(1),
  /** Stack mute-bypass (V58): true → pass the source Image through unchanged. */
  muted: z.boolean().default(false),
});
export type ColorCorrectParams = z.infer<typeof ColorCorrectParams>;

export const ColorCorrectNode: NodeDefinition<ColorCorrectParams, ImageValue> = {
  type: 'ColorCorrect',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ColorCorrectParams,
  inputs: { target: { type: 'Image', cardinality: 'single' } },
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  inspectorSections: ['effect'],
  evaluate(params, inputs): ImageValue {
    const src = inputs.target as ImageValue | undefined;
    // Unwired (transient authoring state) — nothing to grade; stay transparent.
    if (!src) return src as unknown as ImageValue;
    // Mute-bypass (V58) — identity passthrough, byte-identical to no effect.
    if (params.muted) return src;
    // Pure metadata: same descriptor, sourceHash folds in the colour params so the
    // graded frame is content-addressed distinctly from the ungraded source.
    return {
      ...src,
      sourceHash: hashValue({
        effect: 'ColorCorrect',
        base: src.sourceHash,
        b: params.brightness,
        c: params.contrast,
        s: params.saturation,
      }),
    };
  },
};
