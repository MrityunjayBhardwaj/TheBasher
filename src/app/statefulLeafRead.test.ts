// #1579 — a Lag inside a Solver's sub-network may not read that Solver's inputs.
//
// A Solver cooks its sub-network once a frame with `prev` and `input` bound to the leaves
// inside. A Lag met in that cook is replayed apart, from its own seed, where those leaves are
// not bound. Measured before the rule, with the controller held at 2 and the outer Solver
// summing `prev + lag`: the Lag fed by `prev` gave 2, 2, 2, 2 against a hand-worked 2, 4, 7, 12,
// and fed by `input` gave 2, 2, 2, 2 against 2, 4, 6, 8. Every wire was accepted.
//
// Until the two are integrated together the wire is refused, whichever op closes it, and the
// refusal names both nodes and what to do instead.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  __resetRegistryForTests,
  applyOp,
  applyOps,
  evaluate,
  registerNodeType,
} from '../core/dag';
import type { DagState } from '../core/dag/state';
import { statefulLeafReads, subnetworkViolations } from '../core/dag/subnetworks';
import type { EvalCtx, Node, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';

const FPS = 60;
const NUMBER = { type: 'Number', cardinality: 'single' } as const;
const ctxAt = (frame: number): EvalCtx => ({
  time: { frame, seconds: frame / FPS, normalized: 0 },
});

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  registerNodeType({
    type: 'Seven',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: {},
    outputs: { out: NUMBER },
    evaluate: () => 7,
  } as never);
  // An owner that is NOT stateful, with a Number input its sub-network can read: what a Rig is
  // on the pose wire, on a wire a Lag can sit on.
  registerNodeType({
    type: 'NumberGroup',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: { x: NUMBER, body: { ...NUMBER, body: true } },
    outputs: { out: NUMBER },
    bodyInputs: { x: NUMBER },
    evaluate: (_p: unknown, inputs: { body?: number }) => inputs.body ?? 0,
  } as never);
});

type Step = Op | readonly [from: string, to: string, socket: string];

const SOURCE = { sourceTransform: { node: 'n_null', channel: 'tx' } };
const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const asOp = (step: Step): Op =>
  'type' in step
    ? step
    : {
        type: 'connect',
        from: { node: step[0], socket: 'out' },
        to: { node: step[1], socket: step[2] },
      };

/** The default scene with a controller held at x = 2. */
function base(): DagState {
  return [
    node('n_null', 'Null', { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    ['n_null', 'n_scene', 'children'] as const,
  ].reduce((s, step) => applyOp(s, asOp(step)).next, buildDefaultDagState());
}

/** Apply `steps` in order. Returns the state, and the index and message of the first refusal. */
function run(
  steps: readonly Step[],
  from = base(),
): { state: DagState; refusedAt: number; said: string } {
  let state = from;
  for (let i = 0; i < steps.length; i++) {
    try {
      state = applyOp(state, asOp(steps[i])).next;
    } catch (e) {
      return { state, refusedAt: i, said: (e as Error).message };
    }
  }
  return { state, refusedAt: -1, said: '' };
}

/** Outer Solver `O` whose rule is `prev + lag`; the Lag is not fed yet. */
const NODES: Step[] = [
  node('O_prev', 'BodyInput', { input: 'prev' }),
  node('O_feed', 'BodyInput', { input: 'prev' }),
  node('O_sum', 'Math', { op: 'add' }),
  node('lag', 'Lag', { factor: 0.5, seedFrame: 0 }),
  node('O', 'Solver', { seedFrame: 0, ...SOURCE }),
];
const SUM: Step[] = [
  ['O_prev', 'O_sum', 'a'],
  ['lag', 'O_sum', 'b'],
];
const FEED: Step = ['O_feed', 'lag', 'in'];
const BODY: Step = ['O_sum', 'O', 'body'];

const REFUSAL =
  'connect: Lag "lag" is inside the sub-network of Solver "O" and would read its "prev" input ' +
  '(through "O_feed"). A Lag keeps a history of its own, replayed apart from the Solver around ' +
  'it, so it cannot see that input yet. Build the step into "O"\'s own sub-network instead ' +
  '(a Mix of "prev" and the input is a lag), or feed "lag" from outside the sub-network.';

describe('#1579 — a Lag inside a Solver reading that Solver`s inputs is refused', () => {
  it('when the sub-network is closed last, at the wire into `body`', () => {
    const steps = [...NODES, ...SUM, FEED, BODY];
    const r = run(steps);
    expect(r.refusedAt).toBe(steps.length - 1);
    expect(r.said).toBe(REFUSAL);
    // Refused whole: the body is not wired, and nothing in the graph reads a leaf wrongly.
    expect(r.state.nodes.O.inputs.body).toBeUndefined();
    expect(statefulLeafReads(r.state)).toEqual([]);
  });

  it('when the Lag is fed last', () => {
    const steps = [...NODES, ...SUM, BODY, FEED];
    const r = run(steps);
    expect(r.refusedAt).toBe(steps.length - 1);
    expect(r.said).toBe(REFUSAL);
    expect(r.state.nodes.lag.inputs.in).toBeUndefined();
  });

  it('through a node between the leaf and the Lag, when the leaf is wired last', () => {
    const steps: Step[] = [
      ...NODES,
      node('between', 'Math', { op: 'add' }),
      ...SUM,
      ['between', 'lag', 'in'],
      BODY,
      ['O_feed', 'between', 'a'],
    ];
    const r = run(steps);
    expect(r.refusedAt).toBe(steps.length - 1);
    expect(r.said).toBe(REFUSAL);
  });

  it('whichever input of the Solver the leaf reads', () => {
    const nodes = NODES.map((s) =>
      'type' in s && s.type === 'addNode' && s.nodeId === 'O_feed'
        ? node('O_feed', 'BodyInput', { input: 'input' })
        : s,
    );
    const r = run([...nodes, ...SUM, FEED, BODY]);
    expect(r.said).toContain('would read its "input" input (through "O_feed")');
  });

  it('when the wires come in on addNode', () => {
    const steps: Step[] = [
      node('O_prev', 'BodyInput', { input: 'prev' }),
      node('O_feed', 'BodyInput', { input: 'prev' }),
      {
        ...node('lag', 'Lag', { factor: 0.5, seedFrame: 0 }),
        inputs: { in: { node: 'O_feed', socket: 'out' } },
      } as Op,
      {
        ...node('O_sum', 'Math', { op: 'add' }),
        inputs: { a: { node: 'O_prev', socket: 'out' }, b: { node: 'lag', socket: 'out' } },
      } as Op,
      {
        ...node('O', 'Solver', { seedFrame: 0, ...SOURCE }),
        inputs: { body: { node: 'O_sum', socket: 'out' } },
      } as Op,
    ];
    const r = run(steps);
    expect(r.refusedAt).toBe(steps.length - 1);
    expect(r.said).toBe(REFUSAL.replace(/^connect: /, 'addNode: '));
    expect(r.state.nodes.O).toBeUndefined();
  });
});

describe('#1579 — the third door: naming the input a leaf reads', () => {
  // A leaf reads the input its `input` param names, and the inspector's picker sets that with
  // a setParam. So a leaf that read nothing can be turned into one that reads `prev` with no
  // wire added at all.
  const unbound = NODES.map((s) =>
    'type' in s && s.type === 'addNode' && s.nodeId === 'O_feed'
      ? node('O_feed', 'BodyInput', { input: 'nothing-the-solver-declares' })
      : s,
  );
  const rename = (value: string): Op => ({
    type: 'setParam',
    nodeId: 'O_feed',
    paramPath: 'input',
    value,
  });

  it('every wire is taken while the leaf reads nothing', () => {
    const r = run([...unbound, ...SUM, FEED, BODY]);
    expect(r.refusedAt).toBe(-1);
    expect(statefulLeafReads(r.state)).toEqual([]);
  });

  it('pointing the leaf at the Solver`s input is refused, in the same words', () => {
    const steps = [...unbound, ...SUM, FEED, BODY, rename('prev')];
    const r = run(steps);
    expect(r.refusedAt).toBe(steps.length - 1);
    expect(r.said).toBe(REFUSAL.replace(/^connect: /, 'setParam: '));
    expect((r.state.nodes.O_feed.params as { input: string }).input).toBe(
      'nothing-the-solver-declares',
    );
  });

  it('a leaf that feeds no Lag can be pointed anywhere', () => {
    const r = run([
      ...unbound,
      ['O_prev', 'O_sum', 'a'],
      ['O_feed', 'O_sum', 'b'],
      BODY,
      rename('input'),
      rename('prev'),
    ]);
    expect(r.refusedAt).toBe(-1);
  });
});

describe('#1623 — the same rule, asked of a batch where it ends', () => {
  const batch = (steps: readonly Step[], from = base()) => applyOps(from, steps.map(asOp));

  it('a batch that ends with the Lag reading the Solver`s input is refused, in the same words', () => {
    expect(() => batch([...NODES, ...SUM, FEED, BODY])).toThrow(REFUSAL);
    expect(() => batch([...NODES, ...SUM, BODY, FEED])).toThrow(REFUSAL);
  });

  it('the rename that makes the read is the operation named', () => {
    const unbound = NODES.map((s) =>
      'type' in s && s.type === 'addNode' && s.nodeId === 'O_feed'
        ? node('O_feed', 'BodyInput', { input: 'nothing-the-solver-declares' })
        : s,
    );
    const rename: Op = { type: 'setParam', nodeId: 'O_feed', paramPath: 'input', value: 'prev' };
    expect(() => batch([...unbound, ...SUM, FEED, BODY, rename])).toThrow(
      REFUSAL.replace(/^connect: /, 'setParam: '),
    );
  });

  it('a batch that reads the input for a moment and ends reading nothing is taken', () => {
    const { next } = batch([
      ...NODES,
      ...SUM,
      FEED,
      BODY,
      { type: 'setParam', nodeId: 'O_feed', paramPath: 'input', value: 'nothing' },
    ]);
    expect(statefulLeafReads(next)).toEqual([]);
  });
});

describe('#1579 — what is still taken', () => {
  it('a Lag inside a Solver that reads its own controller, and gives the right numbers', () => {
    const lagWithSource = NODES.map((s) =>
      'type' in s && s.type === 'addNode' && s.nodeId === 'lag'
        ? node('lag', 'Lag', { factor: 0.5, seedFrame: 0, ...SOURCE })
        : s,
    );
    const r = run([...lagWithSource, ...SUM, BODY]);
    expect(r.refusedAt).toBe(-1);
    // The Lag trails a constant 2, so it is 2 at every frame and O(f) = 2 + 2f.
    expect(
      [0, 1, 2, 3].map((f) => evaluate(r.state, 'O', { ctx: ctxAt(f), socket: 'out' }).value),
    ).toEqual([2, 4, 6, 8]);
  });

  it('a Lag inside a Solver fed by a node inside that reads no leaf', () => {
    const r = run([...NODES, node('seven', 'Seven'), ...SUM, ['seven', 'lag', 'in'], BODY]);
    expect(r.refusedAt).toBe(-1);
    // The Lag trails a constant 7: O(f) = 2 + 7f.
    expect(
      [0, 1, 2, 3].map((f) => evaluate(r.state, 'O', { ctx: ctxAt(f), socket: 'out' }).value),
    ).toEqual([2, 9, 16, 23]);
  });

  it('a node with no history reading the leaves, which is what a sub-network is for', () => {
    const r = run([
      node('O_prev', 'BodyInput', { input: 'prev' }),
      node('O_in', 'BodyInput', { input: 'input' }),
      node('O_sum', 'Math', { op: 'add' }),
      node('O', 'Solver', { seedFrame: 0, ...SOURCE }),
      ['O_prev', 'O_sum', 'a'],
      ['O_in', 'O_sum', 'b'],
      ['O_sum', 'O', 'body'],
    ]);
    expect(r.refusedAt).toBe(-1);
  });

  it('a Lag outside the sub-network reading the Solver', () => {
    const r = run([
      node('O_prev', 'BodyInput', { input: 'prev' }),
      node('O_sum', 'Math', { op: 'add' }),
      node('O', 'Solver', { seedFrame: 0, ...SOURCE }),
      node('after', 'Lag', { factor: 0.5, seedFrame: 0 }),
      ['O_prev', 'O_sum', 'a'],
      ['O_sum', 'O', 'body'],
      ['O', 'after', 'in'],
    ]);
    expect(r.refusedAt).toBe(-1);
  });

  it('a Solver inside a Solver, each reading its own leaves', () => {
    const r = run([
      node('I_prev', 'BodyInput', { input: 'prev' }),
      node('I_in', 'BodyInput', { input: 'input' }),
      node('I_sum', 'Math', { op: 'add' }),
      node('I', 'Solver', { seedFrame: 0, ...SOURCE }),
      ['I_prev', 'I_sum', 'a'],
      ['I_in', 'I_sum', 'b'],
      ['I_sum', 'I', 'body'],
      node('O_prev', 'BodyInput', { input: 'prev' }),
      node('O_sum', 'Math', { op: 'add' }),
      node('O', 'Solver', { seedFrame: 0, ...SOURCE }),
      ['O_prev', 'O_sum', 'a'],
      ['I', 'O_sum', 'b'],
      ['O_sum', 'O', 'body'],
    ]);
    expect(r.refusedAt).toBe(-1);
    expect(statefulLeafReads(r.state)).toEqual([]);
  });

  it('a Lag inside an owner that is not stateful reads its input, and reads it right', () => {
    const r = run([
      node('seven', 'Seven'),
      node('leaf', 'BodyInput', { input: 'x' }),
      node('lag', 'Lag', { factor: 0.5, seedFrame: 0 }),
      node('group', 'NumberGroup'),
      ['seven', 'group', 'x'],
      ['leaf', 'lag', 'in'],
      ['lag', 'group', 'body'],
    ]);
    expect(r.refusedAt).toBe(-1);
    // A Lag trailing a constant 7 is 7. Unbound, the leaf would read 0 and so would the Lag.
    expect(
      [0, 3].map((f) => evaluate(r.state, 'group', { ctx: ctxAt(f), socket: 'out' }).value),
    ).toEqual([7, 7]);
  });
});

describe('#1579 — a project that already holds one', () => {
  /** The refused graph, made by hand the way a file saved before the rule would hold it. */
  function saved(): DagState {
    // `mid` sits between the Lag and the sum, with an input free for a second Lag.
    const built = run([
      ...NODES,
      node('mid', 'Math', { op: 'add' }),
      ['O_prev', 'O_sum', 'a'],
      ['lag', 'mid', 'a'],
      ['mid', 'O_sum', 'b'],
      FEED,
    ]).state;
    const O = built.nodes.O as Node;
    return {
      ...built,
      nodes: { ...built.nodes, O: { ...O, inputs: { body: { node: 'O_sum', socket: 'out' } } } },
    };
  }

  it('is named, with both nodes and the leaf', () => {
    const state = saved();
    expect(statefulLeafReads(state)).toEqual([
      { inner: 'lag', owner: 'O', leaf: 'O_feed', input: 'prev' },
    ]);
    // It breaks this rule and not the single-owner one.
    expect(subnetworkViolations(state)).toEqual([]);
  });

  it('still takes an edit that adds no new one', () => {
    const r = run([node('other', 'Math', { op: 'add' }), ['n_null', 'n_scene', 'lights']], saved());
    // The Math node is added; whatever the second wire does, it is not refused by this rule.
    expect(r.state.nodes.other).toBeDefined();
    expect(r.said).not.toContain('keeps a history of its own');
    const wired = run([node('m', 'Math', { op: 'add' }), ['lag', 'm', 'a']], saved());
    // `lag` is inside O, so feeding a node outside is the single-owner rule's to refuse.
    expect(wired.said).toContain('A node belongs to one sub-network');
    const inside = run([node('m', 'Math', { op: 'add' }), ['m', 'O_sum', 'b']], saved());
    expect(inside.said).not.toContain('keeps a history of its own');
  });

  it('refuses a second one, with the first still in place', () => {
    const r = run(
      [
        node('lag2', 'Lag', { factor: 0.5, seedFrame: 0 }),
        ['lag2', 'mid', 'b'],
        ['O_prev', 'lag2', 'in'],
      ],
      saved(),
    );
    expect(r.refusedAt).toBe(2);
    expect(r.said).toContain('Lag "lag2" is inside the sub-network of Solver "O"');
    // The one the project came with is untouched, and is still the only one.
    expect(statefulLeafReads(r.state)).toEqual([
      { inner: 'lag', owner: 'O', leaf: 'O_feed', input: 'prev' },
    ]);
  });
});
