// NLA time-varying influence (epic #283 Phase 3, inc 3B) — the `influenceAt` ramp
// thread. Cases 1-4 prove the ramp closure math + the byte-identity anchor (the key
// is ABSENT for non-crossfade strips) via the strip enumerator. Cases 5-6 are the
// ONLY coverage for fold site #2 (`resolveEvaluatedParam` :91/:103, reached by
// `__basher_evaluated_param` — NOT the position e2es): the single-match guard falls
// through to the fold, and the fold uses `influenceAt(t)` not the static `ch.weight`.
//
// Expected values are computed through the REAL `foldChannelValue` / `effectiveInfluence`
// / `readAt` (never hardcoded against an unknown default) so the test asserts render-
// parity by construction.

import { describe, it, expect, beforeEach } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { Op } from '../core/dag/types';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { stripChannelValuesForTarget } from './layeredChannels';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { foldChannelValue, type ChannelContribution } from '../nodes/foldChannel';
import { readAt } from '../nodes/overlayChannels';
import { effectiveInfluence, type InfluenceRamp } from '../nodes/channelModifiers';
import { ActionParams } from '../nodes/Action';
import { StripParams } from '../nodes/Strip';
import { TrackParams } from '../nodes/Track';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

// A 2s vec3 position ramp (actLen=2); influenceAt is a scalar so the valueType is
// irrelevant to the ramp math — this just gives the enumerator a real Action.
const rampChannels = [
  {
    valueType: 'vec3',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [2, 0, 0], easing: 'linear' },
    ],
  },
];
const actionNode = (id: string, channels: unknown[] = rampChannels) => ({
  id,
  type: 'Action',
  params: ActionParams.parse({ name: id, channels }),
  inputs: {},
});
const stripNode = (id: string, over: Partial<StripParams> = {}) => ({
  id,
  type: 'Strip',
  params: StripParams.parse({ name: id, ...over }),
  inputs: {},
});
const trackNode = (id: string, over: Partial<TrackParams> = {}) => ({
  id,
  type: 'Track',
  params: TrackParams.parse({ name: id, ...over }),
  inputs: {},
});

/** The single synthetic value for a lone strip over the ramp Action. */
function loneStripValue(over: Partial<StripParams>) {
  const nodes = {
    act: actionNode('act'),
    strp: stripNode('strp', { action: 'act', target: 'box', start: 0, ...over }),
    trk: trackNode('trk', { strips: ['strp'], order: 0 }),
  };
  const values = stripChannelValuesForTarget(nodes, 'box');
  expect(values).toHaveLength(1);
  return values[0];
}

describe('3B — the influenceAt ramp closure (fold site build)', () => {
  it('case 1 — blend-in ramp: 0 → full over [start, start+blendIn]', () => {
    const v = loneStripValue({ blendIn: 1 }); // rangeEnd = 0 + 2·1·1 = 2
    expect(v.influenceAt).toBeTypeOf('function');
    expect(v.influenceAt!(0)).toBeCloseTo(0);
    expect(v.influenceAt!(0.5)).toBeCloseTo(0.5);
    expect(v.influenceAt!(1)).toBeCloseTo(1);
    expect(v.influenceAt!(2)).toBeCloseTo(1); // inside range, past the lead-in
  });

  it('case 2 — blend-out ramp hits 0 exactly at the placed end (R4 window)', () => {
    const v = loneStripValue({ blendOut: 1 }); // placed end = 2
    expect(v.influenceAt!(1.5)).toBeCloseTo(0.5);
    expect(v.influenceAt!(2)).toBeCloseTo(0); // exactly at start + actLen·timeScale·repeat
  });

  it('case 3 — timeScale/repeat stretch the window (placed end = start+actLen·scale·repeat)', () => {
    const v = loneStripValue({ timeScale: 2, repeat: 1, blendOut: 1 }); // placed end = 0+2·2·1 = 4
    expect(v.influenceAt!(3.5)).toBeCloseTo(0.5);
    expect(v.influenceAt!(4)).toBeCloseTo(0);
  });

  it('case 4 — byte-identity anchor: no crossfade → NO influenceAt key (static weight path)', () => {
    const v = loneStripValue({ blendIn: 0, blendOut: 0 });
    expect(v).not.toHaveProperty('influenceAt');
    expect(v.weight).toBeCloseTo(1); // the static fallback the fold uses instead
  });
});

// --- Cases 5-6: fold site #2 (resolveEvaluatedParam) — the ONLY coverage for :91/:103 ---

// #365 Phase 5a (Slice 1b) — material lives on the BoxData node now (the split), so a
// material channel targets it, not the Object (n_box). resolveEvaluatedParam is kind-agnostic
// (params + fold), so the fold-site behavior under test is unchanged.
const BOX_ID = 'n_box_data';
const PARAM = 'material.base.metalness'; // OpenPBR IR numeric leaf, default 0
const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

/** Build a state with a NUMBER-valued Action (constant `value`) placed by `strips`. */
function buildNumberStripState(
  value: number,
  strips: { id: string; over: Partial<StripParams> }[],
): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'act',
    nodeType: 'Action',
    params: {
      name: 'act',
      channels: [
        {
          valueType: 'number',
          paramPath: PARAM,
          keyframes: [
            { time: 0, value },
            { time: 2, value },
          ],
        },
      ],
    },
  } as Op).next;
  for (const s of strips) {
    state = applyOp(state, {
      type: 'addNode',
      nodeId: s.id,
      nodeType: 'Strip',
      params: { name: s.id, action: 'act', target: BOX_ID, ...s.over },
    } as Op).next;
  }
  state = applyOp(state, {
    type: 'addNode',
    nodeId: 'trk',
    nodeType: 'Track',
    params: { name: 'trk', strips: strips.map((s) => s.id), order: 0 },
  } as Op).next;
  return state;
}

describe('3B — fold site #2 (resolveEvaluatedParam) under time-varying influence', () => {
  it('case 5 — single-match GUARD: a lone crossfading strip folds toward base, not the raw sample', () => {
    const base = readAt(
      buildDefaultDagState().nodes[BOX_ID].params as Record<string, unknown>,
      PARAM,
    ) as number;
    const sample = base + 2; // distinct from base so the fold differs from base AND raw
    const state = buildNumberStripState(sample, [{ id: 's1', over: { start: 0, blendIn: 1 } }]);

    const t = 0.5;
    const ramp: InfluenceRamp = {
      influence: 1,
      useRange: true,
      rangeStart: 0,
      rangeEnd: 2,
      blendIn: 1,
      blendOut: 0,
    };
    const inf = effectiveInfluence(ramp, t); // 0.5
    const expected = foldChannelValue(
      base,
      [{ value: sample, mode: 'replace', influence: inf }] as ChannelContribution[],
      'number',
      PARAM,
    ) as number;

    const got = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(t))?.value as number;
    // Folded toward base (proves the :91 guard fell through to the fold)...
    expect(got).toBeCloseTo(expected);
    // ...and NOT the raw sample (which the un-guarded fast path would have returned).
    expect(got).not.toBeCloseTo(sample);
  });

  it('case 6 — two crossfading matches FOLD via influenceAt(t), not the static ch.weight', () => {
    const base = readAt(
      buildDefaultDagState().nodes[BOX_ID].params as Record<string, unknown>,
      PARAM,
    ) as number;
    const sample = base + 2;
    const state = buildNumberStripState(sample, [
      { id: 's1', over: { start: 0, blendIn: 1 } },
      { id: 's2', over: { start: 0, blendIn: 1 } },
    ]);

    const t = 0.5;
    const ramp: InfluenceRamp = {
      influence: 1,
      useRange: true,
      rangeStart: 0,
      rangeEnd: 2,
      blendIn: 1,
      blendOut: 0,
    };
    const inf = effectiveInfluence(ramp, t); // 0.5 for each
    const contribs: ChannelContribution[] = [
      { value: sample, mode: 'replace', influence: inf },
      { value: sample, mode: 'replace', influence: inf },
    ];
    const expected = foldChannelValue(base, contribs, 'number', PARAM) as number;
    // What a REGRESSION to `ch.weight` (static influence == 1) would produce:
    const weightFold = foldChannelValue(
      base,
      [
        { value: sample, mode: 'replace', influence: 1 },
        { value: sample, mode: 'replace', influence: 1 },
      ] as ChannelContribution[],
      'number',
      PARAM,
    ) as number;

    const got = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(t))?.value as number;
    expect(got).toBeCloseTo(expected); // uses influenceAt(t) at both contributions
    expect(got).not.toBeCloseTo(weightFold); // a ch.weight typo would fail here
  });
});
