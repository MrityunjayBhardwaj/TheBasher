// Track — an ordered mute/solo container of Strips (NLA, epic #283 Phase 2).
//
// A Track holds an ordered list of Strip node ids (edge-less id-refs, V57). The
// reducer folds a track's strips bottom→top; the tracks themselves fold in `order`
// rank (I-2 — reorder changes the result). `mute` bypasses a whole track; `solo`
// on ANY track silences every non-solo track (global). A Strip belongs to exactly
// one Track (single-owner — the resolver deterministically picks the lowest-order
// track if that invariant is ever violated).
//
// INERT in Slice A (renders nothing, edge-less `inputs: {}`). The resolver reads
// tracks to order + gate strips in Slices C–E. Serializable + registered so
// `addNode` validates it (V1).
//
// REF: docs/NLA-DESIGN.md §3.3/§6 (Phase 2); vyapti V57/V88 D2; krama K21.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { TrackValue } from './types';

export const TrackParams = z.object({
  name: z.string().default('Track'),
  /** Ordered Strip node ids (edge-less refs). Position in this array = the
   *  strip's within-track fold rank. */
  strips: z.array(z.string()).default([]),
  /** Cross-track fold rank (bottom→top). */
  order: z.number().default(0),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
});
export type TrackParams = z.infer<typeof TrackParams>;

export const TrackNode: NodeDefinition<TrackParams, TrackValue> = {
  type: 'Track',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TrackParams,
  inputs: {},
  outputs: { out: { type: 'Track', cardinality: 'single' } },
  inspectorSections: ['layout'],
  evaluate(params): TrackValue {
    return {
      kind: 'Track',
      name: params.name,
      strips: params.strips,
      order: params.order,
      mute: params.mute,
      solo: params.solo,
    };
  },
};
