// Strategy resources — workflow guidance the LLM fetches lazily.
//
// The system prompt is the most expensive context — it's re-sent every
// round of every turn. Workflow preferences (units, materials, lighting,
// cameras, asset choice) only matter contextually: the model needs the
// lighting strategy when the user asks about lighting, not on every
// "add a red cube" round. Lazy resources save ~500-1000 tokens/round.
//
// REF: P2.5.2 PLAN §5 Wave D step 8; vyapti V15 (strategy separated).

export type StrategyTopic =
  | 'units'
  | 'materials'
  | 'lighting'
  | 'cameras'
  | 'assetChoice'
  | 'spawnWithProperties';

export interface StrategyResource {
  topic: StrategyTopic;
  /** One-line description used in agent.listStrategies / system-prompt index. */
  description: string;
  /** Markdown body. Returned verbatim by agent.getStrategy. */
  body: string;
}
