// driverStack (#316) — the authoring half of the DRIVER stack: the BAND grouping the panel
// renders, the source labels that make two rows on one band distinguishable, and the
// mute/move/remove builders. The engine (order + mute + the shared enumeration) is #315;
// this is the surface over it.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import {
  buildMoveDriverOps,
  buildRemoveDriverOps,
  buildToggleDriverMuteOp,
  driverBandsForTarget,
  driverSourceLabel,
} from './driverStack';

const BOX_ID = 'n_box';
const METAL = 'material.metalness';
const ROUGH = 'material.roughness';
const ctxAt = (seconds: number) => ({ time: { frame: 0, seconds, normalized: 0 } });

const addClamp = (id: string, min: number): Op =>
  ({ type: 'addNode', nodeId: id, nodeType: 'Clamp', params: { min, max: 1 } }) as Op;
const addDriver = (id: string, paramPath: string, order: number): Op =>
  ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'ParamDriver',
    params: { target: BOX_ID, paramPath, blendMode: 'replace', order },
  }) as Op;
const wire = (from: string, to: string): Op =>
  ({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket: 'in' } }) as Op;

function withOps(...ops: Op[]): DagState {
  let state = buildDefaultDagState();
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

/** Two drivers on the metalness band (0.2 @ order 0, 0.8 @ order 1) + one on roughness. */
function buildBandedState(): DagState {
  return withOps(
    addClamp('c_a', 0.2),
    addClamp('c_b', 0.8),
    addClamp('c_r', 0.5),
    addDriver('d_a', METAL, 0),
    addDriver('d_b', METAL, 1),
    addDriver('d_r', ROUGH, 0),
    wire('c_a', 'd_a'),
    wire('c_b', 'd_b'),
    wire('c_r', 'd_r'),
  );
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('driverStack — the BAND is the unit (#316)', () => {
  it('groups drivers by param path — one stack per driven param, not one per object', () => {
    const bands = driverBandsForTarget(buildBandedState(), BOX_ID);
    expect(bands.map((b) => b.paramPath)).toEqual([METAL, ROUGH]); // sorted, stable
    expect(bands[0].entries.map((e) => e.nodeId)).toEqual(['d_a', 'd_b']); // bottom → top
    expect(bands[1].entries.map((e) => e.nodeId)).toEqual(['d_r']);
  });

  it('rows are labelled by their SOURCE — two ParamDrivers on a band must be tellable apart', () => {
    const bands = driverBandsForTarget(buildBandedState(), BOX_ID);
    const labels = bands[0].entries.map((e) => e.label);
    expect(labels).toEqual(['c_a', 'c_b']); // the wired compute nodes, not "ParamDriver" twice
    expect(new Set(labels).size).toBe(2);
  });

  it('labels the controller ROADS by what they read', () => {
    let state = withOps(
      { type: 'addNode', nodeId: 'ctl', nodeType: 'Null', params: {} } as Op,
      addDriver('d_x', METAL, 0),
    );
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'd_x',
      paramPath: 'sourceTransform',
      value: { node: 'ctl', channel: 'tx' },
    } as Op).next;
    expect(driverSourceLabel(state, state.nodes['d_x'])).toBe('ctl.tx');

    let vecState = withOps(
      { type: 'addNode', nodeId: 'ctl', nodeType: 'Null', params: {} } as Op,
      addDriver('d_v', 'position', 0),
    );
    vecState = applyOp(vecState, {
      type: 'setParam',
      nodeId: 'd_v',
      paramPath: 'sourceTransformVec',
      value: { node: 'ctl' },
    } as Op).next;
    expect(driverSourceLabel(vecState, vecState.nodes['d_v'])).toBe('ctl.position');
  });

  it('an unsourced driver says so rather than pretending to be bound', () => {
    const state = withOps(addDriver('d_0', METAL, 0));
    expect(driverSourceLabel(state, state.nodes['d_0'])).toBe('unbound');
  });

  it('a muted row still renders (so it can be re-enabled) and reads as muted', () => {
    let state = buildBandedState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'd_b',
      paramPath: 'mute',
      value: true,
    } as Op).next;
    const band = driverBandsForTarget(state, BOX_ID)[0];
    expect(band.entries.map((e) => e.nodeId)).toEqual(['d_a', 'd_b']);
    expect(band.entries.map((e) => e.muted)).toEqual([false, true]);
  });
});

describe('driverStack — the builders (#316)', () => {
  it('mute toggles, and the ROW the panel shows becomes the value the fold resolves', () => {
    let state = buildBandedState();
    // Top (0.8) wins.
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))?.value).toBeCloseTo(0.8);
    const op = buildToggleDriverMuteOp(state, 'd_b')!;
    state = applyOp(state, op).next;
    // Bypassed → the one below it takes the band.
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))?.value).toBeCloseTo(0.2);
    // …and toggling back restores it (not a one-way flag).
    state = applyOp(state, buildToggleDriverMuteOp(state, 'd_b')!).next;
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))?.value).toBeCloseTo(0.8);
  });

  it('move reorders WITHIN the band — and the fold winner follows', () => {
    let state = buildBandedState();
    const ops = buildMoveDriverOps(state, 'd_a', 'up')!; // lift the bottom one above d_b
    for (const op of ops) state = applyOp(state, op).next;
    expect(driverBandsForTarget(state, BOX_ID)[0].entries.map((e) => e.nodeId)).toEqual([
      'd_b',
      'd_a',
    ]);
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))?.value).toBeCloseTo(0.2); // d_a now on top
  });

  it('move is a NO-OP at the ends (the UI disables it; the builder refuses too)', () => {
    const state = buildBandedState();
    expect(buildMoveDriverOps(state, 'd_a', 'down')).toBeNull(); // already the bottom
    expect(buildMoveDriverOps(state, 'd_b', 'up')).toBeNull(); // already the top
    // A lone driver on its own band cannot move either way.
    expect(buildMoveDriverOps(state, 'd_r', 'up')).toBeNull();
    expect(buildMoveDriverOps(state, 'd_r', 'down')).toBeNull();
  });

  it('move does NOT reach across bands — a driver on another param is not a neighbour', () => {
    let state = buildBandedState();
    const ops = buildMoveDriverOps(state, 'd_a', 'up')!;
    for (const op of ops) state = applyOp(state, op).next;
    // The roughness band is untouched by a metalness reorder.
    expect(resolveEvaluatedParam(state, BOX_ID, ROUGH, ctxAt(0))?.value).toBeCloseTo(0.5);
    expect(driverBandsForTarget(state, BOX_ID)[1].entries.map((e) => e.nodeId)).toEqual(['d_r']);
  });

  it('remove drops the driver and hands the band back to the one below', () => {
    let state = buildBandedState();
    for (const op of buildRemoveDriverOps(state, 'd_b')!) state = applyOp(state, op).next;
    expect(driverBandsForTarget(state, BOX_ID)[0].entries.map((e) => e.nodeId)).toEqual(['d_a']);
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))?.value).toBeCloseTo(0.2);
  });

  it('removing the LAST driver on a band drops the band and frees the param to its base', () => {
    let state = buildBandedState();
    for (const id of ['d_a', 'd_b']) {
      for (const op of buildRemoveDriverOps(state, id)!) state = applyOp(state, op).next;
    }
    expect(driverBandsForTarget(state, BOX_ID).map((b) => b.paramPath)).toEqual([ROUGH]);
    expect(resolveEvaluatedParam(state, BOX_ID, METAL, ctxAt(0))).toBeNull(); // base fallback
  });

  it('the builders refuse a non-driver node (the panel can only be pointed at drivers)', () => {
    const state = buildBandedState();
    expect(buildToggleDriverMuteOp(state, BOX_ID)).toBeNull();
    expect(buildMoveDriverOps(state, BOX_ID, 'up')).toBeNull();
    expect(buildRemoveDriverOps(state, BOX_ID)).toBeNull();
  });
});
