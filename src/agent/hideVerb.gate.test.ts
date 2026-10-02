// #1445 — "hide the light", "show it again". #334 cut `setHidden` from dag.exec's raw ops, so
// the agent lost the only road it had to the outliner's eye; mutator.setHidden replaces it.
//
// This drives the REAL turn loop with only the transport mocked. Round 1 tries the raw op the
// way a model trained on the old surface would; the schema refuses it and the turn goes on.
// Round 2 takes the verb. The pending diff is what the director would accept.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk } from './transport/types';

const streamMock = vi.hoisted(() => vi.fn());
vi.mock('./transport/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transport/openai')>();
  return { ...real, streamChatCompletion: streamMock };
});

import { runAgentTurn, type TurnOptions } from './orchestrator';
import { useDiffStore } from './diff';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllMutators } from './mutators';
import { registerAllTools } from './tools';
import { useDagStore } from '../core/dag/store';
import { useAgentSessionStore } from './session/store';
import { buildDefaultDagState } from '../core/project/default';
import type { LLMConfig } from './transport/types';

const CONFIG: LLMConfig = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };
const turn = (message: string): TurnOptions => ({
  message,
  mode: 'copilot',
  selectedNodeIds: new Set<string>(),
});

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

/** Script the rounds: each entry is what the model calls in that round; then it says `done`. */
function script(rounds: ((msgs: ChatMessage[]) => StreamChunk)[]): { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  streamMock.mockImplementation(
    async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
      seen.push(o.messages);
      const step = rounds[seen.length - 1];
      o.onChunk(step ? step(o.messages) : ({ type: 'text', text: 'done' } as StreamChunk));
      o.onChunk({ type: 'done' });
    },
  );
  return { seen };
}

const hidden = (id: string) =>
  useDiffStore.getState().pendingDiff?.forkState.nodes[id]?.meta?.hidden ?? false;

describe('#1445 — the agent hides and shows through the verb', () => {
  it('"hide the light": the raw op is refused and changes nothing; the verb hides it', async () => {
    const { seen } = script([
      () =>
        toolCall('dag.exec', {
          description: 'hide the light',
          ops: [{ type: 'setHidden', nodeId: 'n_light', hidden: true }],
        }),
      () =>
        toolCall('agent.proposePlan', {
          mutator: 'mutator.setHidden',
          intent: 'hide the light',
          spec: { targetSelectors: ['n_light'], hidden: true },
        }),
    ]);

    const result = await runAgentTurn(CONFIG, turn('hide the light'));

    expect(result.error).toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // Round 2 was handed round 1's refusal, so the raw op proposed nothing: the hide below is
    // the verb's alone.
    expect(toolText(seen[1])).toMatch(/error|invalid/i);
    const pending = useDiffStore.getState().pendingDiff;
    expect(pending).not.toBeNull();
    expect(pending!.ops).toEqual([{ type: 'setHidden', nodeId: 'n_light', hidden: true }]);
    expect(hidden('n_light')).toBe(true);
  });

  it('"show it again": the verb clears the flag on a hidden light', async () => {
    useDagStore
      .getState()
      .hydrate(
        applyOp(buildDefaultDagState(), { type: 'setHidden', nodeId: 'n_light', hidden: true })
          .next,
      );
    script([
      () =>
        toolCall('agent.proposePlan', {
          mutator: 'mutator.setHidden',
          intent: 'show the light again',
          spec: { targetSelectors: ['n_light'], hidden: false },
        }),
    ]);

    const result = await runAgentTurn(CONFIG, turn('show the light again'));

    expect(result.error).toBeNull();
    const pending = useDiffStore.getState().pendingDiff;
    expect(pending!.ops).toEqual([{ type: 'setHidden', nodeId: 'n_light', hidden: false }]);
    expect(hidden('n_light')).toBe(false);
  });
});
