// timeStore unit tests — bound the playhead's behavior:
//   - setTime clamps to [0, duration]
//   - tick respects playing flag
//   - tick wraps at duration end (loop)
//   - frame/normalized derive from seconds + duration

import { beforeEach, describe, expect, it } from 'vitest';
import { useTimeStore } from './timeStore';

beforeEach(() => {
  useTimeStore.getState().setTimeMap(null);
  useTimeStore.setState({
    seconds: 0,
    frame: 0,
    filmSeconds: 0,
    filmFrame: 0,
    normalized: 0,
    durationSeconds: 10,
    playing: false,
  });
});

describe('timeStore', () => {
  it('setTime updates seconds + derived frame + normalized', () => {
    useTimeStore.getState().setTime(2.5);
    const s = useTimeStore.getState();
    expect(s.seconds).toBe(2.5);
    expect(s.frame).toBe(150);
    expect(s.normalized).toBeCloseTo(0.25);
  });

  it('setTime clamps below 0 to 0', () => {
    useTimeStore.getState().setTime(-1);
    expect(useTimeStore.getState().seconds).toBe(0);
  });

  it('setTime clamps above duration to duration', () => {
    useTimeStore.getState().setTime(99);
    expect(useTimeStore.getState().seconds).toBe(10);
  });

  it('tick is a no-op when not playing', () => {
    useTimeStore.getState().tick(1);
    expect(useTimeStore.getState().seconds).toBe(0);
  });

  it('tick advances time when playing', () => {
    useTimeStore.getState().play();
    useTimeStore.getState().tick(0.5);
    expect(useTimeStore.getState().seconds).toBe(0.5);
  });

  it('tick wraps at duration end (loop)', () => {
    useTimeStore.getState().play();
    // #1594 — the playhead is `filmSeconds`; `seconds` (scene time) follows it.
    useTimeStore.setState({ filmSeconds: 9.9 });
    useTimeStore.getState().tick(0.5);
    // 9.9 + 0.5 = 10.4 → wraps to 0.4
    expect(useTimeStore.getState().seconds).toBeCloseTo(0.4, 5);
  });

  it('#1733 stepFrames lands on the frame grid, from the frame the playhead is on', () => {
    useTimeStore.getState().play();
    useTimeStore.getState().setTime(0.0123); // scrubbed between frames 0 and 1 (nearest: 1)
    useTimeStore.getState().stepFrames(9);
    expect(useTimeStore.getState().filmFrame).toBe(10);
    expect(useTimeStore.getState().filmSeconds * 60).toBeCloseTo(10, 9);
  });

  it('#1733 stepFrames loops at End and does nothing while paused', () => {
    useTimeStore.getState().play();
    useTimeStore.getState().setTime(9.95); // frame 597 of a 600-frame range
    useTimeStore.getState().stepFrames(6);
    expect(useTimeStore.getState().filmFrame).toBe(3);
    useTimeStore.getState().pause();
    useTimeStore.getState().stepFrames(6);
    expect(useTimeStore.getState().filmFrame).toBe(3);
  });

  it('#1733 pausing clears the achieved rate', () => {
    useTimeStore.getState().play();
    useTimeStore.getState().setAchievedFps(24);
    useTimeStore.getState().pause();
    expect(useTimeStore.getState().achievedFps).toBeNull();
  });

  it('toggle flips playing', () => {
    expect(useTimeStore.getState().playing).toBe(false);
    useTimeStore.getState().toggle();
    expect(useTimeStore.getState().playing).toBe(true);
    useTimeStore.getState().toggle();
    expect(useTimeStore.getState().playing).toBe(false);
  });

  it('setDuration re-clamps current seconds', () => {
    useTimeStore.getState().setTime(8);
    useTimeStore.getState().setDuration(5);
    expect(useTimeStore.getState().seconds).toBe(5);
    expect(useTimeStore.getState().normalized).toBe(1);
  });
});
