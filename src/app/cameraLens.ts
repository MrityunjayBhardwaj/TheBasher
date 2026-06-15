// cameraLens — Blender-style lens math (UX #12 slice 1).
//
// The DAG stores a camera's `fov` (the rendered source of truth — three.js
// PerspectiveCamera.fov, in VERTICAL degrees). A director thinks in focal
// length (mm) on a sensor, so the inspector presents focal length + sensor
// size and derives FOV from them, matching Blender/Spline muscle memory.
// These conversions are the single bridge between the two representations.
//
// Convention: `sensorMm` is the sensor dimension along three.js's VERTICAL FOV
// axis (a deliberate, documented divergence from Blender's horizontal
// sensor-fit default — it keeps ONE lossless round-trip with the stored
// vertical fov rather than dragging an aspect ratio + fit mode into the math).
//
//   focal = sensor / (2·tan(fov/2))        fov = 2·atan(sensor / (2·focal))
//
// Pure + unit-testable — no THREE, no React, no DAG. fov results are clamped to
// the PerspectiveCamera schema bound [1,170] so a derived value never fails
// zod re-validation on dispatch.

export const DEFAULT_SENSOR_MM = 36; // full-frame (Blender's default sensor size)
export const MIN_FOV_DEG = 1;
export const MAX_FOV_DEG = 170;
const FALLBACK_FOV_DEG = 45;

/** Clamp a FOV to the PerspectiveCamera schema range; NaN/∞ → the seed default. */
export function clampFov(fovDeg: number): number {
  if (!Number.isFinite(fovDeg)) return FALLBACK_FOV_DEG;
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, fovDeg));
}

/** Focal length (mm) for a vertical FOV on a given sensor. fovDeg is clamped
 *  first, so the result is always finite and positive. */
export function focalLengthFromFov(fovDeg: number, sensorMm: number): number {
  const f = clampFov(fovDeg);
  const s = sensorMm > 0 ? sensorMm : DEFAULT_SENSOR_MM;
  // tan(f° / 2) === tan(f·π/360 rad).
  return s / (2 * Math.tan((f * Math.PI) / 360));
}

/** Vertical FOV (deg, clamped) for a focal length on a given sensor. A
 *  non-positive focal length → the widest allowed FOV. */
export function fovFromFocalLength(focalMm: number, sensorMm: number): number {
  const s = sensorMm > 0 ? sensorMm : DEFAULT_SENSOR_MM;
  if (!(focalMm > 0)) return MAX_FOV_DEG;
  const fovRad = 2 * Math.atan(s / (2 * focalMm));
  return clampFov((fovRad * 180) / Math.PI);
}
