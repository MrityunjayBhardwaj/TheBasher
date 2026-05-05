import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraValue, LightValue, SceneChild, SceneValue } from './types';

export const SceneParams = z.object({}).passthrough();
export type SceneParams = z.infer<typeof SceneParams>;

export const SceneNode: NodeDefinition<SceneParams, SceneValue> = {
  type: 'Scene',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: SceneParams,
  inputs: {
    camera: { type: 'Camera', cardinality: 'single' },
    lights: { type: 'Light', cardinality: 'list' },
    children: { type: 'Mesh', cardinality: 'list' },
  },
  outputs: { out: { type: 'Scene', cardinality: 'single' } },
  evaluate(_params, inputs) {
    return {
      kind: 'Scene',
      camera: inputs.camera as CameraValue,
      lights: (inputs.lights as LightValue[]) ?? [],
      children: (inputs.children as SceneChild[]) ?? [],
    };
  },
};
