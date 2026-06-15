// Unit tests for cameraDof — the DoF param → effect-settings bridge (UX #12).

import { describe, expect, it } from 'vitest';
import type { Node } from '../core/dag/types';
import { dofEffectSettings, readDofParams, resolveCameraDof } from './cameraDof';

describe('readDofParams', () => {
  it('defaults a pre-DoF project to off / sane values', () => {
    expect(readDofParams(undefined)).toEqual({ enabled: false, focusDistance: 5, fStop: 2.8 });
    expect(readDofParams({})).toEqual({ enabled: false, focusDistance: 5, fStop: 2.8 });
  });
  it('reads authored values', () => {
    expect(readDofParams({ dofEnabled: true, focusDistance: 12, fStop: 1.4 })).toEqual({
      enabled: true,
      focusDistance: 12,
      fStop: 1.4,
    });
  });
  it('rejects non-positive distance / f-stop, falling back to defaults', () => {
    const p = readDofParams({ dofEnabled: true, focusDistance: -1, fStop: 0 });
    expect(p).toEqual({ enabled: true, focusDistance: 5, fStop: 2.8 });
  });
});

describe('dofEffectSettings — monotonicity (photographic intuition)', () => {
  it('a wider aperture (smaller f-stop) → shallower focus range + bigger bokeh', () => {
    const wide = dofEffectSettings(5, 1.4, 50);
    const narrow = dofEffectSettings(5, 16, 50);
    expect(wide.focusRange).toBeLessThan(narrow.focusRange);
    expect(wide.bokehScale).toBeGreaterThan(narrow.bokehScale);
  });
  it('a longer lens → bigger bokeh at the same aperture', () => {
    const wideLens = dofEffectSettings(5, 2.8, 24);
    const teleLens = dofEffectSettings(5, 2.8, 200);
    expect(teleLens.bokehScale).toBeGreaterThan(wideLens.bokehScale);
  });
  it('passes focusDistance through and keeps settings finite + clamped', () => {
    const s = dofEffectSettings(8, 2.8, 50);
    expect(s.focusDistance).toBe(8);
    expect(s.focusRange).toBeGreaterThan(0);
    expect(s.bokehScale).toBeGreaterThanOrEqual(1);
    expect(s.bokehScale).toBeLessThanOrEqual(12);
  });
});

function cam(params: Record<string, unknown>, type = 'PerspectiveCamera'): Node {
  return { id: 'n_cam', type, version: 1, params, inputs: {} } as unknown as Node;
}

describe('resolveCameraDof', () => {
  it('returns null when DoF is off, or for a null / non-perspective node', () => {
    expect(resolveCameraDof(null)).toBeNull();
    expect(resolveCameraDof(cam({ dofEnabled: false }))).toBeNull();
    expect(resolveCameraDof(cam({ dofEnabled: true }, 'OrthographicCamera'))).toBeNull();
  });
  it('resolves effect settings from the lens + DoF params when enabled', () => {
    const s = resolveCameraDof(
      cam({ dofEnabled: true, focusDistance: 7, fStop: 2.8, fov: 45, sensorSize: 36 }),
    );
    expect(s).not.toBeNull();
    expect(s!.focusDistance).toBe(7);
    expect(s!.bokehScale).toBeGreaterThan(0);
    // Falsify the bridge: same scene at f/1.4 must blur MORE than at f/2.8.
    const wider = resolveCameraDof(
      cam({ dofEnabled: true, focusDistance: 7, fStop: 1.4, fov: 45, sensorSize: 36 }),
    );
    expect(wider!.bokehScale).toBeGreaterThan(s!.bokehScale);
  });
});
