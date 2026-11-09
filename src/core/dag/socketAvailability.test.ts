// #1801 — a node's mode decides which of its sockets are available (Blender's mechanism), and
// Mix uses it to blend numbers, vectors or rotations.
//
// What must hold:
//   - a Mix saved before the mode existed is a Number Mix with its wires live;
//   - connect refuses a NEW wire to or from a socket the mode has off, and says which mode;
//   - a wire left on a socket the mode switched off is KEPT and IGNORED, and comes back when the
//     mode does (Blender keeps the link and marks it invalid) — including after undo;
//   - the driver picker offers only outputs that exist now;
//   - a whole transform blends as Separate → Mix per part → Combine.

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from './ops';
import { evaluate } from './evaluator';
import { emptyDagState, type DagState } from './state';
import type { Op } from './types';
import { requireNodeType } from './registry';
import { inputAvailable, outputAvailable } from './socketAvailability';
import { registerAllNodes } from '../../nodes/registerAll';
import { driverSourceOptions } from '../../app/driverBind';
import { composeTransform, eulerToQuat, type Mat4 } from '../math/transformMath';

beforeAll(() => registerAllNodes());

const add = (id: string, nodeType: string, params: Record<string, unknown> = {}): Op => ({
  type: 'addNode',
  nodeId: id,
  nodeType,
  params,
});
const wire = (from: string, fs: string, to: string, ts: string): Op => ({
  type: 'connect',
  from: { node: from, socket: fs },
  to: { node: to, socket: ts },
});
const set = (nodeId: string, paramPath: string, value: unknown): Op => ({
  type: 'setParam',
  nodeId,
  paramPath,
  value,
});
const apply = (s: DagState, ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).next, s);
const build = (ops: Op[]) => apply(emptyDagState(), ops);
const close = (a: readonly number[], b: readonly number[], digits = 9) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('#1801 which sockets a mode makes available', () => {
  it('a Mix with no mode stored (saved before it existed) is a Number Mix', () => {
    const def = requireNodeType('Mix');
    for (const params of [{ factor: 0.5 }, { factor: 0.5, dataType: 'Number' }]) {
      expect(['a', 'b'].map((s) => inputAvailable(def, params, s))).toEqual([true, true]);
      expect(outputAvailable(def, params, 'out')).toBe(true);
      expect(inputAvailable(def, params, 'aVector')).toBe(false);
      expect(outputAvailable(def, params, 'outRotation')).toBe(false);
    }
    // And it still computes: an old node's raw params, wired the old way.
    const s = build([add('a', 'Fit', { outMin: 2 }), add('b', 'Fit', { outMin: 6 })]);
    const old = {
      ...s,
      nodes: {
        ...s.nodes,
        m: {
          id: 'm',
          type: 'Mix',
          version: 1,
          params: { factor: 0.25 },
          inputs: { a: { node: 'a', socket: 'out' }, b: { node: 'b', socket: 'out' } },
        },
      },
    } as DagState;
    expect(evaluate(old, 'm').value).toBe(3);
  });

  it('connect refuses a socket the mode has off, naming the mode that would make it', () => {
    const s = build([add('v', 'MakeVec3'), add('m', 'Mix')]);
    expect(() => apply(s, [wire('v', 'out', 'm', 'aVector')])).toThrow(
      'connect: Mix.aVector is not available — it exists only while dataType is Vector (it is Number)',
    );
    const vec = apply(s, [set('m', 'dataType', 'Vector')]);
    expect(() => apply(vec, [wire('v', 'out', 'm', 'aVector')])).not.toThrow();
    // …and the producer side: Number mode has no vector result to take.
    const m2 = build([add('m', 'Mix'), add('p', 'TransformPoint')]);
    expect(() => apply(m2, [wire('m', 'outVector', 'p', 'point')])).toThrow(/Mix.outVector/);
  });

  it('a wire on a socket the mode switches off is kept, ignored, and back when the mode is', () => {
    let s = build([
      add('two', 'Fit', { outMin: 2 }),
      add('m', 'Mix', { factor: 0 }),
      wire('two', 'out', 'm', 'a'),
    ]);
    expect(evaluate(s, 'm').value).toBe(2);
    s = apply(s, [set('m', 'dataType', 'Vector')]);
    expect(s.nodes.m.inputs.a).toEqual({ node: 'two', socket: 'out' }); // kept
    expect(evaluate(s, 'm').value).toEqual([0, 0, 0]); // ignored: the vector inputs are empty
    // Ignored all the way: the switched-off wire is not part of the result's identity, so editing
    // the node behind it does not make the Mix a different value (no needless recompute).
    const before = evaluate(s, 'm').hash;
    expect(evaluate(apply(s, [set('two', 'outMin', 7)]), 'm').hash).toBe(before);
    // Delete and undo restore it with the wire on: addNode takes it as stored state.
    const removed = applyOp(s, { type: 'removeNode', nodeId: 'm' });
    s = applyOp(removed.next, removed.inverse).next;
    expect(s.nodes.m.inputs.a).toEqual({ node: 'two', socket: 'out' });
    s = apply(s, [set('m', 'dataType', 'Number')]);
    expect(evaluate(s, 'm').value).toBe(2); // back in use
  });

  it("a wire from an output the producer's mode switched off reads as unconnected", () => {
    let s = build([
      add('two', 'Fit', { outMin: 2 }),
      add('m', 'Mix', { factor: 0 }),
      add('sum', 'Math', { op: 'add' }),
      wire('two', 'out', 'm', 'a'),
      wire('m', 'out', 'sum', 'a'),
    ]);
    expect(evaluate(s, 'sum').value).toBe(2);
    s = apply(s, [set('m', 'dataType', 'Rotation')]);
    // Without the rule the quaternion would arrive at a Number input as a value it cannot read.
    expect(evaluate(s, 'sum').value).toBe(0);
  });

  it('the driver picker offers only the output the mode has on', () => {
    let s = build([add('m', 'Mix'), add('tgt', 'Null')]);
    const offered = (st: DagState, kind: 'number' | 'vec3') =>
      driverSourceOptions(st, 'tgt', kind)
        .filter((x) => x.kind === 'output' && x.ref.node === 'm')
        .map((x) => (x as { ref: { socket: string } }).ref.socket);
    expect(offered(s, 'number')).toEqual(['out']);
    expect(offered(s, 'vec3')).toEqual([]);
    s = apply(s, [set('m', 'dataType', 'Vector')]);
    expect(offered(s, 'number')).toEqual([]);
    expect(offered(s, 'vec3')).toEqual(['outVector']);
  });
});

describe('#1801 Mix blends each type the way that type blends', () => {
  it('Vector lerps; Rotation takes the shortest arc', () => {
    const vec = requireNodeType('Mix').evaluate(
      { factor: 0.25, dataType: 'Vector' },
      { aVector: [0, 0, 0], bVector: [4, 8, -4] },
      {} as never,
    );
    expect(vec).toEqual([1, 2, -1]);
    const a = eulerToQuat([0, 0, 0]);
    const b = eulerToQuat([0, 0, 90]);
    const half = requireNodeType('Mix').evaluate(
      { factor: 0.5, dataType: 'Rotation' },
      { aRotation: a, bRotation: [-b[0], -b[1], -b[2], -b[3]] }, // the same 90°, other sign
      {} as never,
    ) as number[];
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...half), 'XYZ');
    expect((e.z * 180) / Math.PI).toBeCloseTo(45, 9); // 45°, not the long way round
  });

  it('a transform blends as Separate → Mix each part → Combine', () => {
    const A = composeTransform([0, 0, 0], eulerToQuat([0, 0, 0]), [1, 1, 1]);
    const B = composeTransform([10, 0, -4], eulerToQuat([0, 90, 0]), [3, 1, 1]);
    const s = build([
      add('A', 'MakeVec3'),
      add('B', 'MakeVec3'),
      add('sa', 'SeparateTransform'),
      add('sb', 'SeparateTransform'),
      add('mt', 'Mix', { dataType: 'Vector' }),
      add('mr', 'Mix', { dataType: 'Rotation' }),
      add('ms', 'Mix', { dataType: 'Vector' }),
      add('c', 'CombineTransform'),
      add('ca', 'CombineTransform'),
      add('cb', 'CombineTransform'),
      // The two transforms come from two Combines fed by overridden values.
      wire('ca', 'out', 'sa', 'transform'),
      wire('cb', 'out', 'sb', 'transform'),
      wire('sa', 'translation', 'mt', 'aVector'),
      wire('sb', 'translation', 'mt', 'bVector'),
      wire('sa', 'rotation', 'mr', 'aRotation'),
      wire('sb', 'rotation', 'mr', 'bRotation'),
      wire('sa', 'scale', 'ms', 'aVector'),
      wire('sb', 'scale', 'ms', 'bVector'),
      wire('mt', 'outVector', 'c', 'translation'),
      wire('mr', 'outRotation', 'c', 'rotation'),
      wire('ms', 'outVector', 'c', 'scale'),
    ]);
    const overrides = new Map<string, unknown>([
      ['ca', A],
      ['cb', B],
    ]);
    const blended = evaluate(s, 'c', { overrides }).value as Mat4;
    const want = composeTransform([5, 0, -2], eulerToQuat([0, 45, 0]), [2, 1, 1]);
    close(blended, want);
  });
});
