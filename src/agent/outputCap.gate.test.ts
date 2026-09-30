// #1405 — a round the provider cut at `max_tokens` is not an answer.
//
// Measured on the wire (qwen3:4b, "point the camera at the cube"): after identify matched, the
// model spent all 4096 output tokens reasoning — 17,413 reasoning chars, 0 of content, no tool
// call — and the stream ended `finish_reason: "length"`. The orchestrator never read
// finish_reason, so the round counted as "text-only → turn complete": `error: null`, a blank
// reply, nothing proposed. The director saw an agent that chose to say nothing.
//
// This drives the REAL turn loop with only the transport mocked, and feeds the provider's
// actual ending: the finish chunk says `length`, then the usage chunk and `[DONE]` each arrive
// as another `done` the transport defaults to 'stop'. The LAST word is not the true one.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StreamChunk } from './transport/types';

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

const CONFIG: LLMConfig = { baseUrl: 'http://x', model: 'm', apiKey: 'k', maxTokens: 4096 };
const TURN: TurnOptions = { message: 'go', mode: 'copilot', selectedNodeIds: new Set<string>() };

/** The provider's real ending for a round: the finish chunk, then usage, then [DONE]. */
function end(onChunk: (c: StreamChunk) => void, finish: string, completion: number): void {
  onChunk({ type: 'done', finish_reason: finish } as StreamChunk);
  onChunk({
    type: 'done',
    finish_reason: 'stop',
    usage: { prompt_tokens: 0, completion_tokens: completion },
  } as StreamChunk);
  onChunk({ type: 'done', finish_reason: 'stop' } as StreamChunk);
}

const moveBox = (id: string): StreamChunk =>
  ({
    type: 'tool_call',
    tool_call: {
      id,
      index: 0,
      type: 'function',
      function: {
        name: 'dag.exec',
        arguments: JSON.stringify({
          description: 'move',
          ops: [{ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [5, 0, 0] }],
        }),
      },
    },
  }) as StreamChunk;

type Round = (onChunk: (c: StreamChunk) => void) => void;

function script(rounds: Round[]): void {
  let n = 0;
  streamMock.mockImplementation(async (_c: unknown, o: { onChunk: (c: StreamChunk) => void }) => {
    const r = rounds[n++];
    if (r) r(o.onChunk);
    else end(o.onChunk, 'stop', 1);
  });
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

describe('#1405 — a round cut at the output cap refuses the turn', () => {
  it('THE PIN: cut with no reply and no tool call → an error naming the cap, not a blank "done"', async () => {
    script([(on) => end(on, 'length', 4096)]);
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toMatch(/hit the 4096-token output cap/);
    expect(result.error).toMatch(/without replying or calling a tool/);
    expect(useAgentSessionStore.getState().session.error).toBe(result.error);
  });

  it('a tool call in the cut round is not run', async () => {
    script([
      (on) => {
        on(moveBox('c1'));
        end(on, 'length', 4096);
      },
    ]);
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toMatch(/in the middle of a tool call/);
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it("an earlier round's ops are not proposed either — half a plan is not handed over", async () => {
    script([
      (on) => {
        on(moveBox('c1'));
        end(on, 'tool_calls', 50);
      },
      (on) => end(on, 'length', 4096),
    ]);
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toMatch(/output cap/);
    expect(useDiffStore.getState().pendingDiff).toBeNull();
  });

  it('control: a round that ends "stop" completes as before', async () => {
    script([
      (on) => {
        on({ type: 'text', text: 'hello' } as StreamChunk);
        end(on, 'stop', 3);
      },
    ]);
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toBeNull();
    expect(result.text).toBe('hello');
  });

  it('control: a tool round ending "tool_calls" still runs its call', async () => {
    script([
      (on) => {
        on(moveBox('c1'));
        end(on, 'tool_calls', 50);
      },
    ]);
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toBeNull();
    expect(useDiffStore.getState().pendingDiff).not.toBeNull();
  });
});
