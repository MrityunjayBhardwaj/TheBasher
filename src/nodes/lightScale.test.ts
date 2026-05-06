// Light schemas now carry an optional `scale: vec3` (default [1,1,1]).
// Verify default-fill, evaluator pass-through, twice-eval determinism
// (V2), and the H14 hydrate-seam regression — projects saved before the
// field existed must not crash.
//
// Scale semantics ("size drives power"):
//   - DirectionalLight / PointLight / SpotLight: render-side intensity
//     multiplied by the volume product |sx*sy*sz|. Uniform 2× = 8×
//     brighter. Helper also scales visually.
//   - AreaLight: scale.x × width, scale.y × height. Total flux scales
//     with area naturally (RectAreaLight intensity is luminance), so
//     intensity is NOT additionally multiplied — that would double-count.
//     scale.z is preserved on the value but has no shading effect.
//
// In every case the evaluator carries raw `intensity` + `scale` through
// untouched; the multiplication is a render-side projection so the DAG
// stays the round-trip source of truth.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from './registerAll';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const POSITIONAL_LIGHTS = ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight'];

describe('positional lights — scale param', () => {
  it.each(POSITIONAL_LIGHTS)('%s defaults scale to [1,1,1]', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = { intensity: 1, position: [0, 0, 0] };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    expect((params as { scale: number[] }).scale).toEqual([1, 1, 1]);
  });

  it.each(POSITIONAL_LIGHTS)('%s evaluator passes scale through to the value', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = {
      intensity: 1,
      position: [1, 2, 3],
      scale: [2, 3, 4],
    };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    const value = def.evaluate(params, {}, { time: { frame: 0, seconds: 0, normalized: 0 } });
    expect((value as { scale: number[] }).scale).toEqual([2, 3, 4]);
  });

  it.each(POSITIONAL_LIGHTS)(
    '%s twice-eval — identical output for identical params (V2)',
    (kind) => {
      const def = getNodeType(kind)!;
      const minimal: Record<string, unknown> = {
        intensity: 1,
        position: [1, 2, 3],
        scale: [1.5, 0.75, 2.0],
      };
      if (kind === 'SpotLight') minimal.target = [0, 0, 0];
      if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
      const params = def.paramSchema.parse(minimal);
      const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
      expect(def.evaluate(params, {}, ctx)).toEqual(def.evaluate(params, {}, ctx));
    },
  );

  // H14 regression: projects saved before scale existed land in the
  // hydrate seam without zod re-parsing, so node.params has no scale
  // field. The evaluator MUST default to [1,1,1] rather than emit
  // undefined — otherwise downstream destructures crash.
  it.each(POSITIONAL_LIGHTS)(
    '%s evaluator defaults scale when params lacks it (legacy load)',
    (kind) => {
      const def = getNodeType(kind)!;
      const oldParams: Record<string, unknown> = { intensity: 1, position: [1, 2, 3] };
      if (kind === 'SpotLight') oldParams.target = [0, 0, 0];
      if (kind === 'AreaLight') oldParams.lookAt = [0, 0, 0];
      const value = def.evaluate(
        oldParams as never,
        {},
        { time: { frame: 0, seconds: 0, normalized: 0 } },
      );
      expect((value as { scale: number[] }).scale).toEqual([1, 1, 1]);
    },
  );
});

describe('Point/Spot/Directional — scale drives intensity (volume product)', () => {
  // The renderer (SceneFromDAG.scalePower) multiplies intensity by
  // |sx*sy*sz| on Point/Spot/Directional. The evaluator preserves the
  // raw scalar so the DAG stays round-trip-pure.
  const POWER_SCALED_LIGHTS = ['DirectionalLight', 'PointLight', 'SpotLight'];

  it.each(POWER_SCALED_LIGHTS)('%s evaluator preserves raw intensity + scale', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = {
      intensity: 2,
      position: [0, 0, 0],
      scale: [2, 2, 2],
    };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    const value = def.evaluate(params, {}, { time: { frame: 0, seconds: 0, normalized: 0 } });
    const v = value as { intensity: number; scale: number[] };
    expect(v.intensity).toBe(2);
    expect(v.scale).toEqual([2, 2, 2]);
    // Render-side projection: uniform 2× scale → 8× effective intensity.
    const effective = v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2]);
    expect(effective).toBe(16);
  });

  it.each(POWER_SCALED_LIGHTS)('%s render-side power is monotonic in scale magnitude', (kind) => {
    const def = getNodeType(kind)!;
    const make = (s: [number, number, number]) => {
      const p: Record<string, unknown> = { intensity: 1, position: [0, 0, 0], scale: s };
      if (kind === 'SpotLight') p.target = [0, 0, 0];
      const parsed = def.paramSchema.parse(p);
      const v = def.evaluate(parsed, {}, { time: { frame: 0, seconds: 0, normalized: 0 } }) as {
        intensity: number;
        scale: number[];
      };
      return v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2]);
    };
    expect(make([0.5, 0.5, 0.5])).toBeLessThan(make([1, 1, 1]));
    expect(make([1, 1, 1])).toBeLessThan(make([2, 2, 2]));
  });

  it.each(POWER_SCALED_LIGHTS)(
    '%s render-side power treats negative scale by magnitude',
    (kind) => {
      const def = getNodeType(kind)!;
      const p: Record<string, unknown> = {
        intensity: 1,
        position: [0, 0, 0],
        scale: [-2, 1, 1],
      };
      if (kind === 'SpotLight') p.target = [0, 0, 0];
      const parsed = def.paramSchema.parse(p);
      const v = def.evaluate(parsed, {}, { time: { frame: 0, seconds: 0, normalized: 0 } }) as {
        intensity: number;
        scale: number[];
      };
      // |(-2)*1*1| = 2 — never negative (renderer would clamp via Math.abs).
      expect(v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2])).toBe(2);
    },
  );
});

describe('AreaLight — scale drives width/height multiplication', () => {
  // The renderer (SceneFromDAG.AreaLightR) multiplies value.width by
  // scale.x and value.height by scale.y. The evaluator carries the raw
  // scale through; the multiplication is a render-side projection so
  // round-trip persistence (width, height, scale) stays exact.
  it('evaluator preserves width/height — scale multiplication is render-side', () => {
    const def = getNodeType('AreaLight')!;
    const params = def.paramSchema.parse({
      intensity: 1,
      position: [0, 0, 0],
      lookAt: [0, 0, 0],
      width: 4,
      height: 2,
      scale: [3, 5, 1],
    });
    const value = def.evaluate(params, {}, { time: { frame: 0, seconds: 0, normalized: 0 } });
    const v = value as { width: number; height: number; scale: number[] };
    expect(v.width).toBe(4);
    expect(v.height).toBe(2);
    expect(v.scale).toEqual([3, 5, 1]);
    // Render-side product (the contract AreaLightR + AreaLightHelper rely on)
    expect(v.width * v.scale[0]).toBe(12);
    expect(v.height * v.scale[1]).toBe(10);
  });
});
