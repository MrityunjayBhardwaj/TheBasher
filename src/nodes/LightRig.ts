// LightRig — a switchable lighting PROFILE (epic #201, slice #208; §7.2/§7.5,
// [[V62]]). It GROUPS its lights (the `lights` list input) and OWNS the shared aim
// CENTRE + radius the panel's pucks orbit — formalizing the implicit rig centre
// `resolveRigTarget` derived in #206/#207 from the lights' shared Track-To aim.
//
// One rig = one profile. Multiple rigs co-exist in the DAG; a `LightProfileSelect`
// (#208 increment 2, the ClipSelect pattern) picks one by name to feed the scene.
// Because every rig stays resident in the substrate, switching is a single param
// change on the selector — keyframeable for free (V57: a lighting setup can be
// animated over a shot, which BLS itself can't do). This keeps profiles on the ONE
// substrate (V34/V58 — a NodeDefinition + typed sockets, no parallel store).
//
// The lights stay in EDGE ORDER through `evaluate` (the evaluator pushes list
// inputs in binding order), so the renderer recovers each rig light's node id by
// index-correspondence via `resolveRigLightSources` — exactly as the Scene's
// direct `lights` map to `Scene.inputs.lights`.
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.2/§7.5; src/nodes/ClipSelect.ts
//      (the switch pattern this anticipates); src/app/studioLightRig.ts
//      (`resolveRigTarget` — the implicit centre this formalizes); vyapti V62/V60.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { LightRigValue, LightValue } from './types';
import { recomposeLightObject } from './lightRecompose';

export const LightRigParams = z.object({
  name: z.string().default('Light Rig'),
  /** The rig sphere origin every light on the rig aims at (the BLS "handle"). */
  center: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** The rig sphere radius — the default puck distance from the centre. */
  radius: z.number().positive().default(6),
});
export type LightRigParams = z.infer<typeof LightRigParams>;

export const LightRigNode: NodeDefinition<LightRigParams, LightRigValue> = {
  type: 'LightRig',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LightRigParams,
  inputs: {
    lights: { type: 'SceneObject', cardinality: 'list' },
  },
  outputs: { out: { type: 'LightRig', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): LightRigValue {
    const raw = inputs.lights;
    // #386 — a posable rig light is now an `Object` posing a `LightData`. Recompose
    // each entry back into the flat `LightValue` via the ONE shared helper (also used
    // at Scene.evaluate + ObjectR — V117: two roads gather lights, both recompose
    // here). Miss this and rig lights render at origin with default shading. A fused
    // AmbientLightValue returns null → passes through unchanged.
    const gathered: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const lights: LightValue[] = gathered
      .filter((l): l is object => l != null)
      .map((l) => recomposeLightObject(l) ?? (l as LightValue));
    return {
      kind: 'LightRig',
      name: params.name,
      center: params.center,
      radius: params.radius,
      lights,
    };
  },
};
