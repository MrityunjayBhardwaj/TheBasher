// viewportStore — verify snap math and the toggle helpers used by the
// menu bar / NPanel.

import { beforeEach, describe, expect, it } from 'vitest';
import { maybeSnapVec3, snap, snapVec3, useViewportStore } from './viewportStore';
import { useTimeStore } from './timeStore';

beforeEach(() => {
  useViewportStore.setState({
    pivot: 'median',
    snapStep: 0.25,
    snapEnabled: false,
    gridVisible: true,
    axisWidgetVisible: true,
    shading: 'studio',
  });
});

describe('viewportStore — snap math', () => {
  it('snap(value, step) rounds to the nearest multiple', () => {
    expect(snap(0.7, 0.25)).toBeCloseTo(0.75);
    expect(snap(-0.7, 0.25)).toBeCloseTo(-0.75);
    expect(snap(1.49, 1)).toBe(1);
    expect(snap(1.5, 1)).toBe(2);
  });

  it('snap returns value unchanged when step is zero or negative', () => {
    expect(snap(3.14, 0)).toBe(3.14);
    expect(snap(3.14, -1)).toBe(3.14);
  });

  it('snapVec3 snaps each axis independently', () => {
    expect(snapVec3([0.1, 0.7, -0.4], 0.5)).toEqual([0, 0.5, -0.5]);
  });

  it('maybeSnapVec3 honors snapEnabled flag', () => {
    expect(maybeSnapVec3([0.7, 0.7, 0.7])).toEqual([0.7, 0.7, 0.7]);
    useViewportStore.getState().setSnapEnabled(true);
    expect(maybeSnapVec3([0.7, 0.7, 0.7])).toEqual([0.75, 0.75, 0.75]);
  });
});

describe('viewportStore — toggles', () => {
  it('toggleGridVisible flips the flag', () => {
    expect(useViewportStore.getState().gridVisible).toBe(true);
    useViewportStore.getState().toggleGridVisible();
    expect(useViewportStore.getState().gridVisible).toBe(false);
  });

  it('toggleAxisWidgetVisible flips the flag', () => {
    expect(useViewportStore.getState().axisWidgetVisible).toBe(true);
    useViewportStore.getState().toggleAxisWidgetVisible();
    expect(useViewportStore.getState().axisWidgetVisible).toBe(false);
  });

  it('setSnapStep clamps negatives to zero (no inverted-snap surprises)', () => {
    useViewportStore.getState().setSnapStep(-1);
    expect(useViewportStore.getState().snapStep).toBe(0);
  });

  it('setShading switches between studio and rendered modes', () => {
    expect(useViewportStore.getState().shading).toBe('studio');
    useViewportStore.getState().setShading('rendered');
    expect(useViewportStore.getState().shading).toBe('rendered');
    useViewportStore.getState().setShading('studio');
    expect(useViewportStore.getState().shading).toBe('studio');
  });

  it('setShading accepts wireframe mode', () => {
    useViewportStore.getState().setShading('wireframe');
    expect(useViewportStore.getState().shading).toBe('wireframe');
  });
});

// currentFrameRef — the W9 React-bypass escape hatch (D-W9-1, D-W9-9).
// The ref OBJECT is owned by viewportStore (single init); `.current` is
// written EXCLUSIVELY by timeStore's three frame setters (the chokepoint).
// The invariant under test: currentFrameRef.current === timeStore.frame
// after every frame transition (playback AND scrub AND duration change).
describe('viewportStore — currentFrameRef escape hatch', () => {
  beforeEach(() => {
    // Reset both stores to a known frame-zero baseline. currentFrameRef is
    // mutated in place (never reassigned) so we zero `.current`, not the
    // object.
    useTimeStore.setState({
      seconds: 0,
      frame: 0,
      normalized: 0,
      durationSeconds: 10,
      playing: false,
    });
    useViewportStore.getState().currentFrameRef.current = 0;
  });

  it('is initialized to { current: 0 }', () => {
    expect(useViewportStore.getState().currentFrameRef).toEqual({ current: 0 });
  });

  it('keeps a stable object identity across store mutations (never reassigned)', () => {
    const ref = useViewportStore.getState().currentFrameRef;
    useTimeStore.getState().setTime(1.5);
    useViewportStore.getState().setSnapStep(0.5);
    useTimeStore.getState().setDuration(20);
    expect(useViewportStore.getState().currentFrameRef).toBe(ref);
  });

  it('sync invariant holds after setTime', () => {
    useTimeStore.getState().setTime(2.5);
    expect(useViewportStore.getState().currentFrameRef.current).toBe(
      useTimeStore.getState().frame,
    );
    // 2.5s * 60fps = frame 150 (sanity on the actual value, not just equality).
    expect(useViewportStore.getState().currentFrameRef.current).toBe(150);
  });

  it('sync invariant holds after tick() while playing', () => {
    useTimeStore.getState().play();
    useTimeStore.getState().tick(0.1);
    expect(useViewportStore.getState().currentFrameRef.current).toBe(
      useTimeStore.getState().frame,
    );
    expect(useTimeStore.getState().frame).toBeGreaterThan(0);
  });

  it('sync invariant holds after setDuration', () => {
    useTimeStore.getState().setTime(8);
    useTimeStore.getState().setDuration(5); // clamps seconds 8 → 5
    expect(useViewportStore.getState().currentFrameRef.current).toBe(
      useTimeStore.getState().frame,
    );
    // 5s * 60fps = frame 300 after the duration clamp.
    expect(useViewportStore.getState().currentFrameRef.current).toBe(300);
  });

  it('a non-frame mutation (setSnapStep) leaves currentFrameRef.current unchanged', () => {
    useTimeStore.getState().setTime(1); // .current = 60
    const before = useViewportStore.getState().currentFrameRef.current;
    expect(before).toBe(60);
    useViewportStore.getState().setSnapStep(0.75);
    expect(useViewportStore.getState().currentFrameRef.current).toBe(before);
  });
});
