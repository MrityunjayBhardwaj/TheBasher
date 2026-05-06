// viewportStore — verify snap math and the toggle helpers used by the
// menu bar / NPanel.

import { beforeEach, describe, expect, it } from 'vitest';
import { maybeSnapVec3, snap, snapVec3, useViewportStore } from './viewportStore';

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
