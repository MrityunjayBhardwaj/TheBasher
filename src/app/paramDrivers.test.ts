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
  driverStackForTarget,
  driverSubscriptionNodesForTarget,
  driverTargetSet,
  isDriverMuted,
} from './paramDrivers';
import { overlayChannels } from '../nodes/overlayChannels';
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

// #315 — the ordered driver STACK + mute. Before this, `order` was declared but never
// authorable (every creation site hardcoded 0), so the fold seams' stable sort
// degenerated to arbitrary node-table order; and `mute` did not exist at all. These
// pin BOTH: the winner is the TOP of the stack (deterministic, and it FLIPS when the
// order flips), and a bypassed driver contributes nothing — on the read road AND the
// render road, which must agree (H40).
describe('paramDrivers — the ordered driver stack + mute (#315)', () => {
  const CLAMP_B_ID = 'n_clamp_b';
  const DRV_B_ID = 'n_drv_b';

  /** Two drivers on the SAME (target, paramPath) band — the case that used to fold in
   *  arbitrary order. A: value 0.2 @ orderA. B: value 0.8 @ orderB. */
  function buildTwoDriverState(orderA: number, orderB: number): DagState {
    let state = buildDrivenState(0.2); // CLAMP_ID → DRV_ID @ order 0
    state = applyOp(state, {
      type: 'setParam',
      nodeId: DRV_ID,
      paramPath: 'order',
      value: orderA,
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: CLAMP_B_ID,
      nodeType: 'Clamp',
      params: { min: 0.8, max: 1 },
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_B_ID,
      nodeType: 'ParamDriver',
      params: { target: BOX_ID, paramPath: PARAM, blendMode: 'replace', order: orderB },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: CLAMP_B_ID, socket: 'out' },
      to: { node: DRV_B_ID, socket: 'in' },
    } as Op).next;
    return state;
  }

  const muteOp = (nodeId: string, mute: boolean): Op =>
    ({ type: 'setParam', nodeId, paramPath: 'mute', value: mute }) as Op;

  it('enumerates bottom → top by `order` — and the enumeration IS the fold order', () => {
    const state = buildTwoDriverState(0, 1);
    // The ONE scan+sort (what the #316 panel will list) — bottom first.
    expect(driverStackForTarget(state.nodes, BOX_ID).map((n) => n.id)).toEqual([DRV_ID, DRV_B_ID]);
    // …and the channel values the fold receives arrive in that same order. If these
    // two ever disagree, the panel's rows would lie about what actually renders.
    expect(driverChannelValuesForTarget(state, BOX_ID, ctxAt(0)).map((c) => c.order)).toEqual([
      0, 1,
    ]);
  });

  it('the TOP of the stack wins the band — on the READ road', () => {
    // B (0.8) on top → B wins.
    expect(
      resolveEvaluatedParam(buildTwoDriverState(0, 1), BOX_ID, PARAM, ctxAt(0))?.value,
    ).toBeCloseTo(0.8);
    // Flip the order → A (0.2) on top → the winner FLIPS. This is the whole fix: the
    // outcome is now a function of authored order, not of node-table key order.
    expect(
      resolveEvaluatedParam(buildTwoDriverState(1, 0), BOX_ID, PARAM, ctxAt(0))?.value,
    ).toBeCloseTo(0.2);
  });

  it('the RENDER road folds to the same winner (render == read, H40)', () => {
    const state = buildTwoDriverState(0, 1);
    const chans = driverChannelValuesForTarget(state, BOX_ID, ctxAt(0));
    // The render seam folds these through overlayChannels — the same primitive
    // SceneFromDAG uses. It must land where resolveEvaluatedParam landed.
    const folded = overlayChannels({ material: { metalness: 0 } }, chans, 1, 0);
    expect(folded?.material.metalness).toBeCloseTo(0.8);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.8);
  });

  it('MUTING the top driver hands the band to the one below it', () => {
    let state = buildTwoDriverState(0, 1);
    state = applyOp(state, muteOp(DRV_B_ID, true)).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.2);
    // Dropped at ENUMERATION — a bypassed driver is never even evaluated.
    expect(driverStackForTarget(state.nodes, BOX_ID).map((n) => n.id)).toEqual([DRV_ID]);
    expect(driverChannelValuesForTarget(state, BOX_ID, ctxAt(0))).toHaveLength(1);
    // Un-mute → it comes back and wins again (the flag is not one-way).
    state = applyOp(state, muteOp(DRV_B_ID, false)).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.8);
  });

  it('muting EVERY driver falls the param back to its base (and unmounts the overlay)', () => {
    let state = buildTwoDriverState(0, 1);
    state = applyOp(state, muteOp(DRV_ID, true)).next;
    state = applyOp(state, muteOp(DRV_B_ID, true)).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))).toBeNull(); // base fallback
    expect(driverTargetSet(state.nodes).has(BOX_ID)).toBe(false); // no overlay mount
  });

  it('the panel view keeps muted members — so a bypassed row can be re-enabled', () => {
    let state = buildTwoDriverState(0, 1);
    state = applyOp(state, muteOp(DRV_B_ID, true)).next;
    const rows = driverStackForTarget(state.nodes, BOX_ID, PARAM, true);
    expect(rows.map((n) => n.id)).toEqual([DRV_ID, DRV_B_ID]);
    expect(rows.map((n) => isDriverMuted(n))).toEqual([false, true]);
  });

  it('narrows to ONE param band — a driver on another param is a different stack', () => {
    let state = buildTwoDriverState(0, 1);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: DRV_B_ID,
      paramPath: 'paramPath',
      value: 'material.roughness',
    } as Op).next;
    expect(driverStackForTarget(state.nodes, BOX_ID, PARAM).map((n) => n.id)).toEqual([DRV_ID]);
    expect(
      driverStackForTarget(state.nodes, BOX_ID, 'material.roughness').map((n) => n.id),
    ).toEqual([DRV_B_ID]);
    // Different bands don't contend: each keeps its own value.
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.2);
    expect(resolveEvaluatedParam(state, BOX_ID, 'material.roughness', ctxAt(0))?.value).toBeCloseTo(
      0.8,
    );
  });

  it('BYTE-IDENTITY: a single all-zero-order driver is untouched by the stack', () => {
    // The pre-#315 corpus: one driver, order 0, no mute. Stable sort over it is a no-op.
    const state = buildDrivenState(0.7);
    expect(driverStackForTarget(state.nodes, BOX_ID).map((n) => n.id)).toEqual([DRV_ID]);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.7);
    expect(driverChannelValuesForTarget(state, BOX_ID, ctxAt(0))[0].mute).toBe(false);
  });
});

// #294 (Inc 3) — the spare road: a promoted spare param drives a target directly (the
// `ch()` pull), resolved in the seam via readBaseParam (the evaluator can't see spare).
describe('paramDrivers — the vec Point-controller road (#300 F2b)', () => {
  const NULL_ID = 'n_ctl';
  const DRVV_ID = 'n_drv_vec';
  const NULL_POS: [number, number, number] = [3, 1, 0];

  /** Default scene + a Null (wired as a scene child so it evaluates) at NULL_POS +
   *  a ParamDriver reading the Null's WHOLE position onto box.position. */
  function buildVecDrivenState(): DagState {
    let state = buildDefaultDagState();
    const sceneId = state.outputs.scene!.node;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: NULL_ID,
      nodeType: 'Null',
      params: { position: NULL_POS, rotation: [0, 0, 0], scale: [1, 1, 1] },
    } as Op).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: NULL_ID, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRVV_ID,
      nodeType: 'ParamDriver',
      params: {
        target: BOX_ID,
        paramPath: 'position',
        blendMode: 'replace',
        order: 0,
        sourceTransformVec: { node: NULL_ID },
      },
    } as Op).next;
    return state;
  }

  it('folds the Null WHOLE position as a vec3 channel onto the target', () => {
    const state = buildVecDrivenState();
    const chans = driverChannelValuesForTarget(state, BOX_ID, ctxAt(0));
    expect(chans).toHaveLength(1);
    expect(chans[0].valueType).toBe('vec3');
    expect(chans[0].sample(0)).toEqual(NULL_POS);
  });

  it('a MOVED controller flows through to the driven vec (the pull dependency)', () => {
    let state = buildVecDrivenState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: NULL_ID,
      paramPath: 'position',
      value: [-2, 4, 1],
    } as Op).next;
    expect(driverChannelValuesForTarget(state, BOX_ID, ctxAt(0))[0].sample(0)).toEqual([-2, 4, 1]);
  });

  it('exposes the edge-less driver→controller dep (G6) + subscribes the controller (H48)', () => {
    const state = buildVecDrivenState();
    const deps = driverParamDeps(state.nodes);
    expect(deps[BOX_ID]).toEqual([DRVV_ID]);
    expect(deps[DRVV_ID]).toEqual([NULL_ID]);
    expect(driverSubscriptionNodesForTarget(state.nodes, BOX_ID).map((n) => n.id)).toContain(
      NULL_ID,
    );
  });
});

describe('paramDrivers — the spare (ch) road', () => {
  const SPARE_HOST = 'n_clamp'; // reuse any node; the spare lives on it, not its params

  /** Box.material.metalness ← ParamDriver ← spare `throttle` on SPARE_HOST. */
  function buildSpareDrivenState(value: number): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: SPARE_HOST,
      nodeType: 'Clamp',
      params: { min: 0, max: 1 },
    } as Op).next;
    state = applyOp(state, {
      type: 'setSpareParam',
      nodeId: SPARE_HOST,
      key: 'throttle',
      param: { type: 'float', value, promoted: true },
    } as Op).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: DRV_ID,
      nodeType: 'ParamDriver',
      params: {
        target: BOX_ID,
        paramPath: PARAM,
        blendMode: 'replace',
        order: 0,
        sourceSpare: { node: SPARE_HOST, key: 'throttle' },
      },
    } as Op).next;
    return state;
  }

  it('resolves the promoted spare value onto the target (no wired in edge)', () => {
    const state = buildSpareDrivenState(0.55);
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.55);
  });

  it('a dock/inspector edit to the spare flows through (the pull dependency)', () => {
    let state = buildSpareDrivenState(0.55);
    state = applyOp(state, {
      type: 'setSpareParam',
      nodeId: SPARE_HOST,
      key: 'throttle',
      param: { type: 'float', value: 0.2, promoted: true },
    } as Op).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0.2);
  });

  it('the subscription closure includes the spare host (render rebuilds on a spare edit)', () => {
    const state = buildSpareDrivenState(0.55);
    const ids = driverSubscriptionNodesForTarget(state.nodes, BOX_ID)
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual([DRV_ID, SPARE_HOST].sort());
  });

  it('driverParamDeps exposes the driver→sourceNode edge for the cycle guard', () => {
    const state = buildSpareDrivenState(0.55);
    expect(driverParamDeps(state.nodes)).toEqual({
      [BOX_ID]: [DRV_ID],
      [DRV_ID]: [SPARE_HOST],
    });
  });

  it('a non-numeric / missing spare reads 0 (parity with the unconnected wired default)', () => {
    // Point the driver at a spare key that does not exist.
    let state = buildSpareDrivenState(0.55);
    state = applyOp(state, {
      type: 'setParam',
      nodeId: DRV_ID,
      paramPath: 'sourceSpare',
      value: { node: SPARE_HOST, key: 'missing' },
    } as Op).next;
    expect(resolveEvaluatedParam(state, BOX_ID, PARAM, ctxAt(0))?.value).toBeCloseTo(0);
  });
});
