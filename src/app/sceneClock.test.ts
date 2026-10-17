// #1594 — the scene clock: scene time is the Scene's speed added up over the playhead.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { sceneClockOf } from './sceneClock';
import { useTimeStore } from './stores/timeStore';
import { useViewportStore } from './stores/viewportStore';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

afterEach(() => {
  useTimeStore.getState().setTimeMap(null);
  useTimeStore.getState().setTime(0);
});

function apply(state: DagState, ops: Op[]): DagState {
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

function sceneId(state: DagState): string {
  return state.outputs.scene!.node;
}

/** Speed 1 until 1 s, ramps to 0.05 by 1.5 s, holds to 3 s, back to 1 by 3.5 s. */
function slowedScene(): DagState {
  const state = buildDefaultDagState();
  return apply(state, [
    {
      type: 'addNode',
      nodeId: 'ch_speed',
      nodeType: 'KeyframeChannelNumber',
      params: {
        target: sceneId(state),
        paramPath: 'timeSpeed',
        keyframes: [
          { time: 1, value: 1, easing: 'linear' },
          { time: 1.5, value: 0.05, easing: 'linear' },
          { time: 3, value: 0.05, easing: 'linear' },
          { time: 3.5, value: 1, easing: 'linear' },
        ],
      },
    },
  ]);
}

describe('#1594 — scene time follows the Scene speed', () => {
  it('a scene that never slows runs on the playhead exactly', () => {
    const clock = sceneClockOf(buildDefaultDagState());
    expect(clock.identity).toBe(true);
    for (const f of [0, 0.25, 1 / 60, 7.3]) {
      expect(clock.sceneAt(f)).toBe(f);
      expect(clock.filmAt(f)).toBe(f);
    }
  });

  it('the speed is a Scene param the schema keeps, defaulting to 1', () => {
    const state = buildDefaultDagState();
    const id = sceneId(state);
    expect((state.nodes[id].params as { timeSpeed?: number }).timeSpeed).toBe(1);
    const half = apply(state, [
      { type: 'setParam', nodeId: id, paramPath: 'timeSpeed', value: 0.5 },
    ]);
    expect((half.nodes[id].params as { timeSpeed?: number }).timeSpeed).toBe(0.5);
    const clock = sceneClockOf(half);
    expect(clock.identity).toBe(false);
    expect(clock.sceneAt(4)).toBeCloseTo(2, 9);
    expect(clock.filmAt(2)).toBeCloseTo(4, 9);
  });

  it('a keyed speed slows scene time where it dips, and real time resumes after', () => {
    const clock = sceneClockOf(slowedScene());
    expect(clock.identity).toBe(false);
    // Before the ramp: real time.
    expect(clock.sceneAt(0.5)).toBeCloseTo(0.5, 6);
    expect(clock.sceneAt(1)).toBeCloseTo(1, 6);
    // Ramp 1 → 0.05 over 0.5 s adds (1 + 0.05) / 2 · 0.5 = 0.2625.
    expect(clock.sceneAt(1.5)).toBeCloseTo(1.2625, 4);
    // The hold: 1.5 s of film moves the scene by 0.075 s.
    expect(clock.sceneAt(3) - clock.sceneAt(1.5)).toBeCloseTo(0.075, 4);
    // Ramp back adds another 0.2625; after it, one film second is one scene second.
    expect(clock.sceneAt(3.5)).toBeCloseTo(1.6, 4);
    expect(clock.sceneAt(5.5) - clock.sceneAt(4.5)).toBeCloseTo(1, 6);
  });

  it('filmAt finds where a scene moment is first on screen', () => {
    const clock = sceneClockOf(slowedScene());
    for (const f of [0.3, 1.2, 2.2, 3.4, 6]) {
      expect(clock.filmAt(clock.sceneAt(f))).toBeCloseTo(f, 3);
    }
  });

  it('speed 0 holds the moment: the scene does not move, the playhead does', () => {
    const state = buildDefaultDagState();
    const frozen = apply(state, [
      { type: 'setParam', nodeId: sceneId(state), paramPath: 'timeSpeed', value: 0 },
    ]);
    const clock = sceneClockOf(frozen);
    expect(clock.sceneAt(0)).toBe(0);
    expect(clock.sceneAt(5)).toBe(0);
  });

  it('a muted speed channel slows nothing', () => {
    const state = slowedScene();
    const muted = apply(state, [
      { type: 'setParam', nodeId: 'ch_speed', paramPath: 'mute', value: true },
    ]);
    expect(sceneClockOf(muted).identity).toBe(true);
  });
});

describe('#1594 — the time store keeps two clocks', () => {
  it('the playhead moves film time; seconds is scene time through the installed clock', () => {
    const clock = sceneClockOf(slowedScene());
    const t = useTimeStore.getState();
    t.setRange(10, 10);
    t.setTimeMap(clock);
    t.setTime(2.5);
    const s = useTimeStore.getState();
    expect(s.filmSeconds).toBe(2.5);
    expect(s.filmFrame).toBe(150);
    expect(s.seconds).toBeCloseTo(clock.sceneAt(2.5), 9);
    expect(s.seconds).toBeLessThan(1.5);
    // The timeline's playhead escape hatch draws the playhead, so it carries the FILM frame.
    expect(useViewportStore.getState().currentFrameRef.current).toBe(150);
  });

  it('installing a clock re-derives scene time at the current playhead', () => {
    const t = useTimeStore.getState();
    t.setRange(10, 10);
    t.setTime(4);
    expect(useTimeStore.getState().seconds).toBe(4);
    const clock = sceneClockOf(slowedScene());
    t.setTimeMap(clock);
    expect(useTimeStore.getState().filmSeconds).toBe(4);
    expect(useTimeStore.getState().seconds).toBeCloseTo(clock.sceneAt(4), 9);
    t.setTimeMap(null);
    expect(useTimeStore.getState().seconds).toBe(4);
  });

  it('playback advances the playhead in real time while the scene crawls', () => {
    const clock = sceneClockOf(slowedScene());
    const t = useTimeStore.getState();
    t.setRange(10, 10);
    t.setTimeMap(clock);
    t.setTime(2);
    t.play();
    const before = useTimeStore.getState().seconds;
    for (let i = 0; i < 30; i++) useTimeStore.getState().tick(1 / 60);
    useTimeStore.getState().pause();
    const s = useTimeStore.getState();
    expect(s.filmSeconds).toBeCloseTo(2.5, 9);
    expect(s.seconds - before).toBeCloseTo(0.025, 4);
  });
});
