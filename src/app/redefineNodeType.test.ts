// #1647 — a node type a project defines can be replaced and removed, and what was worked out
// from the old definition is dropped.
//
// A template's definition is a node type (#1557). `Tpl` stands in for one: a stateless owner
// with a Number socket `k`, a Number body, and (in its first definition) a named input `k`.
// The second definition declares no named input, so a leaf reading `k` binds nothing.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import {
  defineNodeType,
  getNodeType,
  isDefinedNodeType,
  registryEpoch,
  undefineNodeType,
} from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';

const NUM = { type: 'Number', cardinality: 'single' } as const;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const defineTpl = (declaresK: boolean) =>
  defineNodeType({
    type: 'Tpl',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: { k: { ...NUM }, body: { ...NUM, body: true } },
    outputs: { out: NUM },
    bodyInputs: declaresK ? { k: NUM } : {},
    evaluate: (_p: unknown, i: Record<string, unknown>) => (i.body as number | undefined) ?? 0,
  } as never);

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string, frame: number) =>
  evaluate(s, id, { ctx: { time: { frame, seconds: frame / 60, normalized: 0 } } }).value;

describe('#1647 — redefining a type', () => {
  it('replaces a defined type and removes it, moving the epoch each time', () => {
    defineTpl(true);
    const first = registryEpoch();
    expect(isDefinedNodeType('Tpl')).toBe(true);
    expect(getNodeType('Tpl')?.bodyInputs).toEqual({ k: NUM });
    defineTpl(false);
    expect(registryEpoch()).toBeGreaterThan(first);
    expect(getNodeType('Tpl')?.bodyInputs).toEqual({});
    const second = registryEpoch();
    undefineNodeType('Tpl');
    expect(registryEpoch()).toBeGreaterThan(second);
    expect(getNodeType('Tpl')).toBeUndefined();
    expect(isDefinedNodeType('Tpl')).toBe(false);
  });

  it('a built-in type is neither replaced nor removed', () => {
    const solver = getNodeType('Solver');
    expect(() => defineNodeType({ ...solver!, bodyInputs: {} } as never)).toThrow(
      /"Solver" is built in, so a definition can't replace it/,
    );
    expect(() => undefineNodeType('Solver')).toThrow(
      /"Solver" is built in, so it can't be removed/,
    );
    expect(() => undefineNodeType('Nope')).toThrow(/No defined node type "Nope"/);
    expect(getNodeType('Solver')).toBe(solver);
  });

  it('a definition is checked as a registration is', () => {
    expect(() =>
      defineNodeType({
        type: 'Tpl',
        version: 1,
        pure: true,
        cost: 'cheap',
        paramSchema: z.object({}),
        inputs: { body: { ...NUM, body: true } },
        outputs: { out: NUM },
        bodyInputs: { k: NUM }, // a stateless owner reads `k` from a socket it lacks
        evaluate: () => 0,
      } as never),
    ).toThrow(/k/);
    expect(getNodeType('Tpl')).toBeUndefined();
  });

  it('a leaf directly under the owner follows the new definition on the same graph', () => {
    defineTpl(true);
    const s = apply(buildDefaultDagState(), [
      node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
      node('two', 'Fit', { outMin: 2, outMax: 2 }),
      node('leaf', 'BodyInput', { input: 'k' }),
      node('mul', 'Math', { op: 'mul' }),
      wire('leaf', 'mul', 'a'),
      wire('two', 'mul', 'b'),
      node('tpl', 'Tpl'),
      wire('kfit', 'tpl', 'k'),
      wire('mul', 'tpl', 'body'),
    ]);
    expect(at(s, 'tpl', 30)).toBe(0.5);
    defineTpl(false);
    expect(at(s, 'tpl', 30)).toBe(0);
    expect(at({ ...s, nodes: { ...s.nodes } }, 'tpl', 30)).toBe(0); // the control: a fresh table
  });

  it('a Solver inside the owner replays under the new definition on the same graph', () => {
    // The Solver steps `prev + (input − prev)·k`, with `k` read from `Tpl` (#1645), following a
    // Null at x = 2. With `k` bound to 0.25 it eases towards 2; with `k` unbound it stays at its
    // seed, the Null's x at frame 0.
    defineTpl(true);
    const s = apply(buildDefaultDagState(), [
      node('nul', 'Null', { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
      wire('nul', 'n_scene', 'children'),
      node('n_tx', 'KeyframeChannelVec3', {
        name: 'position',
        target: 'nul',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [6, 0, 0], easing: 'linear' },
        ],
      }),
      node('kfit', 'Fit', { outMin: 0.25, outMax: 0.25 }),
      node('prev', 'BodyInput', { input: 'prev' }),
      node('inp', 'BodyInput', { input: 'input' }),
      node('kleaf', 'BodyInput', { input: 'k' }),
      node('sub', 'Math', { op: 'sub' }),
      wire('inp', 'sub', 'a'),
      wire('prev', 'sub', 'b'),
      node('mul', 'Math', { op: 'mul' }),
      wire('sub', 'mul', 'a'),
      wire('kleaf', 'mul', 'b'),
      node('add', 'Math', { op: 'add' }),
      wire('prev', 'add', 'a'),
      wire('mul', 'add', 'b'),
      node('sol', 'Solver', { seedFrame: 0, sourceTransform: { node: 'nul', channel: 'tx' } }),
      wire('add', 'sol', 'body'),
      node('tpl', 'Tpl'),
      wire('kfit', 'tpl', 'k'),
      wire('sol', 'tpl', 'body'),
    ]);
    const eased = at(s, 'tpl', 30) as number;
    expect(eased).toBeGreaterThan(0);
    defineTpl(false);
    const fresh = at({ ...s, nodes: { ...s.nodes } }, 'tpl', 30);
    expect(fresh).toBe(0); // the control: the seed, the Null's x at frame 0
    expect(at(s, 'tpl', 30)).toBe(fresh);
  });
});
