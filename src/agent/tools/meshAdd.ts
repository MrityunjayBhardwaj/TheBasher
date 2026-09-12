// mesh.add — agent tool wrapping buildAddPrimitiveOps.
//
// Pure: returns Op[] (never dispatches). Supports adding any PrimitiveKind
// (meshes, lights, cameras, empties) into the scene.
//
// REF: THESIS.md §39-40, vyapti V7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { buildAddPrimitiveOps, SCENE_OBJECT_KINDS } from '../../app/addPrimitives';

// DERIVED from the Add menu's scene-object vocabulary — never a hand-copied subset of it
// (#324). The enum used to be typed out here, so a scene object added to the menu was
// mouse-creatable and VOICELESS until someone remembered to copy it across: `Null` and
// `Curve` both shipped that way, and the failure was a runtime zod rejection — no compile
// error, no failing test, just an agent that says it cannot do a thing the app plainly does.
// Whatever the director can add with the mouse, they can now ask for by name, by
// construction.
const kindSchema = z.enum(SCENE_OBJECT_KINDS);

export const meshAddSchema = z.object({
  kind: kindSchema.describe('The type of primitive to add'),
  position: z
    .array(z.number())
    .length(3)
    .default([0, 0, 0])
    .describe('Spawn position as [x, y, z]'),
});

export type MeshAddArgs = z.infer<typeof meshAddSchema>;

export const meshAddTool: ToolDefinition<MeshAddArgs> = {
  name: 'mesh.add',
  // The supported list is INTERPOLATED from the same source as the schema. A hand-written
  // sentence here would be a third copy of the vocabulary — and the one the LLM actually
  // reads, so it would go stale first and loudest ("I can't add a curve").
  description:
    'Add a scene object to the scene: a mesh, light, camera, empty, controller, or path. ' +
    'Returns an Op[] that creates and optionally wires the node into the Scene aggregator. ' +
    `Supports: ${SCENE_OBJECT_KINDS.join(', ')}. ` +
    'Null is an empty controller/target (Blender Empty); Curve is a path of control points ' +
    'that objects can follow. Returns newNodeId (the object you select and refer to) and, ' +
    'for a kind that has one, dataNodeId — the node holding the params that describe the ' +
    "thing itself: a Curve's points, a light's colour, a camera's fov.",
  paramSchema: meshAddSchema,
  handler(args: MeshAddArgs, ctx: ToolContext): ToolResult {
    const result = buildAddPrimitiveOps(
      ctx.dagState,
      args.kind,
      args.position as [number, number, number],
    );
    if (!result) {
      throw new Error('mesh.add: no Scene output found in the DAG');
    }
    // Surface newNodeId so chained Mutators (e.g. setMaterialColor) can
    // target it without a follow-up dag.inspect. JSON-shaped so the LLM
    // parses unambiguously — see strategy 'spawnWithProperties'.
    //
    // ...and `dataNodeId` beside it (#772). A split kind mints two nodes and the
    // agent was told about one: the POSE. Every param that describes the thing
    // itself — a curve's `points`, a light's colour, a camera's `fov` — lives on
    // the other one, whose id was discarded one call earlier. The id was
    // recoverable through `dag.inspect`'s `data` edge, so this is a round trip
    // saved rather than a capability gained — except that an LLM has to KNOW to
    // make that round trip, which is the kind of thing learned by failing first.
    // Omitted entirely for a fused kind, so its absence means "there is no second
    // node" rather than "I did not tell you".
    return {
      ops: result.ops,
      text: JSON.stringify({
        kind: args.kind,
        newNodeId: result.newNodeId,
        ...(result.dataNodeId !== undefined ? { dataNodeId: result.dataNodeId } : {}),
        position: args.position,
      }),
    };
  },
};
