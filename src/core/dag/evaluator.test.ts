import { beforeEach, describe, expect, it } from 'vitest';
import { createEvaluatorCache, evaluate, topoSort } from './evaluator';
import { applyOp } from './ops';
import { emptyDagState } from './state';
import type { DagState, Op } from './types';
import { seedTestRegistry } from './__fixtures__/testNodes';

function buildSumGraph(): DagState {
  let state = emptyDagState();
  const ops: Op[] = [
    { type: 'addNode', nodeId: 'a', nodeType: 'TestNumber', params: { value: 3 } },
    { type: 'addNode', nodeId: 'b', nodeType: 'TestNumber', params: { value: 4 } },
    { type: 'addNode', nodeId: 's', nodeType: 'TestSum', params: {} },
    {
      type: 'connect',
      from: { node: 'a', socket: 'out' },
      to: { node: 's', socket: 'a' },
    },
    {
      type: 'connect',
      from: { node: 'b', socket: 'out' },
      to: { node: 's', socket: 'b' },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

describe('evaluator', () => {
  beforeEach(() => seedTestRegistry());

  it('evaluates a simple sum graph', () => {
    const state = buildSumGraph();
    const result = evaluate(state, 's');
    expect(result.value).toBe(7);
  });

  it('is deterministic across two evaluations (V2 twice-eval)', () => {
    const state = buildSumGraph();
    const r1 = evaluate(state, 's');
    const r2 = evaluate(state, 's');
    expect(r1.value).toBe(r2.value);
    expect(r1.hash).toBe(r2.hash);
  });

  it('cache hits on second evaluate of unchanged graph', () => {
    const state = buildSumGraph();
    const cache = createEvaluatorCache();
    evaluate(state, 's', { cache });
    const sizeAfterFirst = cache.size();
    evaluate(state, 's', { cache });
    expect(cache.size()).toBe(sizeAfterFirst); // no new entries
    expect(sizeAfterFirst).toBeGreaterThan(0);
  });

  it('hash changes when an upstream param changes', () => {
    const state = buildSumGraph();
    const r1 = evaluate(state, 's');
    const next = applyOp(state, {
      type: 'setParam',
      nodeId: 'a',
      paramPath: 'value',
      value: 99,
    }).next;
    const r2 = evaluate(next, 's');
    expect(r2.value).toBe(103);
    expect(r2.hash).not.toBe(r1.hash);
  });

  it('detects a cycle inside an already-corrupt graph', () => {
    // Construct cycle by hand bypassing applyOp's check (simulating a load
    // of a corrupted file).
    const state: DagState = {
      nodes: {
        x: {
          id: 'x',
          type: 'TestSum',
          version: 1,
          params: {},
          inputs: { a: { node: 'y', socket: 'out' } },
        },
        y: {
          id: 'y',
          type: 'TestSum',
          version: 1,
          params: {},
          inputs: { a: { node: 'x', socket: 'out' } },
        },
      },
      outputs: {},
    };
    expect(() => evaluate(state, 'x')).toThrow(/cycle/);
  });

  it('throws on missing node', () => {
    expect(() => evaluate(emptyDagState(), 'ghost')).toThrow(/not found/);
  });

  it('topoSort returns dependencies-first order', () => {
    const state = buildSumGraph();
    const order = topoSort(state, 's');
    const idxA = order.indexOf('a');
    const idxB = order.indexOf('b');
    const idxS = order.indexOf('s');
    expect(idxA).toBeLessThan(idxS);
    expect(idxB).toBeLessThan(idxS);
  });
});
