// BeautyPass — final composited RGB output for a (Scene, Camera, Time) triple.
//
// Pure: same (params, scene, camera, time) → same ImageValue. The evaluator
// returns metadata only — descriptor + content-hash. Actual pixel work
// happens at RenderJob execution time (Wave B), driven off this hash.
//
// Time threads in via a typed `Time` socket (V3) so the value's sourceHash
// flips on scrub without the evaluator reading any clock directly. Scene +
// Camera ride sockets the same way — the renderer-side dispatch reads the
// resolved POJOs via DAG eval at each render frame.
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

export const BeautyPassParams = z.object({
  width: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.width),
  height: z.number().int().positive().default(DEFAULT_IMAGE_DESCRIPTOR.height),
});
export type BeautyPassParams = z.infer<typeof BeautyPassParams>;

export const BeautyPassNode: NodeDefinition<BeautyPassParams, ImageValue> = {
  type: 'BeautyPass',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BeautyPassParams,
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
      passKind: 'beauty',
      descriptor: {
        width: params.width,
        height: params.height,
        format: 'rgba8',
      },
      sourceHash: buildPassSourceHash({
        passKind: 'beauty',
        params,
        scene,
        camera,
        time,
      }),
    };
  },
};
