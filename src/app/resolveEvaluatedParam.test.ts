// C2 unit — resolveEvaluatedParam, the generic NON-transform evaluated resolver.
//
// Proves precedence transient > channel.sample() > null, that the channel path
// goes through the channel VALUE's .sample() (the render-identical path, NOT
// re-interpolation), and a grep gate banning interpolation math in the source
// (H40 form 1 trap).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { useTransientEditStore } from './stores/transientEditStore';

const BOX_ID = 'n_box';
const CHAN_ID = 'n_chan_param';
const PARAM = 'material.metalness';

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** Default box + a KeyframeChannelNumber animating material.metalness:
 *  0 at t=0 → 1 at t=1 (linear), so t=0.5 samples 0.5. */
function buildState(): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: CHAN_ID,
    nodeType: 'KeyframeChannelNumber',
    params: {
      target: BOX_ID,
      paramPath: PARAM,
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    },
  } as Op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useTransientEditStore.getState().clearAll();
});

describe('resolveEvaluatedParam (C2 — generic non-transform resolver)', () => {
  it('channel path returns channel.sample() at the ctx time (render-identical)', () => {
    const state = buildState();
    const at0 = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0));
    const atHalf = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0.5));
    const at1 = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(1));
    expect(at0?.value).toBeCloseTo(0);
    expect(atHalf?.value).toBeCloseTo(0.5);
    expect(at1?.value).toBeCloseTo(1);
  });

  it('transient WINS over the channel (precedence transient > channel)', () => {
    const state = buildState();
    useTransientEditStore.getState().set(BOX_ID, PARAM, 0.9);
    const r = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0.5));
    expect(r?.value).toBe(0.9); // the held edit, NOT the curve's 0.5
  });

  it('no channel for this (node, param) → null (caller reads base)', () => {
    const state = buildState();
    expect(resolveEvaluatedParam(state, BOX_ID, 'material.roughness', ctxAt(0.5))).toBeNull();
    expect(resolveEvaluatedParam(state, 'ghost', PARAM, ctxAt(0.5))).toBeNull();
  });

  it('transient on an UN-channeled param still resolves (transient > base-null)', () => {
    const state = buildState();
    useTransientEditStore.getState().set(BOX_ID, 'material.roughness', 0.3);
    const r = resolveEvaluatedParam(state, BOX_ID, 'material.roughness', ctxAt(0.5));
    expect(r?.value).toBe(0.3);
  });

  // GREP GATE (H40 form 1) — the resolver MUST NOT re-implement keyframe
  // interpolation; it must go through the channel value's .sample(). Banning
  // raw keyframe-array math here keeps render and read on the same code path.
  it('source contains NO keyframe-interpolation math (H40 form-1 grep gate)', () => {
    const src = readFileSync(join(__dirname, 'resolveEvaluatedParam.ts'), 'utf8');
    // No raw keyframe-array access (the renderer samples the value, not keyframes).
    expect(src).not.toMatch(/\.keyframes\b/);
    // No manual lerp / interpolation primitives.
    expect(src).not.toMatch(/\blerp\b/i);
    expect(src).not.toMatch(/\bslerp\b/i);
    // It MUST call .sample (the render-identical path).
    expect(src).toMatch(/\.sample\(/);
  });
});
