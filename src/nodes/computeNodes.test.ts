// #292 (Epic 1 Inc 1) — the compute-node vocabulary. Each node is a thin, pure
// wrapper over the shared value-math core; these pin the wiring (param → core fn,
// input default 0) and that the family is registered for real use.

import { describe, expect, it } from 'vitest';
import type { EvalCtx } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from './registerAll';
import {
  ClampNode,
  CurveRemapNode,
  FitNode,
  fractalNoise,
  MathNode,
  MixNode,
  NoiseNode,
} from './index';

const CTX = {} as EvalCtx; // these nodes are ctx-independent (pure over params+inputs)

describe('#292 compute nodes — evaluate', () => {
  it('Math applies the op-enum and defaults an unconnected input to 0', () => {
    expect(MathNode.evaluate({ op: 'mul' }, { a: 3, b: 4 }, CTX)).toBe(12);
    expect(MathNode.evaluate({ op: 'add' }, { a: 5 }, CTX)).toBe(5); // b unconnected → 0
    expect(MathNode.evaluate({ op: 'div' }, { a: 5, b: 0 }, CTX)).toBe(0); // safe divide
  });

  it('Clamp bounds its input', () => {
    expect(ClampNode.evaluate({ min: 0, max: 1 }, { in: 2 }, CTX)).toBe(1);
    expect(ClampNode.evaluate({ min: 0, max: 1 }, { in: -1 }, CTX)).toBe(0);
  });

  it('Fit maps ranges and honours clamp', () => {
    expect(
      FitNode.evaluate(
        { inMin: 0, inMax: 10, outMin: 0, outMax: 100, clamp: false },
        { in: 5 },
        CTX,
      ),
    ).toBe(50);
    expect(
      FitNode.evaluate(
        { inMin: 0, inMax: 10, outMin: 0, outMax: 100, clamp: true },
        { in: 20 },
        CTX,
      ),
    ).toBe(100);
  });

  it('Mix blends a and b by factor', () => {
    expect(MixNode.evaluate({ factor: 0.25 }, { a: 0, b: 100 }, CTX)).toBe(25);
  });

  it('CurveRemap remaps through its ramp points', () => {
    expect(
      CurveRemapNode.evaluate(
        {
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 10 },
          ],
        },
        { in: 0.5 },
        CTX,
      ),
    ).toBe(5);
  });

  it('Noise is deterministic and matches the shared core formula', () => {
    const params = { scale: 2, phase: 0.5, octaves: 3, amplitude: 4, offset: 1 };
    const out = NoiseNode.evaluate(params, { t: 1.5 }, CTX);
    expect(out).toBe(fractalNoise(1.5 * 2 + 0.5, 3) * 4 + 1);
    expect(NoiseNode.evaluate(params, { t: 1.5 }, CTX)).toBe(out); // deterministic
  });
});

describe('#292 compute nodes — registration', () => {
  it('the whole vocabulary is registered by registerAllNodes', () => {
    __reseedAllNodesForTests();
    for (const type of ['Math', 'Clamp', 'Fit', 'Mix', 'CurveRemap', 'Noise']) {
      expect(getNodeType(type), `${type} should be registered`).toBeDefined();
    }
  });
});
