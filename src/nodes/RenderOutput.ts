import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { RenderOutputValue, SceneValue } from './types';

/** Default render resolution — Full HD, the Blender default. #168. */
export const DEFAULT_RENDER_WIDTH = 1920;
export const DEFAULT_RENDER_HEIGHT = 1080;

export const RenderOutputParams = z.object({
  postFx: z.object({
    tonemap: z.enum(['ACES', 'Linear']).default('ACES'),
    smaa: z.boolean().default(true),
  }),
  // #168 — explicit render output resolution (pixels). A render is produced
  // offscreen at this exact size, decoupled from the window (Blender F12).
  width: z.number().int().min(1).default(DEFAULT_RENDER_WIDTH),
  height: z.number().int().min(1).default(DEFAULT_RENDER_HEIGHT),
});
export type RenderOutputParams = z.infer<typeof RenderOutputParams>;

export const RenderOutputNode: NodeDefinition<RenderOutputParams, RenderOutputValue> = {
  type: 'RenderOutput',
  // v2 (#168): added width/height. v1 projects migrate to the 1920×1080
  // default below — IDENTITY for the existing render (resolution was the
  // viewport size before; the migration just records the explicit default).
  version: 2,
  pure: true,
  cost: 'cheap',
  paramSchema: RenderOutputParams,
  inputs: { scene: { type: 'Scene', cardinality: 'single' } },
  outputs: { out: { type: 'RenderOutput', cardinality: 'single' } },
  inspectorSections: ['render'],
  migrations: {
    // v1 → v2: add the explicit resolution default. Every other param is
    // byte-identical (proven in migrations.test.ts).
    1: (params) => ({
      ...(params as object),
      width: DEFAULT_RENDER_WIDTH,
      height: DEFAULT_RENDER_HEIGHT,
    }),
  },
  evaluate(params, inputs) {
    return {
      kind: 'RenderOutput',
      scene: inputs.scene as SceneValue,
      postFx: params.postFx,
      // Defensive defaults (V10/H14): a seed node or a pre-field project may
      // reach evaluate with width/height undefined — never NaN the resolution.
      width: params.width ?? DEFAULT_RENDER_WIDTH,
      height: params.height ?? DEFAULT_RENDER_HEIGHT,
    };
  },
};
