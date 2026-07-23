// Light rotation semantics — POST-SPLIT (#386 S4).
//
// The four posable lights are now Object(TRS) + LightData(shading): `rotation` lives on the
// Object, and `recomposeLightObject` merges it into the flat LightValue the renderer consumes.
// These tests build a split light and assert the RECOMPOSED value. (The fused light schemas
// still carry `rotation`, so its zod default is asserted directly; the fused evaluate is
// retired and never called.)

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

/** Build a split light and return its RECOMPOSED flat LightValue. rotation comes from the
 *  Object; intensity from the LightData. */
function recomposed(kind: string, rotation?: [number, number, number]): LightValue {
  const { state, objectId } = makeSplitLight(emptyDagState(), {
    objectId: 'l',
    lightKind: KIND_OF[kind],
    position: [1, 2, 3],
    ...(rotation ? { rotation } : {}),
    shading: { intensity: 1 },
  });
  const objVal = evaluate(state, objectId).value;
  return recomposeLightObject(objVal)!;
}

describe('positional lights — rotation param', () => {
  it.each(POSITIONAL_LIGHTS)('%s schema defaults rotation to [0,0,0]', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = { intensity: 1, position: [0, 0, 0] };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    expect((params as { rotation: number[] }).rotation).toEqual([0, 0, 0]);
  });

  it.each(POSITIONAL_LIGHTS)('%s recomposed value carries rotation through', (kind) => {
    const v = recomposed(kind, [0.1, 0.2, 0.3]) as { rotation: number[] };
    expect(v.rotation).toEqual([0.1, 0.2, 0.3]);
  });

  it.each(POSITIONAL_LIGHTS)('%s twice-eval — identical recomposed output (V2)', (kind) => {
    expect(recomposed(kind, [0.4, 0.0, -0.2])).toEqual(recomposed(kind, [0.4, 0.0, -0.2]));
  });

  it.each(POSITIONAL_LIGHTS)(
    '%s recomposed value defaults rotation to [0,0,0] (no authored rotation)',
    (kind) => {
      const v = recomposed(kind) as { rotation: number[] };
      expect(v.rotation).toEqual([0, 0, 0]);
    },
  );
});
