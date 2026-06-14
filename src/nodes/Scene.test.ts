// UX #9 — Scene-level environment (HDRI/IBL) params fold into SceneValue.
// Enforces vyapti V47: env config is a DAG-resident Scene-node datum; the
// default is `none`; an old project (params predate the env fields) still
// resolves to `none` via the V10/H14 two-layer default.

import { describe, expect, it } from 'vitest';
import { SceneNode, SceneParams } from './Scene';
import type { CameraValue } from './types';

const CAMERA: CameraValue = {
  kind: 'PerspectiveCamera',
  position: [0, 0, 5],
  rotation: [0, 0, 0],
  fov: 45,
  near: 0.1,
  far: 1000,
};

const INPUTS = { camera: CAMERA, lights: [], children: [] };

describe('Scene environment params (UX #9 / V47)', () => {
  it('defaults envSource to none for a fresh (empty) Scene', () => {
    const params = SceneParams.parse({});
    const value = SceneNode.evaluate(params, INPUTS);
    expect(value.environment.source).toEqual({ kind: 'none' });
    expect(value.environment.intensity).toBe(1);
    expect(value.environment.rotationY).toBe(0);
    expect(value.environment.background).toBe(false);
  });

  it('folds a preset source + intensity + rotation + background into the value', () => {
    const params = SceneParams.parse({
      envSource: { kind: 'preset', name: 'sunset' },
      envIntensity: 2.5,
      envRotationY: 90,
      envBackground: true,
    });
    const value = SceneNode.evaluate(params, INPUTS);
    expect(value.environment).toEqual({
      source: { kind: 'preset', name: 'sunset' },
      intensity: 2.5,
      rotationY: 90,
      background: true,
    });
  });

  it('folds a file source (OPFS assetRef)', () => {
    const params = SceneParams.parse({
      envSource: { kind: 'file', assetRef: 'user-imports/env/studio.hdr' },
    });
    const value = SceneNode.evaluate(params, INPUTS);
    expect(value.environment.source).toEqual({
      kind: 'file',
      assetRef: 'user-imports/env/studio.hdr',
    });
  });

  it('back-compat: a Scene whose params have NO env fields resolves to none (not a crash/black)', () => {
    // Simulate an old saved Scene node: params is the legacy empty object, but
    // imagine the migration layer did NOT run (the defensive second layer). The
    // evaluate `?? default` must still produce a valid `none` environment.
    const value = SceneNode.evaluate({} as SceneParams, INPUTS);
    expect(value.environment.source).toEqual({ kind: 'none' });
    expect(value.environment.intensity).toBe(1);
  });
});
