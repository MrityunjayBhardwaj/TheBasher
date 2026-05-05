// Character — a renderable agent driven by an upstream LocomotionState.
//
// Inputs:
//   - locomotion (LocomotionState, single)
//
// Output: a CharacterValue (a SceneChild kind) carrying position + heading
// + pose. The viewport renders it as a small placeholder rig — boxes per
// bone — until a full skinning pass lands in P3.
//
// Pure: deterministic given (params, inputs.locomotion). The character node
// is a passthrough that elevates the locomotion result to a renderable.
//
// REF: THESIS.md §40, vyapti V2, krama K7.

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { CharacterValue, LocomotionStateValue, PosedSkeletonValue } from './types';

export const CharacterParams = z.object({
  name: z.string().default('character'),
});
export type CharacterParams = z.infer<typeof CharacterParams>;

const EMPTY_POSE: PosedSkeletonValue = {
  kind: 'PosedSkeleton',
  skeleton: { kind: 'Skeleton', bones: [] },
  poses: [],
};

export const CharacterNode: NodeDefinition<CharacterParams, CharacterValue> = {
  type: 'Character',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CharacterParams,
  inputs: { locomotion: { type: 'LocomotionState', cardinality: 'single' } },
  outputs: { out: { type: 'Character', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs) {
    const loco = inputs.locomotion as LocomotionStateValue | undefined;
    return {
      kind: 'Character',
      name: params.name,
      position: loco?.position ?? [0, 0, 0],
      heading: loco?.heading ?? 0,
      pose: loco?.pose ?? EMPTY_POSE,
    };
  },
};
