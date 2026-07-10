import { describe, expect, it } from 'vitest';
import { nearestPointOnMesh, raycastMesh } from './rayMesh';

// A 20×20 quad in the XZ plane at local y=0 (verts 0..3), indexed as two triangles.
const QUAD = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DOWN: [number, number, number] = [0, -1, 0];

describe('raycastMesh — project rays (the vertical-drop cases, generalized)', () => {
  it('drops onto a flat plane: point, up normal, distance along the ray', () => {
    const hit = raycastMesh(QUAD, QUAD_INDEX, IDENTITY, [0.5, 5, 0.3], DOWN);
    expect(hit).not.toBeNull();
    expect(hit!.point[0]).toBeCloseTo(0.5, 6);
    expect(hit!.point[1]).toBeCloseTo(0, 6);
    expect(hit!.point[2]).toBeCloseTo(0.3, 6);
    expect(hit!.normal[1]).toBeCloseTo(1, 6); // faces the ray origin (up)
    expect(hit!.distance).toBeCloseTo(5, 6); // origin y=5 → surface y=0
  });

  it('interpolates a tilted plane and tilts the normal', () => {
    const ramp = [-10, -5, -10, 10, 5, -10, 10, 5, 10, -10, -5, 10]; // y = 0.5·x
    const hit = raycastMesh(ramp, QUAD_INDEX, IDENTITY, [2, 10, 0], DOWN);
    expect(hit).not.toBeNull();
    expect(hit!.point[1]).toBeCloseTo(1, 6); // 0.5·2
    expect(hit!.normal[1]).toBeGreaterThan(0);
    expect(hit!.normal[0] / hit!.normal[1]).toBeCloseTo(-0.5, 6);
  });

  it('applies the world matrix', () => {
    const up5 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1]; // translate +5 in Y
    const hit = raycastMesh(QUAD, QUAD_INDEX, up5, [3, 20, -4], DOWN);
    expect(hit!.point[1]).toBeCloseTo(5, 6);
  });

  it('returns null when the ray misses the footprint', () => {
    expect(raycastMesh(QUAD, QUAD_INDEX, IDENTITY, [100, 5, 100], DOWN)).toBeNull();
  });

  it('a downward ray from above keeps the CLOSEST (topmost) of stacked surfaces', () => {
    const lower = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, -10, 10, 0, 10, -10, 0, 10];
    const upper = lower.map((v, i) => (i % 3 === 1 ? v + 3 : v)); // a copy raised by 3
    const hit = raycastMesh([...lower, ...upper], null, IDENTITY, [0, 10, 0], DOWN);
    expect(hit!.point[1]).toBeCloseTo(3, 6); // hits the upper surface first
  });

  it('handles a non-indexed buffer', () => {
    const nonIndexed = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, -10, 10, 0, 10, -10, 0, 10];
    const hit = raycastMesh(nonIndexed, null, IDENTITY, [-2, 5, 5], DOWN);
    expect(hit!.point[1]).toBeCloseTo(0, 6);
  });
});

describe('raycastMesh — direction, orientation, farthest', () => {
  it('casts along an arbitrary direction (a 45° ray hits where geometry says)', () => {
    // Ray from (0,10,0) toward (+x,-y): dir (1,-1,0). Hits y=0 plane at x=10 (t·(1/√2)=10√2).
    const hit = raycastMesh(QUAD, QUAD_INDEX, IDENTITY, [0, 10, 0], [1, -1, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.point[1]).toBeCloseTo(0, 5);
    expect(hit!.point[0]).toBeCloseTo(10, 5); // travelled +10 in x as it dropped 10 in y
  });

  it('forward misses when the surface is BEHIND the origin; reverse finds it', () => {
    // Origin BELOW the plane, dir down → forward misses (nothing below); reverse (up) hits.
    const below: [number, number, number] = [0, -5, 0];
    expect(
      raycastMesh(QUAD, QUAD_INDEX, IDENTITY, below, DOWN, { orientation: 'forward' }),
    ).toBeNull();
    const rev = raycastMesh(QUAD, QUAD_INDEX, IDENTITY, below, DOWN, { orientation: 'reverse' });
    expect(rev).not.toBeNull();
    expect(rev!.point[1]).toBeCloseTo(0, 6);
    expect(rev!.distance).toBeCloseTo(5, 6);
  });

  it('bidirectional finds the surface whether the origin is above or below', () => {
    const above = raycastMesh(QUAD, QUAD_INDEX, IDENTITY, [0, 5, 0], DOWN, { orientation: 'both' });
    const below = raycastMesh(QUAD, QUAD_INDEX, IDENTITY, [0, -5, 0], DOWN, {
      orientation: 'both',
    });
    expect(above!.point[1]).toBeCloseTo(0, 6);
    expect(below!.point[1]).toBeCloseTo(0, 6);
  });

  it('farthest picks the far surface of a stack instead of the near one', () => {
    const lower = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, -10, 10, 0, 10, -10, 0, 10];
    const upper = lower.map((v, i) => (i % 3 === 1 ? v + 3 : v)); // raised by 3
    const buf = [...lower, ...upper];
    const near = raycastMesh(buf, null, IDENTITY, [0, 10, 0], DOWN, { farthest: false });
    const far = raycastMesh(buf, null, IDENTITY, [0, 10, 0], DOWN, { farthest: true });
    expect(near!.point[1]).toBeCloseTo(3, 6); // top surface
    expect(far!.point[1]).toBeCloseTo(0, 6); // bottom surface
  });
});

describe('nearestPointOnMesh — minimum distance', () => {
  it('finds the closest surface point + distance (a point above a flat plane)', () => {
    const hit = nearestPointOnMesh(QUAD, QUAD_INDEX, IDENTITY, [2, 7, -3]);
    expect(hit).not.toBeNull();
    expect(hit!.point).toEqual([expect.closeTo(2, 6), expect.closeTo(0, 6), expect.closeTo(-3, 6)]);
    expect(hit!.distance).toBeCloseTo(7, 6); // straight down onto the plane
    expect(hit!.normal[1]).toBeCloseTo(1, 6);
  });

  it('clamps to the nearest EDGE when the query is off the footprint', () => {
    // Query beyond +x edge (plane spans x∈[-10,10] at y=0). Nearest point is on the x=10 edge.
    const hit = nearestPointOnMesh(QUAD, QUAD_INDEX, IDENTITY, [15, 0, 0]);
    expect(hit!.point[0]).toBeCloseTo(10, 6); // clamped to the edge, not projected past it
    expect(hit!.distance).toBeCloseTo(5, 6);
  });

  it('unlike a ray, never misses (returns the nearest point even far off-footprint)', () => {
    const hit = nearestPointOnMesh(QUAD, QUAD_INDEX, IDENTITY, [100, 0, 100]);
    expect(hit).not.toBeNull();
  });
});
