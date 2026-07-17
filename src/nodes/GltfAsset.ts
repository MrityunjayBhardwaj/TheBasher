// GltfAsset — references an external GLB file by path/url. The evaluator
// returns the spec only (a content key); the viewport performs the async
// load via drei's `useGLTF`. This keeps the node `pure: true`: the same
// `assetRef` always evaluates to the same JS object, so the cache is honest.
//
// V9: assetRef is a string handle. No shader source. No JS callbacks.
// The node never embeds binary data — that lives on disk under `assets/`.
//
// REF: THESIS.md §14, §39 (P1 node types).

import { z } from 'zod';
import type { NodeDefinition, ResolvedInputs } from '../core/dag/types';
import type { GltfAssetValue, TransformClipValue } from './types';

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const GltfAssetParams = z.object({
  /** Storage-relative path or URL. e.g. "assets/tree.glb" or "https://…". */
  assetRef: z.string().min(1),
  /**
   * P7.5 — glTF TRS animation extraction (issue #81). Sanitised
   * scene-node-name → DAG target id, populated by `buildGltfImportOps`
   * at drop time. The `.default({})` makes the field additive: pre-7.5
   * saved projects with a GltfAsset node hydrate with an empty map,
   * which the renderer treats as "no per-child override available."
   * (V10 / H14-clean — no schema-version bump needed.)
   */
  nodeNameMap: z.record(z.string(), z.string()).default({}),
  /**
   * P7.7 — glTF child DAG addressing (issue #91). Parent-key → child-keys,
   * derived from the glTF `node.children` index arrays at drop time
   * (`buildNodeNameMap`). Stored by post-dedup KEY (matching nodeNameMap),
   * NOT by raw glTF index. The outliner (Wave D) reads this to nest child
   * rows — pure PROJECTION, not render `inputs` (R-2 / B12 guard). The
   * `.default({})` makes it additive: pre-7.7 saves hydrate with an empty
   * hierarchy (V10 / H14-clean — no schema-version bump needed).
   */
  childHierarchy: z.record(z.string(), z.array(z.string())).default({}),
  /**
   * P7.11 — glTF skin metadata (issue #100, D-04). Captured at import by
   * `buildSkinMetadata`: per skin, the joint KEYS + bind TRS + parent index
   * + inverse-bind matrices, ALL in `skin.joints[]` order (the projection
   * spine). The pure `GltfSkeleton` node reads this to project a `Skeleton`
   * value — no second copy of pose; GltfChild stays the sole pose owner
   * (V20/H36). `.default([])` makes it additive: pre-7.11 saves hydrate with
   * no skins (V10/H14-clean — no schema-version bump). Mirrors the
   * nodeNameMap/childHierarchy additive-param precedent.
   */
  skins: z
    .array(
      z.object({
        jointKeys: z.array(z.string()),
        bindTRS: z.array(z.object({ position: Vec3, rotation: Vec3, scale: Vec3 })),
        // (FLAG 2) first-class — GltfSkeleton (C1) reads it directly, no
        // runtime parent re-derivation.
        parentJointIndex: z.array(z.number()),
        inverseBindMatrices: z.array(z.array(z.number()).length(16)),
        skeletonRootKey: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * P151 (Apply-Transform, issue #151) — the sanitised child KEYS (same key
   * space as `nodeNameMap`) whose RENDER is suppressed because the child was
   * baked into a standalone `BakedMesh`. `GltfAssetR` sets
   * `clone.getObjectByName(key).visible = false` for each entry, so the asset
   * stops rendering that child by name (no double-render with the BakedMesh).
   * This is an Op-backed param: the Apply composite appends the key here in the
   * SAME atomic `setParam`, and undo's inverse `setParam` un-suppresses (the
   * child renders again). `Object3D.visible=false` skips render + raycast for
   * the subtree (three propagates down) — reversible, no clone surgery, and a
   * NEW writer of `.visible` only (no V20 collision with the TRS/material
   * writers). `.default([])` makes it additive: pre-151 saves hydrate with an
   * empty list (V10 / H14-clean — no schema-version bump). Does NOT touch
   * nodeNameMap / childHierarchy (P7.7 sibling addressing stays intact, M7).
   */
  suppressedChildren: z.array(z.string()).default([]),
  /**
   * UX #7 / H90 — glTF node INDEX → post-dedup KEY (same key space as
   * `nodeNameMap`), captured at import by `buildNodeNameMap`. JSON object keys
   * are strings, so the integer node index serialises as a string key. The
   * renderer pairs this with `gltf.parser.associations` (node index per loaded
   * object) to stamp each clone object's `userData.basherGltfChildId`, making
   * viewport drill-in immune to the producer-key ↔ clone-name divergence that
   * leaves ~28% of a real export's meshes unaddressable by name (H90).
   * `.default({})` makes it additive: pre-UX#7 saves hydrate empty and fall back
   * to name-match (V10/H14-clean — no schema-version bump). Mirrors the
   * nodeNameMap/childHierarchy/skins additive-param precedent.
   */
  keyByGltfNodeIndex: z.record(z.string(), z.string()).default({}),
});
export type GltfAssetParams = z.infer<typeof GltfAssetParams>;

export const GltfAssetNode: NodeDefinition<GltfAssetParams, GltfAssetValue> = {
  type: 'GltfAsset',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfAssetParams,
  inputs: {
    // P7.5 — optional. When connected, `GltfAssetR` overrides per-child
    // TRS via `nodeNameMap` keys. Closure walks via the 'animation'
    // EdgeKind (V13 — same as the AnimationLayer.animation socket).
    transformClip: { type: 'TransformClip', cardinality: 'single' },
  },
  outputs: { out: { type: 'SceneObject', cardinality: 'single' } },
  // The pose contract (#362, §9): a GltfAsset's pose lives on its import-root Group
  // (#222/V67 — the Group carries position + pivot and mounts the gizmo; this node
  // resolves to NO `position`, so its transform panel was inert #356). It stays the
  // DATA under that Group and drops the inert transform/constraint panels, keeping
  // mesh/material (the asset's editable surface) + driver. Phase 3 (#363) makes the
  // import build explicit Object(s) + data; this is the honest interim.
  inspectorSections: ['mesh', 'driver', 'material'],
  evaluate(params, inputs: ResolvedInputs): GltfAssetValue {
    return {
      kind: 'GltfAsset',
      assetRef: params.assetRef,
      nodeNameMap: params.nodeNameMap,
      childHierarchy: params.childHierarchy,
      skins: params.skins,
      suppressedChildren: params.suppressedChildren,
      keyByGltfNodeIndex: params.keyByGltfNodeIndex,
      transformClip: (inputs.transformClip as TransformClipValue | undefined) ?? null,
    };
  },
};
