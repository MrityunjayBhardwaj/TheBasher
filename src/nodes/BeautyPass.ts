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
import { recomposeCameraObject } from './cameraRecompose';

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
    camera: { type: 'SceneObject', cardinality: 'single' },
    time: { type: 'Time', cardinality: 'single' },
  },
  /** #608 — the ROLE is declared here, so a reader can answer "which socket is the
   *  beauty pass" from the graph alone, without evaluating the node. */
  outputs: { out: { type: 'Image', cardinality: 'single', role: 'beauty' } },
  inspectorSections: ['render'],
  evaluate(params, inputs: ResolvedInputs): ImageValue {
    const scene = inputs.scene as SceneValue | undefined;
    // #387 — a camera may arrive as an `Object` posing a `CameraData`; recompose it into
    // the flat CameraValue before it enters `buildPassSourceHash`. Skipping this hashes the
    // Object shape instead of the lens, so two DIFFERENT lenses on one pose collide on a
    // cache key and the pass silently reuses stale pixels. Fused → null → unchanged.
    const camera =
      recomposeCameraObject(inputs.camera) ?? (inputs.camera as CameraValue | undefined);
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
