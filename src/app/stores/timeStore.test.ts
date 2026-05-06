// timeStore unit tests — bound the playhead's behavior:
//   - setTime clamps to [0, duration]
//   - tick respects playing flag
//   - tick wraps at duration end (loop)
//   - frame/normalized derive from seconds + duration

import { beforeEach, describe, expect, it } from 'vitest';
import { useTimeStore } from './timeStore';

beforeEach(() => {
  useTimeStore.setState({
    seconds: 0,
    frame: 0,
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
    useTimeStore.setState({ seconds: 9.9 });
    useTimeStore.getState().tick(0.5);
    // 9.9 + 0.5 = 10.4 → wraps to 0.4
    expect(useTimeStore.getState().seconds).toBeCloseTo(0.4, 5);
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
