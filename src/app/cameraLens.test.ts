// Unit tests for cameraLens — the focal-length ↔ FOV bridge (UX #12).

import { describe, expect, it } from 'vitest';
import {
  clampFov,
  DEFAULT_SENSOR_MM,
  focalLengthFromFov,
  fovFromFocalLength,
  MAX_FOV_DEG,
  MIN_FOV_DEG,
} from './cameraLens';

describe('clampFov', () => {
  it('clamps into the PerspectiveCamera schema range', () => {
    expect(clampFov(0)).toBe(MIN_FOV_DEG);
    expect(clampFov(500)).toBe(MAX_FOV_DEG);
    expect(clampFov(45)).toBe(45);
  });
  it('falls back to the seed default for non-finite input', () => {
    expect(clampFov(NaN)).toBe(45);
    expect(clampFov(Infinity)).toBe(45); // non-finite → fallback, not clamp
    expect(clampFov(-Infinity)).toBe(45);
  });
});

describe('focal ↔ fov round-trip', () => {
  it('round-trips on the full-frame sensor', () => {
    for (const fov of [20, 35, 45, 60, 90]) {
      const focal = focalLengthFromFov(fov, DEFAULT_SENSOR_MM);
      expect(fovFromFocalLength(focal, DEFAULT_SENSOR_MM)).toBeCloseTo(fov, 4);
    }
  });

  it('derives the documented default focal (~43.5mm at fov 45 on a 36mm sensor)', () => {
    expect(focalLengthFromFov(45, 36)).toBeCloseTo(43.456, 2);
  });

  it('a longer lens narrows the FOV (telephoto), a shorter one widens it (wide-angle)', () => {
    const wide = fovFromFocalLength(18, 36);
    const normal = fovFromFocalLength(50, 36);
    const tele = fovFromFocalLength(200, 36);
    expect(wide).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(tele);
  });

  it('a bigger sensor at the same focal length widens the FOV', () => {
    const small = fovFromFocalLength(50, 24); // Super35-ish
    const full = fovFromFocalLength(50, 36); // full-frame
    expect(full).toBeGreaterThan(small);
  });
});

describe('guards', () => {
  it('a non-positive focal length → widest allowed FOV (never NaN)', () => {
    expect(fovFromFocalLength(0, 36)).toBe(MAX_FOV_DEG);
    expect(fovFromFocalLength(-5, 36)).toBe(MAX_FOV_DEG);
  });
  it('a non-positive sensor falls back to full-frame', () => {
    expect(focalLengthFromFov(45, 0)).toBeCloseTo(focalLengthFromFov(45, DEFAULT_SENSOR_MM), 6);
    expect(fovFromFocalLength(50, -1)).toBeCloseTo(fovFromFocalLength(50, DEFAULT_SENSOR_MM), 6);
  });
  it('a derived FOV never escapes the schema bound', () => {
    // A microscopic focal length would mathematically exceed 170° — must clamp.
    expect(fovFromFocalLength(0.1, 36)).toBe(MAX_FOV_DEG);
  });
});
