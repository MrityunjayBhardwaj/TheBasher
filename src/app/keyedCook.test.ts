// #575 — a key on a compute node setting reaches what the node cooks.
//
// Before this, Mix with its factor keyed 0 to 1 read back 0, 0.5, 1 and output 0 at all three
// (measured 2026-11-07): the key was stored and the cook saw only the authored value.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, evaluate, __resetRegistryForTests } from '../core/dag';
import { createEvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { COMPUTE_NODES } from '../nodes/computeNodes';
import { registerAllNodes } from '../nodes/registerAll';

const at = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const run = (s: DagState, ops: object[]) => {
  for (const o of ops) s = applyOp(s, o as never).next;
  return s;
};
const add = (nodeId: string, nodeType: string, params: object = {}) => ({
  type: 'addNode',
  nodeId,
  nodeType,
  params,
});
const key = (id: string, target: string, paramPath: string, values: [number, number]) =>
  add(id, 'KeyframeChannelNumber', {
    target,
    paramPath,
    keyframes: [
      { time: 0, value: values[0] },
      { time: 1, value: values[1] },
    ],
  });
const value = (s: DagState, id: string, seconds: number, cache = createEvaluatorCache()) =>
  evaluate(s, id, { ctx: at(seconds), cache }).value;

describe('a key on a compute node reaches its cook', () => {
  const mix = (extra: object[] = []) =>
    run(buildDefaultDagState(), [add('m', 'Mix', { dataType: 'Number', factor: 0 }), ...extra]);

  it('Mix: the factor key moves the output', () => {
    const wired = run(mix(), [
      key('ch', 'm', 'factor', [0, 1]),
      add('c', 'Clamp', { min: 10, max: 10 }),
      { type: 'connect', from: { node: 'c', socket: 'out' }, to: { node: 'm', socket: 'b' } },
    ]);
    expect(value(wired, 'm', 0)).toBeCloseTo(0);
    expect(value(wired, 'm', 0.5)).toBeCloseTo(5);
    expect(value(wired, 'm', 1)).toBeCloseTo(10);
  });

  it('one cache across frames still sees the key move', () => {
    const s = run(mix(), [
      key('ch', 'm', 'factor', [0, 1]),
      add('c', 'Clamp', { min: 10, max: 10 }),
      { type: 'connect', from: { node: 'c', socket: 'out' }, to: { node: 'm', socket: 'b' } },
    ]);
    const cache = createEvaluatorCache();
    expect(value(s, 'm', 0, cache)).toBeCloseTo(0);
    expect(value(s, 'm', 0.5, cache)).toBeCloseTo(5);
    expect(value(s, 'm', 1, cache)).toBeCloseTo(10);
  });

  it('Clamp, Fit and Noise take keys on their settings', () => {
    const s = run(buildDefaultDagState(), [
      add('c', 'Clamp', { min: 0, max: 9 }),
      key('c_min', 'c', 'min', [0, 4]),
      add('f', 'Fit', { dataType: 'Number', inMin: 0, inMax: 1, outMin: 0, outMax: 1 }),
      key('f_out', 'f', 'outMin', [0, 7]),
      add('n', 'Noise', { amplitude: 0, scale: 1, phase: 0.37 }),
      key('n_amp', 'n', 'amplitude', [0, 3]),
    ]);
    expect(value(s, 'c', 1)).toBeCloseTo(4);
    expect(value(s, 'f', 1)).toBeCloseTo(7);
    expect(value(s, 'n', 0)).toBeCloseTo(0);
    expect(value(s, 'n', 1)).not.toBeCloseTo(0);
  });

  it('a key on one point of a CurveRemap reaches the curve, leaving the others', () => {
    const s = run(buildDefaultDagState(), [
      add('r', 'CurveRemap', {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
      key('r_y', 'r', 'points.0.y', [0, 2]),
    ]);
    expect(value(s, 'r', 0)).toBeCloseTo(0);
    expect(value(s, 'r', 1)).toBeCloseTo(2);
    expect((s.nodes.r.params as { points: { y: number }[] }).points[0].y).toBe(0);
  });

  it('a wire on the input still wins over a key on the setting, as an unkeyed setting loses', () => {
    const s = run(mix(), [
      key('ch', 'm', 'factor', [0, 1]),
      add('wf', 'Clamp', { min: 0, max: 0 }),
      add('c', 'Clamp', { min: 10, max: 10 }),
      { type: 'connect', from: { node: 'wf', socket: 'out' }, to: { node: 'm', socket: 'factor' } },
      { type: 'connect', from: { node: 'c', socket: 'out' }, to: { node: 'm', socket: 'b' } },
    ]);
    expect(value(s, 'm', 1)).toBeCloseTo(0);
  });

  it('the saved settings do not change, and a muted key is ignored', () => {
    const s = run(mix(), [
      add('ch', 'KeyframeChannelNumber', {
        target: 'm',
        paramPath: 'factor',
        mute: true,
        keyframes: [
          { time: 0, value: 1 },
          { time: 1, value: 1 },
        ],
      }),
      add('c', 'Clamp', { min: 10, max: 10 }),
      { type: 'connect', from: { node: 'c', socket: 'out' }, to: { node: 'm', socket: 'b' } },
    ]);
    expect(value(s, 'm', 1)).toBeCloseTo(0);
    expect((s.nodes.m.params as { factor: number }).factor).toBe(0);
  });

  it('a node with no key re-cooks nothing on a new frame; a keyed one re-cooks only on a new value', () => {
    const cache = createEvaluatorCache();
    const plain = run(buildDefaultDagState(), [add('c', 'Clamp', { min: 1, max: 2 })]);
    value(plain, 'c', 0, cache);
    const before = cache.size();
    value(plain, 'c', 0.5, cache);
    expect(cache.size()).toBe(before);

    const held = run(plain, [key('ch', 'c', 'min', [1, 1])]);
    const cacheHeld = createEvaluatorCache();
    value(held, 'c', 0, cacheHeld);
    const heldBefore = cacheHeld.size();
    value(held, 'c', 0.5, cacheHeld);
    expect(cacheHeld.size()).toBe(heldBefore);
  });

  it('every compute node takes keys', () => {
    for (const def of COMPUTE_NODES) expect(def.keyedCook, def.type).toBe(true);
  });
});
