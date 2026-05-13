// NormalPass — world-space surface normals encoded as rgb (rgba8 sRGB).
//
// P5 §43 amendment (D-02 locked): Normal ships alongside Depth so
// stylizedRealism's ControlNet-Normal conditioning has its raw input.
// Encoding follows the standard (n + 1) / 2 → 8-bit-per-channel pack so
// ControlNet's sRGB PNG input contract works without a separate color
// path. ControlNet expects rgba8; the renderer-side encoder owns the
// (n + 1) / 2 transform — this evaluator only declares the metadata.
//
// Pure: same shape as DepthPass + IDPass + BeautyPass. Pixel work at
// RenderJob / runComfyUIWorkflow execution time.
//
// REF: THESIS §43; project_p5_context D-02; vyapti V2 + V3.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import {
  DEFAULT_IMAGE_DESCRIPTOR,
  type CameraValue,
  type ImageValue,
  type SceneValue,
  type TimeValue,
} from './types';
import { buildPassSourceHash } from './passes/passHash';

export const NormalPassParams = z.object({
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type NormalPassParams = z.infer<typeof NormalPassParams>;

export const NormalPassNode: NodeDefinition<NormalPassParams, ImageValue> = {
  type: 'NormalPass',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NormalPassParams,
  inputs: {
    scene: { type: 'Scene', cardinality: 'single' },
    camera: { type: 'Camera', cardinality: 'single' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  inspectorSections: ['render'],
  evaluate(params, inputs: ResolvedInputs): ImageValue {
    const scene = inputs.scene as SceneValue | undefined;
    const camera = inputs.camera as CameraValue | undefined;
    const time = inputs.time as TimeValue | undefined;
    return {
      kind: 'Image',
      passKind: 'normal',
      descriptor: {
        width: params.width ?? DEFAULT_IMAGE_DESCRIPTOR.width,
        height: params.height ?? DEFAULT_IMAGE_DESCRIPTOR.height,
        format: 'rgba8',
      },
      sourceHash: buildPassSourceHash({
        passKind: 'normal',
        params,
        scene,
        camera,
        time,
      }),
    };
  },
};
