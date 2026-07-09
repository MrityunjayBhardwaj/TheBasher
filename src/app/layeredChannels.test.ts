// layeredChannels — the strip enumerator (epic #283 Phase 2, Slice C).
// Strips become synthetic KeyframeChannel contributions folded by the SAME reducer
// bare channels use. Nodes are parsed through their real schemas (as the DAG stores
// them) so channel-sampler defaults (modifiers/extend) apply exactly as in prod.

import { describe, it, expect, beforeAll } from 'vitest';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  layeredChannelValues,
  stripChannelValuesForTarget,
  stripTargetSet,
  layeredChannelNodesForTarget,
} from './layeredChannels';
import { ActionParams } from '../nodes/Action';
import { StripParams } from '../nodes/Strip';
import { TrackParams } from '../nodes/Track';
import type { Vec3 } from '../nodes/types';

beforeAll(() => {
  __reseedAllNodesForTests();
});

// A 2s linear position ramp [0,0,0] → [2,0,0] (predictable halfway = [1,0,0]).
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

describe('a single Replace strip folds to the retimed Action sample', () => {
  it('the synthetic value samples the placed Action (halfway → [1,0,0])', () => {
    const nodes = {
      act: actionNode('act'),
      strp: stripNode('strp', { action: 'act', target: 'box', start: 0 }),
      trk: trackNode('trk', { strips: ['strp'], order: 0 }),
    };
    const values = stripChannelValuesForTarget(nodes, 'box');
    expect(values).toHaveLength(1);
    expect(values[0].paramPath).toBe('position');
    expect(values[0].blendMode).toBe('replace');
    expect((values[0].sample(1) as Vec3).map((n) => Math.round(n))).toEqual([1, 0, 0]);
    expect(values[0].sample(0)).toEqual([0, 0, 0]);
  });
});

describe('two strips of one Action at different starts replay it, order-stable', () => {
  it('emits two ordered contributions; the second is time-shifted', () => {
    const nodes = {
      act: actionNode('act'),
      s1: stripNode('s1', { action: 'act', target: 'box', start: 0 }),
      s2: stripNode('s2', { action: 'act', target: 'box', start: 3 }),
      trk: trackNode('trk', { strips: ['s1', 's2'], order: 0 }),
    };
    const values = stripChannelValuesForTarget(nodes, 'box');
    expect(values).toHaveLength(2);
    // order = trackRank·STRIDE + stripIndex → 0, 1 (stable, authored order)
    expect(values[0].order).toBe(0);
    expect(values[1].order).toBe(1);
    // s2 placed at start=3 replays the ramp: global t=3 → action t=0 → [0,0,0].
    expect(values[1].sample(3)).toEqual([0, 0, 0]);
    expect((values[1].sample(4) as Vec3).map((n) => Math.round(n))).toEqual([1, 0, 0]);
  });
});

describe('touched-domain (I-3) — a strip only contributes to params its Action keys', () => {
  it('a position-only Action emits no scale/other-param value', () => {
    const nodes = {
      act: actionNode('act'), // position only
      strp: stripNode('strp', { action: 'act', target: 'box' }),
      trk: trackNode('trk', { strips: ['strp'] }),
    };
    const paths = stripChannelValuesForTarget(nodes, 'box').map((v) => v.paramPath);
    expect(paths).toEqual(['position']);
    expect(paths).not.toContain('scale');
  });
});

describe('track order + mute/solo gate at enumeration (render==read for mute)', () => {
  const build = (
    over: { trkOver?: Partial<TrackParams>; stripOver?: Partial<StripParams> } = {},
  ) => ({
    act: actionNode('act'),
    strp: stripNode('strp', { action: 'act', target: 'box', ...over.stripOver }),
    trk: trackNode('trk', { strips: ['strp'], ...over.trkOver }),
  });

  it('a muted track contributes nothing', () => {
    expect(stripChannelValuesForTarget(build({ trkOver: { mute: true } }), 'box')).toEqual([]);
  });
  it('a muted strip contributes nothing', () => {
    expect(stripChannelValuesForTarget(build({ stripOver: { muted: true } }), 'box')).toEqual([]);
  });
  it('solo on another track silences a non-solo track', () => {
    const nodes = {
      act: actionNode('act'),
      strp: stripNode('strp', { action: 'act', target: 'box' }),
      trk: trackNode('trk', { strips: ['strp'], order: 0 }),
      soloAct: actionNode('soloAct'),
      soloStrp: stripNode('soloStrp', { action: 'soloAct', target: 'other' }),
      soloTrk: trackNode('soloTrk', { strips: ['soloStrp'], order: 1, solo: true }),
    };
    // box's strip lives on a non-solo track → silenced while soloTrk soloes.
    expect(stripChannelValuesForTarget(nodes, 'box')).toEqual([]);
  });
});

describe('bottom→top track order + single-owner dedupe', () => {
  it('lower Track.order folds first; a strip shared by two tracks counts once (lowest order)', () => {
    const nodes = {
      act: actionNode('act'),
      shared: stripNode('shared', { action: 'act', target: 'box' }),
      low: trackNode('low', { strips: ['shared'], order: 0 }),
      high: trackNode('high', { strips: ['shared'], order: 5 }),
    };
    const values = stripChannelValuesForTarget(nodes, 'box');
    expect(values).toHaveLength(1); // deduped — lowest-order track wins
    expect(values[0].order).toBe(0);
  });
});

describe('empty strip set is byte-identical to the bare channel path', () => {
  it('layeredChannelValues returns the bare array when no strips target the node', () => {
    const nodes = { act: actionNode('act'), trk: trackNode('trk', { strips: [] }) };
    expect(layeredChannelValues(nodes, 'box')).toEqual([]);
    expect(stripChannelValuesForTarget(nodes, 'box')).toEqual([]);
  });
});

describe('membership + dependency helpers', () => {
  const nodes = {
    act: actionNode('act'),
    strp: stripNode('strp', { action: 'act', target: 'box' }),
    trk: trackNode('trk', { strips: ['strp'] }),
  };
  it('stripTargetSet lists every strip target (the render-mount gate)', () => {
    expect([...stripTargetSet(nodes)]).toEqual(['box']);
  });
  it('layeredChannelNodesForTarget includes the strip, its action, and all tracks', () => {
    const ids = layeredChannelNodesForTarget(nodes, 'box')
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(['act', 'strp', 'trk']);
  });
});
