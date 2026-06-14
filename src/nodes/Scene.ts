import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraValue, EnvironmentSource, LightValue, SceneChild, SceneValue } from './types';

// UX #9 — scene-level environment (HDRI/IBL) source. Discriminated so the
// editor authors exactly one of: nothing / a drei preset (CDN) / an imported
// .hdr/.exr (OPFS assetRef, embeds in the .basher bundle). See vyapti V47.
export const EnvSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('preset'), name: z.string() }),
  z.object({ kind: z.literal('file'), assetRef: z.string(), name: z.string().optional() }),
]);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

// SceneParams was an empty passthrough. UX #9 adds the env params as DEFAULTED
// fields: an old project's Scene node (params `{}`) parses to `kind:'none'` —
// the V10/H14 two-layer default (here in the zod `.default(...)` AND defensively
// at the renderer consumer). Version stays 1 (additive defaults, no migration).
export const SceneParams = z
  .object({
    envSource: EnvSourceSchema.default({ kind: 'none' }),
    envIntensity: z.number().default(1),
    envRotationY: z.number().default(0),
    envBackground: z.boolean().default(false),
  })
  .passthrough();
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
  inspectorSections: ['environment', 'layout'],
  evaluate(params, inputs) {
    // UX #9 — fold the env params into SceneValue.environment. The `?? default`
    // here is the SECOND layer of the V10/H14 two-layer default (the zod
    // `.default(...)` is the first): an old project whose Scene params predate
    // these fields still resolves to `none` rather than crashing.
    return {
      kind: 'Scene',
      camera: inputs.camera as CameraValue,
      lights: (inputs.lights as LightValue[]) ?? [],
      children: (inputs.children as SceneChild[]) ?? [],
      environment: {
        source: (params.envSource as EnvironmentSource | undefined) ?? { kind: 'none' },
        intensity: (params.envIntensity as number | undefined) ?? 1,
        rotationY: (params.envRotationY as number | undefined) ?? 0,
        background: (params.envBackground as boolean | undefined) ?? false,
      },
    };
  },
};
