import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type {
  CameraValue,
  EnvironmentSource,
  LightRigValue,
  LightValue,
  SceneChild,
  SceneValue,
} from './types';

// UX #9 — scene-level environment (HDRI/IBL) source. Discriminated so the
// editor authors exactly one of: nothing / a drei preset (CDN) / an imported
// .hdr/.exr (OPFS assetRef, embeds in the .basher bundle). See vyapti V47.
export const EnvSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('preset'), name: z.string() }),
  z.object({ kind: z.literal('file'), assetRef: z.string(), name: z.string().optional() }),
]);

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
    camera: { type: 'SceneObject', cardinality: 'single' },
    lights: { type: 'SceneObject', cardinality: 'list' },
    children: { type: 'SceneObject', cardinality: 'list' },
    // #208 — the active lighting PROFILE (a LightRig directly, or the rig a
    // LightProfileSelect picks). Kept SEPARATE from `lights` so the direct-light
    // index-correspondence with `inputs.lights` stays byte-identical.
    lightRig: { type: 'LightRig', cardinality: 'single' },
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
      // #208 — the active profile's rig, passed through SEPARATELY (never merged
      // into `lights`). null when nothing is wired (the common case, byte-identical
      // to a pre-#208 project).
      lightRig: (inputs.lightRig as LightRigValue | undefined) ?? null,
      environment: {
        source: (params.envSource as EnvironmentSource | undefined) ?? { kind: 'none' },
        intensity: (params.envIntensity as number | undefined) ?? 1,
        rotationY: (params.envRotationY as number | undefined) ?? 0,
        background: (params.envBackground as boolean | undefined) ?? false,
      },
    };
  },
};
