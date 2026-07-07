// nlaLaneModel — the §3.1 PARITY GATE (epic #283 Phase 5, inc 5A).
//
// The lane model RE-STATES layeredChannels' enumeration rules (the file is
// do-not-touch and exports none of its internals) — so this test is the ONLY
// drift guard: ONE synthetic node table feeds BOTH `buildNlaLanes` AND the
// real `layeredChannelValues`, and we assert every strip the model marks
// `live` appears in the enumeration in the SAME relative order, and every
// model-degraded strip is ABSENT. Nodes are parsed through their real schemas
// (as the DAG stores them), the layeredChannels.test.ts discipline.

import { describe, it, expect, beforeAll } from 'vitest';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { layeredChannelValues } from '../app/layeredChannels';
import { buildNlaLanes, type NlaLanes, type NlaStripBlock } from './nlaLaneModel';
import { ActionParams } from '../nodes/Action';
import { StripParams } from '../nodes/Strip';
import { TrackParams } from '../nodes/Track';

beforeAll(() => {
  __reseedAllNodesForTests();
});

// A 2s linear position ramp 0 → [2,1,0] (the box target, predictable values).
const rampChannels = [
  {
    valueType: 'vec3',
    paramPath: 'position',
    keyframes: [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 2, value: [2, 1, 0], easing: 'linear' },
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

/** The model's LIVE strip ids for `target`, in ASCENDING fold order (rows are
 *  display-reversed → walk them bottom-up), strips in array order. */
function modelLiveIdsAsc(lanes: NlaLanes, target: string): string[] {
  const out: string[] = [];
  for (let i = lanes.rows.length - 1; i >= 0; i--) {
    for (const s of lanes.rows[i].strips) {
      if (s.live && s.targetId === target) out.push(s.stripId);
    }
  }
  return out;
}

/** The REAL enumeration's contributing strip ids for `target`, in fold order.
 *  Synthetic values are named `${strip.name}/${ch.paramPath}` and the
 *  builders set strip name = strip id. */
function enumIds(nodes: Parameters<typeof layeredChannelValues>[0], target: string): string[] {
  return layeredChannelValues(nodes, target).map((v) => v.name.split('/')[0]);
}

function findStrip(lanes: NlaLanes, trackId: string, stripId: string): NlaStripBlock {
  const row = lanes.rows.find((r) => r.trackId === trackId);
  if (!row) throw new Error(`no row ${trackId}`);
  const s = row.strips.find((b) => b.stripId === stripId);
  if (!s) throw new Error(`no strip ${stripId} in ${trackId}`);
  return s;
}

describe('PARITY case 1 — two tracks, distinct strips: order-asc enumeration, display reversed', () => {
  const nodes = {
    act: actionNode('act'),
    sA: stripNode('sA', { action: 'act', target: 'box', start: 0 }),
    sB: stripNode('sB', { action: 'act', target: 'box', start: 3 }),
    t1: trackNode('t1', { strips: ['sA'], order: 0 }),
    t2: trackNode('t2', { strips: ['sB'], order: 1 }),
  };
  it('every model-live strip appears in the enumeration, SAME relative order', () => {
    const lanes = buildNlaLanes(nodes);
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(['sA', 'sB']);
    expect(enumIds(nodes, 'box')).toEqual(['sA', 'sB']);
  });
  it('rows are display-REVERSED: top = highest order', () => {
    const lanes = buildNlaLanes(nodes);
    expect(lanes.rows.map((r) => r.trackId)).toEqual(['t2', 't1']);
    expect(lanes.soloActive).toBe(false);
  });
  it('placed span is derived: end = start + actLen·timeScale·repeat', () => {
    const lanes = buildNlaLanes(nodes);
    expect(findStrip(lanes, 't1', 'sA')).toMatchObject({ start: 0, end: 2, live: true });
    expect(findStrip(lanes, 't2', 'sB')).toMatchObject({ start: 3, end: 5 });
  });
});

describe('PARITY case 2 — solo on one track: the other model-degraded AND absent from enumeration', () => {
  const nodes = {
    act: actionNode('act'),
    sA: stripNode('sA', { action: 'act', target: 'box' }),
    sB: stripNode('sB', { action: 'act', target: 'box', start: 3 }),
    t1: trackNode('t1', { strips: ['sA'], order: 0 }),
    t2: trackNode('t2', { strips: ['sB'], order: 1, solo: true }),
  };
  it('model: non-solo track soloedOut, its strips not live; enumeration: only the solo track', () => {
    const lanes = buildNlaLanes(nodes);
    expect(lanes.soloActive).toBe(true);
    const t1Row = lanes.rows.find((r) => r.trackId === 't1');
    expect(t1Row?.soloedOut).toBe(true);
    expect(findStrip(lanes, 't1', 'sA')).toMatchObject({ soloedOut: true, live: false });
    expect(findStrip(lanes, 't2', 'sB').live).toBe(true);
    // parity: model-live == enumeration; degraded sA is ABSENT.
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(['sB']);
    expect(enumIds(nodes, 'box')).toEqual(['sB']);
  });
  it('soloed-out tracks stay VISIBLE as rows (authored state, never hidden)', () => {
    const lanes = buildNlaLanes(nodes);
    expect(lanes.rows).toHaveLength(2);
  });
});

describe('PARITY case 3 — duplicate strip id in a MUTED lowest track: the live/ghost SWAP', () => {
  const build = (t1Muted: boolean) => ({
    act: actionNode('act'),
    shared: stripNode('shared', { action: 'act', target: 'box' }),
    t1: trackNode('t1', { strips: ['shared'], order: 0, mute: t1Muted }),
    t2: trackNode('t2', { strips: ['shared'], order: 1 }),
  });

  it('T1 MUTED → ownership swaps: live in T2, ghost in T1; exactly ONE enumeration contribution', () => {
    const nodes = build(true);
    const lanes = buildNlaLanes(nodes);
    // the dedupe runs over the mute/solo-FILTERED list (layeredChannels.ts:173-175):
    // muted T1 is not scanned, so the live owner is T2.
    expect(findStrip(lanes, 't2', 'shared')).toMatchObject({ live: true, duplicateGhost: false });
    expect(findStrip(lanes, 't1', 'shared')).toMatchObject({
      live: false,
      duplicateGhost: true,
      trackMuted: true,
    });
    const values = layeredChannelValues(nodes, 'box');
    expect(values).toHaveLength(1); // exactly one contribution
    expect(values[0].order).toBe(0); // T2 is the ONLY live track → rank 0
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(enumIds(nodes, 'box'));
  });

  it('UN-mute T1 → the assignment SWAPS BACK: live in T1 (lowest order wins), ghost in T2; still one', () => {
    const nodes = build(false);
    const lanes = buildNlaLanes(nodes);
    expect(findStrip(lanes, 't1', 'shared')).toMatchObject({ live: true, duplicateGhost: false });
    expect(findStrip(lanes, 't2', 'shared')).toMatchObject({ live: false, duplicateGhost: true });
    const values = layeredChannelValues(nodes, 'box');
    expect(values).toHaveLength(1);
    expect(values[0].order).toBe(0); // T1, rank 0
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(enumIds(nodes, 'box'));
  });
});

describe('PARITY case 4 — orphan strip (dangling action id): degraded + absent', () => {
  const nodes = {
    orphn: stripNode('orphn', { action: 'nope', target: 'box' }),
    trk: trackNode('trk', { strips: ['orphn'], order: 0 }),
  };
  it('model flags orphan, not live; enumeration is empty', () => {
    const lanes = buildNlaLanes(nodes);
    expect(findStrip(lanes, 'trk', 'orphn')).toMatchObject({
      orphan: true,
      live: false,
      end: 0, // no domain → degenerate span at start
    });
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual([]);
    expect(enumIds(nodes, 'box')).toEqual([]);
  });
  it('an Action with no keys and an empty target are orphans too', () => {
    const nodes2 = {
      emptyAct: actionNode('emptyAct', []),
      noKeys: stripNode('noKeys', { action: 'emptyAct', target: 'box' }),
      act: actionNode('act'),
      noTgt: stripNode('noTgt', { action: 'act', target: '' }),
      trk: trackNode('trk', { strips: ['noKeys', 'noTgt'], order: 0 }),
    };
    const lanes = buildNlaLanes(nodes2);
    expect(findStrip(lanes, 'trk', 'noKeys')).toMatchObject({ orphan: true, live: false });
    expect(findStrip(lanes, 'trk', 'noTgt')).toMatchObject({ orphan: true, live: false });
    expect(enumIds(nodes2, 'box')).toEqual([]);
  });
});

describe('fold-fidelity edges the mirror must not soften', () => {
  it('missing strip ids are SKIPPED (not rendered, never claim ownership)', () => {
    const nodes = {
      act: actionNode('act'),
      real: stripNode('real', { action: 'act', target: 'box' }),
      trk: trackNode('trk', { strips: ['ghost-id', 'real'], order: 0 }),
    };
    const lanes = buildNlaLanes(nodes);
    const row = lanes.rows[0];
    expect(row.strips.map((s) => s.stripId)).toEqual(['real']);
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(enumIds(nodes, 'box'));
  });

  it('a MUTED strip in the lowest live track still CLAIMS ownership (claim precedes the gate, :175-180) — the duplicate stays a ghost and NOTHING folds', () => {
    const nodes = {
      act: actionNode('act'),
      shared: stripNode('shared', { action: 'act', target: 'box', muted: true }),
      t1: trackNode('t1', { strips: ['shared'], order: 0 }),
      t2: trackNode('t2', { strips: ['shared'], order: 1 }),
    };
    const lanes = buildNlaLanes(nodes);
    // T1's appearance owns but is strip-muted → not live; T2's is a ghost.
    expect(findStrip(lanes, 't1', 'shared')).toMatchObject({
      live: false,
      stripMuted: true,
      duplicateGhost: false,
    });
    expect(findStrip(lanes, 't2', 'shared')).toMatchObject({ live: false, duplicateGhost: true });
    expect(enumIds(nodes, 'box')).toEqual([]); // parity: nothing live, nothing folds
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual([]);
  });

  it('a duplicate within the SAME track: second appearance is a ghost (one fold contribution)', () => {
    const nodes = {
      act: actionNode('act'),
      shared: stripNode('shared', { action: 'act', target: 'box' }),
      trk: trackNode('trk', { strips: ['shared', 'shared'], order: 0 }),
    };
    const lanes = buildNlaLanes(nodes);
    const strips = lanes.rows[0].strips;
    expect(strips).toHaveLength(2);
    expect(strips[0]).toMatchObject({ live: true, duplicateGhost: false });
    expect(strips[1]).toMatchObject({ live: false, duplicateGhost: true });
    expect(enumIds(nodes, 'box')).toEqual(['shared']);
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(['shared']);
  });

  it('equal track orders tie-break lexicographically by id (the :158 sort)', () => {
    const nodes = {
      act: actionNode('act'),
      s1: stripNode('s1', { action: 'act', target: 'box' }),
      s2: stripNode('s2', { action: 'act', target: 'box', start: 3 }),
      zb: trackNode('zb', { strips: ['s2'], order: 0 }),
      aa: trackNode('aa', { strips: ['s1'], order: 0 }),
    };
    const lanes = buildNlaLanes(nodes);
    // asc = [aa, zb] → display reversed = [zb, aa]
    expect(lanes.rows.map((r) => r.trackId)).toEqual(['zb', 'aa']);
    expect(modelLiveIdsAsc(lanes, 'box')).toEqual(['s1', 's2']);
    expect(enumIds(nodes, 'box')).toEqual(['s1', 's2']);
  });
});
