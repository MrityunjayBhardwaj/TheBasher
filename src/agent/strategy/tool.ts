// agent.getStrategy + agent.listStrategies — LLM-facing surface for
// the strategy catalog.
//
// REF: P2.5.2 PLAN §5 Wave D step 8; vyapti V15.

import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types';
import { getStrategy, listStrategyMetadata } from './catalog';
import type { StrategyTopic } from './types';

// Single source of truth for the topic enum. Derived from StrategyTopic
// so adding a new topic to types.ts auto-extends the zod schema (and
// every consumer that reads it). Without this, types.ts and tool.ts
// drift — H23 class.
const STRATEGY_TOPICS = [
  'units',
  'materials',
  'lighting',
  'cameras',
  'assetChoice',
  'spawnWithProperties',
  'animation',
  'rendering',
  'aiRender',
] as const satisfies readonly StrategyTopic[];

// Compile-time check: STRATEGY_TOPICS covers every StrategyTopic.
type _CheckExhaustive =
  Exclude<StrategyTopic, (typeof STRATEGY_TOPICS)[number]> extends never ? true : never;
const _checkExhaustive: _CheckExhaustive = true;
void _checkExhaustive;

// ---------------------------------------------------------------------------
// agent.listStrategies
// ---------------------------------------------------------------------------

const listStrategiesSchema = z.object({}).default({});

export const listStrategiesTool: ToolDefinition<Record<string, never>> = {
  name: 'agent.listStrategies',
  description:
    'List the registered strategy resources (workflow guidance topics: ' +
    `${STRATEGY_TOPICS.join(', ')}). Read-only metadata; ` +
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
  topic: z.enum(STRATEGY_TOPICS).describe('Strategy topic. Call agent.listStrategies if unsure.'),
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
