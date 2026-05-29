// projectGltfSkeleton — pure projection of captured glTF skin metadata into a
// `Skeleton` value (Phase 7.11 Wave C, issue #100, D-02).
//
// A `Skeleton` is a BIND-pose definition — import-time STATIC. So the
// projection reads ONLY the captured `GltfSkinMetadata` (the additive bind
// data on `GltfAsset`, written once at import by `buildSkinMetadata`). It does
// NOT read GltfChild's live pose and there is NO edge from GltfChild: pose
// ownership stays with GltfChild (V20/H36 single-writer), and this projector
// has no write path. Mirrors `resolveGltfChildTrs` — resolved data in, data
// out, zero three.js work (V2 purity).
//
// INDEX DISCIPLINE (the #1 bug site — RESEARCH #3 / risk #1): every per-joint
// array on `GltfSkinMetadata` is already in `skin.joints[]` order (the spine,
// captured by Wave A). We emit `BoneSpec[]` in that SAME order, so:
//   BoneSpec index i == skin.joints[] position i == IBM index i
//                    == parentJointIndex space i == render skeleton index i.
// `parentJointIndex[i]` is read DIRECTLY (captured first-class in Wave A) — no
// runtime indexOf, no childHierarchy walk here. This keeps the H40 render
// boundary-pair (projected bone i == rendered SkinnedMesh.skeleton bone i) a
// plain index-by-index match in Wave F.
//
// ROTATION UNITS (H46 / H20 boundary — the Wave C/D correctness trap):
//   - `GltfSkinMetadata.bindTRS[i].rotation` is DEGREES Euler. Wave A captures
//     it via `radVec3ToDeg(...)` (gltfImportChain.ts defaultTRS), matching the
//     codebase DAG-storage convention (Transform/TransformClip/GltfChild are
//     all degrees — see viewport/rotation.ts).
//   - `BoneSpec.rotation` is RADIANS. The existing producers prove this:
//     `bonesToSpec` (threeAdapter.ts) emits `quaternionToEulerVec3(quaternion)`
//     = raw THREE.Euler components = RADIANS; the consumer
//     `specToThreeSkeleton` rebuilds `new Euler(rot[0], rot[1], rot[2], 'XYZ')`
//     which expects RADIANS. BVH/FBX BoneSpec[] are therefore radians.
//   So the projector converts DEGREES → RADIANS here (degVec3ToRad), so a
//   glTF-projected BoneSpec is consumed by the SAME retarget adapter
//   (specToThreeSkeleton) identically to a BVH/FBX one — no deg/rad scale bug.
//
// REF: PLAN.md Wave C (C1); CONTEXT D-02/D-03/D-04; threeAdapter.ts (bonesToSpec
// / specToThreeSkeleton — the radians contract); viewport/rotation.ts (units).

import type { BoneSpec, GltfSkinMetadata, SkeletonValue } from '../../nodes/types';
import { degVec3ToRad } from '../../viewport/rotation';

/**
 * Project one captured glTF skin into a `Skeleton` value. Pure: data in, data
 * out; no three.js, no clock, no DOM, no store access, no write-back.
 *
 * BoneSpec rotation is emitted in RADIANS to match the BVH/FBX BoneSpec
 * contract (the input `bindTRS.rotation` is degrees — converted here).
 */
export function projectGltfSkeleton(skin: GltfSkinMetadata): SkeletonValue {
  const hasIbm = skin.inverseBindMatrices.length > 0;
  const bones: BoneSpec[] = skin.jointKeys.map((name, i): BoneSpec => {
    const trs = skin.bindTRS[i];
    const radRot = degVec3ToRad(trs.rotation);
    const bone: BoneSpec = {
      name,
      // Read the captured first-class parent index directly (Wave A) — joints
      // space, -1 for a root / no-joint-parent. No runtime re-derivation.
      parent: skin.parentJointIndex[i],
      position: trs.position,
      rotation: [radRot[0], radRot[1], radRot[2]],
      scale: trs.scale,
      // OMIT inverseBindMatrix when the skin declares no IBMs ([]) so a
      // no-IBM rig produces a byte-identical BoneSpec (no `inverseBindMatrix:
      // undefined` key) — keeps value-equality clean, mirroring Skeleton.ts.
      ...(hasIbm ? { inverseBindMatrix: skin.inverseBindMatrices[i] } : {}),
    };
    return bone;
  });
  return { kind: 'Skeleton', bones };
}
