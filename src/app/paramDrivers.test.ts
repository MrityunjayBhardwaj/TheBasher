// paramDrivers + resolveEvaluatedParam driver overlay (#293, Inc 2). Proves the PULL
// rail end to end on the read side: a Clamp compute node → a ParamDriver → a target
// param, resolved through the SAME fold channels ride (H40). Also the membership set,
// the edge-less paramDeps adjacency (G6), and the render-subscription closure.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import {
  driverChannelValuesForTarget,
  driverNodesForTarget,
  driverParamDeps,
  driverSubscriptionNodesForTarget,
  driverTargetSet,
} from './paramDrivers';
import { useTransientEditStore } from './stores/transientEditStore';

const BOX_ID = 'n_box';
const CLAMP_ID = 'n_clamp';
const DRV_ID = 'n_drv';
const PARAM = 'material.metalness';
const ctxAt = (seconds: number) => ({ time: { frame: 0, seconds, normalized: 0 } });

/** Default box + a Clamp(min) source producing a known constant (in unconnected → 0
 *  → clamp(0, min, 1) === min) + a ParamDriver overlaying box.material.metalness. */
function buildDrivenState(min = 0.7): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: CLAMP_ID,
    nodeType: 'Clamp',
    params: { min, max: 1 },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: DRV_ID,
    nodeType: 'ParamDriver',
    params: { target: BOX_ID, paramPath: PARAM, blendMode: 'replace', order: 0 },
  } as Op).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: CLAMP_ID, socket: 'out' },
    to: { node: DRV_ID, socket: 'in' },
  } as Op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useTransientEditStore.getState().clearAll();
});

describe('paramDrivers — the PULL rail read side', () => {
  it('resolveEvaluatedParam returns the driven (computed) value', () => {
    const state = buildDrivenState(0.7);
    const r = resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0));
    expect(r?.value).toBeCloseTo(0.7);
  });

  it('is CONSTANT over scrub (stateless driver → render == read, H40)', () => {
    const state = buildDrivenState(0.42);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.42);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(3))?.value).toBeCloseTo(0.42);
  });

  it('a SOURCE edit flows through to the driven value (the pull dependency)', () => {
    let state = buildDrivenState(0.7);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: CLAMP_ID,
      paramPath: 'min',
      value: 0.3,
    } as Op).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.3);
  });

  it('transient still WINS over a driver (precedence transient > overlay)', () => {
    const state = buildDrivenState(0.7);
    useTransientEditStore.getState().set(BOX_ID, PARAM, 0.9);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBe(0.9);
  });

  it('an undriven param is byte-identical — resolve returns null (base fallback)', () => {
    const state = buildDefaultDagState();
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))).toBeNull();
  });

  it('driverTargetSet + driverParamDeps expose the edge-less relation', () => {
    const state = buildDrivenState();
    expect(driverTargetSet(state.nodes).has(BOX_ID)).toBe(true);
    expect(driverParamDeps(state.nodes)).toEqual({ [BOX_ID]: [DRV_ID] });
    expect(driverChannelValuesForTarget(state, BOX_ID, ctxAt(0)).length).toBe(1);
    expect(driverNodesForTarget(state.nodes, BOX_ID).map((d) => d.id)).toEqual([DRV_ID]);
  });

  it('driverSubscriptionNodesForTarget includes the driver AND its compute closure', () => {
    const state = buildDrivenState();
    const ids = driverSubscriptionNodesForTarget(state.nodes, BOX_ID)
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual([CLAMP_ID, DRV_ID].sort());
  });

  it('an UNBOUND ParamDriver (no target/param) overlays nothing', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: { target: '', paramPath: '', blendMode: 'replace', order: 0 },
    } as Op).next;
    expect(driverTargetSet(state.nodes).size).toBe(0);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))).toBeNull();
  });
});
