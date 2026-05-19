// character.walkTo — agent tool wrapping buildWalkToOps.
//
// Pure: returns Op[] (never dispatches). The Diff system applies to the
// forked DAG; the user accepts before any real mutation.
//
// REF: THESIS.md §40, vyapti V7, krama K7.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types';
import { buildWalkToOps } from '../../app/character/walkTo';

export const characterWalkToSchema = z.object({
  characterId: z.string().min(1, 'characterId is required'),
  worldPoint: z.array(z.number()).length(3).describe('Target position as [x, y, z]'),
});

export type CharacterWalkToArgs = z.infer<typeof characterWalkToSchema>;

export const characterWalkToTool: ToolDefinition<CharacterWalkToArgs> = {
  name: 'character.walkTo',
  description:
    'Make a Character node walk to a world-space point. ' +
    "Returns an Op[] that adds/connects a WalkPath to the character's LocomotionState.",
  paramSchema: characterWalkToSchema,
  handler(args: CharacterWalkToArgs, ctx: ToolContext): ToolResult {
    const result = buildWalkToOps(
      ctx.dagState,
      args.characterId,
      args.worldPoint as [number, number, number],
    );
    if (!result) {
      throw new Error(
        'character.walkTo: character not found, or missing Navmesh/LocomotionState. ' +
          'Ensure the character has a LocomotionState wired, and the project has a Navmesh node.',
      );
    }
    return { ops: result.ops, text: `Walk to [${args.worldPoint}]` };
  },
};
