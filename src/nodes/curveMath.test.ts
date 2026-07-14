// curveMath + the Curve node — the LOCAL sampler (#321). The world-space arc-length
// behaviour is proven separately, in src/app/curveSampleSource.test.ts.

import { describe, expect, it, beforeAll } from 'vitest';
import { sampleCurve } from './curveMath';
import { CurveNode, CurveParams, MIN_CURVE_POINTS } from './Curve';
import { isDefaultCollapsed } from '../app/inspectorSections';
import { registerAllNodes } from './registerAll';
import type { CurveValue, Vec3 } from './types';

const SQUARE: Vec3[] = [
  [0, 0, 0],
  [4, 0, 0],
  [4, 0, 4],
  [0, 0, 4],
];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

beforeAll(() => {
  registerAllNodes();
});

describe('sampleCurve — centripetal Catmull-Rom', () => {
  it('passes THROUGH every control point ("drag a point, the path goes there")', () => {
    const samples = sampleCurve(SQUARE, false, 8);
    // Each control point i sits at sample index i*resolution (spans emit `resolution`
    // points each, starting at their first control point).
    for (let i = 0; i < SQUARE.length; i++) {
      const s = samples[i * 8];
      expect(dist(s, SQUARE[i])).toBeLessThan(1e-9);
    }
  });

  it('emits (n-1)*resolution + 1 samples open, n*resolution + 1 closed', () => {
    expect(sampleCurve(SQUARE, false, 8)).toHaveLength(3 * 8 + 1);
    expect(sampleCurve(SQUARE, true, 8)).toHaveLength(4 * 8 + 1);
  });

  it('a CLOSED curve repeats its first point as the last (a self-closing strip)', () => {
    const samples = sampleCurve(SQUARE, true, 8);
    expect(samples[samples.length - 1]).toEqual(SQUARE[0]);
  });

  it('a 2-point curve is a straight line (the phantom end tangents do not bow it)', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    for (const s of sampleCurve(line, false, 16)) {
      expect(Math.abs(s[1])).toBeLessThan(1e-9);
      expect(Math.abs(s[2])).toBeLessThan(1e-9);
    }
  });

  it('coincident control points do not produce NaN (the zero-knot-span guard)', () => {
    const dupes: Vec3[] = [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    for (const s of sampleCurve(dupes, false, 8)) {
      expect(s.every(Number.isFinite)).toBe(true);
    }
  });

  it('is pure — the same input yields the same samples', () => {
    expect(sampleCurve(SQUARE, false, 8)).toEqual(sampleCurve(SQUARE, false, 8));
  });
});

describe('Curve node', () => {
  it('bakes its samples in evaluate, and is a SceneObject', () => {
    const params = CurveParams.parse({ points: SQUARE, resolution: 8 });
    const value = CurveNode.evaluate(params, {}, {} as never) as CurveValue;
    expect(value.kind).toBe('Curve');
    expect(value.samples).toHaveLength(3 * 8 + 1);
    expect(value.points).toEqual(SQUARE);
    expect(CurveNode.outputs.out.type).toBe('SceneObject');
    expect(CurveNode.pure).toBe(true);
  });

  it('declares the sections the registry invariants require (posable ⟺ constrainable ⟹ drivable)', () => {
    expect(CurveNode.inspectorSections).toContain('transform');
    expect(CurveNode.inspectorSections).toContain('constraint');
    expect(CurveNode.inspectorSections).toContain('driver');
    expect(CurveNode.inspectorSections).toContain('curve');
  });

  it('leads with `curve` — the DEFINING section, since only the first opens by default', () => {
    // Observed on :5180: leading with 'transform' opened a new Curve on its TRS with the
    // control points COLLAPSED out of sight. The convention is the object's substance
    // first (BoxMesh → 'mesh', PerspectiveCamera → 'camera'), and isDefaultCollapsed
    // expands only sections[0].
    expect(CurveNode.inspectorSections![0]).toBe('curve');
    expect(isDefaultCollapsed(CurveNode.inspectorSections!, 'curve')).toBe(false);
  });

  it('refuses fewer than two points — a path needs a span', () => {
    expect(() => CurveParams.parse({ points: [[0, 0, 0]] })).toThrow();
    expect(MIN_CURVE_POINTS).toBe(2);
  });

  it('hydrates a bare param bag through zod defaults (H14)', () => {
    const params = CurveParams.parse({});
    expect(params.position).toEqual([0, 0, 0]);
    expect(params.scale).toEqual([1, 1, 1]);
    expect(params.closed).toBe(false);
    expect(params.points.length).toBeGreaterThanOrEqual(MIN_CURVE_POINTS);
  });
});
