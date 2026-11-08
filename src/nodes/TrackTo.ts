// TrackTo — the first CHOP/constraint node (epic #201, slice #204). It aims a
// node (`target`) so its -Z faces an aim target (a node-ref `aimNode` whose world
// position is read, or a fixed `aimPoint`), with `up` as the roll reference.
//
// A STEP ON ITS OBJECT'S CHAIN (#1811, #1812): the transform comes up `in`, the aim replaces its
// rotation (`constraintChain.ts`), and `world` goes on to the next step or the object's `constraints`
// input. `target` still names the object, which is what ties the step's life to it and how a commit
// knows which chain a new step joins (`chainFollowUpOps`). What it aims at is a wire on `aim` or the
// `aimNode` reference; only the reference can close a loop.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.1/§4.2; vyapti V58/V56.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { TrackToConstraintValue } from './types';
import { nameParam, optionsParam } from './paramWidget';
import { characterPartOptions, constrainedObjectOptions } from '../app/constraintStack';

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const TrackToParams = z.object({
  name: nameParam('track-to'),
  /** The constrained node id whose rotation this derives (mirrors a channel's
   *  `target`). Empty → inert (enumerated but no node to aim). */
  target: optionsParam(
    z.string().default(''),
    // Wrapped so this module never reads an import during load (#1065): the provider's module
    // reaches the world resolver, which can import back into the node registry.
    (s) => constrainedObjectOptions(s),
    undefined,
    'nodeId',
  ),
  /** Aim at this node's WORLD position when non-empty; else `aimPoint`. */
  aimNode: z.string().default(''),
  /** #1284 — when `aimNode` is a character, aim at this node INSIDE it (a bone, e.g. its Hips)
   *  rather than at the character's own origin — Blender's Track To `subtarget`. A walk moves the
   *  Hips while the character's Group stays where the walk began. Empty → the node itself. */
  aimBone: optionsParam(
    z.string().default(''),
    // Wrapped like `target`'s provider, for the same load-order reason.
    (s, id) => characterPartOptions(s, id),
    'the object itself',
    'name',
  ),
  /** Fixed-point aim target used when `aimNode` is empty, in `aimSpace`. */
  aimPoint: Vec3Schema.default([0, 0, 0]),
  /** #1759 — the space `aimPoint` is in: the world (default), or the constrained object's
   *  parent, so a point authored beside the object travels with what it hangs from — Blender's
   *  Track To owner/target space. An `aimNode` is always aimed at where it is in the world. */
  aimSpace: z.enum(['world', 'parent']).default('world'),
  /** Roll reference for the aim basis (default +Y). */
  up: Vec3Schema.default([0, 1, 0]),
  /** #1759 — degrees of roll about the aim axis, after aiming (a dutch angle). Blender's Track To
   *  has none, only an up axis, which cannot hold a steady roll while the aim moves; a camera's
   *  roll moves onto its Track-To in #487, so this one goes past Blender on purpose. */
  roll: z.number().default(0),
  /** Bypass — a muted constraint contributes nothing (the constraint stack). */
  mute: z.boolean().default(false),
  /** Where a new step joins its object's chain. Once it is on the chain, the wires are the order. */
  order: z.number().default(0),
});
export type TrackToParams = z.infer<typeof TrackToParams>;

export const TrackToNode: NodeDefinition<TrackToParams, TrackToConstraintValue> = {
  type: 'TrackTo',
  version: 1,
  pure: true,
  worldStep: true,
  // #1811 — an aim target picked by name, which can close a loop where a wire can't.
  worldRefs: { aim: 'aimNode' },
  ownerParent: { socket: 'parent', owner: 'target' },
  cost: 'cheap',
  paramSchema: TrackToParams,
  // #421 — `target` is the CONSTRAINED object: this constraint lives on it
  // (Blender keeps a constraint on its owner), so it dies with it. `aimNode` is
  // a separate object this merely AIMS AT — usually shared by several
  // constraints — so deleting the aim target must not delete the constraint.
  // Clearing it falls back to `aimPoint`, an already-supported inert state.
  idRefs: [
    { path: 'target', shape: 'id', role: 'subject' },
    { path: 'aimNode', shape: 'id', role: 'argument' },
  ],
  mainInput: 'in',
  inputs: {
    // #1811 — on a wired chain: the transform coming up it, what to aim at (else `aimPoint`), and
    // the world the object hangs from, for an up or an aim point in its parent's space.
    in: { type: 'Matrix4', cardinality: 'single', chain: 'step' },
    aim: { type: 'Matrix4', cardinality: 'single', chain: 'step' },
    parent: { type: 'Matrix4', cardinality: 'single', chain: 'step' },
  },
  outputs: {
    out: { type: 'Constraint', cardinality: 'single' },
    // #1811 — the transform that came up the chain, changed by this constraint.
    world: { type: 'Matrix4', cardinality: 'single', world: true },
  },
  // #1817 — 'stack': a step selected in the Transform Stack keeps its object's stack on screen.
  inspectorSections: ['constraint', 'driver', 'stack'],
  // The aim target is authored through the general node-ref picker (the same surface as
  // SampleGeometry/Solver), so a director can bind a Track-To's target from its own
  // inspector instead of only through the bespoke camera look-at dropdown (#341, the last
  // sidecar). `shape:'id'` because `aimNode` is a plain string id (the enumeration reads
  // it raw); `transformable` because the aim reads the target's WORLD position.
  refParams: { aimNode: { label: 'aim target', kind: 'transformable', shape: 'id' } },
  evaluate(params): TrackToConstraintValue {
    return {
      kind: 'Constraint',
      constraintType: 'trackTo',
      name: params.name,
      target: params.target,
      aimNode: params.aimNode,
      aimBone: params.aimBone,
      aimPoint: params.aimPoint,
      aimSpace: params.aimSpace,
      up: params.up,
      roll: params.roll,
      mute: params.mute,
      order: params.order,
    };
  },
};
