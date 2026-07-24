import { describe, expect, it } from 'vitest';
import { recomposeLightObject } from './lightRecompose';
import type {
  AmbientLightValue,
  AreaLightValue,
  LightDataValue,
  ObjectValue,
  PointLightValue,
  SpotLightValue,
} from './types';

// A full LightData value (every shading field present, as the node's evaluate emits).
// `light` selects which subset the recompose reads.
function lightData(
  over: Partial<LightDataValue> & { light: LightDataValue['light'] },
): LightDataValue {
  return {
    kind: 'LightData',
    intensity: 1,
    color: '#ffffff',
    distance: 0,
    decay: 2,
    angle: Math.PI / 6,
    penumbra: 0.1,
    width: 2,
    height: 2,
    target: [0, 0, 0],
    lookAt: [0, 0, 0],
    ...over,
  };
}

function objPosingLight(data: LightDataValue, over?: Partial<ObjectValue>): ObjectValue {
  return {
    kind: 'Object',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    data,
    ...over,
  };
}

describe('recomposeLightObject', () => {
  it('reconstitutes a flat PointLightValue from an Object posing a Point LightData', () => {
    // Non-default intensity (3.7) so a dropped field cannot pass vacuously (H177);
    // non-origin position so the pose merge is proven.
    const v = objPosingLight(lightData({ light: 'Point', intensity: 3.7 }), {
      position: [5, 0, 0],
    });
    const out = recomposeLightObject(v) as PointLightValue;
    expect(out.kind).toBe('PointLight');
    expect(out.intensity).toBe(3.7);
    expect(out.position).toEqual([5, 0, 0]);
    expect(out.distance).toBe(0);
    expect(out.decay).toBe(2);
  });

  it('maps each posable kind to its LightValue kind', () => {
    expect(recomposeLightObject(objPosingLight(lightData({ light: 'Directional' })))!.kind).toBe(
      'DirectionalLight',
    );
    expect(recomposeLightObject(objPosingLight(lightData({ light: 'Point' })))!.kind).toBe(
      'PointLight',
    );
    expect(recomposeLightObject(objPosingLight(lightData({ light: 'Spot' })))!.kind).toBe(
      'SpotLight',
    );
    expect(recomposeLightObject(objPosingLight(lightData({ light: 'Area' })))!.kind).toBe(
      'AreaLight',
    );
  });

  it('carries the spot cone fields (target/angle/penumbra) — a dropped field would lose the cone', () => {
    const out = recomposeLightObject(
      objPosingLight(lightData({ light: 'Spot', angle: 0.42, penumbra: 0.45, target: [1, 2, 3] })),
    ) as SpotLightValue;
    expect(out.angle).toBe(0.42);
    expect(out.penumbra).toBe(0.45);
    expect(out.target).toEqual([1, 2, 3]);
  });

  it('carries area width/height/lookAt and the optional emitter tex', () => {
    const withTex = recomposeLightObject(
      objPosingLight(
        lightData({ light: 'Area', width: 3.25, height: 4.5, tex: 'assets/hdri.exr' }),
      ),
    ) as AreaLightValue;
    expect(withTex.width).toBe(3.25);
    expect(withTex.height).toBe(4.5);
    expect(withTex.lookAt).toEqual([0, 0, 0]);
    expect(withTex.tex).toBe('assets/hdri.exr');
    // Absent tex stays absent (undefined → plain light).
    const noTex = recomposeLightObject(
      objPosingLight(lightData({ light: 'Area' })),
    ) as AreaLightValue;
    expect('tex' in noTex).toBe(false);
  });

  it('returns null (passes through) for a still-fused AmbientLightValue', () => {
    const ambient: AmbientLightValue = { kind: 'AmbientLight', intensity: 0.4, color: '#ffffff' };
    expect(recomposeLightObject(ambient)).toBeNull();
  });

  it('returns null for a mesh Object, a null value, and a non-Object', () => {
    const meshObj: ObjectValue = {
      kind: 'Object',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      data: null,
    };
    expect(recomposeLightObject(meshObj)).toBeNull();
    expect(recomposeLightObject(null)).toBeNull();
    expect(recomposeLightObject({ kind: 'PointLight' })).toBeNull();
  });
});
