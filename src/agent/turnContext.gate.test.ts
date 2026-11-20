// #1705 — the context chips reach the model: which pane the director was last in (Where), the
// playhead and its shot (When), and the selection (What). Each is a line in the turn's Context
// block, and each is gone when its chip is dismissed.
//
// The block rides in the USER message, never the system prompt, so a moved playhead or a new pane
// does not churn the cached prompt; and a turn with no chips sends exactly what it sent before
// there were chips.
//
// Drives the real turn loop with only the transport mocked (the #334 pattern).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk } from './transport/types';

const streamMock = vi.hoisted(() => vi.fn());
vi.mock('./transport/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transport/openai')>();
  return { ...real, streamChatCompletion: streamMock };
});

import { buildContextBlock, runAgentTurn, type TurnOptions } from './orchestrator';
import { useDiffStore } from './diff';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllMutators } from './mutators';
import { registerAllTools } from './tools';
import { useDagStore } from '../core/dag/store';
import { useAgentSessionStore, summarizeDag } from './session/store';
import { buildDefaultDagState } from '../core/project/default';
import type { LLMConfig } from './transport/types';

const CONFIG: LLMConfig = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };

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

/** One turn whose model just answers "ok"; returns the first request's messages. */
async function firstRequest(options: Partial<TurnOptions>): Promise<ChatMessage[]> {
  const requests: ChatMessage[][] = [];
  streamMock.mockImplementation(
    async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
      requests.push([...o.messages]);
      o.onChunk({ type: 'text', text: 'ok' });
      o.onChunk({ type: 'done' });
    },
  );
  await runAgentTurn(CONFIG, {
    message: 'make it rougher',
    mode: 'copilot',
    selectedNodeIds: new Set<string>(),
    ...options,
  });
  return requests[0];
}

const userOf = (m: ChatMessage[]) => String(m[m.length - 1].content);
const systemOf = (m: ChatMessage[]) => String(m.find((x) => x.role === 'system')?.content);

const state = () => useDagStore.getState().state;

describe('#1705 — buildContextBlock carries each chip as one line', () => {
  it('Where and When appear when given', () => {
    const block = buildContextBlock(state(), new Set(), {
      pane: 'Curves · Box position',
      playhead: 'Shot 2 · 3.40 s',
    });
    expect(block).toMatch(/^Where: Curves · Box position/m);
    expect(block).toMatch(/^When: Shot 2 · 3\.40 s/m);
  });

  it('an absent (dismissed) chip leaves no line at all', () => {
    const block = buildContextBlock(state(), new Set(['n_box']), { pane: 'Curves' });
    expect(block).toMatch(/^Where: Curves/m);
    expect(block).not.toMatch(/^When:/m);
    const noWhere = buildContextBlock(state(), new Set(['n_box']), { playhead: '1.00 s' });
    expect(noWhere).not.toMatch(/^Where:/m);
    expect(noWhere).toMatch(/^When: 1\.00 s/m);
  });

  it('dismissing What drops the selection line, present or empty', () => {
    expect(buildContextBlock(state(), new Set(['n_box']), {})).toMatch(/^Selected nodes:/m);
    const without = buildContextBlock(state(), new Set(['n_box']), { omitSelection: true });
    expect(without).not.toMatch(/Selected nodes/);
    expect(buildContextBlock(state(), new Set(), { omitSelection: true })).not.toMatch(
      /Selected nodes/,
    );
  });

  it('with no chips the block is byte-for-byte what it was before chips existed', () => {
    const s = state();
    const anchors = Object.entries(s.outputs).map(([name, ref]) => {
      const r = ref as { node: string; socket: string };
      return `  - ${name} → ${r.node} (${s.nodes[r.node].type}), socket "${r.socket}"`;
    });
    const before = [
      'Context (current DAG state):',
      summarizeDag(s.nodes, s.outputs),
      '',
      `Anchors (project named outputs — use these ids verbatim, do NOT use the names "scene"/"render" as node ids):\n${anchors.join('\n')}`,
      '',
      'Selected nodes: none.',
    ].join('\n');
    expect(buildContextBlock(s, new Set())).toBe(before);
    expect(buildContextBlock(s, new Set(), {})).toBe(before);
  });
});

describe('#1705 — the chips reach the model in the user message, not the system prompt', () => {
  it('Where and When ride in the request the provider receives', async () => {
    const msgs = await firstRequest({
      context: { pane: 'Nodes › Hull', playhead: 'Shot 1 · 0.50 s' },
    });
    expect(userOf(msgs)).toMatch(/^Where: Nodes › Hull/m);
    expect(userOf(msgs)).toMatch(/^When: Shot 1 · 0\.50 s/m);
    expect(userOf(msgs)).toContain('User request: make it rougher');
    expect(systemOf(msgs)).not.toContain('Nodes › Hull');
  });

  it('two panes, the same sentence: the requests differ only in the Where line', async () => {
    const curves = await firstRequest({ context: { pane: 'Curves · Box position' } });
    useAgentSessionStore.getState().reset();
    const nodes = await firstRequest({ context: { pane: 'Nodes › Hull' } });
    expect(systemOf(curves)).toBe(systemOf(nodes));
    const strip = (s: string) => s.replace(/^Where: .*$/m, '');
    expect(userOf(curves)).not.toBe(userOf(nodes));
    expect(strip(userOf(curves))).toBe(strip(userOf(nodes)));
  });

  it('the system prompt is the same with and without chips', async () => {
    const plain = await firstRequest({});
    useAgentSessionStore.getState().reset();
    const chipped = await firstRequest({ context: { pane: 'Curves', playhead: '2.00 s' } });
    expect(systemOf(chipped)).toBe(systemOf(plain));
  });
});
