// Light schemas now carry an optional `rotation: vec3` (default
// [0,0,0]). Verify default-fill, evaluator pass-through, and the
// twice-eval determinism contract (V2) for every positional light.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag/registry';
import { __reseedAllNodesForTests } from './registerAll';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const POSITIONAL_LIGHTS = ['DirectionalLight', 'PointLight', 'SpotLight', 'AreaLight'];

describe('positional lights — rotation param', () => {
  it.each(POSITIONAL_LIGHTS)('%s defaults rotation to [0,0,0]', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = { intensity: 1, position: [0, 0, 0] };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    expect((params as { rotation: number[] }).rotation).toEqual([0, 0, 0]);
  });

  it.each(POSITIONAL_LIGHTS)('%s evaluator passes rotation through to the value', (kind) => {
    const def = getNodeType(kind)!;
    const minimal: Record<string, unknown> = {
      intensity: 1,
      position: [1, 2, 3],
      rotation: [0.1, 0.2, 0.3],
    };
    if (kind === 'SpotLight') minimal.target = [0, 0, 0];
    if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
    const params = def.paramSchema.parse(minimal);
    const value = def.evaluate(params, {}, { time: { frame: 0, seconds: 0, normalized: 0 } });
    expect((value as { rotation: number[] }).rotation).toEqual([0.1, 0.2, 0.3]);
  });

  it.each(POSITIONAL_LIGHTS)(
    '%s twice-eval — identical output for identical params (V2)',
    (kind) => {
      const def = getNodeType(kind)!;
      const minimal: Record<string, unknown> = {
        intensity: 1,
        position: [1, 2, 3],
        rotation: [0.4, 0.0, -0.2],
      };
      if (kind === 'SpotLight') minimal.target = [0, 0, 0];
      if (kind === 'AreaLight') minimal.lookAt = [0, 0, 0];
      const params = def.paramSchema.parse(minimal);
      const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
      expect(def.evaluate(params, {}, ctx)).toEqual(def.evaluate(params, {}, ctx));
    },
  );

  // Regression: projects saved before rotation existed land in the
  // hydrate seam without zod re-parsing, so node.params has no rotation
  // field. The evaluator MUST default to [0,0,0] rather than emit
  // undefined — otherwise downstream destructures crash.
  it.each(POSITIONAL_LIGHTS)(
    '%s evaluator defaults rotation when params lacks it (legacy load)',
    (kind) => {
      const def = getNodeType(kind)!;
      // Simulate old-project params (no rotation field) — bypass zod parse
      // so the absence is preserved into the evaluator.
      const oldParams: Record<string, unknown> = { intensity: 1, position: [1, 2, 3] };
      if (kind === 'SpotLight') oldParams.target = [0, 0, 0];
      if (kind === 'AreaLight') oldParams.lookAt = [0, 0, 0];
      const value = def.evaluate(
        oldParams as never,
        {},
        { time: { frame: 0, seconds: 0, normalized: 0 } },
      );
      expect((value as { rotation: number[] }).rotation).toEqual([0, 0, 0]);
    },
  );
});
