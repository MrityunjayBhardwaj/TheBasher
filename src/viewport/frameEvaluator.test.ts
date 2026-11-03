// #1748 — the frame evaluator runs every tick once a frame, holders before what they hold, and
// commits the frame's React updates together, in one synchronous commit.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const commits = vi.hoisted(() => ({ count: 0 }));
vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  flushSync: (fn: () => void) => {
    commits.count++;
    fn();
  },
}));

import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { createFrameEvaluator } from './frameEvaluator';

const ref = (node: string) => ({ node, socket: 'out' });
const KEYS = [
  { frame: 0, value: [0, 0, 0] },
  { frame: 10, value: [1, 0, 0] },
];

// A keyed Group holding a Group holding an Object: all three move, in that order.
function seed() {
  const nodes: Record<string, unknown> = {};
  for (const n of [
    { id: 'scene', type: 'Scene', inputs: { children: [ref('outer')] } },
    { id: 'outer', type: 'Group', inputs: { children: [ref('mid')] } },
    { id: 'mid', type: 'Group', inputs: { children: [ref('leaf')] } },
    { id: 'leaf', type: 'Object' },
    {
      id: 'outer_ch',
      type: 'KeyframeChannelVec3',
      params: { target: 'outer', name: 'position', keyframes: KEYS },
    },
  ])
    nodes[n.id] = { params: {}, inputs: {}, ...n };
  useDagStore.setState({ state: { nodes, outputs: {} } as unknown as DagState } as never);
}

beforeEach(() => {
  commits.count = 0;
  seed();
});

describe('#1748 — the frame evaluator', () => {
  it('runs holders before what they hold, whatever order they registered in', () => {
    const ev = createFrameEvaluator();
    const ran: string[] = [];
    for (const id of ['leaf', null, 'outer', 'mid'] as const)
      ev.register({ nodeId: id, tick: () => void ran.push(id ?? 'none') });
    ev.run();
    expect(ran).toEqual(['outer', 'mid', 'leaf', 'none']);
  });

  it("commits a frame's updates in one synchronous commit, and none when there are none", () => {
    const ev = createFrameEvaluator();
    const applied: string[] = [];
    ev.register({ nodeId: 'leaf', tick: () => () => void applied.push('leaf') });
    ev.register({ nodeId: 'outer', tick: () => () => void applied.push('outer') });
    ev.register({ nodeId: 'mid', tick: () => {} });
    ev.run();
    expect(commits.count).toBe(1);
    expect(applied).toEqual(['outer', 'leaf']);

    const quiet = createFrameEvaluator();
    quiet.register({ nodeId: 'leaf', tick: () => {} });
    quiet.run();
    expect(commits.count).toBe(1);
  });

  it('stops running a tick once unregistered', () => {
    const ev = createFrameEvaluator();
    const ran: string[] = [];
    const off = ev.register({ nodeId: 'mid', tick: () => void ran.push('mid') });
    ev.register({ nodeId: 'leaf', tick: () => void ran.push('leaf') });
    ev.run();
    off();
    ev.run();
    expect(ran).toEqual(['mid', 'leaf', 'leaf']);
  });

  it('re-orders after an edit, with nothing registered or removed', () => {
    const ev = createFrameEvaluator();
    const ran: string[] = [];
    ev.register({ nodeId: 'mid', tick: () => void ran.push('mid') });
    ev.register({ nodeId: 'leaf', tick: () => void ran.push('leaf') });
    ev.run();
    expect(ran).toEqual(['mid', 'leaf']);

    // Re-parent: leaf now holds mid, and the key moves onto leaf.
    ran.length = 0;
    const s = useDagStore.getState().state;
    const nodes = { ...s.nodes } as Record<string, { inputs: Record<string, unknown> }>;
    nodes.scene = { ...nodes.scene, inputs: { children: [ref('leaf')] } };
    nodes.leaf = { ...nodes.leaf, inputs: { children: [ref('mid')] } };
    nodes.mid = { ...nodes.mid, inputs: {} };
    nodes.outer_ch = {
      ...nodes.outer_ch,
      params: { target: 'leaf', name: 'position', keyframes: KEYS },
    } as never;
    useDagStore.setState({ state: { ...s, nodes } as unknown as DagState } as never);
    ev.run();
    expect(ran).toEqual(['leaf', 'mid']);
  });
});
