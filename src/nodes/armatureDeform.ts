// #393 (step 2) — the armature deform: where a skinned mesh's points are at a time, by Blender's
// Armature modifier with linear blending, the default.
//
// ── THE RULE, AS BLENDER RUNS IT ────────────────────────────────────────────────────────────────
//
// In armature space, each point moves by the weighted sum of what each of its bones does to it,
// divided by the weight that found a bone (`armature_deform.cc`, `armature_vert_task_with_mixer`
// and `BoneDeformLinearMixer`):
//
//     co' = co + Σ wᵢ (Mᵢ·co − co) / Σ wᵢ,    Mᵢ = pose_matᵢ · arm_matᵢ⁻¹   (`armature.cc:3129`)
//
// - A group whose name no bone has contributes nothing and adds nothing to Σ wᵢ (a `nullptr`
//   pose channel is skipped, `:398-405`). Measured in Blender 5.1.1: a renamed group deforms 0.
// - A point whose matched weight is at most 0.0001 stays where it is (`contrib_threshold`,
//   `:434-436`). Measured: a zero-sum vertex stays at rest while its neighbours move.
// - A zero weight is skipped before it reaches the sum (`pchan_bone_deform`, `:252-254`).
//
// The point is taken into armature space by the armature Object's placement relative to the mesh
// and brought back after (Blender's `target_to_armature` / `armature_to_target`).
//
// REF: ref/sources/blender-armature-deform/armature_deform.cc, armature.cc;
//      ref/probes/blender-armature-deform/q11_join.py, q13_skinned_bar_oracle.py; issue #393.

import { Matrix4, Vector3 } from 'three';
import { boneWorldMatrices, posedWorldMatrices } from '../viewport/boneShape';
import { skinLanes } from './skinInfluences';
import type { BoneSpec, MeshGeometryData, PosedSkeletonValue, SkinDeformValue } from './types';

/** Below this matched weight a point is left where it is — Blender's `contrib_threshold`. */
const CONTRIB_THRESHOLD = 0.0001;

/**
 * Each group's bone by NAME, or -1 — the join Blender makes once per evaluation
 * (`BKE_pose_channel_find_name(…, dg.name)`, `armature_deform.cc:330-333`).
 */
export function boneOfGroups(
  vertexGroups: readonly string[],
  bones: readonly BoneSpec[],
): number[] {
  const byName = new Map<string, number>();
  bones.forEach((bone, i) => {
    if (!byName.has(bone.name)) byName.set(bone.name, i);
  });
  return vertexGroups.map((name) => byName.get(name) ?? -1);
}

/**
 * Each bone's posed matrix at `seconds`, in armature space — Blender's `pose_mat`, at the bone's
 * head — or the rest matrices when there is no pose. THE one answer to where a bone is: the
 * deform reads it here, and an Object parented to a bone reads it too (`boneParent.ts`, #1210), so
 * a prop in a hand cannot drift from the skin the hand deforms.
 *
 * It takes the POSE, built once per graph change, not a clip (#1223): it used to rebuild every
 * bone's sampler on every call, ~383 µs a frame on the 78-bone `walk.bvh` against ~32 µs to sample
 * (#1222).
 */
export function posedBoneMatrices(
  bones: readonly BoneSpec[],
  pose: PosedSkeletonValue | null,
  seconds: number,
): Matrix4[] {
  if (pose === null) return boneWorldMatrices(bones);
  return posedWorldMatrices(bones, pose.sample(seconds));
}

/** Each bone's skinning matrix at `seconds`, in armature space: pose · rest⁻¹. */
function skinningMatrices(skin: SkinDeformValue, seconds: number): Matrix4[] {
  const rest = boneWorldMatrices(skin.bones);
  if (skin.pose === null) return rest.map(() => new Matrix4());
  const posed = posedBoneMatrices(skin.bones, skin.pose, seconds);
  return posed.map((m, i) => m.clone().multiply(rest[i].clone().invert()));
}

/**
 * #1430 — what the deform does to a DIRECTION at each point of `mesh` at `seconds`: the linear part
 * of the point's blended matrix, in the mesh's own space, nine numbers per point, column-major. A
 * point the deform leaves at rest gets the identity.
 *
 * `sampleSkinDeform` states the rule as a sum of displacements; the same sum is one matrix per
 * point, `A · (Σ wᵢ Mᵢ / Σ wᵢ) · A⁻¹`, and a normal turns by its linear part — what three's skinning
 * shader does to a normal with its own four lanes (`skinnormal_vertex.glsl.js`). A draw that reads
 * the deform instead of skinning on the GPU needs this to light the mesh as the GPU draw would.
 */
export function sampleSkinDirections(
  skin: SkinDeformValue,
  mesh: MeshGeometryData,
  seconds: number,
): Float32Array {
  const points = mesh.points.length / 3;
  const out = new Float32Array(points * 9);
  for (let p = 0; p < points; p++) out[p * 9] = out[p * 9 + 4] = out[p * 9 + 8] = 1;
  const lanes = skinLanes(mesh);
  if (lanes === null) return out;
  const { joints, weights, width } = lanes;
  const toArmature = new Matrix4().fromArray(skin.armatureMatrix).invert();
  const fromArmature = new Matrix4().fromArray(skin.armatureMatrix);
  // Each bone's matrix taken into the mesh's space ONCE, so a point's blend is a plain weighted
  // sum of nine numbers: A · (Σ w M) · A⁻¹ = Σ w (A · M · A⁻¹).
  const bone = skinningMatrices(skin, seconds).map(
    (m) => fromArmature.clone().multiply(m).multiply(toArmature).elements,
  );
  const LINEAR = [0, 1, 2, 4, 5, 6, 8, 9, 10];
  const sum = new Float64Array(9);
  for (let p = 0; p < points; p++) {
    sum.fill(0);
    let contrib = 0;
    for (let lane = 0; lane < width; lane++) {
      const weight = weights[p * width + lane];
      if (!weight) continue;
      const b = skin.boneOfGroup[joints[p * width + lane]] ?? -1;
      if (b < 0) continue;
      const e = bone[b];
      for (let k = 0; k < 9; k++) sum[k] += weight * e[LINEAR[k]];
      contrib += weight;
    }
    if (!(contrib > CONTRIB_THRESHOLD)) continue;
    for (let k = 0; k < 9; k++) out[p * 9 + k] = sum[k] / contrib;
  }
  return out;
}

/**
 * Every point of `mesh` at `seconds`, deformed by `skin`, in the mesh's own space — xyz per point,
 * in the mesh's point order. A mesh without joint and weight layers comes back unmoved.
 */
export function sampleSkinDeform(
  skin: SkinDeformValue,
  mesh: MeshGeometryData,
  seconds: number,
): Float32Array {
  const out = Float32Array.from(mesh.points);
  // #1430 — every influence the mesh holds, however many sets it stores them in.
  const lanes = skinLanes(mesh);
  if (lanes === null) return out;
  const { joints, weights, width } = lanes;

  const toArmature = new Matrix4().fromArray(skin.armatureMatrix).invert();
  const fromArmature = new Matrix4().fromArray(skin.armatureMatrix);
  const bone = skinningMatrices(skin, seconds);
  const co = new Vector3();
  const moved = new Vector3();
  const delta = new Vector3();
  for (let p = 0; p * 3 < out.length; p++) {
    co.fromArray(out, p * 3).applyMatrix4(toArmature);
    delta.set(0, 0, 0);
    let contrib = 0;
    for (let lane = 0; lane < width; lane++) {
      const weight = weights[p * width + lane];
      if (!weight) continue;
      const b = skin.boneOfGroup[joints[p * width + lane]] ?? -1;
      if (b < 0) continue;
      moved.copy(co).applyMatrix4(bone[b]).sub(co).multiplyScalar(weight);
      delta.add(moved);
      contrib += weight;
    }
    if (contrib > CONTRIB_THRESHOLD) co.addScaledVector(delta, 1 / contrib);
    co.applyMatrix4(fromArmature).toArray(out, p * 3);
  }
  return out;
}
