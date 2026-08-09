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
    // #609 — ONE socket accepting BOTH types, where there were two sockets for one
    // role. Pinned as the set, in order: this is the first production socket to declare
    // one, so it is also the adoption proof that the union has a real user.
    expect(ParamDriverNode.inputs.in.type).toEqual(['Number', 'Vector3']);
    expect(Object.keys(ParamDriverNode.inputs)).toEqual(['in']);
    expect(ParamDriverNode.outputs.out.type).toBe('Number');
  });

  it('a Vec3 on `in` emits a vec3 KeyframeChannelValue (the Vector3 target road)', () => {
    const v = ParamDriverNode.evaluate(
      { target: 'n_light', paramPath: 'lookAt', blendMode: 'replace', order: 0 },
      { in: [1, 2, 3] },
      CTX,
    );
    expect(v.kind).toBe('KeyframeChannel');
    expect(v.valueType).toBe('vec3');
    expect(v.paramPath).toBe('lookAt');
    expect(v.sample(0)).toEqual([1, 2, 3]);
    expect(v.sample(99)).toEqual([1, 2, 3]); // constant over time (H40)
  });

  it('the road is chosen by the VALUE, not by which socket was wired (#609)', () => {
    // The two sockets are gone, so there is no precedence rule left to get backwards:
    // the same socket carries either type and the shape decides. Both directions, since
    // a guard that only ever sees one of them proves nothing about the branch.
    const vec = ParamDriverNode.evaluate(
      { target: 'n', paramPath: 'p', blendMode: 'replace', order: 0 },
      { in: [7, 8, 9] },
      CTX,
    );
    expect(vec.valueType).toBe('vec3');
    expect(vec.sample(0)).toEqual([7, 8, 9]);

    const num = ParamDriverNode.evaluate(
      { target: 'n', paramPath: 'p', blendMode: 'replace', order: 0 },
      { in: 4.2 },
      CTX,
    );
    expect(num.valueType).toBe('number');
    expect(num.sample(0)).toBe(4.2);
  });

  it('a malformed payload reads 0 rather than being cast to a number (#609)', () => {
    // With two sockets a bad Vector3 left the scalar socket's real number behind it.
    // One socket has nothing behind it, so an unrecognised payload must be REJECTED to
    // 0 — casting it would fold `[1, 2]` as if it were a scalar.
    const v = ParamDriverNode.evaluate(
      { target: 'n', paramPath: 'p', blendMode: 'replace', order: 0 },
      { in: [1, 2] as unknown },
      CTX,
    );
    expect(v.valueType).toBe('number');
    expect(v.sample(0)).toBe(0);
  });
});
