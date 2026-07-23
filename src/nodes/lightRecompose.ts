// recomposeLightObject — the ONE place an `Object` posing a `LightData` becomes the
// flat `LightValue` the renderer's light band consumes (#386, Stage C · C3).
//
// Post-split the node wired into a light socket (Scene.inputs.lights,
// LightRig.inputs.lights) is an `ObjectValue` whose `data` is a `LightDataValue` —
// NOT a `LightValue`. The entire light renderer (LightNode → LightKindR, aim,
// Track-To, the studio rig, the helpers) consumes a flat `LightValue`. Rather than
// teach every one of those to read `value.data.*`, we reconstitute the flat
// `LightValue` at the two GATHER chokepoints (Scene.evaluate + LightRig.evaluate)
// AND at ObjectR's nested-light arm — three roads, ONE helper (V117: a cross-cutting
// transform goes at every road that funnels the same values). This keeps the whole
// light band UNTOUCHED for the value.kind road.
//
// A still-fused `AmbientLightValue` (or any non-split value) passes through: the
// caller does `recomposeLightObject(v) ?? v`, so a null return means "not a split
// light, keep the original".
//
// The recompose merges the Object's TRS (position/rotation/scale) back onto the flat
// value and copies the per-kind shading fields off the LightData. `target` (spot) /
// `lookAt` (area) live on the LightData (authored shading orientation, parity-first
// #386) and are merged back here.

import type { LightDataValue, LightValue, ObjectValue, Vec3 } from './types';

/** LightData.light (the enum discriminator) → the flat LightValue kind. */
const KIND_OF = {
  Directional: 'DirectionalLight',
  Point: 'PointLight',
  Spot: 'SpotLight',
  Area: 'AreaLight',
} as const;

/**
 * Reconstitute the flat `LightValue` for an `Object` posing a `LightData`, or return
 * null for anything else (a fused light, a mesh Object, a non-Object value) so the
 * caller keeps the original value unchanged.
 */
export function recomposeLightObject(value: unknown): LightValue | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as ObjectValue;
  if (obj.kind !== 'Object' || obj.data == null || obj.data.kind !== 'LightData') return null;
  const d: LightDataValue = obj.data;
  const position: Vec3 = obj.position;
  const rotation: Vec3 = obj.rotation;
  const scale: Vec3 = obj.scale ?? [1, 1, 1];
  switch (d.light) {
    case 'Directional':
      return {
        kind: KIND_OF.Directional,
        intensity: d.intensity,
        position,
        rotation,
        scale,
        color: d.color,
      };
    case 'Point':
      return {
        kind: KIND_OF.Point,
        intensity: d.intensity,
        position,
        rotation,
        scale,
        color: d.color,
        distance: d.distance,
        decay: d.decay,
      };
    case 'Spot':
      return {
        kind: KIND_OF.Spot,
        intensity: d.intensity,
        position,
        target: d.target,
        rotation,
        scale,
        color: d.color,
        angle: d.angle,
        penumbra: d.penumbra,
        distance: d.distance,
        decay: d.decay,
      };
    case 'Area':
      return {
        kind: KIND_OF.Area,
        intensity: d.intensity,
        position,
        rotation,
        scale,
        color: d.color,
        width: d.width,
        height: d.height,
        lookAt: d.lookAt,
        ...(d.tex ? { tex: d.tex } : {}),
      };
  }
}
