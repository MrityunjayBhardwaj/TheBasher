// statefulOps — the stateful eval-contract replay seam (Epic 2, #297). Proves the
// PURE integration core (determinism / scrub-safety / seed / bounds) and the seam
// wiring: a stateful Lag node feeding a driver is DETECTED and routed to the replay,
// and the Lag's transform-source controller is threaded into the render subscription
// set (H48) and the cycle-guard deps (G6) — the two edge-less hops the input walk
// can't see. The animated end-to-end (render == read under scrub) is the live probe.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { integrateLag, statefulSourceOf } from './statefulOps';
import { driverParamDeps, driverSubscriptionNodesForTarget } from './paramDrivers';

const BOX_ID = 'n_box';
const NULL_ID = 'n_null';
const LAG_ID = 'n_lag';
const CLAMP_ID = 'n_clamp';
const DRV_ID = 'n_drv';

/** box + a Null controller + a Lag (reading the Null's `tx`) wired into a ParamDriver
 *  that overlays box.material.metalness. This is the β wiring: driver ← (wired) Lag ←
 *  (transform param-ref) Null. */
// `null` source = a Lag with NO transform source (a bare wired lag); anything else is
// its `sourceTransform`. (Note: default params fire on `undefined`, so the no-source
// case must pass `null`, not `undefined`.)
function buildLagDrivenState(
  sourceTransform: unknown = { node: NULL_ID, channel: 'tx' },
): DagState {
  let state = buildDefaultDagState();
  state = applyOp(state, {
    type: 'addNode',
    nodeId: NULL_ID,
    nodeType: 'Null',
    params: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: LAG_ID,
    nodeType: 'Lag',
    params:
      sourceTransform === null
        ? { factor: 0.3, seedFrame: 0 }
        : { factor: 0.3, seedFrame: 0, sourceTransform },
  } as Op).next;
  state = applyOp(state, {
    type: 'addNode',
    nodeId: DRV_ID,
    nodeType: 'ParamDriver',
    params: { target: BOX_ID, paramPath: 'material.metalness', blendMode: 'replace', order: 0 },
  } as Op).next;
  state = applyOp(state, {
    type: 'connect',
    from: { node: LAG_ID, socket: 'out' },
    to: { node: DRV_ID, socket: 'in' },
  } as Op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('integrateLag — the pure interval/seed core', () => {
  const ramp = (f: number) => f; // input(f) = f (a rising sawtooth)

  it('seeds with the input at the seed frame (no lag at the seed)', () => {
    expect(integrateLag(ramp, 0, 0, 0.5)).toBe(0); // input(0) = 0
    expect(integrateLag((f) => f + 3, 5, 5, 0.5)).toBe(8); // input(5) = 8
  });

  it('closes `factor` of the gap toward the input each frame', () => {
    // seed out=0; f=1: lagStep(0,1,0.5)=0.5; f=2: lagStep(0.5,2,0.5)=1.25
    expect(integrateLag(ramp, 0, 1, 0.5)).toBe(0.5);
    expect(integrateLag(ramp, 0, 2, 0.5)).toBe(1.25);
  });

  it('factor 1 snaps to the input at the target frame (no lag)', () => {
    expect(integrateLag(ramp, 0, 10, 1)).toBe(10);
  });

  it('is deterministic / scrub-safe — same target frame, same value regardless of call order', () => {
    const at7a = integrateLag(ramp, 0, 7, 0.3);
    integrateLag(ramp, 0, 20, 0.3); // a "forward scrub" in between
    const at7b = integrateLag(ramp, 0, 7, 0.3); // back to 7
    expect(at7b).toBe(at7a);
  });

  it('trails a rising input (lagged value is BELOW the instantaneous input)', () => {
    const at10 = integrateLag(ramp, 0, 10, 0.3);
    expect(at10).toBeGreaterThan(0);
    expect(at10).toBeLessThan(10); // it trails — hasn't caught up to input(10)=10
  });

  it('backward of the seed there is nothing to integrate → raw input at that frame', () => {
    expect(integrateLag(ramp, 5, 2, 0.3)).toBe(2); // start=2, no loop → input(2)
  });

  it('bounds a pathological seed without diverging (the replay cap)', () => {
    const v = integrateLag((f) => (f % 2 === 0 ? 0 : 10), -1_000_000, 5, 0.3);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('statefulSourceOf — routing a stateful source to the replay', () => {
  it('detects a Lag wired into a driver’s `in`', () => {
    const state = buildLagDrivenState();
    const driver = state.nodes[DRV_ID];
    expect(statefulSourceOf(driver, state)?.id).toBe(LAG_ID);
  });

  it('returns null for a non-stateful (Clamp) source', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: CLAMP_ID,
      nodeType: 'Clamp',
      params: { min: 0.5, max: 1 },
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'material.metalness' },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: CLAMP_ID, socket: 'out' },
      to: { node: DRV_ID, socket: 'in' },
    } as Op).next;
    expect(statefulSourceOf(state.nodes[DRV_ID], state)).toBeNull();
  });

  it('returns null for an unwired driver', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: 'material.metalness' },
    } as Op).next;
    expect(statefulSourceOf(state.nodes[DRV_ID], state)).toBeNull();
  });
});

describe('the two edge-less hops through a stateful source', () => {
  it('cycle-guard deps include the Lag → controller hop (G6)', () => {
    const state = buildLagDrivenState();
    const deps = driverParamDeps(state.nodes);
    // driver → target and Lag → controller are both present
    expect(deps[BOX_ID]).toContain(DRV_ID);
    expect(deps[LAG_ID]).toContain(NULL_ID);
  });

  it('render subscription set includes the Lag AND its controller (H48)', () => {
    const state = buildLagDrivenState();
    const subs = driverSubscriptionNodesForTarget(state.nodes, BOX_ID).map((n) => n.id);
    expect(subs).toContain(LAG_ID); // reached via the wired driver.in edge
    expect(subs).toContain(NULL_ID); // reached via the Lag's transform param-ref
  });

  it('omits the controller hop when the Lag has no transform source', () => {
    const state = buildLagDrivenState(null);
    const deps = driverParamDeps(state.nodes);
    expect(deps[LAG_ID]).toBeUndefined();
  });
});
