// A skeleton Object's bones as they are DRAWN — posed, placed in the world, and measured.
//
// Two readers need the same answer: the armature helper, which draws the bones, and Frame
// Selected, which has to fit them (#1179). A skeleton Object has no mesh of its own — its bones
// are editor chrome, drawn by the helper outside the Object's group — so the scene walk that
// measures everything else finds nothing under it. Framing therefore measures the bones the
// same way the helper places them, from this one function, so the camera cannot fit a rig the
// viewport is not showing.
//
// REF: src/viewport/ArmatureHelper.tsx (the drawing reader); src/app/character/framing.ts
//      (`boundsForNode`, the fitting reader); src/app/skeletonObjects.ts (the inputs).

import * as THREE from 'three';
import { boneTransforms, type BoneFrame } from './boneShape';
import { posedSourceBones } from './referenceRig';
import type { SceneBounds } from './sceneBounds';
import type { SkeletonObject } from '../app/skeletonObjects';

const _world = new THREE.Matrix4();
const _point = new THREE.Vector3();

/**
 * #1056 — a skeleton Object's bones, carried from the rig's own space into the world by the
 * Object's matrix. Head, tail and instance matrix all move together, and the length scales
 * with the Object, so sticks, bounds and picking read the same bone the octahedron draws.
 */
function placeInWorld(frames: readonly BoneFrame[], world: readonly number[]): BoneFrame[] {
  _world.fromArray(world);
  const scale = _world.getMaxScaleOnAxis();
  return frames.map((f) => {
    _point.set(f.head[0], f.head[1], f.head[2]).applyMatrix4(_world);
    const head = [_point.x, _point.y, _point.z] as const;
    _point.set(f.tail[0], f.tail[1], f.tail[2]).applyMatrix4(_world);
    const tail = [_point.x, _point.y, _point.z] as const;
    return {
      ...f,
      head,
      tail,
      length: f.length * scale,
      matrix: new THREE.Matrix4().multiplyMatrices(_world, f.matrix),
    };
  });
}

/** The Object's bones in world space at `seconds`: posed from its one clip, or at rest when it
 *  has none (or several). */
export function skeletonObjectFrames(o: SkeletonObject, seconds: number): BoneFrame[] {
  return placeInWorld(
    boneTransforms(o.clip ? posedSourceBones(o.clip, seconds) : o.bones),
    o.world,
  );
}

/**
 * The bounding sphere of every drawn bone, heads AND tails, or null when there are none.
 *
 * Every bone, the rig's transport root included: this is what Frame Selected fits, and the
 * reference fits what is drawn. Measured in Blender 5.1.1 — View Selected on an armature
 * Object whose one bone runs (0,0,0)→(0,0,1), posed 90° about X, located at (5,0,0) and scaled
 * 100×, centres on (5,−50,0): the midpoint of the POSED bone, head to tail, in world space.
 * (`armatureBounds` drops parentless bones on purpose — it sizes a figure, not a view.)
 */
export function boneFramesBounds(frames: readonly BoneFrame[]): SceneBounds | null {
  if (frames.length === 0) return null;
  const box = new THREE.Box3();
  for (const f of frames) {
    box.expandByPoint(_point.set(f.head[0], f.head[1], f.head[2]));
    box.expandByPoint(_point.set(f.tail[0], f.tail[1], f.tail[2]));
  }
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (![sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius].every(Number.isFinite)) {
    return null;
  }
  return { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius };
}
