// What the product KNOWS about a plan has to reach the model that wrote it. Two
// instances of that one property live here, because they ride the same message and
// would otherwise be pinned by two copies of the same turn harness:
//
//   #1014 — a surfaced no-op has TWO readers, and only one of them was wired.
//   #733  — the gates prove a plan is LEGAL; the critic says what it DID.
//
// `applyOp` accepts an op that changed nothing and hands back a `Reportable`
// saying exactly what went wrong. The director reads it in the DiffBar. The
// model that WROTE the op did not: the speculative fork kept `.fork` and threw
// the report away, and the tool result was answered before the fork even ran.
//
// This gate holds the other reader open. It drives the REAL turn loop with a
// mocked transport and reads the `role:'tool'` message the next round actually
// sends, because that — not a helper's return value — is what the model sees.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatMessage, StreamChunk } from './transport/types';

// Only the network half is mocked; buildToolSchemas stays real.
const streamMock = vi.hoisted(() => vi.fn());
vi.mock('./transport/openai', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transport/openai')>();
  return { ...real, streamChatCompletion: streamMock };
});

import { runAgentTurn, renderNoOpReport } from './orchestrator';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { registerAllMutators } from './mutators';
import { registerAllTools } from './tools';
import { useDagStore } from '../core/dag/store';
import { useAgentSessionStore } from './session/store';
import { buildDefaultDagState } from '../core/project/default';
import { badgeLabel } from '../app/badges';
import type { Op } from '../core/dag/types';
import type { Reportable } from '../core/dag/ops';

const CONFIG = { baseUrl: 'http://x', model: 'm', apiKey: 'k' } as never;

/**
 * Round 1 emits one `dag.exec` carrying `ops`; round 2 records the messages it
 * was handed and ends the turn. Returns the recorded round-2 messages.
 */
async function turnWithOps(ops: Op[], description: string): Promise<ChatMessage[]> {
  let round = 0;
  let roundTwo: ChatMessage[] = [];
  streamMock.mockImplementation(
    async (_c: unknown, o: { messages: ChatMessage[]; onChunk: (c: StreamChunk) => void }) => {
      round++;
      if (round === 1) {
        o.onChunk({
          type: 'tool_call',
          tool_call: {
            id: 'call_1',
            index: 0,
            type: 'function',
            function: { name: 'dag.exec', arguments: JSON.stringify({ ops, description }) },
          },
        } as StreamChunk);
      } else {
        roundTwo = o.messages;
        o.onChunk({ type: 'text', text: 'done' });
      }
      o.onChunk({ type: 'done' });
    },
  );
  await runAgentTurn(CONFIG, { message: 'go', mode: 'agent', selectedNodeIds: [] } as never);
  return roundTwo;
}

/** Every `role:'tool'` message the second round carried, concatenated. */
const toolText = (msgs: ChatMessage[]): string =>
  msgs
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');

// Registries are process-global and throw on a second registration, so they are
// built ONCE; only the scene and the transport reset per test.
__resetRegistryForTests();
registerAllNodes();
registerAllMutators();
registerAllTools();

beforeEach(() => {
  useDagStore.getState().hydrate(buildDefaultDagState());
  // 🔴 THE SESSION STORE PERSISTS ACROSS TESTS IN A FILE. Without this reset the
  // throwing-fork row below reads an EARLIER row's `[dag.exec]` line and passes
  // whether or not the fix is present — measured: its falsifier stayed green.
  useAgentSessionStore.getState().reset();
  streamMock.mockReset();
});

describe('#1014 — a surfaced no-op reaches the model, not only the DiffBar', () => {
  // The op shape is not invented: a model answered "make this shot run from 0 to
  // 4 seconds on the camera" with exactly these three ops. Both writes vanished.
  const STRIPPED: Op[] = [
    { type: 'addNode', nodeId: 'n_shot', nodeType: 'Shot', params: {} },
    { type: 'setParam', nodeId: 'n_shot', paramPath: 'start', value: 0 },
    { type: 'setParam', nodeId: 'n_shot', paramPath: 'end', value: 4 },
  ] as Op[];

  it('THE PIN: the tool result the next round sends names both dropped writes', async () => {
    const text = toolText(await turnWithOps(STRIPPED, 'shot 0-4s'));
    expect(text).toContain('NOTE -');
    expect(text).toContain('2 of 3 ops');
    expect(text).toContain('start');
    expect(text).toContain('end');
    // The product's own diagnosis, not a sentence re-invented in the agent layer.
    expect(text).toContain('Shot has no such parameter');
  });

  it('CONTROL: a plan whose ops all do real work carries no note', async () => {
    // Same tool, same road, same round structure — only the ops differ.
    const real: Op[] = [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] },
    ] as Op[];
    const text = toolText(await turnWithOps(real, 'rotate the cube'));
    expect(text).toContain('Proposed 1 Op'); // the round really ran the tool
    expect(text).not.toContain('NOTE -');
  });

  it('CONTROL: the detector is not vacuous — it fires on one op and clears its sibling', async () => {
    const mixed: Op[] = [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] },
      { type: 'setParam', nodeId: 'n_box', paramPath: 'nosuchparam', value: 1 },
    ] as Op[];
    const text = toolText(await turnWithOps(mixed, 'one good one bad'));
    expect(text).toContain('1 of 2 ops');
    expect(text).toContain('nosuchparam');
    expect(text).not.toContain('rotation');
  });

  it('a fork that THROWS still answers the call first — the debug line survives', async () => {
    // createFork re-validates against the live shape and throws on a bad reference,
    // which is a common agent mistake. Moving the fork above the answer would have
    // quietly taken the chat's tool line away on exactly that path.
    const bad: Op[] = [
      {
        type: 'connect',
        from: { node: 'n_nope', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ] as Op[];
    await turnWithOps(bad, 'connect a node that does not exist');
    const chat = useAgentSessionStore
      .getState()
      .session.messages.map((m) => String(m.content))
      .join('\n');
    expect(chat).toContain('[dag.exec]');
    expect(useAgentSessionStore.getState().session.error ?? '').not.toBe('');
  });

  it('the sentence the model reads is the sentence the director reads', () => {
    const r: Reportable = {
      badge: 'stripped-write',
      nodeId: 'n_shot',
      paramPath: 'start',
      reason: 'Shot has no such parameter',
    };
    // If the agent layer ever grows its own formatter, these drift apart silently.
    expect(renderNoOpReport([r])).toContain(
      badgeLabel(r.badge, { paramPath: r.paramPath, nodeId: r.nodeId, reason: r.reason }),
    );
  });

  it('a badge kind this file has never heard of still reaches the model', () => {
    // The registry is meant to grow. Forwarding the report rather than
    // special-casing the kind is what keeps a future badge from needing an edit
    // here before the model can see it.
    const out = renderNoOpReport([
      { badge: 'some-future-kind', nodeId: 'n_x', paramPath: 'p', reason: 'because' },
    ]);
    expect(out).toContain('NOTE -');
    expect(out).toContain('p');
  });

  it('nothing to report renders nothing at all', () => {
    expect(renderNoOpReport([])).toBe('');
    expect(renderNoOpReport([null, null])).toBe('');
  });
});

describe('#733 — the critic reaches the model too', () => {
  it('THE PIN: a plan that adds a node wired to nothing says so in the tool result', async () => {
    const stranded: Op[] = [
      {
        type: 'addNode',
        nodeId: 'n_scatter',
        nodeType: 'Scatter',
        params: { density: 1, seed: 0, bounds: [1, 1, 1], scaleJitter: 0, randomYaw: false },
      },
    ] as Op[];
    const text = toolText(await turnWithOps(stranded, 'scatter the cube'));
    expect(text).toContain('CRITIC -');
    expect(text).toContain('n_scatter');
    expect(text).toContain('connected it to nothing');
    expect(text).toContain('observations, not rejections');
  });

  it('CONTROL: a plan that does what it says carries no critique', async () => {
    const real: Op[] = [
      { type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: [0, 45, 0] },
    ] as Op[];
    const text = toolText(await turnWithOps(real, 'rotate the cube'));
    expect(text).toContain('Proposed 1 Op');
    expect(text).not.toContain('CRITIC -');
  });

  it('the two reports ride the SAME message and do not displace each other', async () => {
    // Stripped writes (the no-op half) AND an unconsumed addition (the critic half)
    // in one plan: the model must receive both, not whichever ran last.
    const both: Op[] = [
      { type: 'addNode', nodeId: 'n_shot', nodeType: 'Shot', params: {} },
      { type: 'setParam', nodeId: 'n_shot', paramPath: 'start', value: 0 },
    ] as Op[];
    const text = toolText(await turnWithOps(both, 'shot 0-4s'));
    expect(text).toContain('NOTE -');
    expect(text).toContain('Shot has no such parameter');
    expect(text).toContain('CRITIC -');
  });
});
