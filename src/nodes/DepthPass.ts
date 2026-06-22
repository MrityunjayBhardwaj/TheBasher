// DepthPass — per-pixel scene depth, encoded as grayscale sRGB.
//
// P5 §43 amendment (D-02 locked): Depth ships in v0.5 because
// stylizedRealism's ControlNet-Depth conditioning needs it. LineArt /
// Segmentation / AO / Albedo / Alpha / MotionVector remain deferred to
// v0.6 — they only land when a preset registered in
// src/agent/strategy/presets/ demands them.
//
// Pure: returns ImageValue metadata only. Pixel work happens at
// RenderJob / runComfyUIWorkflow execution time. Format = rgba8 so
// ControlNet's sRGB-PNG input contract is satisfied without a per-pass
// color-space conversion in the encoder.
//
// REF: THESIS §43, §49, §51; project_p5_context D-02; vyapti V2 + V3.

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

export const DepthPassParams = z.object({
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type DepthPassParams = z.infer<typeof DepthPassParams>;

export const DepthPassNode: NodeDefinition<DepthPassParams, ImageValue> = {
  type: 'DepthPass',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: DepthPassParams,
  inputs: {
    scene: { type: 'Scene', cardinality: 'single' },
    camera: { type: 'SceneObject', cardinality: 'single' },
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
      passKind: 'depth',
      descriptor: {
        width: params.width ?? DEFAULT_IMAGE_DESCRIPTOR.width,
        height: params.height ?? DEFAULT_IMAGE_DESCRIPTOR.height,
        format: 'rgba8',
      },
      sourceHash: buildPassSourceHash({
        passKind: 'depth',
        params,
        scene,
        camera,
        time,
      }),
    };
  },
};
