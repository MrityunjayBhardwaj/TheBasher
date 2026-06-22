// GltfSkeleton — a PURE read-only projection of a glTF asset's captured skin
// bind data into a `Skeleton` value (Phase 7.11 Wave C, issue #100, D-02).
//
// Takes ONE input: a `GltfAsset`'s `out` (typed `Mesh`, but it carries a
// `GltfAssetValue` whose `skins` were captured at import). `skinIndex` picks
// which skin. The evaluator joins the captured `GltfSkinMetadata` into a
// `Skeleton`-typed value via `projectGltfSkeleton` — so a dropped glTF rig
// participates in the existing `Skeleton`/`PosedSkeleton` node family and can
// be a retarget target/source (Wave D).
//
// WHY THIS IS PURE OVER `GltfAsset` PARAMS (the resolved fork): a `Skeleton` is
// a BIND-pose definition, and the bind pose is import-time STATIC. GltfChild
// has no output socket (it is an addressing satellite, not a producer), so a
// live edge from GltfChild is impossible AND unnecessary. The mutable live pose
// stays OWNED by GltfChild (V20/H36 single-writer); this node only READS the
// immutable captured bind data. There is NO setParam, NO dispatch, NO store
// access, NO GltfChild reference anywhere here — the read-only guarantee D-02
// is chosen for, enforced by the F3 grep guard.
//
// REF: THESIS.md §40; CONTEXT D-02/D-03/D-04; vyapti V2 (purity) / V20 + H36
// (single-writer); projectGltfSkeleton.ts (the pure join); Skeleton.ts /
// PosedSkeleton.ts (single-input pure-node precedent).

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import { projectGltfSkeleton } from '../core/import/projectGltfSkeleton';
import type { GltfAssetValue, SkeletonValue } from './types';

export const GltfSkeletonParams = z.object({
  /** Which skin to project (a glTF may declare more than one). */
  skinIndex: z.number().int().min(0).default(0),
});
export type GltfSkeletonParams = z.infer<typeof GltfSkeletonParams>;

export const GltfSkeletonNode: NodeDefinition<GltfSkeletonParams, SkeletonValue> = {
  type: 'GltfSkeleton',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfSkeletonParams,
  inputs: {
    // Connect a `GltfAsset.out`. It is typed `Mesh` (the asset's render
    // output socket type), but the resolved value is a `GltfAssetValue` whose
    // `skins` we project. We read it as `GltfAssetValue` in evaluate.
    asset: { type: 'SceneObject', cardinality: 'single' },
  },
  outputs: { out: { type: 'Skeleton', cardinality: 'single' } },
  evaluate(params, inputs: ResolvedInputs): SkeletonValue {
    const asset = inputs.asset as GltfAssetValue | undefined;
    const skin = asset?.skins?.[params.skinIndex];
    if (!skin) return { kind: 'Skeleton', bones: [] };
    return projectGltfSkeleton(skin);
  },
};
