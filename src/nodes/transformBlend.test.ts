// #1811 — blending two whole transforms out of small nodes, checked against Blender.
//
// Influence on a Blender constraint interpolates the whole matrix: the location by lerp, and the
// 3×3 by polar decomposition, the rotation part by the shortest arc and the stretch part by lerp.
// Basher builds that from wires: Polar Split on each side, a Mix per part, then Combine Transform
// and Multiply Transforms. The expected numbers are Blender 5.1.1's own (4.5.9 gives the same),
// from `scripts/blender-transform-blend-oracle.py`.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag/ops';
import { evaluate } from '../core/dag/evaluator';
import { emptyDagState, type DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { requireNodeType } from '../core/dag/registry';
import {
  type Mat4,
  composeTransform,
  eulerToQuat,
  multiplyTransforms,
  polarSplit,
} from '../core/math/transformMath';
import { registerAllNodes } from './registerAll';
import oracle from './__fixtures__/blender-transform-blend.json';

beforeAll(() => registerAllNodes());

type Case = { rows: Record<string, number[]> };
const CASES = oracle.cases as Record<string, Case>;
const FACTORS = ['0', '0.25', '0.5', '0.75', '1'];

const run = (type: string, params: object, inputs: Record<string, unknown>) => {
  const def = requireNodeType(type);
  return def.evaluate(def.paramSchema.parse(params), inputs, {} as never) as never;
};

/** The wiring, node by node, with each node's own evaluate. */
function blend(a: Mat4, b: Mat4, factor: number): Mat4 {
  const pa = run('PolarSplit', {}, { transform: a }) as ReturnType<typeof polarSplit>;
  const pb = run('PolarSplit', {}, { transform: b }) as ReturnType<typeof polarSplit>;
  const location = run(
    'Mix',
    { dataType: 'Vector' },
    { aVector: pa.translation, bVector: pb.translation, factor },
  );
  const rotation = run(
    'Mix',
    { dataType: 'Rotation' },
    { aRotation: pa.rotation, bRotation: pb.rotation, factor },
  );
  const stretch = run(
    'Mix',
    { dataType: 'Matrix' },
    { aMatrix: pa.stretch, bMatrix: pb.stretch, factor },
  );
  const placed = run('CombineTransform', {}, { translation: location, rotation });
  return run('MultiplyTransforms', {}, { a: placed, b: stretch });
}

const maxError = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('#1811 Polar Split', () => {
  it('rotation × stretch rebuilds the transform, sheared and mirrored included', () => {
    for (const [name, c] of Object.entries(CASES))
      for (const f of FACTORS) {
        const m = c.rows[f];
        const p = polarSplit(m);
        const placed = composeTransform(p.translation, p.rotation, [1, 1, 1]);
        expect(maxError(multiplyTransforms(placed, p.stretch), m), `${name} @${f}`).toBeLessThan(
          1e-5,
        );
      }
  });

  it('never yields a NaN, even from an all-zero 3×3', () => {
    const zero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 1];
    const p = polarSplit(zero);
    expect([...p.translation, ...p.rotation, ...p.stretch].every(Number.isFinite)).toBe(true);
    expect(p.translation).toEqual([1, 2, 3]);
    [0, 0, 0, 1].forEach((v, i) => expect(p.rotation[i]).toBeCloseTo(v, 12));
  });
});

// A target flattened on some axes but not all has no single nearest rotation, so what a blend does
// on the way there depends on which one the decomposition settles on. Blender's choice can collapse
// the object mid-blend (flat-x at 0.5 is a line, though neither end is), so these rows are not
// matched: they are named here, and each end and the rebuild still are. An all-zero scale is not on
// this list; it matches at every factor.
const NOT_MATCHED = new Set(['flat-x', 'line-z']);
const MID = new Set(['0.25', '0.5', '0.75']);

describe('#1811 the wiring reproduces Blender', () => {
  for (const [name, c] of Object.entries(CASES))
    for (const f of FACTORS) {
      if (NOT_MATCHED.has(name) && MID.has(f)) continue;
      it(`${name} at factor ${f}`, () => {
        const got = blend(c.rows['0'], c.rows['1'], Number(f));
        expect(maxError(got, c.rows[f])).toBeLessThan(2e-5);
      });
    }

  it('a target flat on some axes: finite on the way, and it does differ from Blender', () => {
    for (const name of NOT_MATCHED)
      for (const f of MID) {
        const c = CASES[name];
        const got = blend(c.rows['0'], c.rows['1'], Number(f));
        expect(got.every(Number.isFinite), `${name} @${f}`).toBe(true);
        // Reds if the difference goes away, so this list cannot outlive its reason.
        expect(maxError(got, c.rows[f]), `${name} @${f}`).toBeGreaterThan(0.1);
      }
  });

  it('the wires, through the real evaluator: a sheared child blends with a math node on the factor', () => {
    const add = (nodeId: string, nodeType: string, params = {}): Op => ({
      type: 'addNode',
      nodeId,
      nodeType,
      params,
    });
    const wire = (a: string, as: string, b: string, bs: string): Op => ({
      type: 'connect',
      from: { node: a, socket: as },
      to: { node: b, socket: bs },
    });
    const vec = (id: string, axes: Record<string, number>): Op[] => [
      add(id, 'MakeVec3'),
      ...Object.entries(axes).flatMap(([axis, v]) => [
        add(`${id}${axis}`, 'Fit', { outMin: v, outMax: v }),
        wire(`${id}${axis}`, 'out', id, axis),
      ]),
    ];
    const ops: Op[] = [
      ...vec('pe', { z: 45 }),
      ...vec('ce', { z: 30 }),
      ...vec('ps', { x: 1, y: 3, z: 1 }),
      ...vec('bt', { x: 2 }),
      add('pr', 'EulerToRotation'),
      add('cr', 'EulerToRotation'),
      wire('pe', 'out', 'pr', 'euler'),
      wire('ce', 'out', 'cr', 'euler'),
      add('parent', 'CombineTransform'),
      wire('pr', 'out', 'parent', 'rotation'),
      wire('ps', 'out', 'parent', 'scale'),
      add('child', 'CombineTransform'),
      wire('cr', 'out', 'child', 'rotation'),
      add('world', 'MultiplyTransforms'),
      wire('parent', 'out', 'world', 'a'),
      wire('child', 'out', 'world', 'b'),
      add('target', 'CombineTransform'),
      wire('bt', 'out', 'target', 'translation'),
      add('sa', 'PolarSplit'),
      add('sb', 'PolarSplit'),
      wire('world', 'out', 'sa', 'transform'),
      wire('target', 'out', 'sb', 'transform'),
      add('half', 'Fit', { outMin: 0.5, outMax: 0.5 }),
      add('ml', 'Mix', { dataType: 'Vector' }),
      add('mr', 'Mix', { dataType: 'Rotation' }),
      add('ms', 'Mix', { dataType: 'Matrix' }),
      wire('sa', 'translation', 'ml', 'aVector'),
      wire('sb', 'translation', 'ml', 'bVector'),
      wire('sa', 'rotation', 'mr', 'aRotation'),
      wire('sb', 'rotation', 'mr', 'bRotation'),
      wire('sa', 'stretch', 'ms', 'aMatrix'),
      wire('sb', 'stretch', 'ms', 'bMatrix'),
      wire('half', 'out', 'ml', 'factor'),
      wire('half', 'out', 'mr', 'factor'),
      wire('half', 'out', 'ms', 'factor'),
      add('placed', 'CombineTransform'),
      wire('ml', 'outVector', 'placed', 'translation'),
      wire('mr', 'outRotation', 'placed', 'rotation'),
      add('result', 'MultiplyTransforms'),
      wire('placed', 'out', 'result', 'a'),
      wire('ms', 'outMatrix', 'result', 'b'),
    ];
    const s = ops.reduce((acc, o) => applyOp(acc, o).next, emptyDagState());
    expect(maxError(evaluate(s, 'world').value as Mat4, CASES.shear.rows['0'])).toBeLessThan(1e-5);
    expect(maxError(evaluate(s, 'result').value as Mat4, CASES.shear.rows['0.5'])).toBeLessThan(
      2e-5,
    );
  });
});

describe('#1811 Mix factor is a socket', () => {
  it('a wired factor wins over the setting, through the real evaluator', () => {
    const op = (o: Op) => (s: DagState) => applyOp(s, o).next;
    const add = (nodeId: string, nodeType: string, params = {}): Op => ({
      type: 'addNode',
      nodeId,
      nodeType,
      params,
    });
    const wire = (a: string, b: string, sock: string): Op => ({
      type: 'connect',
      from: { node: a, socket: 'out' },
      to: { node: b, socket: sock },
    });
    const ops: Op[] = [
      add('ten', 'Fit', { outMin: 10, outMax: 10 }),
      add('quarter', 'Fit', { outMin: 0.25, outMax: 0.25 }),
      add('m', 'Mix', { factor: 0.5 }),
      wire('ten', 'm', 'b'),
    ];
    let s = ops.reduce((acc, o) => op(o)(acc), emptyDagState());
    expect(evaluate(s, 'm').value).toBe(5); // no wire: the setting
    s = op(wire('quarter', 'm', 'factor'))(s);
    expect(evaluate(s, 'm').value).toBe(2.5); // wired: the wire
    s = op({ type: 'setParam', nodeId: 'quarter', paramPath: 'outMin', value: 1 })(s);
    s = op({ type: 'setParam', nodeId: 'quarter', paramPath: 'outMax', value: 1 })(s);
    expect(evaluate(s, 'm').value).toBe(10); // a math node driving it follows
  });

  it('a Matrix Mix at 0 and 1 hands back each side exactly', () => {
    const a = composeTransform([1, 2, 3], eulerToQuat([10, 20, 30]), [1, 2, 3]);
    const b = composeTransform([4, 5, 6], eulerToQuat([40, 50, 60]), [3, 2, 1]);
    expect(run('Mix', { dataType: 'Matrix', factor: 0 }, { aMatrix: a, bMatrix: b })).toEqual(a);
    expect(run('Mix', { dataType: 'Matrix', factor: 1 }, { aMatrix: a, bMatrix: b })).toEqual(b);
  });
});
