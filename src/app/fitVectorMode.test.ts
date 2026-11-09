// #1802 — Fit (Map Range) in Vector mode: each axis through its own range, clamp per axis
// (Blender's Map Range Vector mode, node_shader_map_range.cc). A Fit saved before the mode
// existed is a Number one.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { evaluate } from '../core/dag/evaluator';
import type { EvalCtx } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { FitNode } from '../nodes/computeNodes';

beforeAll(() => registerAllNodes());

const CTX = {} as EvalCtx;

describe('#1802 Fit in Vector mode', () => {
  const base = FitNode.paramSchema.parse({ dataType: 'Vector', clamp: false });

  it('remaps each axis through its own range', () => {
    const params = {
      ...base,
      inMinVector: [0, 0, 10] as [number, number, number],
      inMaxVector: [1, 2, 20] as [number, number, number],
      outMinVector: [0, 100, 0] as [number, number, number],
      outMaxVector: [10, 200, -1] as [number, number, number],
    };
    expect(FitNode.evaluate(params, { inVector: [0.5, 1, 15] }, CTX)).toEqual([5, 150, -0.5]);
  });

  it('clamps each axis into its own output range, an inverted one included', () => {
    const params = {
      ...base,
      clamp: true,
      outMinVector: [0, 10, 0] as [number, number, number],
      outMaxVector: [1, 0, 1] as [number, number, number], // y's range runs downward
    };
    expect(FitNode.evaluate(params, { inVector: [2, 2, -1] }, CTX)).toEqual([1, 0, 0]);
  });

  it('a Fit saved before the mode existed is a Number Fit, and switches mode cleanly', () => {
    let s = buildDefaultDagState();
    s = {
      ...s,
      nodes: {
        ...s.nodes,
        f: {
          id: 'f',
          type: 'Fit',
          version: 1,
          params: { inMin: 0, inMax: 1, outMin: 0, outMax: 10, clamp: false },
          inputs: {},
        },
      },
    } as DagState;
    expect(evaluate(s, 'f').value).toBe(0);
    s = applyOp(s, { type: 'setParam', nodeId: 'f', paramPath: 'dataType', value: 'Vector' }).next;
    expect(evaluate(s, 'f').value).toEqual([0, 0, 0]);
  });
});
