// agent.getStrategy + agent.listStrategies — LLM-facing surface for
// the strategy catalog.
//
// REF: P2.5.2 PLAN §5 Wave D step 8; vyapti V15.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types';
import { getStrategy, listStrategyMetadata } from './catalog';

// ---------------------------------------------------------------------------
// agent.listStrategies
// ---------------------------------------------------------------------------

const listStrategiesSchema = z.object({}).default({});

export const listStrategiesTool: ToolDefinition<Record<string, never>> = {
  name: 'agent.listStrategies',
  description:
    'List the registered strategy resources (workflow guidance topics: ' +
    'units, materials, lighting, cameras, assetChoice). Read-only metadata; ' +
    'use agent.getStrategy({ topic }) to fetch the body.',
  paramSchema: listStrategiesSchema as unknown as z.ZodType<
    Record<string, never>,
    z.ZodTypeDef,
    unknown
  >,
  handler(_args, _ctx: ToolContext): ToolResult {
    return {
      ops: [],
      text: JSON.stringify({ strategies: listStrategyMetadata() }, null, 2),
    };
  },
};

// ---------------------------------------------------------------------------
// agent.getStrategy
// ---------------------------------------------------------------------------

const getStrategySchema = z.object({
  topic: z
    .enum(['units', 'materials', 'lighting', 'cameras', 'assetChoice'])
    .describe('Strategy topic. Call agent.listStrategies if unsure.'),
});

export type GetStrategyArgs = z.infer<typeof getStrategySchema>;

export const getStrategyTool: ToolDefinition<GetStrategyArgs> = {
  name: 'agent.getStrategy',
  description:
    'Fetch a strategy resource (markdown body) by topic. Read-only. Use ' +
    'when the user asks about lighting / materials / cameras / units / ' +
    'asset choice and you need workflow guidance beyond the system prompt.',
  paramSchema: getStrategySchema,
  handler(args: GetStrategyArgs, _ctx: ToolContext): ToolResult {
    const resource = getStrategy(args.topic);
    if (!resource) {
      return { ops: [], text: `ERROR: strategy "${args.topic}" not registered.` };
    }
    return { ops: [], text: resource.body };
  },
};
