// IDPass — per-object instance/object ID buffer.
//
// Pure: returns ImageValue metadata only. RenderJob's execution side
// renders flat unique colors per scene object so masks can be derived per
// frame. Pixel work is deferred — Wave A ships only the deductive contract.
//
// Format choice: rgba16f keeps ID precision for >255 objects (id packed
// across channels) and stays in line with Wave B's render target options.
// Default 1280x720 mirrors BeautyPass so a paired beauty + id render
// trivially aligns.
//
// REF: THESIS §43, §49, §51; project_p4_prompt locked decisions.

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

export const IDPassParams = z.object({
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type IDPassParams = z.infer<typeof IDPassParams>;

export const IDPassNode: NodeDefinition<IDPassParams, ImageValue> = {
  type: 'IDPass',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: IDPassParams,
  inputs: {
    scene: { type: 'Scene', cardinality: 'single' },
    camera: { type: 'Camera', cardinality: 'single' },
    time: { type: 'Time', cardinality: 'single' },
  },
  outputs: { out: { type: 'Image', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs): ImageValue {
    const scene = inputs.scene as SceneValue | undefined;
    const camera = inputs.camera as CameraValue | undefined;
    const time = inputs.time as TimeValue | undefined;
    return {
      kind: 'Image',
      passKind: 'id',
      descriptor: {
        width: params.width,
        height: params.height,
        format: 'rgba16f',
      },
      sourceHash: buildPassSourceHash({
        passKind: 'id',
        params,
        scene,
        camera,
        time,
      }),
    };
  },
};
