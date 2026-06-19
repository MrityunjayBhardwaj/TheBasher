// LightProfileSelect — the PROFILE SWITCH (epic #201, slice #208 increment 2;
// §7.5, [[V62]]). Picks one `LightRig` out of N by name and exposes it on a single
// output that feeds `Scene.inputs.lightRig` — so exactly one lighting profile is
// live at a time, while every rig stays co-resident in the DAG (V34).
//
// This is the ClipSelect pattern (src/nodes/ClipSelect.ts) lifted to lighting: the
// switch is a SINGLE param (`selectedProfile`), so changing the live profile is one
// `setParam` → keyframeable for free (V57): a shot can animate from one lighting
// setup to another, which BLS itself can't do. null-on-miss is deliberate (not a
// fallback to the first rig) — it makes "the selected profile is gone" visible.
//
// Pure: output is a function of (params, inputs.rigs). The renderer recovers the
// selected rig's light node ids through the SAME hop (`resolveRigLightSources` →
// `resolveActiveRigNode`), so render and read agree on which profile is live.
//
// REF: src/nodes/ClipSelect.ts (the switch pattern); src/nodes/LightRig.ts;
//      src/app/resolveRigLightSources.ts (the matching id-side hop);
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.5; vyapti V62.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { LightRigValue } from './types';

export const LightProfileSelectParams = z.object({
  /** The `name` of the live `LightRig`. Empty / no-match → null (no profile). */
  selectedProfile: z.string().default(''),
});
export type LightProfileSelectParams = z.infer<typeof LightProfileSelectParams>;

export const LightProfileSelectNode: NodeDefinition<
  LightProfileSelectParams,
  LightRigValue | null
> = {
  type: 'LightProfileSelect',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: LightProfileSelectParams,
  inputs: {
    rigs: { type: 'LightRig', cardinality: 'list' },
  },
  outputs: { out: { type: 'LightRig', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params, inputs: ResolvedInputs): LightRigValue | null {
    const raw = inputs.rigs;
    const candidates: readonly LightRigValue[] = Array.isArray(raw)
      ? (raw as LightRigValue[]).filter((r): r is LightRigValue => r != null)
      : raw
        ? [raw as LightRigValue]
        : [];
    return candidates.find((r) => r.name === params.selectedProfile) ?? null;
  },
};
