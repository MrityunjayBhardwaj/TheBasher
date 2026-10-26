// #1688 — [ and ] seek to the previous / next key on the active channel, compared on the clock the
// key plays on. The scene runs at a quarter and the playhead is at 4 s (scene time 1 s); both
// channels have keys at 2 s and 6 s.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { useDagStore } from '../core/dag/store';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { findAdjacentKeyframeTime } from './KeyboardShortcuts';
import { sceneClockOf } from './sceneClock';
import { useTimeStore } from './stores/timeStore';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

afterEach(() => {
  useTimeStore.getState().setTimeMap(null);
  useTimeStore.getState().setTime(0);
  useTimelineSelection.getState().setActiveChannel(null);
});

function keysAt2And6(id: string, target: string): Op {
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: 'KeyframeChannelVec3',
    params: {
      name: 'position',
      target,
      paramPath: 'position',
      keyframes: [
        { time: 2, value: [0, 0, 0], easing: 'linear' },
        { time: 6, value: [1, 0, 0], easing: 'linear' },
      ],
    },
  };
}

function load(): DagState {
  let state = buildDefaultDagState();
  const scene = state.outputs.scene!.node;
  for (const op of [
    { type: 'setParam', nodeId: scene, paramPath: 'timeSpeed', value: 0.25 },
    keysAt2And6('ch_box', 'n_box'),
    keysAt2And6('ch_cam', 'n_camera'),
  ] as Op[]) {
    state = applyOp(state, op).next;
  }
  useDagStore.setState({ state });
  useTimeStore.getState().setTimeMap(sceneClockOf(state));
  useTimeStore.getState().setTime(4);
  return state;
}

describe('[ and ] on the clock a key plays on (#1688)', () => {
  it('a scene-time key is reached where it is first on screen', () => {
    load();
    expect(useTimeStore.getState().seconds).toBeCloseTo(1);
    useTimelineSelection.getState().setActiveChannel('ch_box');
    // Scene time 1 s: the next key is at 2 s, on screen at playhead 8 s; none before.
    expect(findAdjacentKeyframeTime('next')).toBeCloseTo(8);
    expect(findAdjacentKeyframeTime('prev')).toBeNull();
  });

  it("a camera's keys are compared and reached on the playhead", () => {
    load();
    useTimelineSelection.getState().setActiveChannel('ch_cam');
    // Playhead 4 s: the camera's key at 2 s is behind it, the one at 6 s ahead.
    expect(findAdjacentKeyframeTime('prev')).toBe(2);
    expect(findAdjacentKeyframeTime('next')).toBe(6);
  });
});
