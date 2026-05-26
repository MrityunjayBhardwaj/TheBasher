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
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  inspectorSections: ['mesh', 'transform', 'material'],
  evaluate(params, inputs: ResolvedInputs): GltfAssetValue {
    return {
      kind: 'GltfAsset',
      assetRef: params.assetRef,
      nodeNameMap: params.nodeNameMap,
      childHierarchy: params.childHierarchy,
      transformClip: (inputs.transformClip as TransformClipValue | undefined) ?? null,
    };
  },
};
