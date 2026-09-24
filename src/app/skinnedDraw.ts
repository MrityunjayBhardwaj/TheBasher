// #1197 — a skinned mesh drawn natively: a three `SkinnedMesh` over the stored mesh, skinned on the
// GPU by the same rule the Armature modifier states (`src/nodes/armatureDeform.ts`).
//
// ── THE SKELETON IS BUILT ONCE, BY THE BUILDER THAT ALREADY EXISTS ─────────────────────────────
//
// `specToThreeSkeleton` turns the armature's rest bones into three bones with their world matrices
// composed before the inverses are taken — the order whose absence once flattened every rig to the
// origin (#828, #838, #839). Those bones live outside the scene, in armature space; each frame they
// take the action's pose and their world matrices are recomputed.
//
// ── THE PALETTE IS THE MESH'S GROUP TABLE ──────────────────────────────────────────────────────
//
// The bone array handed to the `SkinnedMesh` is ordered by the mesh's `vertexGroups`, so a stored
// joint number goes straight into `skinIndex`. Each slot is the bone its group's NAME joined
// (`SkinDeformValue.boneOfGroup`); one more slot at the end is a bone that never moves.
//
// ── THE WEIGHTS CARRY BLENDER'S RULE, SO THE GPU'S PLAIN SUM COMPUTES IT ────────────────────────
//
// three skins a vertex as Σ wᵢ·Mᵢ·v and divides by nothing. Blender divides by the weight that
// found a bone and leaves a point with none at rest. So the weights are rewritten once, here: a lane
// whose group joined no bone gets 0, the rest are divided by the joined sum, and a vertex whose
// joined weight is at most 0.0001 goes wholly to the still bone. The GPU's sum is then exactly the
// modifier's answer.
//
// ── THE ARMATURE'S PLACEMENT IS THE BIND MATRIX ─────────────────────────────────────────────────
//
// Bound DETACHED with `bindMatrix` = the armature's placement⁻¹, three computes
// A · Σ wᵢ (poseᵢ · restᵢ⁻¹) · A⁻¹ · v (`SkinnedMesh.applyBoneTransform`, three r169) — the
// modifier's armature-space round trip, in the mesh's own space.
//
// REF: src/nodes/armatureDeform.ts; src/core/import/threeAdapter.ts (`specToThreeSkeleton`);
//      node_modules/three/src/objects/SkinnedMesh.js; issues #1197, #393.

import { Bone, Euler, Matrix4, Skeleton } from 'three';
import { specToThreeSkeleton } from '../core/import/threeAdapter';
import { posedSkeletonFromClip } from '../nodes/AnimationClip';
import { SKIN_JOINTS, SKIN_WEIGHTS } from '../nodes/attributes';
import type { MeshGeometryData, PosedSkeletonValue, SkinDeformValue } from '../nodes/types';
import { meshSplitLayout } from './polygonLayout';

/** Below this joined weight a point stays at rest — Blender's `contrib_threshold`. */
const CONTRIB_THRESHOLD = 0.0001;

export interface SkinnedDraw {
  /** The palette the `SkinnedMesh` binds to: one bone per vertex group, then the still bone. */
  readonly skeleton: Skeleton;
  /** `bindMatrix` for a DETACHED bind: the armature's placement in the mesh's space, inverted. */
  readonly bindMatrix: Matrix4;
  /** Per buffer vertex, four joint numbers and four weights, as `buildMeshGeometry` lays them. */
  readonly skinIndex: Uint16Array;
  readonly skinWeight: Float32Array;
  /** Pose the armature's bones at `seconds`. With no action the rig keeps its rest. */
  readonly pose: (seconds: number) => void;
}

/** Build the draw of `mesh` deformed by `skin`. */
export function buildSkinnedDraw(skin: SkinDeformValue, mesh: MeshGeometryData): SkinnedDraw {
  const { skeleton: armature, bones } = specToThreeSkeleton(skin.bones);
  const still = new Bone();
  still.name = '';
  const groups = skin.boneOfGroup.length;
  const palette: Bone[] = [];
  const inverses: Matrix4[] = [];
  for (let g = 0; g < groups; g++) {
    const b = skin.boneOfGroup[g];
    palette.push(b >= 0 ? bones[b] : still);
    inverses.push(b >= 0 ? armature.boneInverses[b].clone() : new Matrix4());
  }
  palette.push(still);
  inverses.push(new Matrix4());

  const { skinIndex, skinWeight } = vertexBindings(skin, mesh, groups);
  const roots = bones.filter((b) => !b.parent);
  const sampler: PosedSkeletonValue | null =
    skin.action === null ? null : posedSkeletonFromClip(skin.action);
  const euler = new Euler();
  return {
    skeleton: new Skeleton(palette, inverses),
    bindMatrix: new Matrix4().fromArray(skin.armatureMatrix).invert(),
    skinIndex,
    skinWeight,
    pose(seconds) {
      if (sampler === null) return;
      const pose = sampler.sample(seconds);
      bones.forEach((bone, i) => {
        const p = pose[i];
        if (!p) return;
        bone.position.set(p.position[0], p.position[1], p.position[2]);
        bone.quaternion.setFromEuler(euler.set(p.rotation[0], p.rotation[1], p.rotation[2], 'XYZ'));
      });
      for (const root of roots) root.updateMatrixWorld(true);
    },
  };
}

/** Each buffer vertex's joints and weights, rewritten to Blender's rule (see the header). */
function vertexBindings(
  skin: SkinDeformValue,
  mesh: MeshGeometryData,
  stillSlot: number,
): { skinIndex: Uint16Array; skinWeight: Float32Array } {
  const joints = mesh.pointLayers.find((l) => l.name === SKIN_JOINTS)?.data;
  const weights = mesh.pointLayers.find((l) => l.name === SKIN_WEIGHTS)?.data;
  const { vertexCorner } = meshSplitLayout(mesh);
  const skinIndex = new Uint16Array(vertexCorner.length * 4);
  const skinWeight = new Float32Array(vertexCorner.length * 4);
  for (let v = 0; v < vertexCorner.length; v++) {
    const point = mesh.cornerPoints[vertexCorner[v]];
    let joined = 0;
    if (joints && weights) {
      for (let lane = 0; lane < 4; lane++) {
        const w = weights[point * 4 + lane];
        if (w > 0 && (skin.boneOfGroup[joints[point * 4 + lane]] ?? -1) >= 0) joined += w;
      }
    }
    if (joined <= CONTRIB_THRESHOLD) {
      skinIndex[v * 4] = stillSlot;
      skinWeight[v * 4] = 1;
      continue;
    }
    for (let lane = 0; lane < 4; lane++) {
      const j = joints![point * 4 + lane];
      const w = weights![point * 4 + lane];
      skinIndex[v * 4 + lane] = j;
      skinWeight[v * 4 + lane] = w > 0 && (skin.boneOfGroup[j] ?? -1) >= 0 ? w / joined : 0;
    }
  }
  return { skinIndex, skinWeight };
}
