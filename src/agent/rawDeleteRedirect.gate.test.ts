// #335 — "delete the light". The model reached for dag.exec's raw removeNode, the op
// layer (correctly) refused to orphan the scene's edge, and the refusal ENDED THE TURN:
// the throw happens in the speculative fork, after the model had already been told
// "Proposed 1 Op(s)", so it never saw why and the director got a raw OpError.
//
// dag.exec now refuses removeNode in its handler, before any fork, with a redirect that
// names the mutator and carries the ids. This gate drives the REAL turn loop with only
// the transport mocked, and reads what the model is actually handed on the next round.
// Round 2 does what a model reading the redirect would do: it copies the call out of it.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk } from './transport/types';

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
  message: 'delete the light',
  mode: 'copilot',
  selectedNodeIds: new Set<string>(),
};

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

const toolText = (msgs: ChatMessage[]): string =>
  msgs
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');

/** The agent.proposePlan argument object the redirect names, read back out of its text. */
function planOutOf(text: string): unknown {
  const m = /agent\.proposePlan\((\{.*?\})\)/.exec(text);
  return m ? JSON.parse(m[1]) : null;
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

describe('#335 — a raw delete is redirected to the mutator, inside the same turn', () => {
  it('THE PIN: the model sees the redirect, follows it, and the light goes — both halves', async () => {
    let round = 0;
    let roundTwo: ChatMessage[] = [];
    streamMock.mockImplementation(
      async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
        round++;
        if (round === 1) {
          o.onChunk(
            toolCall('dag.exec', {
              description: 'delete the light',
              ops: [{ type: 'removeNode', nodeId: 'n_light' }],
            }),
          );
        } else if (round === 2) {
          roundTwo = o.messages;
          o.onChunk(toolCall('agent.proposePlan', planOutOf(toolText(o.messages))));
        } else {
          o.onChunk({ type: 'text', text: 'deleted' });
        }
        o.onChunk({ type: 'done' });
      },
    );

    const result = await runAgentTurn(CONFIG, TURN);

    // The turn survived the raw attempt: it reached round 2 and ended without an error.
    expect(result.error).toBeNull();
    const redirect = toolText(roundTwo);
    expect(redirect).toContain('ERROR: dag.exec does not delete nodes');
    expect(planOutOf(redirect)).toEqual({
      mutator: 'mutator.deleteNode',
      intent: 'delete',
      spec: { targetSelectors: ['n_light'] },
    });

    // And the road it points at arrives: a pending diff with the light and its data gone.
    const pending = useDiffStore.getState().pendingDiff;
    expect(pending).not.toBeNull();
    expect(pending!.forkState.nodes.n_light).toBeUndefined();
    expect(pending!.forkState.nodes.n_light_data).toBeUndefined();
    expect(pending!.ops.some((o) => o.type === 'removeNode')).toBe(true);
  });

  it('a batch carrying a removeNode proposes NOTHING, not the half without it', async () => {
    let round = 0;
    streamMock.mockImplementation(
      async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
        round++;
        if (round === 1) {
          o.onChunk(
            toolCall('dag.exec', {
              description: 'swap the light',
              ops: [
                { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [5, 0, 0] },
                { type: 'removeNode', nodeId: 'n_light' },
              ],
            }),
          );
        } else {
          o.onChunk({ type: 'text', text: 'ok' });
        }
        o.onChunk({ type: 'done' });
      },
    );
    await runAgentTurn(CONFIG, TURN);
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('the system prompt no longer TEACHES removeNode as a dag.exec op', async () => {
    // The old op example 3 was `{"type":"removeNode","nodeId":"box1"}` right after an example
    // that wires box1 into the scene — the exact foot-gun, taught.
    let system = '';
    streamMock.mockImplementation(
      async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
        system = String(o.messages[0].content);
        o.onChunk({ type: 'text', text: 'ok' });
        o.onChunk({ type: 'done' });
      },
    );
    await runAgentTurn(CONFIG, TURN);
    expect(system).toContain('mutator.deleteNode');
    expect(system).not.toContain('{"type":"removeNode"');
  });
});
