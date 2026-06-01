// Imported-asset reference scanner — Phase 7.14 Wave B (issue #112).
//
// Pure DAG query: which nodes reference a given My-Imports asset by its OPFS
// path? Today only `GltfAsset` persists a reference (`params.assetRef`, set at
// import to the OPFS path — importGltf.ts:180). BVH/FBX leave NO persistent
// reference (they dispatch Skeleton+AnimationClip and nothing holds the path),
// so a BVH/FBX asset is never "referenced" — its rename is a folder move only
// and its delete never needs a break-refs prompt (CONTEXT D-03 asymmetry).
//
// Used by both management operations:
//   - rename: rewrite every referencing node's assetRef from the old prefix to
//     the new one (in one dispatchAtomic, K6).
//   - delete: if any node references the asset, block + offer break-refs (D-06).
//
// Pure (no store handle, no storage) so it unit-tests trivially and can run
// against a forked DAG state. V8: app-layer, no viewport import.
//
// REF: phase 7.14 PLAN Wave B (B1); CONTEXT D-03/D-06; importGltf.ts:180
//      (assetRef provenance); RESEARCH §E (the reference graph).

import type { DagState } from '../../core/dag/state';
import { USER_IMPORTS_ROOT } from './importCommon';

/** The OPFS path prefix that every file of import `name` lives under. */
export function importPathPrefix(name: string): string {
  return `${USER_IMPORTS_ROOT}/${name}/`;
}

/**
 * Return the ids of every node whose persistent reference points inside
 * `user-imports/<name>/`. A node matches iff it is a `GltfAsset` and its
 * `params.assetRef` starts with the import's path prefix.
 *
 * The trailing slash in the prefix is load-bearing: import `foo` must NOT match
 * a node referencing import `foobar` (`user-imports/foo/` is not a prefix of
 * `user-imports/foobar/`). The unit test pins this boundary.
 */
export function nodesReferencingImport(name: string, state: DagState): string[] {
  const prefix = importPathPrefix(name);
  const ids: string[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'GltfAsset') continue;
    const ref = (node.params as { assetRef?: unknown } | undefined)?.assetRef;
    if (typeof ref === 'string' && ref.startsWith(prefix)) {
      ids.push(node.id);
    }
  }
  return ids;
}
