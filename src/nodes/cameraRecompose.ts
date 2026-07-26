// recomposeCameraObject — the ONE place an `Object` posing a `CameraData` becomes the
// flat `CameraValue` the DAG's camera consumers still read (#387, Stage C · C4).
//
// The direct analogue of `recomposeLightObject`, and it is deliberately its mirror
// image: same guard shape, same "null means not a split camera, keep the original"
// contract, same switch on the data half's discriminator.
//
// WHAT IT IS FOR, AND WHAT IT IS NOT FOR — this is the part that differs from the
// light, and getting it wrong is the whole hazard of C4.
//
// `CameraValue` is consumed by seven `evaluate` gathers (Scene, CameraSelect, Shot,
// and the four passes) plus `runRenderJob`, and `Scene.inputs.camera` is typed as a
// `SceneObject`. All of that is the VALUE road, and this function is what keeps it
// working for a split pair. But the value road is NOT what draws the picture: the
// `CameraValue` a pass receives goes into `buildPassSourceHash` — a render-cache key.
// What actually frames the shot is a `CameraPose` built from RAW params by
// `activeCamera.ts`. So a channel landing correctly in the value produced here proves
// the cache key is right; it says nothing about whether the camera moved. That second
// question belongs to the pose road, and it is asked separately.
//
// The Object's `rotation` and `scale` are DROPPED, and that is the parity-first
// decision (#387 D1) showing through rather than an omission: `CameraValue` has no
// rotation, the camera's orientation is `lookAt` + `roll` on the data half, and the
// pose road reads those. A camera Object's `rotation` is therefore a no-op today.
//
// REF: src/nodes/lightRecompose.ts (the shape this mirrors); src/nodes/CameraData.ts;
//      src/app/activeCamera.ts (the pose road that does NOT go through here);
//      issue #387.

import type { CameraDataValue, CameraValue, ObjectValue, Vec3 } from './types';

/**
 * Reconstitute the flat `CameraValue` for an `Object` posing a `CameraData`, or return
 * null for anything else (a fused camera, a mesh Object, a non-Object value) so the
 * caller keeps the original value unchanged.
 */
export function recomposeCameraObject(value: unknown): CameraValue | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as ObjectValue;
  if (obj.kind !== 'Object' || obj.data == null || obj.data.kind !== 'CameraData') return null;
  const d: CameraDataValue = obj.data;
  const position: Vec3 = obj.position;
  switch (d.projection) {
    case 'Perspective':
      return {
        kind: 'PerspectiveCamera',
        fov: d.fov,
        near: d.near,
        far: d.far,
        position,
        lookAt: d.lookAt,
        roll: d.roll,
      };
    case 'Orthographic':
      return {
        kind: 'OrthographicCamera',
        zoom: d.zoom,
        near: d.near,
        far: d.far,
        position,
        lookAt: d.lookAt,
        roll: d.roll,
      };
  }
}
