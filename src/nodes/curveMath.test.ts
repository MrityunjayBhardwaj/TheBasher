// curveMath + the Curve node — the LOCAL sampler (#321). The world-space arc-length
// behaviour is proven separately, in src/app/curveSampleSource.test.ts.

import { describe, expect, it, beforeAll } from 'vitest';
import { sampleCurve } from './curveMath';
import { CurveNode, MIN_CURVE_POINTS } from './Curve';
import { CurveDataNode, CurveDataParams } from './CurveData';
import { isDefaultCollapsed } from '../app/inspectorSections';
import { registerAllNodes } from './registerAll';
import type { CurveDataValue, Vec3 } from './types';
import { withIds } from '../test-utils/curvePoints';

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

// #385 S4 — the live curve is the CurveData half (points/closed/resolution → ObjectData); the
// Object owns the pose. The fused Curve node is a retired migration relic (evaluate throws).
describe('CurveData node (the live curve data half)', () => {
  it('bakes its samples in evaluate and outputs ObjectData', () => {
    const params = CurveDataParams.parse({ points: withIds(SQUARE), resolution: 8 });
    const value = CurveDataNode.evaluate(params, {}, {} as never) as CurveDataValue;
    expect(value.kind).toBe('CurveData');
    expect(value.samples).toHaveLength(3 * 8 + 1);
    expect(value.points).toEqual(SQUARE);
    expect(CurveDataNode.outputs.out.type).toBe('ObjectData');
    expect(CurveDataNode.pure).toBe(true);
  });

  it('declares only the `curve` section — the pose sections live on the Object (#385)', () => {
    expect(CurveDataNode.inspectorSections).toEqual(['curve']);
  });

  it('leads with `curve` — the DEFINING section, since only the first opens by default', () => {
    // The object's substance first (BoxData → 'mesh', CurveData → 'curve'); isDefaultCollapsed
    // expands only sections[0], so the control points open rather than hiding behind the pose.
    expect(CurveDataNode.inspectorSections![0]).toBe('curve');
    expect(isDefaultCollapsed(CurveDataNode.inspectorSections!, 'curve')).toBe(false);
  });

  it('refuses fewer than two points — a path needs a span', () => {
    expect(() => CurveDataParams.parse({ points: withIds([[0, 0, 0]]) })).toThrow();
    expect(MIN_CURVE_POINTS).toBe(2);
  });

  it('hydrates a bare param bag through zod defaults (H14)', () => {
    const params = CurveDataParams.parse({});
    expect(params.closed).toBe(false);
    expect(params.resolution).toBeGreaterThanOrEqual(1);
    expect(params.points.length).toBeGreaterThanOrEqual(MIN_CURVE_POINTS);
  });

  it('the fused Curve node is a retired relic — evaluate throws, migration data kept', () => {
    expect(() => CurveNode.evaluate({} as never, {}, {} as never)).toThrow(/retired/);
    expect(CurveNode.type).toBe('Curve'); // still registered so the load-migration can normalize
    expect(CurveNode.migrations?.[1]).toBeTypeOf('function');
  });
});
