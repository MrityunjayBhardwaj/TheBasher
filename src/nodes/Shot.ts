// Shot — editorial unit. Ties a time range to a camera + scene reference.
//
// A film is a sequence of Shots (and Cuts between them). Wave A ships the
// data plumbing: a Shot evaluator forwards the wired camera and scene as a
// ShotValue with the time range. The render-graph integration (which scene
// is active at runtime time t) lands in P4 alongside the render pass nodes.
//
// REF: THESIS §42, project_p3_plan, vyapti V2.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CameraValue, SceneValue, ShotValue } from './types';

export const ShotParams = z.object({
  name: z.string().default('Shot'),
  startTime: z.number().nonnegative().default(0),
  endTime: z.number().nonnegative().default(2),
});
export type ShotParams = z.infer<typeof ShotParams>;

export const ShotNode: NodeDefinition<ShotParams, ShotValue> = {
  type: 'Shot',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ShotParams,
  inputs: {
    camera: { type: 'Camera', cardinality: 'single' },
    scene: { type: 'Scene', cardinality: 'single' },
  },
  outputs: { out: { type: 'Shot', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs) {
    return {
      kind: 'Shot',
      name: params.name,
      startTime: params.startTime,
      endTime: params.endTime,
      camera: (inputs.camera as CameraValue | undefined) ?? null,
      scene: (inputs.scene as SceneValue | undefined) ?? null,
    };
  },
};
