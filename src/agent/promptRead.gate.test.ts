// #1057 — a turn must not act on a prompt the model did not read.
//
// Ollama shortens an over-long prompt from the FRONT and answers normally, so the
// system prompt is what goes missing and nothing in the reply says so. Measured on
// the product's own requests against `qwen3:4b` at a 4,096-token window: four
// rounds read 64%, 63%, 62% and 47% of what was sent, the turn looked healthy, and
// the model picked a stub generator over the `mesh.add` tool it had been offered.
//
// This gate drives the REAL turn loop with a mocked transport whose reported
// `prompt_tokens` is derived from the request the orchestrator actually built —
// so the numbers below are the measured ratios, applied to this turn's own size.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk, ToolSchema } from './transport/types';

// Only the network half is mocked; buildToolSchemas stays real.
const streamMock = vi.hoisted(() => vi.fn());
vi.mock('./transport/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transport/openai')>();
  return { ...real, streamChatCompletion: streamMock };
});

import {
  runAgentTurn,
  estimateRequestTokens,
  promptReadShortfall,
  MIN_PROMPT_READ_RATIO,
} from './orchestrator';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllMutators } from './mutators';
import { registerAllTools } from './tools';
import { useDagStore } from '../core/dag/store';
import { useAgentSessionStore } from './session/store';
import { useDiffStore } from './diff';
import { buildDefaultDagState } from '../core/project/default';

const CONFIG = { baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never;

const ROTATE = JSON.stringify({
  ops: [{ type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] }],
  description: 'rotate the cube',
});

/**
 * What the provider reports for one round, given this round's estimate and the
 * previous round's reported count. `undefined` = the provider sends no usage.
 */
type Report = (estimate: number, previousReported: number | undefined) => number | undefined;

/**
 * Round 1 calls `dag.exec` (one real op); round 2 answers in text and ends the
 * turn. Each round's usage comes from `reports[round - 1]`.
 */
async function turn(reports: [Report, Report]) {
  let round = 0;
  let previous: number | undefined;
  streamMock.mockImplementation(
    async (
      _c: unknown,
      o: { messages: ChatMessage[]; tools: ToolSchema[]; onChunk: (c: StreamChunk) => void },
    ) => {
      round++;
      const estimate = estimateRequestTokens(o.messages, o.tools);
      if (round === 1) {
        o.onChunk({
          type: 'tool_call',
          tool_call: {
            id: 'call_1',
            index: 0,
            type: 'function',
            function: { name: 'dag.exec', arguments: ROTATE },
          },
        } as StreamChunk);
      } else {
        o.onChunk({ type: 'text', text: 'done' });
      }
      const reported = reports[round - 1](estimate, previous);
      previous = reported;
      o.onChunk(
        reported === undefined
          ? { type: 'done' }
          : { type: 'done', usage: { prompt_tokens: reported, completion_tokens: 40 } },
      );
    },
  );
  // 🔴 The selection is a SET. Passed as `[]` (as the #1014 harness does), `.size`
  // is undefined, the closure is inferred with ZERO roots, and every plan is
  // refused at propose time — which that harness never reaches, and which made
  // this file's controls fail for a reason unrelated to the prompt read.
  const result = await runAgentTurn(CONFIG, {
    message: 'go',
    mode: 'agent',
    selectedNodeIds: new Set<string>(),
  } as never);
  return {
    result,
    rounds: round,
    diff: useDiffStore.getState(),
    chat: JSON.stringify(useAgentSessionStore.getState().session),
  };
}

// The measured round-1 ratios (reported / estimate) on the product's own request.
const UNCUT_QWEN3 = 6363 / 7250; // 0.878 — the lowest real tokenizer measured
const CUT_AT_4096 = 4096 / 7250; // 0.565 — the same request at a 4,096-token window

const ratio =
  (r: number): Report =>
  (estimate) =>
    Math.floor(estimate * r);

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

describe('#1057 — a turn does not act on a prompt the model did not read', () => {
  it('THE PIN: a round read at the measured cut ratio is refused before its tool runs', async () => {
    const { result, rounds, diff, chat } = await turn([ratio(CUT_AT_4096), ratio(UNCUT_QWEN3)]);
    expect(result.error).toContain('did not read the whole prompt');
    expect(rounds, 'the turn must stop at the round that was cut').toBe(1);
    // Its tool call was chosen against the cut prompt: nothing it asked for runs.
    expect(chat).not.toContain('[dag.exec]');
    expect(diff.status).toBe('idle');
    // And the director is told, in the chat, not only in the returned value.
    expect(chat).toContain('did not read the whole prompt');
  });

  it('CONTROL: the lowest real tokenizer measured, uncut, runs the whole turn', async () => {
    const { result, rounds, diff, chat } = await turn([ratio(UNCUT_QWEN3), ratio(UNCUT_QWEN3)]);
    expect(result.error).toBeNull();
    expect(rounds).toBe(2);
    expect(chat).toContain('[dag.exec]');
    expect(diff.status).toBe('pending');
    expect(diff.pendingDiff?.ops).toHaveLength(1);
  });

  it('FLAT: a count that does not grow with the prompt is refused, and the earlier op is not proposed', async () => {
    // Round 1 reads fine; round 2 carries round 1's call and result, so it is
    // bigger — and the provider reports the same count. That is a window.
    const { result, rounds, diff } = await turn([
      ratio(UNCUT_QWEN3),
      (_estimate, previous) => previous,
    ]);
    expect(rounds).toBe(2);
    expect(result.error).toContain('did not read the whole prompt');
    expect(result.error).toContain('no more than');
    // Round 1's op was made at the window's edge; a half plan is not proposed.
    expect(diff.status).toBe('idle');
  });

  it('CONTROL: a provider that sends no usage is not refused — there is nothing to read', async () => {
    const none: Report = () => undefined;
    const { result, rounds, diff } = await turn([none, none]);
    expect(result.error).toBeNull();
    expect(rounds).toBe(2);
    expect(diff.status).toBe('pending');
  });
});

describe('promptReadShortfall — against the measured requests', () => {
  // Round 1 of the captured turn: estimate 7,250.
  it('passes an uncut count from every tokenizer measured (qwen3, o200k, cl100k)', () => {
    for (const reported of [6363, 6687, 6628]) {
      expect(promptReadShortfall({ reported, estimated: 7250 })).toBeNull();
    }
  });

  it('refuses all four captured rounds as read at a 4,096-token window', () => {
    for (const estimated of [7250, 7425, 7572, 9736]) {
      expect(promptReadShortfall({ reported: 4096, estimated })).toContain('4096');
    }
  });

  it('the floor sits between the two populations, not at either edge', () => {
    expect(MIN_PROMPT_READ_RATIO).toBeGreaterThan(CUT_AT_4096);
    expect(MIN_PROMPT_READ_RATIO).toBeLessThan(UNCUT_QWEN3);
  });

  it('FLAT fires on a count that held while the request grew, and not on noise', () => {
    const previous = { reported: 6000, estimated: 6800 };
    expect(promptReadShortfall({ reported: 6000, estimated: 6975 }, previous)).toContain(
      'no more than',
    );
    // Growth too small to be evidence.
    expect(promptReadShortfall({ reported: 6000, estimated: 6820 }, previous)).toBeNull();
    // A count that grew with it.
    expect(promptReadShortfall({ reported: 6150, estimated: 6975 }, previous)).toBeNull();
  });

  it('a zero count is no reading, never a short one', () => {
    expect(promptReadShortfall({ reported: 0, estimated: 7250 })).toBeNull();
  });
});
