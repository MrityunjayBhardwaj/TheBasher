// cameraDof — depth-of-field param → effect-settings bridge (UX #12 slice 2).
//
// A director authors DoF as three intuitive params on a PerspectiveCamera:
// dofEnabled, focusDistance (world units), and fStop (aperture f-number). The
// postprocessing DepthOfFieldEffect is parameterized by focusDistance +
// focusRange (both world units) + bokehScale. This module is the SINGLE pure
// bridge between the two — so the live viewport (<DepthOfField> in PostFx) and
// the offscreen still (DepthOfFieldEffect in renderToImage) build the EXACT
// same circle-of-confusion and their bokeh matches (V34/V37 parity).
//
// Photographic intuition encoded (artistic, monotonic, clamped — NOT a physical
// CoC integral, which postprocessing already computes from focusDistance/range):
//   - a SMALLER fStop (wider aperture) → shallower focusRange + bigger bokeh;
//   - a LONGER lens (focal length, derived from fov+sensor) → bigger bokeh.
//
// Pure + unit-testable. No THREE, no postprocessing, no React, no DAG.
//
// REF: src/app/cameraLens.ts (focal length); postprocessing DepthOfFieldEffect
//      ctor (focusDistance default 3.0, focusRange default 2.0, world units).

import type { Node } from '../core/dag/types';
import { focalLengthFromFov, DEFAULT_SENSOR_MM } from './cameraLens';

/** The director-facing DoF params, read defensively (pre-DoF projects → off). */
export interface DofParams {
  enabled: boolean;
  focusDistance: number;
  fStop: number;
}

/** The postprocessing DepthOfFieldEffect settings — identical option names in
 *  the React <DepthOfField> wrapper and the imperative ctor, so both paths
 *  produce the same blur. */
export interface DofEffectSettings {
  focusDistance: number;
  focusRange: number;
  bokehScale: number;
}

const DEFAULTS: DofParams = { enabled: false, focusDistance: 5, fStop: 2.8 };

export function readDofParams(params: Record<string, unknown> | undefined): DofParams {
  const p = params ?? {};
  return {
    enabled: typeof p.dofEnabled === 'boolean' ? p.dofEnabled : DEFAULTS.enabled,
    focusDistance:
      typeof p.focusDistance === 'number' && p.focusDistance > 0
        ? p.focusDistance
        : DEFAULTS.focusDistance,
    fStop: typeof p.fStop === 'number' && p.fStop > 0 ? p.fStop : DEFAULTS.fStop,
  };
}

/** Map director params + lens → DepthOfFieldEffect settings. Pure + monotonic. */
export function dofEffectSettings(
  focusDistance: number,
  fStop: number,
  focalLengthMm: number,
): DofEffectSettings {
  const fd = focusDistance > 0 ? focusDistance : DEFAULTS.focusDistance;
  const f = fStop > 0 ? fStop : DEFAULTS.fStop;
  const focal = focalLengthMm > 0 ? focalLengthMm : 43.5;
  // Sharp band scales with fStop and the focus distance: f/2.8 ≈ 0.2·distance
  // (shallow), f/16 ≈ deep. Clamped so it never collapses to 0 or runs away.
  const focusRange = clamp((f / 2.8) * (fd * 0.2), 0.05, fd * 2);
  // Bokeh disc scales with aperture diameter (focal / fStop). f/2.8 50mm ≈ 2.2,
  // f/2.8 200mm ≈ 8.9 (creamy telephoto), f/16 ≈ floor. Clamped to a sane range.
  const bokehScale = clamp(focal / f / 8, 1, 12);
  return { focusDistance: fd, focusRange, bokehScale };
}

/** Resolve a camera node's active DoF effect settings, or null when DoF is off
 *  / the node isn't a perspective camera. Reads the lens (fov + sensorSize) to
 *  derive focal length. Pure — both the viewport and the still call THIS. */
export function resolveCameraDof(node: Node | null | undefined): DofEffectSettings | null {
  if (!node || node.type !== 'PerspectiveCamera') return null;
  const params = node.params as Record<string, unknown>;
  const dof = readDofParams(params);
  if (!dof.enabled) return null;
  const fov = typeof params.fov === 'number' ? params.fov : 45;
  const sensor = typeof params.sensorSize === 'number' ? params.sensorSize : DEFAULT_SENSOR_MM;
  return dofEffectSettings(dof.focusDistance, dof.fStop, focalLengthFromFov(fov, sensor));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
