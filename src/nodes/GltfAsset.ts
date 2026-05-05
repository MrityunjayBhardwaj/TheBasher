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
import type { NodeDefinition } from '../core/dag/types';
import type { GltfAssetValue } from './types';

export const GltfAssetParams = z.object({
  /** Storage-relative path or URL. e.g. "assets/tree.glb" or "https://…". */
  assetRef: z.string().min(1),
});
export type GltfAssetParams = z.infer<typeof GltfAssetParams>;

export const GltfAssetNode: NodeDefinition<GltfAssetParams, GltfAssetValue> = {
  type: 'GltfAsset',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfAssetParams,
  inputs: {},
  outputs: { out: { type: 'Mesh', cardinality: 'single' } },
  evaluate(params) {
    return { kind: 'GltfAsset', assetRef: params.assetRef };
  },
};
