// resolveLightBrushPlacement — the Light Brush placement core (#207). Asserts the
// reflection math, that the placed light lands ON the rig sphere, the 'normal' vs
// 'reflect' modes, and the miss → null fallback.
//
// REF: src/app/resolveLightBrushPlacement.ts; vyapti V60/V37; epic #201.

import { describe, expect, it } from 'vitest';
import { reflect, resolveLightBrushPlacement } from './resolveLightBrushPlacement';

type Vec3 = [number, number, number];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('reflect', () => {
  it('mirrors an incident ray about the normal (head-on → reversed)', () => {
    // Incident straight down (-Y) onto an up-facing surface → reflects straight up.
    expect(reflect([0, -1, 0], [0, 1, 0])).toEqual([0, 1, 0]);
  });

  it('reflects a 45° ray off a vertical wall', () => {
    // Travelling +X−Y, wall normal +Y → flips the Y component only.
    const r = reflect([1, -1, 0], [0, 1, 0]);
    expect(r[0]).toBeCloseTo(1, 9);
    expect(r[1]).toBeCloseTo(1, 9);
  });
});

describe('resolveLightBrushPlacement', () => {
  const centre: Vec3 = [0, 0, 0];
  const radius = 5;

  it('places the light ON the rig sphere (reflect mode)', () => {
    // Hit the top of the subject; camera looking down; the light lands on the shell.
    const out = resolveLightBrushPlacement(
      [0, 1, 0],
      [0, 1, 0],
      [0, -1, 0],
      centre,
      radius,
      'reflect',
    );
    expect(out).not.toBeNull();
    expect(dist(out!.position, centre)).toBeCloseTo(radius, 6);
  });

  it('reflect mode: a head-on view paints the light back toward the camera', () => {
    // Hit at +Z front, normal +Z, camera looking −Z → reflection is +Z → the light
    // sits on the +Z shell (so its highlight bounces straight back to the camera).
    const out = resolveLightBrushPlacement(
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, -1],
      centre,
      radius,
      'reflect',
    );
    expect(out).not.toBeNull();
    expect(out!.position[2]).toBeCloseTo(radius, 6);
    expect(out!.position[0]).toBeCloseTo(0, 6);
    expect(out!.position[1]).toBeCloseTo(0, 6);
  });

  it('normal mode places along the surface normal, on the sphere', () => {
    const out = resolveLightBrushPlacement(
      [0, 1, 0],
      [0, 1, 0],
      [0, -1, 0],
      centre,
      radius,
      'normal',
    );
    expect(out).not.toBeNull();
    expect(out!.position[1]).toBeCloseTo(radius, 6); // straight up the +Y normal
    expect(dist(out!.position, centre)).toBeCloseTo(radius, 6);
  });

  it('returns null when the ray misses the sphere (hit outside, pointing away)', () => {
    // Hit well outside the sphere, normal pointing further away → no intersection.
    const out = resolveLightBrushPlacement(
      [100, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      centre,
      radius,
      'normal',
    );
    expect(out).toBeNull();
  });
});
