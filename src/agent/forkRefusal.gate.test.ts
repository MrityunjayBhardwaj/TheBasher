// #1401 — a dag.exec batch the op layer refuses is ANSWERED, not the end of the turn.
//
// The point of answering is that the model can correct itself inside the same turn. This
// drives the REAL turn loop (transport mocked): round 1 sends a batch naming a node that does
// not exist, round 2 — having read the refusal — sends the corrected batch, round 3 ends. Only
// the corrected batch may be proposed; the refused one must contribute nothing.

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
import type { Op } from '../core/dag/types';
import type { LLMConfig } from './transport/types';

const CONFIG: LLMConfig = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };
const TURN: TurnOptions = { message: 'go', mode: 'copilot', selectedNodeIds: new Set<string>() };

const exec = (id: string, ops: Op[]): StreamChunk =>
  ({
    type: 'tool_call',
    tool_call: {
      id,
      index: 0,
      type: 'function',
      function: { name: 'dag.exec', arguments: JSON.stringify({ description: id, ops }) },
    },
  }) as StreamChunk;

const move = (nodeId: string): Op =>
  ({ type: 'setParam', nodeId, paramPath: 'position', value: [5, 0, 0] }) as Op;

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

describe('#1401 — the model corrects a refused batch inside the same turn', () => {
  it('THE PIN: refused → read → corrected, and only the corrected batch is proposed', async () => {
    let round = 0;
    let roundTwo: ChatMessage[] = [];
    streamMock.mockImplementation(
      async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
        round++;
        if (round === 1)
          o.onChunk(exec('bad', [move('n_cube')])); // the id is n_box
        else if (round === 2) {
          // A COPY: the array is the live conversation, and this round's own answer is
          // appended to it after the call returns.
          roundTwo = [...o.messages];
          o.onChunk(exec('good', [move('n_box')]));
        } else o.onChunk({ type: 'text', text: 'moved' });
        o.onChunk({ type: 'done', finish_reason: 'stop' } as StreamChunk);
      },
    );
    const result = await runAgentTurn(CONFIG, TURN);

    const refusal = roundTwo.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatch(/^ERROR: .*n_cube.*nothing in this batch was proposed/);

    expect(result.error).toBeNull();
    const pending = useDiffStore.getState().pendingDiff;
    expect(pending?.ops).toEqual([move('n_box')]);
  });

  it('a refused batch after a good one does not take the good one down with it', async () => {
    let round = 0;
    streamMock.mockImplementation(async (_c: unknown, o: { onChunk: (c: StreamChunk) => void }) => {
      round++;
      if (round === 1) o.onChunk(exec('good', [move('n_box')]));
      else if (round === 2) o.onChunk(exec('bad', [move('n_cube')]));
      else o.onChunk({ type: 'text', text: 'done' });
      o.onChunk({ type: 'done', finish_reason: 'stop' } as StreamChunk);
    });
    const result = await runAgentTurn(CONFIG, TURN);
    expect(result.error).toBeNull();
    expect(useDiffStore.getState().pendingDiff?.ops).toEqual([move('n_box')]);
  });
});
