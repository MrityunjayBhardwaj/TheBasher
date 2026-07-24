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

describe('#386 — the INVERSE (data → poser) reach and the null contract it must not break', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  /** A split light: an Object posing a LightData, the #386 C3 shape. */
  function buildSplitLight(): DagState {
    let s = buildState();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt_data',
      nodeType: 'LightData',
      params: { lightKind: 'Point', intensity: 5 },
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt',
      nodeType: 'Object',
      params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'lt_data', socket: 'out' },
      to: { node: 'lt', socket: 'data' },
    }).next;
    return s;
  }

  const ctx = (seconds: number) => ({
    time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
  });

  // THE CONTRACT GUARD. null means "nothing overrides this — caller uses base", and surfaces
  // gate on it (NPanel goes read-only while playing only when resolved !== null). The inverse
  // reach recurses into the poser, whose OWN forward reach would happily fall back to the data
  // node's base value — returning that would mark every un-animated data param as animated.
  it('an un-animated data param still resolves NULL (the base-fallback must not leak up the inverse reach)', () => {
    const s = buildSplitLight();
    expect(resolveEvaluatedParam(s, 'lt_data', 'intensity', ctx(0))).toBeNull();
  });

  // A channel authored on the POSER with a data paramPath — the shape a push-down leaves
  // behind (the Strip targets the Object; V112 aggregates animation under it). The inspector
  // renders the LightData's rows against the DATA id, so this read must reach UP or the row
  // reports the static base while the viewport animates (H40).
  it('a channel on the POSER resolves when the DATA node is asked (read == render)', () => {
    let s = buildSplitLight();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt_ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: 'lt',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 5, easing: 'linear' },
          { time: 2, value: 40, easing: 'linear' },
        ],
      },
    }).next;
    expect(resolveEvaluatedParam(s, 'lt_data', 'intensity', ctx(0))?.value).toBe(5);
    expect(resolveEvaluatedParam(s, 'lt_data', 'intensity', ctx(2))?.value).toBe(40);
  });

  // The data node's OWN channel still wins — the forward road is untouched.
  it("the data node's own channel is unaffected by the inverse reach", () => {
    let s = buildSplitLight();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'lt_ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'intensity',
        target: 'lt_data',
        paramPath: 'intensity',
        keyframes: [
          { time: 0, value: 9, easing: 'linear' },
          { time: 2, value: 90, easing: 'linear' },
        ],
      },
    }).next;
    expect(resolveEvaluatedParam(s, 'lt_data', 'intensity', ctx(2))?.value).toBe(90);
    // …and asking the OBJECT still reaches DOWN to it (the forward road, #398).
    expect(resolveEvaluatedParam(s, 'lt', 'intensity', ctx(2))?.value).toBe(90);
  });
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

  it('two channels on ONE param FOLD (not first-match) — the TOP order wins (#283)', () => {
    let state = buildState(); // CHAN_ID: 0→1 linear, blendMode replace / order 0 (defaults)
    // A SECOND channel on the same (target, param), higher order, constant 0.25.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_chan_param_2',
      nodeType: 'KeyframeChannelNumber',
      params: {
        target: BOX_ID,
        paramPath: PARAM,
        blendMode: 'replace',
        order: 5,
        keyframes: [{ time: 0, value: 0.25 }],
      },
    } as Op).next;
    // First-match would return CHAN_ID's 0.5 at t=0.5; the FOLD returns the TOP
    // (order 5) channel's constant 0.25 — proving the compositor read composes all
    // matching channels, matching the renderer (V88 D3 / H40).
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0.5))?.value).toBeCloseTo(0.25);
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

  // #398 — the object↔data reach. A cube's `material` lives on its linked BoxData, and the
  // inspector renders those rows against that node, so a keyed material channel targets the
  // DATA half while a caller naturally names the cube (the Object). The resolver must find it,
  // or the render overlays the animated value while every read surface reports the static base.
  it('reaches through the split: a channel on the DATA node resolves when asked on the Object', () => {
    let state = buildDefaultDagState();
    const dataId = Object.keys(state.nodes).find((k) => state.nodes[k].type === 'BoxData');
    expect(dataId, 'seed should be split (Object + BoxData)').toBeTruthy();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_on_data',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'rough',
        target: dataId,
        paramPath: 'material.specular.roughness',
        keyframes: [
          { time: 0, value: 0.1, easing: 'linear' },
          { time: 2, value: 0.9, easing: 'linear' },
        ],
      },
    }).next;

    // Asked on the OBJECT — the id a caller naturally has.
    const viaObject = resolveEvaluatedParam(state, BOX_ID, 'material.specular.roughness', ctxAt(1));
    expect(viaObject?.value).toBeCloseTo(0.5, 5);

    // Asked on the DATA node directly — the same answer, no double-reach.
    const viaData = resolveEvaluatedParam(state, dataId!, 'material.specular.roughness', ctxAt(1));
    expect(viaData?.value).toBeCloseTo(0.5, 5);
  });

  // #399 — the BASE-read twin of the #398 channel reach. With NO channel on the material,
  // reading the base colour on the OBJECT must still reach through the split to the BoxData's
  // real base value — not return null (which lets a caller fall back to the Object's absent
  // `material` and surface the fallback grey #808080).
  it('reaches through the split for the BASE value: an un-animated data param resolves on the Object', () => {
    const state = buildDefaultDagState();
    const dataId = Object.keys(state.nodes).find((k) => state.nodes[k].type === 'BoxData');
    expect(dataId, 'seed should be split (Object + BoxData)').toBeTruthy();
    const dataMat = (state.nodes[dataId!].params as { material: { base: { color: string } } })
      .material;
    const trueColor = dataMat.base.color;
    expect(trueColor).not.toBe('#808080'); // the seed cube has a real (green) default

    // Asked on the OBJECT, un-animated — reaches the BoxData's base, not null/grey.
    const viaObject = resolveEvaluatedParam(state, BOX_ID, 'material.base.color', ctxAt(0));
    expect(viaObject).not.toBeNull();
    expect(viaObject?.value).toBe(trueColor);

    // The size base reaches through too (the other data param).
    const size = resolveEvaluatedParam(state, BOX_ID, 'size', ctxAt(0));
    expect(size?.value).toEqual((state.nodes[dataId!].params as { size: unknown }).size);
  });

  // The reach is a FALLBACK, not a redirect: a channel authored against the Object with a
  // data paramPath must keep resolving. Both conventions exist and an up-front redirect
  // silently breaks this one (it did — 20 driver/param tests went red).
  it('still resolves a channel authored against the Object itself', () => {
    const state = buildState(); // channel targets BOX_ID with 'material.metalness'
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0.5))?.value).toBeCloseTo(0.5, 5);
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
