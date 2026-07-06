// Action — a reusable, target-LESS animation performance (NLA, epic #283 Phase 2).
//
// An Action is a bundle of relative-path keyframe channel specs — a "walk"
// authored once, with no bound target. A Strip binds it to a concrete object at
// placement time (I-1: the source is immutable; edits live on the Strip). Each
// channel spec is exactly a `KeyframeChannel*Params` with the bound `target`
// removed and a `valueType` discriminant added, so the Action never drifts from
// the channel schema (V57/DRY) and a strip resolver can feed the spec straight to
// `build{Type}Sampler` (Slice C).
//
// This node is INERT in Slice A: it renders nothing and is not wired by edge
// (edge-less sidecar, `inputs: {}`). It is enumerated + folded by the resolver
// scan in Slices C–E. Serializable + registered so `addNode` validates it (V1).
//
// REF: docs/NLA-DESIGN.md §3.1/§3.3/§6 (Phase 2), §11 (Fork A); vyapti V57/V88 D2.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ActionValue } from './types';
import { KeyframeChannelNumberParams } from './KeyframeChannelNumber';
import { KeyframeChannelVec2Params } from './KeyframeChannelVec2';
import { KeyframeChannelVec3Params } from './KeyframeChannelVec3';
import { KeyframeChannelQuatParams } from './KeyframeChannelQuat';
import { KeyframeChannelColorParams } from './KeyframeChannelColor';
import { KeyframeChannelTextParams } from './KeyframeChannelText';
import { KeyframeChannelImageParams } from './KeyframeChannelImage';

/** A relative-path channel spec = the channel schema minus the bound `target`,
 *  plus a `valueType` discriminant. `mute`/`weight`/`blendMode`/`order` are inert
 *  at Action scope (the Strip owns placement blend) but retained so the spec feeds
 *  `build{Type}Sampler` unchanged (V57/DRY). Arms are inlined (not a generic
 *  helper) so each schema's concrete shape — crucially `paramPath` — survives
 *  inference into the discriminated union. */
export const ActionChannelSchema = z.discriminatedUnion('valueType', [
  KeyframeChannelNumberParams.omit({ target: true }).extend({ valueType: z.literal('number') }),
  KeyframeChannelVec2Params.omit({ target: true }).extend({ valueType: z.literal('vec2') }),
  KeyframeChannelVec3Params.omit({ target: true }).extend({ valueType: z.literal('vec3') }),
  KeyframeChannelQuatParams.omit({ target: true }).extend({ valueType: z.literal('quat') }),
  KeyframeChannelColorParams.omit({ target: true }).extend({ valueType: z.literal('color') }),
  KeyframeChannelTextParams.omit({ target: true }).extend({ valueType: z.literal('text') }),
  KeyframeChannelImageParams.omit({ target: true }).extend({ valueType: z.literal('image') }),
]);
export type ActionChannel = z.infer<typeof ActionChannelSchema>;

export const ActionParams = z.object({
  name: z.string().default('Action'),
  channels: z.array(ActionChannelSchema).default([]),
});
export type ActionParams = z.infer<typeof ActionParams>;

export const ActionNode: NodeDefinition<ActionParams, ActionValue> = {
  type: 'Action',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ActionParams,
  // Edge-less sidecar (V57): no inputs; the output exists for introspection but the
  // Action is reached by resolver scan (Slice C), never wired into the graph.
  inputs: {},
  outputs: { out: { type: 'Action', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params): ActionValue {
    return {
      kind: 'Action',
      name: params.name,
      channels: params.channels,
    };
  },
};
