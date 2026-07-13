// TrackTo — the first CHOP/constraint node (epic #201, slice #204). It aims a
// node (`target`) so its -Z faces an aim target (a node-ref `aimNode` whose world
// position is read, or a fixed `aimPoint`), with `up` as the roll reference.
//
// MODELLED LIKE A KEYFRAME CHANNEL (V57 direct-channel road), NOT a wrapper node:
// a relationship constraint needs the constrained object's WORLD position to
// compute the aim, and a bare node `evaluate` has no world context (that depends
// on ancestors). So TrackTo is EDGE-LESS — it carries `target` + the aim, is
// enumerated from the node table (`nodeConstraints.ts`), and is RESOLVED at the
// scene-resolution layer (alongside `resolveWorldTransform` / the camera's
// `resolveActiveCameraPoseAt`), where world transforms exist. This is the exact
// `resolveActiveCameraPoseAt` pattern ([[V56]]) generalized to any node, and is
// why §2.2's "wrapper sub-chain" model fits geometry/value operators but NOT
// relationship constraints (the aim is a scene-layer derive).
//
// `evaluate` returns a `ConstraintValue` for agent/introspection completeness; the
// resolver reads params directly (the channel pattern — no edge, no consumer).
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1/§4.2; vyapti V58/V56.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { TrackToConstraintValue } from './types';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const TrackToParams = z.object({
  name: z.string().default('track-to'),
  /** The constrained node id whose rotation this derives (mirrors a channel's
   *  `target`). Empty → inert (enumerated but no node to aim). */
  target: z.string().default(''),
  /** Aim at this node's WORLD position when non-empty; else `aimPoint`. */
  aimNode: z.string().default(''),
  /** Fixed-point aim target (world) used when `aimNode` is empty. */
  aimPoint: Vec3Schema.default([0, 0, 0]),
  /** Roll reference for the aim basis (default +Y). */
  up: Vec3Schema.default([0, 1, 0]),
  /** Bypass — a muted constraint contributes nothing (the constraint stack). */
  mute: z.boolean().default(false),
  /** Position in the target's ordered constraint stack (low → high, bottom → top).
   *  A relational operator is EDGE-LESS, so the stack orders by this field rather
   *  than by a wire — the geometry stack's sub-chain model cannot apply (see
   *  `operatorStack.ts`: "modifiers are [sub-chains]; constraints aren't"). Mirrors
   *  `ParamDriver.order`. Default 0 → a pre-stack project is a single-member stack in
   *  node-table order, byte-identical to the old first-wins scan. */
  order: z.number().default(0),
});
export type TrackToParams = z.infer<typeof TrackToParams>;

export const TrackToNode: NodeDefinition<TrackToParams, TrackToConstraintValue> = {
  type: 'TrackTo',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: TrackToParams,
  // Edge-less (enumerated + scene-layer resolved, like a direct channel). The
  // `out` socket exists for introspection/future stack wiring; nothing consumes it.
  inputs: {},
  outputs: { out: { type: 'Constraint', cardinality: 'single' } },
  inspectorSections: ['constraint', 'driver'],
  evaluate(params): TrackToConstraintValue {
    return {
      kind: 'Constraint',
      constraintType: 'trackTo',
      name: params.name,
      target: params.target,
      aimNode: params.aimNode,
      aimPoint: params.aimPoint,
      up: params.up,
      mute: params.mute,
      order: params.order,
    };
  },
};
