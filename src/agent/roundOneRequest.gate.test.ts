// #334 — what the first request of a turn costs. Two things on it were paid for twice
// or paid for and never used:
//
//   1. The system prompt restated every tool's name and description in an
//      "Available tools" block — the same 17 descriptions the request's `tools` array
//      already carries. ~6.5 KB, about a fifth of round 1.
//   2. dag.exec advertised the full OpSchema union, nine variants, while its
//      description names four. ~3.9 KB, the largest single schema on the wire.
//
// This gate drives the REAL turn loop with only the transport mocked, and reads the
// request the provider would be handed.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk, ToolSchema } from './transport/types';

// Only the network half is mocked; buildToolSchemas stays real.
const streamMock = vi.hoisted(() => vi.fn());
vi.mock('./transport/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transport/openai')>();
  return { ...real, streamChatCompletion: streamMock };
});

import { runAgentTurn, type TurnOptions } from './orchestrator';
import { useDiffStore } from './diff';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllMutators } from './mutators';
import { registerAllTools } from './tools';
import { useDagStore } from '../core/dag/store';
import { useAgentSessionStore } from './session/store';
import { buildDefaultDagState } from '../core/project/default';
import type { LLMConfig } from './transport/types';

const CONFIG: LLMConfig = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };
const TURN: TurnOptions = {
  message: 'add a sphere to the scene',
  mode: 'copilot',
  selectedNodeIds: new Set<string>(),
};

interface Captured {
  messages: ChatMessage[];
  tools: ToolSchema[];
}

__resetRegistryForTests();
registerAllNodes();
registerAllMutators();
registerAllTools();

beforeEach(() => {
  useDagStore.getState().hydrate(buildDefaultDagState());
  useAgentSessionStore.getState().reset();
  useDiffStore.getState().reset();
  streamMock.mockReset();
});

/** Runs one turn whose model answers each round with `reply(round)`; returns every request. */
async function turn(reply: (round: number) => StreamChunk[]): Promise<Captured[]> {
  const requests: Captured[] = [];
  streamMock.mockImplementation(
    async (
      _c: unknown,
      o: { messages: ChatMessage[]; tools: ToolSchema[]; onChunk: (c: StreamChunk) => void },
    ) => {
      // The array is live — the loop keeps pushing to it — so copy it.
      requests.push({ messages: [...o.messages], tools: o.tools });
      for (const c of reply(requests.length)) o.onChunk(c);
      o.onChunk({ type: 'done' });
    },
  );
  await runAgentTurn(CONFIG, TURN);
  return requests;
}

const toolCall = (name: string, args: unknown): StreamChunk =>
  ({
    type: 'tool_call',
    tool_call: {
      id: `call_${name}`,
      index: 0,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  }) as StreamChunk;

/** The `type` values dag.exec's advertised schema admits, read off the wire schema. */
function advertisedOpTypes(tools: ToolSchema[]): string[] {
  const exec = tools.find((t) => t.name === 'dag.exec');
  const params = exec?.parameters as {
    properties: { ops: { items: { anyOf?: unknown[]; oneOf?: unknown[] } } };
  };
  const variants = (params.properties.ops.items.anyOf ?? params.properties.ops.items.oneOf) as {
    properties: { type: { enum: string[] } };
  }[];
  return variants.flatMap((v) => v.properties.type.enum).sort();
}

describe('#334 — the round-1 request carries each thing once', () => {
  it('the system prompt does not restate the tools the request already carries', async () => {
    const [first] = await turn(() => [{ type: 'text', text: 'ok' }]);
    const system = String(first.messages.find((m) => m.role === 'system')?.content);

    // The tools are all still offered, with their descriptions, in the tools array.
    expect(first.tools.length).toBeGreaterThan(10);
    for (const t of first.tools) expect(t.description.length).toBeGreaterThan(0);

    // And not one description is repeated in the system prompt.
    const restated = first.tools.filter((t) => system.includes(t.description));
    expect(restated.map((t) => t.name)).toEqual([]);
    expect(system).not.toContain('Available tools:');
  });

  it("dag.exec advertises the five ops it takes, not the op layer's nine", async () => {
    const [first] = await turn(() => [{ type: 'text', text: 'ok' }]);
    expect(advertisedOpTypes(first.tools)).toEqual(
      ['addNode', 'connect', 'disconnect', 'removeNode', 'setParam'].sort(),
    );
  });

  it('an op outside that set is answered to the model as an error, and the turn goes on', async () => {
    const requests = await turn((round) =>
      round === 1
        ? [
            toolCall('dag.exec', {
              description: 'hide the light',
              ops: [{ type: 'setHidden', nodeId: 'n_light', hidden: true }],
            }),
          ]
        : [{ type: 'text', text: 'done' }],
    );
    expect(requests.length).toBe(2);
    const answer = requests[1].messages
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content))
      .join('\n');
    expect(answer).toMatch(/^ERROR/);
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });
});
