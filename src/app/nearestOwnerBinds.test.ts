// #1645 — a body-input leaf reads the NEAREST owner around it that declares its name.
//
// Before: a leaf bound only to the innermost owner around it. A Solver inside a stateless owner
// (a template instance, from #1557) whose body read the outer owner's `k` got 0 on every frame,
// with nothing refused (measured: 0 against a Lag's 0.05, 0.88, 2.41 …).
//
// `Tpl` stands in for a template instance: a stateless owner with a Number socket `k`, a
// Vector3 socket `prev`, a Number body, and a named input for each socket.

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { __resetRegistryForTests, applyOp, applyOps } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { registerNodeType } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import {
  bodyInputChoicesOf,
  bodyInputLeavesOf,
  bodyInputOwnerOf,
  subnetworkViolations,
} from '../core/dag/subnetworks';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import type { ParamDriverParams } from '../nodes/ParamDriver';
import { registerAllNodes } from '../nodes/registerAll';
import { makeStatefulDriverChannelValue } from './statefulOps';

const FPS = 60;
const FRAMES = [0, 1, 7, 15, 30, 31, 45, 60, 75];
const NUM = { type: 'Number', cardinality: 'single' } as const;
const VEC = { type: 'Vector3', cardinality: 'single' } as const;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  registerNodeType({
    type: 'Tpl',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}),
    inputs: { k: { ...NUM }, prev: { ...VEC }, body: { ...NUM, body: true } },
    outputs: { out: NUM },
    bodyInputs: { k: NUM, prev: VEC },
    evaluate: (_p: unknown, i: Record<string, unknown>) => (i.body as number | undefined) ?? 0,
  } as never);
});

const node = (nodeId: string, nodeType: string, params: Record<string, unknown> = {}): Op =>
  ({ type: 'addNode', nodeId, nodeType, params }) as Op;
const wire = (from: string, to: string, socket: string, fromSocket = 'out'): Op =>
  ({ type: 'connect', from: { node: from, socket: fromSocket }, to: { node: to, socket } }) as Op;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (s: DagState, id: string, frame: number) =>
  evaluate(s, id, { ctx: { time: { frame, seconds: frame / FPS, normalized: 0 } } }).value;

/** A Null swept along x, a Lag at 0.25 following it (the reference), and a Solver stepping
 *  `prev + (input − prev)·k` inside `Tpl`, with `k` read from `Tpl` (wired from `kfit`). */
function lagInsideTemplate(k = 0.25): DagState {
  return apply(buildDefaultDagState(), [
    node('nul', 'Null', { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
    wire('nul', 'n_scene', 'children'),
    node('n_tx', 'KeyframeChannelVec3', {
      name: 'position',
      target: 'nul',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 0.5, value: [6, 0, 0], easing: 'linear' },
        { time: 1, value: [-3, 0, 0], easing: 'linear' },
      ],
    }),
    node('lag', 'Lag', {
      factor: k,
      seedFrame: 0,
      sourceTransform: { node: 'nul', channel: 'tx' },
    }),
    node('drv', 'ParamDriver', {
      target: 'n_box',
      paramPath: 'material.metalness',
      blendMode: 'replace',
      order: 0,
    }),
    wire('lag', 'drv', 'in'),
    node('kfit', 'Fit', { outMin: k, outMax: k }),
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
}

const lagCurve = (s: DagState) => {
  const lag = makeStatefulDriverChannelValue(
    s,
    s.nodes.drv.params as ParamDriverParams,
    s.nodes.lag,
  );
  return FRAMES.map((f) => lag.sample(f / FPS));
};

describe('#1645 — a Solver inside a template reads the template’s inputs', () => {
  it('the Solver’s step reads `k` from the template around it, frame for frame a Lag', () => {
    const s = lagInsideTemplate();
    const expected = lagCurve(s);
    expect(new Set(expected).size).toBeGreaterThan(3); // the reference moves
    expect(FRAMES.map((f) => at(s, 'tpl', f))).toEqual(expected);
    expect(subnetworkViolations(s)).toEqual([]);
  });

  it('follows a change to what feeds the template’s `k`', () => {
    const s = lagInsideTemplate(0.5);
    expect(FRAMES.map((f) => at(s, 'tpl', f))).toEqual(lagCurve(s));
    expect(lagCurve(s)).not.toEqual(lagCurve(lagInsideTemplate(0.25)));
  });

  it('`k` binds to the template, `prev` and `input` stay the Solver’s', () => {
    const s = lagInsideTemplate();
    expect(bodyInputOwnerOf(s, 'kleaf')).toBe('tpl');
    expect(bodyInputOwnerOf(s, 'prev')).toBe('sol');
    expect(bodyInputLeavesOf(s, 'tpl').map((l) => l.id)).toEqual(['kleaf']);
    expect(
      bodyInputLeavesOf(s, 'sol')
        .map((l) => l.id)
        .sort(),
    ).toEqual(['inp', 'prev']);
    expect(bodyInputChoicesOf(s, 'kleaf')).toEqual({
      owners: ['sol', 'tpl'],
      names: ['prev', 'input', 'k'],
    });
  });

  it('a name the inner owner declares only for another type does not hide the outer one', () => {
    // The Solver's `prev` is a Number; `Tpl` declares a Vector3 `prev`. A Vector3 leaf named
    // `prev` inside the Solver can only be bound by `Tpl`.
    // One batch: the step moves behind `m2` (#1623 judges the graph it ends in).
    const s = applyOps(lagInsideTemplate(), [
      node('pv', 'BodyInputVec', { input: 'prev' }),
      node('br', 'VecBreak3'),
      wire('pv', 'br', 'v'),
      node('m2', 'Math', { op: 'add' }),
      wire('add', 'm2', 'a'),
      wire('br', 'm2', 'b', 'x'),
      wire('m2', 'sol', 'body'),
    ]).next;
    expect(bodyInputOwnerOf(s, 'pv')).toBe('tpl');
    expect(bodyInputOwnerOf(s, 'prev')).toBe('sol');
    // The owner the picker names is the one whose cook binds the leaf, for every leaf.
    for (const leaf of ['pv', 'prev', 'inp', 'kleaf']) {
      const binding = ['sol', 'tpl'].filter((o) =>
        bodyInputLeavesOf(s, o).some((l) => l.id === leaf),
      );
      expect({ leaf, binding }).toEqual({ leaf, binding: [bodyInputOwnerOf(s, leaf)] });
    }
  });

  it('a name no owner around the leaf declares binds nothing', () => {
    const s = apply(lagInsideTemplate(), [
      { type: 'setParam', nodeId: 'kleaf', paramPath: 'input', value: 'gain' } as Op,
    ]);
    expect(bodyInputOwnerOf(s, 'kleaf')).toBeUndefined();
    expect(bodyInputLeavesOf(s, 'tpl')).toEqual([]);
  });

  it('a Solver inside a stateful owner may not read that owner’s inputs (#1579)', () => {
    registerNodeType({
      type: 'StatefulTpl',
      version: 1,
      pure: true,
      cost: 'cheap',
      stateful: true,
      paramSchema: z.object({}),
      inputs: { body: { ...NUM, body: true } },
      outputs: { out: NUM },
      bodyInputs: { k: NUM },
      evaluate: () => 0,
    } as never);
    const s = apply(buildDefaultDagState(), [
      node('kleaf', 'BodyInput', { input: 'k' }),
      node('sol', 'Solver'),
      wire('kleaf', 'sol', 'body'),
      node('outer', 'StatefulTpl'),
    ]);
    expect(() => applyOp(s, wire('sol', 'outer', 'body'))).toThrow(
      /Solver "sol" is inside the sub-network of StatefulTpl "outer" and would read its "k" input/,
    );
  });
});
