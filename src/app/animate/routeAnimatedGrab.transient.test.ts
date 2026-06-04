// A3 unit — routeAnimatedGrab OFF branch now HOLDS a transient (issue #149),
// no longer rejects with window.alert.
//
// Proves the FLAG-A supersession: an animated + paused + Auto-Key-OFF edit
//   1. sets the transient slot (the held value),
//   2. fires ZERO DAG ops (state ref is untouched — H36 single-write),
//   3. fires NO window.alert,
//   4. still returns true (caller skips its raw setParam + trailing autoKeyCommit).
// And the un-animated path is byte-identical: returns false, no transient.
//
// REF: PLAN.md Wave A (A3); CONTEXT D-149-1; hetvabhasa H36; vyapti V1.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { applyOp } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { buildDefaultDagState } from '../../core/project/default';
import { __resetRegistryForTests } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { routeAnimatedGrab } from './autoKeyCommit';
import { useDagStore } from '../../core/dag/store';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { useTimeStore } from '../stores/timeStore';
import { useTransientEditStore } from '../stores/transientEditStore';

// Reuse the default project's box (it already carries valid params); add a
// channel that animates its `position`.
const BOX_ID = 'n_box';
const CHAN_ID = 'n_chan_149';

/** The default box + a KeyframeChannelVec3 animating `position` (one key t=0). */
function buildAnimatedState(): DagState {
  let state = buildDefaultDagState();
  if (!state.nodes[BOX_ID]) {
    throw new Error(`expected default state to contain ${BOX_ID}`);
  }
  state = applyOp(state, {
    type: 'addNode',
    nodeId: CHAN_ID,
    nodeType: 'KeyframeChannelVec3',
    params: {
      target: BOX_ID,
      paramPath: 'position',
      keyframes: [{ time: 0, value: [0, 0, 0] }],
    },
  } as Op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  useTransientEditStore.getState().clearAll();
  useTimeStore.setState({ playing: false, frame: 0, seconds: 0 } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routeAnimatedGrab — Auto-Key-OFF transient hold (A3)', () => {
  it('animated + paused + OFF → sets transient, ZERO ops, no alert, returns true', () => {
    const state = buildAnimatedState();
    useDagStore.setState({ state } as Partial<ReturnType<typeof useDagStore.getState>>);
    useAutoKeyStore.setState({ enabled: false } as never);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const stateRefBefore = useDagStore.getState().state;
    const handled = routeAnimatedGrab(BOX_ID, 'position', [9, 0, 0]);

    expect(handled).toBe(true); // handled → caller does NOT raw-setParam
    // 1. transient held
    expect(useTransientEditStore.getState().get(BOX_ID, 'position')).toEqual({
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [9, 0, 0],
    });
    // 2. ZERO DAG ops — the dag state object is the SAME ref (H36 single-write)
    expect(useDagStore.getState().state).toBe(stateRefBefore);
    // 3. no alert
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('un-animated param → returns false (raw setParam path), no transient', () => {
    const state = buildAnimatedState();
    useDagStore.setState({ state } as Partial<ReturnType<typeof useDagStore.getState>>);
    useAutoKeyStore.setState({ enabled: false } as never);

    // `rotation` is NOT animated (only `position` has a channel).
    const handled = routeAnimatedGrab(BOX_ID, 'rotation', [1, 0, 0]);

    expect(handled).toBe(false); // un-animated → caller's existing raw path
    expect(useTransientEditStore.getState().has(BOX_ID, 'rotation')).toBe(false);
  });

  it('animated + playing → returns true (no op, no transient — display-follow)', () => {
    const state = buildAnimatedState();
    useDagStore.setState({ state } as Partial<ReturnType<typeof useDagStore.getState>>);
    useAutoKeyStore.setState({ enabled: false } as never);
    useTimeStore.setState({ playing: true, frame: 0, seconds: 0 } as never);

    const handled = routeAnimatedGrab(BOX_ID, 'position', [9, 0, 0]);

    expect(handled).toBe(true);
    // playing gate fires BEFORE the OFF branch → no transient held.
    expect(useTransientEditStore.getState().has(BOX_ID, 'position')).toBe(false);
  });
});
