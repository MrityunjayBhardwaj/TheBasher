// LightRig — the switchable lighting profile node (epic #201, slice #208).
// Verifies it GROUPS its lights in edge order and OWNS the shared centre/radius,
// so the renderer's index-correspondence (`resolveRigLightSources`) holds and the
// panel can read an explicit rig centre (formalizing #206/#207's derived one).

import { describe, expect, it } from 'vitest';
import { LightRigNode, LightRigParams } from './LightRig';
import type { AreaLightValue, LightValue } from './types';

function areaLight(intensity: number): AreaLightValue {
  return {
    kind: 'AreaLight',
    intensity,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: '#ffffff',
    width: 2,
    height: 2,
    lookAt: [0, 0, 0],
  };
}

describe('LightRig node (#208)', () => {
  it('groups its lights in edge order + carries name/center/radius', () => {
    const params = LightRigParams.parse({ name: 'Key setup', center: [1, 2, 3], radius: 8 });
    const lights: LightValue[] = [areaLight(5), areaLight(9)];
    const value = LightRigNode.evaluate(params, { lights });
    expect(value.kind).toBe('LightRig');
    expect(value.name).toBe('Key setup');
    expect(value.center).toEqual([1, 2, 3]);
    expect(value.radius).toBe(8);
    // Edge order preserved — the renderer's id↔value correspondence depends on it.
    expect(value.lights.map((l) => (l as AreaLightValue).intensity)).toEqual([5, 9]);
  });

  it('defaults to an origin-centred rig of radius 6 with no lights', () => {
    const params = LightRigParams.parse({});
    const value = LightRigNode.evaluate(params, { lights: [] });
    expect(value.name).toBe('Light Rig');
    expect(value.center).toEqual([0, 0, 0]);
    expect(value.radius).toBe(6);
    expect(value.lights).toEqual([]);
  });

  it('tolerates a single (non-array) light binding and null entries', () => {
    const single = LightRigNode.evaluate(LightRigParams.parse({}), { lights: areaLight(3) });
    expect(single.lights).toHaveLength(1);
    const withNulls = LightRigNode.evaluate(LightRigParams.parse({}), {
      lights: [areaLight(1), null, areaLight(2)] as unknown as LightValue[],
    });
    expect(withNulls.lights.map((l) => (l as AreaLightValue).intensity)).toEqual([1, 2]);
  });
});
