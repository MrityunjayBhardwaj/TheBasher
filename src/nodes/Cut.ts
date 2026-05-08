// Cut — connects two Shots with an optional N-frame transition.
//
// transitionFrame=0 is a hard cut (the editorial default). >0 is a
// crossfade-style transition; the render integration treats it as a blend
// window where both shots' scenes evaluate simultaneously. P4 wires that;
// Wave A just ships the data.
//
// REF: THESIS §42, project_p3_plan, vyapti V2.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CutValue, ShotValue } from './types';

export const CutParams = z.object({
  transitionFrame: z.number().int().nonnegative().default(0),
});
export type CutParams = z.infer<typeof CutParams>;

export const CutNode: NodeDefinition<CutParams, CutValue> = {
  type: 'Cut',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CutParams,
  inputs: {
    from: { type: 'Shot', cardinality: 'single' },
    to: { type: 'Shot', cardinality: 'single' },
  },
  outputs: { out: { type: 'Cut', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    return {
      kind: 'Cut',
      from: (inputs.from as ShotValue | undefined) ?? null,
      to: (inputs.to as ShotValue | undefined) ?? null,
      transitionFrame: params.transitionFrame,
    };
  },
};
