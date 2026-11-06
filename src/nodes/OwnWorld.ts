// OwnWorld — the bottom of a constraint chain (#1811).
//
// A chain runs from an object's own world up to that object: what the constraints start from is
// the world it would have with none (its parent's world times its own transform), and what they
// end in is its world. Taking the start off the object's `world` output would be a wire from the
// object into its own chain and so a loop, so this node names the object in a param and the
// evaluator hands it that world (`evalOwnWorld`).
//
// As Houdini's Get World Space CHOP at the bottom of a constraints network. Blender has no such
// node because its stack starts implicitly from the owner's matrix.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { optionsParam } from './paramWidget';
import { constrainedObjectOptions } from '../app/constraintStack';

export const OwnWorldParams = z.object({
  /** The object whose world this reads, before its constraint chain. */
  object: optionsParam(
    z.string().default(''),
    // Wrapped like TrackTo's `target`, for the same load-order reason (#1065).
    (s) => constrainedObjectOptions(s),
    undefined,
    'nodeId',
  ),
});
export type OwnWorldParams = z.infer<typeof OwnWorldParams>;

export const OwnWorldNode: NodeDefinition<OwnWorldParams, null> = {
  type: 'OwnWorld',
  version: 1,
  pure: true,
  ownWorldOf: 'object',
  cost: 'cheap',
  paramSchema: OwnWorldParams,
  // It dies with its object, as a constraint does.
  idRefs: [{ path: 'object', shape: 'id', role: 'subject' }],
  inputs: {},
  outputs: { world: { type: 'Matrix4', cardinality: 'single', world: true } },
  // The evaluator answers the world output; this node has no other value.
  evaluate: () => null,
};
