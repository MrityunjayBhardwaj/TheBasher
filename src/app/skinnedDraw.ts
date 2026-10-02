// #1197 — a skinned mesh drawn natively: a three `SkinnedMesh` over the stored mesh, skinned on the
// GPU by the same rule the Armature modifier states (`src/nodes/armatureDeform.ts`).
//
// ── THE SKELETON IS BUILT ONCE, BY THE BUILDER THAT ALREADY EXISTS ─────────────────────────────
//
// `specToThreeSkeleton` turns the armature's rest bones into three bones with their world matrices
// composed before the inverses are taken — the order whose absence once flattened every rig to the
// origin (#828, #838, #839). Those bones live outside the scene, in armature space; each frame they
// take the armature's pose and their world matrices are recomputed.
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
// ── A POINT WITH MORE THAN FOUR BONES IS DRAWN FROM THE DEFORM ITSELF (#1430) ─────────────────
//
// three's skinning shader sums four lanes per vertex. A mesh holds every influence its file states,
// so a point may have more. Such a mesh is not drawn with the strongest four: it is drawn as an
// ordinary mesh whose positions and normals are the Armature modifier's own answer, re-read when the
// pose or the time changes (`buildDeformedDraw`), as Blender's viewport draws the evaluated mesh.
// What decides is the mesh's points, not how many sets it stores: a mesh with a second set whose
// every point still has at most four bones that found a group is skinned on the GPU, its lanes
// packed into the four the shader has (`gpuSkinnable`).
//
// REF: src/nodes/armatureDeform.ts; src/core/import/threeAdapter.ts (`specToThreeSkeleton`);
//      node_modules/three/src/objects/SkinnedMesh.js; issues #1197, #393.

import { Bone, Matrix4, Skeleton } from 'three';
import { specToThreeSkeleton } from '../core/import/threeAdapter';
import { restBonePose } from '../nodes/bonePose';
import { sampleSkinDeform, sampleSkinDirections } from '../nodes/armatureDeform';
import { SKIN_SET_WIDTH, skinLanes } from '../nodes/skinInfluences';
import type {
  BonePose,
  MeshGeometryData,
  PosedSkeletonValue,
  SkinDeformValue,
} from '../nodes/types';
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
  /**
   * Pose the armature's bones by `pose` at `seconds`; with none, back to rest. The pose is passed
   * per call rather than fixed at build (#1207): it changes whenever the motion does, and the
   * build must not be redone for it.
   */
  readonly pose: (seconds: number, pose: PosedSkeletonValue | null) => void;
}

/**
 * What the build depends on, as content (#1207): the mesh's geometry key and the skin's rest
 * bones, group join and armature placement — never object identity, which changes with every
 * graph change. The pose is not in it; `pose` takes that.
 */
export function skinnedDrawKey(geometryKey: string, skin: SkinDeformValue): string {
  return JSON.stringify([geometryKey, skin.bones, skin.boneOfGroup, skin.armatureMatrix]);
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
  const rest = skin.bones.map(restBonePose);
  const place = (entries: readonly BonePose[]): void => {
    entries.forEach((p, i) => {
      const bone = bones[i];
      if (!bone) return;
      bone.position.set(p.position[0], p.position[1], p.position[2]);
      bone.quaternion.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]);
      bone.scale.set(p.scale[0], p.scale[1], p.scale[2]);
    });
  };
  return {
    skeleton: new Skeleton(palette, inverses),
    bindMatrix: new Matrix4().fromArray(skin.armatureMatrix).invert(),
    skinIndex,
    skinWeight,
    pose(seconds, pose) {
      // The same pose the CPU deform reads (`SkinDeformValue.pose`), so the draw and the modifier
      // cannot disagree.
      place(pose === null ? rest : pose.sample(seconds));
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
  const lanes = skinLanes(mesh);
  const width = lanes?.width ?? 0;
  const { vertexCorner } = meshSplitLayout(mesh);
  const skinIndex = new Uint16Array(vertexCorner.length * 4);
  const skinWeight = new Float32Array(vertexCorner.length * 4);
  const found = (point: number, lane: number): boolean =>
    lanes!.weights[point * width + lane] > 0 &&
    (skin.boneOfGroup[lanes!.joints[point * width + lane]] ?? -1) >= 0;
  for (let v = 0; v < vertexCorner.length; v++) {
    const point = mesh.cornerPoints[vertexCorner[v]];
    let joined = 0;
    for (let lane = 0; lane < width; lane++) {
      if (found(point, lane)) joined += lanes!.weights[point * width + lane];
    }
    if (joined <= CONTRIB_THRESHOLD) {
      skinIndex[v * 4] = stillSlot;
      skinWeight[v * 4] = 1;
      continue;
    }
    if (width === SKIN_SET_WIDTH) {
      // One set: each stored lane is a shader lane, as it has been since #1197.
      for (let lane = 0; lane < 4; lane++) {
        const j = lanes!.joints[point * 4 + lane];
        skinIndex[v * 4 + lane] = j;
        skinWeight[v * 4 + lane] = found(point, lane)
          ? lanes!.weights[point * 4 + lane] / joined
          : 0;
      }
      continue;
    }
    // #1430 — further sets: the lanes that found a bone, packed into the shader's four. The caller
    // has checked there are at most four (`gpuSkinnable`).
    let slot = 0;
    for (let lane = 0; lane < width && slot < 4; lane++) {
      if (!found(point, lane)) continue;
      skinIndex[v * 4 + slot] = lanes!.joints[point * width + lane];
      skinWeight[v * 4 + slot] = lanes!.weights[point * width + lane] / joined;
      slot++;
    }
  }
  return { skinIndex, skinWeight };
}

/**
 * #1430 — whether three's four-lane skinning shader can draw `mesh` deformed by `skin` exactly: no
 * point has more than four lanes that carry weight AND found a bone. A lane whose group joined no
 * bone moves nothing in the deform either, so it does not count.
 */
export function gpuSkinnable(skin: SkinDeformValue, mesh: MeshGeometryData): boolean {
  const lanes = skinLanes(mesh);
  if (lanes === null || lanes.width <= 4) return true;
  const { joints, weights, width } = lanes;
  for (let p = 0; p * width < weights.length; p++) {
    let found = 0;
    for (let lane = 0; lane < width; lane++) {
      if (weights[p * width + lane] > 0 && (skin.boneOfGroup[joints[p * width + lane]] ?? -1) >= 0)
        found++;
    }
    if (found > 4) return false;
  }
  return true;
}

export interface DeformedDraw {
  /**
   * Write the mesh at `seconds`, posed by `pose`, into a build's `position` and (when it has one)
   * `normal` buffers, in `buildMeshGeometry`'s vertex order. `restNormal` is the build's normals as
   * built. Returns false, and writes nothing, when neither the time nor the pose has changed since
   * the last write.
   */
  readonly write: (
    seconds: number,
    pose: PosedSkeletonValue | null,
    position: Float32Array,
    normal: Float32Array | null,
    restNormal: Float32Array | null,
  ) => boolean;
}

/**
 * #1430 — the draw of a mesh the GPU cannot skin exactly: every buffer vertex takes its point's
 * place in the Armature modifier's own answer (`sampleSkinDeform`), and its normal turns by that
 * point's blended matrix. Nothing is approximated, so what is drawn IS the evaluated deform.
 */
export function buildDeformedDraw(skin: SkinDeformValue, mesh: MeshGeometryData): DeformedDraw {
  const { vertexCorner } = meshSplitLayout(mesh);
  const pointOfVertex = Uint32Array.from(vertexCorner, (corner) => mesh.cornerPoints[corner]);
  let last: { seconds: number; pose: PosedSkeletonValue | null } | null = null;
  return {
    write(seconds, pose, position, normal, restNormal) {
      if (last !== null && last.seconds === seconds && last.pose === pose) return false;
      last = { seconds, pose };
      const posed = { ...skin, pose };
      const points = sampleSkinDeform(posed, mesh, seconds);
      for (let v = 0; v < pointOfVertex.length; v++) {
        const p = pointOfVertex[v] * 3;
        position[v * 3] = points[p];
        position[v * 3 + 1] = points[p + 1];
        position[v * 3 + 2] = points[p + 2];
      }
      if (normal !== null && restNormal !== null) {
        const turn = sampleSkinDirections(posed, mesh, seconds);
        for (let v = 0; v < pointOfVertex.length; v++) {
          const m = pointOfVertex[v] * 9;
          const x = restNormal[v * 3];
          const y = restNormal[v * 3 + 1];
          const z = restNormal[v * 3 + 2];
          const nx = turn[m] * x + turn[m + 3] * y + turn[m + 6] * z;
          const ny = turn[m + 1] * x + turn[m + 4] * y + turn[m + 7] * z;
          const nz = turn[m + 2] * x + turn[m + 5] * y + turn[m + 8] * z;
          const length = Math.hypot(nx, ny, nz) || 1;
          normal[v * 3] = nx / length;
          normal[v * 3 + 1] = ny / length;
          normal[v * 3 + 2] = nz / length;
        }
      }
      return true;
    },
  };
}
