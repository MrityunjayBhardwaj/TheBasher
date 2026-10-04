// The pose-mode bone gizmo's arithmetic (#1336): where a selected bone stands, and what a drag of
// its gizmo writes. Pure (three's math only, no store, no React), so the rule is tested without a
// renderer; `BoneGizmo.tsx` mounts it.
//
// THE RULE. A pose member REPLACES the bone's local transform (`restBonePose` is what it replaces),
// so a drag is turned into the bone's new LOCAL transform under its POSED parent:
//
//     boneWorld'  = Δ · boneWorld₀,          Δ = proxyWorld · proxyWorld₀⁻¹
//     local'      = parentWorld⁻¹ · boneWorld'
//
// The proxy is seeded at the bone's head with the bone's world rotation, so Δ is a rotation or a
// scale ABOUT THE HEAD in the bone's axes, or a translation, as in Blender's pose mode, where the
// gizmo sits at the bone's head and a rotation pivots there. Only the dragged component of `local'`
// is written (translate → position, rotate → rotation, scale → scale): the other two are what the
// bone already had, and writing them would author components the director never touched.
//
// That is the bone's local transform AS DRAWN, which is the member's value only when the layer the
// pose writes is the last word on the bone (an override at weight 1 with nothing above). The gizmo
// solves it back through the blend first (`layerValueForDrawn`, #1337).
//
// REF: src/app/BoneGizmo.tsx (the consumer); src/viewport/boneShape.ts (`posedWorldMatrices`);
//      src/app/animate/autoKeyCommit.ts (`commitObjectBonePose`, the write); issue #1336.

import * as THREE from 'three';
import { eulerFromQuat, type EulerOrder } from '../nodes/bonePose';
import type { Quat, Vec3 } from '../nodes/types';

const DEG = Math.PI / 180;

/** Where the gizmo stands for a bone: its head, and its world rotation (scale left at 1). */
export function boneGizmoSeed(boneWorld: THREE.Matrix4): THREE.Matrix4 {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  boneWorld.decompose(p, q, s);
  return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}

/**
 * The bone's new local transform under `parentWorld` — as it should be DRAWN — given the bone and
 * the proxy as they stood when the drag began and the proxy now. Turning it into what a layer
 * stores is `layerValueForDrawn` (#1337).
 */
export function boneDragLocal(
  boneWorld0: THREE.Matrix4,
  proxyWorld0: THREE.Matrix4,
  proxyWorld: THREE.Matrix4,
  parentWorld: THREE.Matrix4,
): { position: Vec3; quaternion: Quat; scale: Vec3 } {
  const delta = proxyWorld.clone().multiply(proxyWorld0.clone().invert());
  const boneWorld = delta.multiply(boneWorld0);
  const local = parentWorld.clone().invert().multiply(boneWorld);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  local.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
}

/** A rotation as a member stores it: degrees, in the member's euler order. */
export function memberDegrees(q: Quat, order: EulerOrder): Vec3 {
  const e = eulerFromQuat(q, order);
  return [e[0] / DEG + 0, e[1] / DEG + 0, e[2] / DEG + 0];
}
