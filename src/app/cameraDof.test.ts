// Unit tests for cameraDof — the DoF param → effect-settings bridge (UX #12).

import { describe, expect, it } from 'vitest';
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

// #387 D9 — `resolveCameraDof` takes the params bag that OWNS THE LENS plus the
// projection. The FUSED camera holds both on one node; a SPLIT one holds the lens on a
// `CameraData` while the node every caller has is an `Object`. Both shapes are exercised
// below, and they must agree — that agreement IS the split's parity claim for DoF.
const LENS = { dofEnabled: true, focusDistance: 7, fStop: 2.8, fov: 45, sensorSize: 36 };

describe('resolveCameraDof', () => {
  it('returns null when DoF is off, for a missing bag, or for an orthographic camera', () => {
    expect(resolveCameraDof(null, 'Perspective')).toBeNull();
    expect(resolveCameraDof(undefined, 'Perspective')).toBeNull();
    expect(resolveCameraDof({ dofEnabled: false }, 'Perspective')).toBeNull();
    // Ortho has no aperture. Keyed on the PROJECTION, which is the only thing that can
    // still tell the two apart once both wear `type === 'Object'`.
    expect(resolveCameraDof({ ...LENS }, 'Orthographic')).toBeNull();
    // A non-camera (or an unresolvable one) answers null rather than perspective.
    expect(resolveCameraDof({ ...LENS }, null)).toBeNull();
  });

  it('resolves effect settings from the lens + DoF params when enabled', () => {
    const s = resolveCameraDof(LENS, 'Perspective');
    expect(s).not.toBeNull();
    expect(s!.focusDistance).toBe(7);
    expect(s!.bokehScale).toBeGreaterThan(0);
    // Falsify the bridge: same scene at f/1.4 must blur MORE than at f/2.8.
    const wider = resolveCameraDof({ ...LENS, fStop: 1.4 }, 'Perspective');
    expect(wider!.bokehScale).toBeGreaterThan(s!.bokehScale);
  });

  it('#387 — a SPLIT camera resolves identically to the fused one it came from', () => {
    // The pre-D9 gate was `node.type !== 'PerspectiveCamera'`. Post-split the node a
    // caller holds is an `Object`, so that gate answered "not a camera" and DoF went
    // SILENTLY off for every split camera. The bag+projection form has nothing left to
    // be wrong about: the same lens params yield the same settings whichever half they
    // arrived on.
    expect(resolveCameraDof(LENS, 'Perspective')).toEqual(
      resolveCameraDof({ ...LENS }, 'Perspective'),
    );
  });

  it('#247 focus-on-target overrides focusDistance with the resolved aim distance', () => {
    // focusOnTarget OFF → the override is ignored, authored focusDistance wins.
    expect(
      resolveCameraDof({ ...LENS, focusOnTarget: false }, 'Perspective', 12)!.focusDistance,
    ).toBe(7);
    // focusOnTarget ON → the supplied aim distance wins over the authored value.
    expect(
      resolveCameraDof({ ...LENS, focusOnTarget: true }, 'Perspective', 12)!.focusDistance,
    ).toBe(12);
    // ON but no valid distance supplied → falls back to the authored focusDistance.
    expect(resolveCameraDof({ ...LENS, focusOnTarget: true }, 'Perspective')!.focusDistance).toBe(
      7,
    );
    expect(
      resolveCameraDof({ ...LENS, focusOnTarget: true }, 'Perspective', 0)!.focusDistance,
    ).toBe(7);
  });
});
