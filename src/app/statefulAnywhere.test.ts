// #1558 — a stateful node (Lag, Solver) gives its replayed value to EVERY consumer, not only to
// a driver it feeds directly, and that is what lets a sub-network sit inside another.
//
// Before: the replay was reached from one place (a driver's direct `in`), so a Solver behind a
// Math node read 0,0,0,0 and a Solver or Lag inside a Solver's sub-network left the outer one
// at 2,2,2,2. Every one of those wires was accepted without a report.
//
// The fixtures share one controller, a Null at x = 2, and one recurrence, the accumulator
// `out(f) = out(f-1) + input(f)` seeded with the input, so `acc(f) = 2 + 2f` and every expected
// number below can be worked by hand.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { createEvaluatorCache, evaluate, setStatefulReplay } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { bodyInputLeavesOf, subnetworkViolations } from '../core/dag/subnetworks';
import type { EvalCtx, Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import type { ParamDriverParams } from '../nodes/ParamDriver';
import { driverChannelValuesForTarget, driverParamDeps } from './paramDrivers';
import {
  makeStatefulDriverChannelValue,
  replayStatefulAt,
  statefulSourceOf,
  statefulUpstreamOf,
} from './statefulOps';

const FPS = 60;
const BOX = 'n_box';
const NULL = 'n_null';
const DRV = 'n_drv';
const FRAMES = [0, 1, 2, 3] as const;

const ctxAt = (frame: number): EvalCtx => ({
  time: { frame, seconds: frame / FPS, normalized: 0 },
});

interface Builder {
  readonly state: () => DagState;
  /** Applies an op; throws what the op throws. */
  readonly add: (op: unknown) => void;
  readonly wire: (from: string, to: string, socket: string, fromSocket?: string) => void;
}

function builder(): Builder {
  let state = buildDefaultDagState();
  const add = (op: unknown) => {
    state = applyOp(state, op as Op).next;
  };
  const wire = (from: string, to: string, socket: string, fromSocket = 'out') =>
    add({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } });
  add({
    type: 'addNode',
    nodeId: NULL,
    nodeType: 'Null',
    params: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  wire(NULL, 'n_scene', 'children');
  return { state: () => state, add, wire };
}

const SOURCE = { sourceTransform: { node: NULL, channel: 'tx' } };

/** A Solver `id` with nothing in its sub-network yet, reading the controller. */
function solver(b: Builder, id: string): void {
  b.add({ type: 'addNode', nodeId: id, nodeType: 'Solver', params: { seedFrame: 0, ...SOURCE } });
}

/** `id` = the accumulator: its sub-network is `prev + input`. acc(f) = 2 + 2f. */
function accumulator(b: Builder, id: string): void {
  b.add({
    type: 'addNode',
    nodeId: `${id}_prev`,
    nodeType: 'BodyInput',
    params: { input: 'prev' },
  });
  b.add({ type: 'addNode', nodeId: `${id}_in`, nodeType: 'BodyInput', params: { input: 'input' } });
  b.add({ type: 'addNode', nodeId: `${id}_sum`, nodeType: 'Math', params: { op: 'add' } });
  b.wire(`${id}_prev`, `${id}_sum`, 'a');
  b.wire(`${id}_in`, `${id}_sum`, 'b');
  solver(b, id);
  b.wire(`${id}_sum`, id, 'body');
}

/** `id` = a Solver whose sub-network is `prev + <inner>`: it sums what `inner` gives each frame. */
function summing(b: Builder, id: string, inner: string): void {
  b.add({
    type: 'addNode',
    nodeId: `${id}_prev`,
    nodeType: 'BodyInput',
    params: { input: 'prev' },
  });
  b.add({ type: 'addNode', nodeId: `${id}_sum`, nodeType: 'Math', params: { op: 'add' } });
  b.wire(`${id}_prev`, `${id}_sum`, 'a');
  b.wire(inner, `${id}_sum`, 'b');
  solver(b, id);
  b.wire(`${id}_sum`, id, 'body');
}

function drive(b: Builder, from: string): void {
  b.add({
    type: 'addNode',
    nodeId: DRV,
    nodeType: 'ParamDriver',
    params: { target: BOX, paramPath: 'material.metalness', blendMode: 'replace', order: 0 },
  });
  b.wire(from, DRV, 'in');
}

/** What the fold gives the driven param: resolved ONCE, at frame 0, then sampled at each frame.
 *  A reader that resolves once and samples many times is the case a constant fold gets wrong. */
function driven(state: DagState): unknown[] {
  const values = driverChannelValuesForTarget(state, BOX, ctxAt(0));
  expect(values).toHaveLength(1);
  const cv = values[0] as { sample: (seconds: number) => unknown };
  return FRAMES.map((f) => cv.sample(f / FPS));
}

/** What the evaluator gives for `id`'s `out` at each frame. */
function evaluated(state: DagState, id: string): unknown[] {
  return FRAMES.map((f) => evaluate(state, id, { ctx: ctxAt(f), socket: 'out' }).value);
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('a stateful node is replayed for every consumer (#1558)', () => {
  it('control: the accumulator straight into a driver', () => {
    const b = builder();
    accumulator(b, 'A');
    drive(b, 'A');
    expect(statefulSourceOf(b.state().nodes[DRV], b.state())?.id).toBe('A');
    expect(driven(b.state())).toEqual([2, 4, 6, 8]);
  });

  it('the evaluator gives the same numbers the driver road gives', () => {
    const b = builder();
    accumulator(b, 'A');
    drive(b, 'A');
    const state = b.state();
    const cv = makeStatefulDriverChannelValue(
      state,
      state.nodes[DRV].params as ParamDriverParams,
      state.nodes['A'],
    );
    expect(evaluated(state, 'A')).toEqual(FRAMES.map((f) => cv.sample(f / FPS)));
    expect(evaluated(state, 'A')).toEqual([2, 4, 6, 8]);
  });

  it('a Solver behind a Math node drives its replayed value, sampled across time', () => {
    const b = builder();
    accumulator(b, 'A');
    b.add({ type: 'addNode', nodeId: 'n_mid', nodeType: 'Math', params: { op: 'add' } });
    b.wire('A', 'n_mid', 'a');
    drive(b, 'n_mid');
    const state = b.state();
    expect(statefulSourceOf(state.nodes[DRV], state)).toBeNull();
    expect(statefulUpstreamOf(state.nodes[DRV], state)).toEqual({ node: 'n_mid', socket: 'out' });
    expect(driven(state)).toEqual([2, 4, 6, 8]);
  });

  it('a driver with no stateful node behind it is not treated as one', () => {
    const b = builder();
    b.add({ type: 'addNode', nodeId: 'n_mid', nodeType: 'Math', params: { op: 'add' } });
    drive(b, 'n_mid');
    expect(statefulUpstreamOf(b.state().nodes[DRV], b.state())).toBeNull();
    expect(driven(b.state())).toEqual([0, 0, 0, 0]);
  });

  it('a Lag fed by a Solver trails the replayed Solver, not its placeholder', () => {
    const b = builder();
    accumulator(b, 'A');
    b.add({
      type: 'addNode',
      nodeId: 'n_lag',
      nodeType: 'Lag',
      params: { factor: 0.5, seedFrame: 0 },
    });
    b.wire('A', 'n_lag', 'in');
    drive(b, 'n_lag');
    // lag(0) = acc(0) = 2; then half the gap to acc(f) = 2 + 2f each frame.
    expect(driven(b.state())).toEqual([2, 3, 4.5, 6.25]);
  });
  it('one shared cache across frames: what sits behind a Solver follows it, never a stale frame', () => {
    const b = builder();
    accumulator(b, 'A');
    b.add({ type: 'addNode', nodeId: 'n_mid', nodeType: 'Math', params: { op: 'add' } });
    b.wire('A', 'n_mid', 'a');
    const cache = createEvaluatorCache();
    const at = (f: number) => evaluate(b.state(), 'n_mid', { ctx: ctxAt(f), cache }).value;
    // `n_mid` is pure, so its cache key carries no time: only the Solver's hash can move it.
    expect([at(1), at(2), at(1), at(3)]).toEqual([4, 6, 4, 8]);
  });
});

describe('a sub-network inside a sub-network (#1558)', () => {
  it('a Solver inside a Solver: the outer sums the inner one frame by frame', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    drive(b, 'A');
    // A(0) = 2 (seeded with its input); A(f) = A(f-1) + B(f), B(f) = 2 + 2f.
    expect(driven(b.state())).toEqual([2, 6, 12, 20]);
    expect(evaluated(b.state(), 'A')).toEqual([2, 6, 12, 20]);
  });

  it('three levels: a Solver inside a Solver inside a Solver', () => {
    const b = builder();
    accumulator(b, 'C');
    summing(b, 'B', 'C');
    summing(b, 'A', 'B');
    drive(b, 'A');
    // B = 2, 6, 12, 20 (above); A(0) = 2; A(f) = A(f-1) + B(f).
    expect(driven(b.state())).toEqual([2, 8, 20, 40]);
  });

  it('a Lag inside a Solver', () => {
    const b = builder();
    b.add({
      type: 'addNode',
      nodeId: 'n_lag',
      nodeType: 'Lag',
      params: { factor: 0.5, seedFrame: 0, ...SOURCE },
    });
    summing(b, 'A', 'n_lag');
    drive(b, 'A');
    // The Lag trails a constant 2, so it is 2 at every frame: A(f) = 2 + 2f.
    expect(driven(b.state())).toEqual([2, 4, 6, 8]);
  });

  it('two Solvers side by side inside one outer Solver keep their own bindings', () => {
    const b = builder();
    accumulator(b, 'B');
    accumulator(b, 'C');
    b.add({ type: 'addNode', nodeId: 'n_both', nodeType: 'Math', params: { op: 'add' } });
    b.wire('B', 'n_both', 'a');
    b.wire('C', 'n_both', 'b');
    summing(b, 'A', 'n_both');
    drive(b, 'A');
    // B(f) + C(f) = 4 + 4f; A(0) = 2; A(f) = A(f-1) + 4 + 4f.
    expect(driven(b.state())).toEqual([2, 10, 22, 38]);
  });

  it('a frame lands the same value whatever was sampled before it', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    drive(b, 'A');
    const cv = driverChannelValuesForTarget(b.state(), BOX, ctxAt(0))[0] as {
      sample: (seconds: number) => unknown;
    };
    const first = cv.sample(3 / FPS);
    cv.sample(40 / FPS);
    cv.sample(1 / FPS);
    expect(cv.sample(3 / FPS)).toBe(first);
    expect(first).toBe(20);
  });

  it('each level owns only its own leaves, and nothing leaves a sub-network sideways', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    const state = b.state();
    expect(bodyInputLeavesOf(state, 'A').map((l) => l.id)).toEqual(['A_prev']);
    expect(
      bodyInputLeavesOf(state, 'B')
        .map((l) => l.id)
        .sort(),
    ).toEqual(['B_in', 'B_prev']);
    expect(subnetworkViolations(state)).toEqual([]);
  });

  it('a node inside the inner sub-network cannot also feed the outer one', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    b.add({ type: 'addNode', nodeId: 'n_extra', nodeType: 'Math', params: { op: 'add' } });
    b.wire('n_extra', 'A_sum', 'b');
    // `B_sum` is inside B; `n_extra` is inside A and outside B.
    expect(() => b.wire('B_sum', 'n_extra', 'a')).toThrow(/inside the sub-network of Solver "B"/);
  });

  it('a node inside the outer sub-network cannot feed anything outside it', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    b.add({ type: 'addNode', nodeId: 'n_out', nodeType: 'Math', params: { op: 'add' } });
    // The inner Solver itself is a node of A's sub-network.
    expect(() => b.wire('B', 'n_out', 'a')).toThrow(/inside the sub-network of Solver "A"/);
  });
});

describe('the replay is the only answer a stateful node has (#1558)', () => {
  it('with no replay registered a stateful node is an error that names it', () => {
    const b = builder();
    accumulator(b, 'A');
    setStatefulReplay(null);
    try {
      expect(() => evaluate(b.state(), 'A', { ctx: ctxAt(1) })).toThrow(
        /Solver "A" is stateful and no replay is registered/,
      );
    } finally {
      setStatefulReplay(replayStatefulAt);
    }
  });

  it('a node read by its own replay stops at once instead of walking until the stack ends', () => {
    const b = builder();
    b.add({
      type: 'addNode',
      nodeId: 'n_lag',
      nodeType: 'Lag',
      params: { factor: 0.5, seedFrame: 0 },
    });
    // Minted by hand: `connect` refuses a wire from a node to itself. A loop through a reference
    // (a Lag whose controller that Lag drives) reaches the same place by a longer road.
    const lag = b.state().nodes['n_lag'];
    const state: DagState = {
      ...b.state(),
      nodes: {
        ...b.state().nodes,
        n_lag: { ...lag, inputs: { in: { node: 'n_lag', socket: 'out' } } },
      },
    };
    let calls = 0;
    setStatefulReplay((s, id, ctx, cache) => {
      calls += 1;
      return replayStatefulAt(s, id, ctx, cache);
    });
    try {
      // The inner read throws, the replay reads a thrown input as 0, and the Lag settles on 0.
      expect(evaluate(state, 'n_lag', { ctx: ctxAt(3) }).value).toBe(0);
      // One call from the walk, then one refused re-entry per frame read (0..3, some twice).
      expect(calls).toBeLessThan(20);
    } finally {
      setStatefulReplay(replayStatefulAt);
    }
  });
});

describe('the controller hop is named for a stateful node wherever it sits (#1558)', () => {
  it('a Solver behind a Math node still depends on its controller', () => {
    const b = builder();
    accumulator(b, 'A');
    b.add({ type: 'addNode', nodeId: 'n_mid', nodeType: 'Math', params: { op: 'add' } });
    b.wire('A', 'n_mid', 'a');
    drive(b, 'n_mid');
    const deps = driverParamDeps(b.state().nodes);
    expect(deps[BOX]).toContain(DRV);
    expect(deps['A']).toContain(NULL);
  });

  it('an inner Solver depends on its controller too', () => {
    const b = builder();
    accumulator(b, 'B');
    summing(b, 'A', 'B');
    drive(b, 'A');
    const deps = driverParamDeps(b.state().nodes);
    expect(deps['A']).toContain(NULL);
    expect(deps['B']).toContain(NULL);
  });

  it('a vector Solver names its whole-position controller', () => {
    const b = builder();
    b.add({
      type: 'addNode',
      nodeId: 'V',
      nodeType: 'Solver',
      params: { seedFrame: 0, sourceTransformVec: { node: NULL } },
    });
    expect(driverParamDeps(b.state().nodes)['V']).toContain(NULL);
  });
});
