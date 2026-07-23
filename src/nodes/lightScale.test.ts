// Light scale semantics — POST-SPLIT (#386 S4).
//
// The four posable lights are now Object(TRS) + LightData(shading): `scale` lives on the
// Object, `intensity`/`width`/`height` on the LightData, and `recomposeLightObject` merges
// them into the flat LightValue the renderer consumes. These tests build a split light and
// assert the RECOMPOSED value, which is the round-trip source of truth the render-side power
// projection reads. (The fused light schemas still carry `scale`, so its zod default is
// asserted directly; the fused evaluate is retired and never called.)
//
// Scale semantics ("size drives power"):
//   - Directional / Point / Spot: render-side intensity × the volume product |sx*sy*sz|.
//   - Area: scale.x × width, scale.y × height (flux scales with area naturally).
// In every case the recomposed value carries raw `intensity` + `scale` through untouched; the
// multiplication is a render-side projection so the DAG stays the round-trip source of truth.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag/registry';
import { emptyDagState, evaluate } from '../core/dag';
import { __reseedAllNodesForTests } from './registerAll';
import { makeSplitLight, type SplitLightKind } from '../test-utils/splitLight';
import { recomposeLightObject } from './lightRecompose';
import type { LightValue } from './types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const POSITIONAL_LIGHTS = ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight'];
const KIND_OF: Record<string, SplitLightKind> = {
  DirectionalLight: 'Directional',
  PointLight: 'Point',
  SpotLight: 'Spot',
  AreaLight: 'Area',
};

/** Build a split light and return its RECOMPOSED flat LightValue (what the renderer consumes).
 *  scale/rotation come from the Object; intensity/width/height from the LightData. */
function recomposed(
  kind: string,
  opts: {
    intensity?: number;
    scale?: [number, number, number];
    rotation?: [number, number, number];
    width?: number;
    height?: number;
  } = {},
): LightValue {
  const shading: Record<string, unknown> = {};
  if (opts.intensity !== undefined) shading.intensity = opts.intensity;
  if (opts.width !== undefined) shading.width = opts.width;
  if (opts.height !== undefined) shading.height = opts.height;
  const { state, objectId } = makeSplitLight(emptyDagState(), {
    objectId: 'l',
    lightKind: KIND_OF[kind],
    position: [1, 2, 3],
    ...(opts.scale ? { scale: opts.scale } : {}),
    ...(opts.rotation ? { rotation: opts.rotation } : {}),
    shading,
  });
  const objVal = evaluate(state, objectId).value;
  return recomposeLightObject(objVal)!;
}

describe('positional lights — scale param', () => {
  it.each(POSITIONAL_LIGHTS)('%s schema defaults scale to [1,1,1]', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = { intensity: 1, position: [0, 0, 0] };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    expect((params as { scale: number[] }).scale).toEqual([1, 1, 1]);
  });

  it.each(POSITIONAL_LIGHTS)('%s recomposed value carries scale through', (kind) => {
    const v = recomposed(kind, { intensity: 1, scale: [2, 3, 4] }) as { scale: number[] };
    expect(v.scale).toEqual([2, 3, 4]);
  });

  it.each(POSITIONAL_LIGHTS)('%s twice-eval — identical recomposed output (V2)', (kind) => {
    expect(recomposed(kind, { intensity: 1, scale: [1.5, 0.75, 2.0] })).toEqual(
      recomposed(kind, { intensity: 1, scale: [1.5, 0.75, 2.0] }),
    );
  });

  it.each(POSITIONAL_LIGHTS)(
    '%s recomposed value defaults scale to [1,1,1] (no authored scale)',
    (kind) => {
      const v = recomposed(kind, { intensity: 1 }) as { scale: number[] };
      expect(v.scale).toEqual([1, 1, 1]);
    },
  );
});

describe('Point/Spot/Directional — scale drives intensity (volume product)', () => {
  // The renderer multiplies intensity by |sx*sy*sz|; the recomposed value preserves the raw
  // scalar so the DAG stays round-trip-pure.
  const POWER_SCALED_LIGHTS = ['DirectionalLight', 'PointLight', 'SpotLight'];

  it.each(POWER_SCALED_LIGHTS)('%s recomposed value preserves raw intensity + scale', (kind) => {
    const v = recomposed(kind, { intensity: 2, scale: [2, 2, 2] }) as {
      intensity: number;
      scale: number[];
    };
    expect(v.intensity).toBe(2);
    expect(v.scale).toEqual([2, 2, 2]);
    // Render-side projection: uniform 2× scale → 8× effective intensity.
    expect(v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2])).toBe(16);
  });

  it.each(POWER_SCALED_LIGHTS)('%s render-side power is monotonic in scale magnitude', (kind) => {
    const power = (s: [number, number, number]) => {
      const v = recomposed(kind, { intensity: 1, scale: s }) as {
        intensity: number;
        scale: number[];
      };
      return v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2]);
    };
    expect(power([0.5, 0.5, 0.5])).toBeLessThan(power([1, 1, 1]));
    expect(power([1, 1, 1])).toBeLessThan(power([2, 2, 2]));
  });

  it.each(POWER_SCALED_LIGHTS)(
    '%s render-side power treats negative scale by magnitude',
    (kind) => {
      const v = recomposed(kind, { intensity: 1, scale: [-2, 1, 1] }) as {
        intensity: number;
        scale: number[];
      };
      expect(v.intensity * Math.abs(v.scale[0] * v.scale[1] * v.scale[2])).toBe(2);
    },
  );
});

describe('AreaLight — scale drives width/height multiplication', () => {
  it('recomposed value preserves width/height — scale multiplication is render-side', () => {
    const v = recomposed('AreaLight', { intensity: 1, width: 4, height: 2, scale: [3, 5, 1] }) as {
      width: number;
      height: number;
      scale: number[];
    };
    expect(v.width).toBe(4);
    expect(v.height).toBe(2);
    expect(v.scale).toEqual([3, 5, 1]);
    // Render-side product (the contract AreaLightR + AreaLightHelper rely on).
    expect(v.width * v.scale[0]).toBe(12);
    expect(v.height * v.scale[1]).toBe(10);
  });
});
