// ParamDriver unit (#293, Inc 2) — the node's evaluate produces a KeyframeChannelValue
// that folds like a channel: constant sample() = the resolved `in`, carrying the bound
// (target, paramPath) so the target's followers/resolver can enumerate it.

import { beforeEach, describe, expect, it } from 'vitest';
import { ParamDriverNode } from './ParamDriver';
import type { EvalCtx } from '../core/dag/types';

const CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

describe('ParamDriverNode.evaluate', () => {
  beforeEach(() => {});

  it('emits a number KeyframeChannelValue whose sample() is the resolved `in`', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n_light', paramPath: 'intensity', blendMode: 'replace', order: 0 },
      { in: 4.2 },
      CTX,
    );
    expect(v.kind).toBe('KeyframeChannel');
    expect(v.valueType).toBe('number');
    expect(v.target).toBe('n_light');
    expect(v.paramPath).toBe('intensity');
    expect(v.mute).toBe(false);
    expect(v.weight).toBe(1);
    expect(v.blendMode).toBe('replace');
    // Constant over time (H40 — no time-varying leaf in Inc 2).
    expect(v.sample(0)).toBe(4.2);
    expect(v.sample(99)).toBe(4.2);
  });

  it('an unconnected `in` reads 0 (parity with the compute nodes)', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n_light', paramPath: 'intensity', blendMode: 'replace', order: 0 },
      {},
      CTX,
    );
    expect(v.sample(0)).toBe(0);
  });

  it('is a pure, cheap node (the stateless-driver contract)', () => {
    expect(ParamDriverNode.pure).toBe(true);
    expect(ParamDriverNode.type).toBe('ParamDriver');
    expect(ParamDriverNode.inputs.in.type).toBe('Number');
    expect(ParamDriverNode.inputs.inVec.type).toBe('Vector3');
    expect(ParamDriverNode.outputs.out.type).toBe('Number');
  });

  it('a wired `inVec` emits a vec3 KeyframeChannelValue (the Vector3 target road)', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n_light', paramPath: 'lookAt', blendMode: 'replace', order: 0 },
      { inVec: [1, 2, 3] },
      CTX,
    );
    expect(v.kind).toBe('KeyframeChannel');
    expect(v.valueType).toBe('vec3');
    expect(v.paramPath).toBe('lookAt');
    expect(v.sample(0)).toEqual([1, 2, 3]);
    expect(v.sample(99)).toEqual([1, 2, 3]); // constant over time (H40)
  });

  it('`inVec` wins over `in` when both are present (the vec road is chosen by type)', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n', paramPath: 'p', blendMode: 'replace', order: 0 },
      { in: 4.2, inVec: [7, 8, 9] },
      CTX,
    );
    expect(v.valueType).toBe('vec3');
    expect(v.sample(0)).toEqual([7, 8, 9]);
  });

  it('a malformed `inVec` (not a 3-number array) falls through to the scalar road', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n', paramPath: 'p', blendMode: 'replace', order: 0 },
      { in: 5, inVec: [1, 2] as unknown },
      CTX,
    );
    expect(v.valueType).toBe('number');
    expect(v.sample(0)).toBe(5);
  });
});
