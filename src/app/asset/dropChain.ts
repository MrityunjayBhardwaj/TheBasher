// Build the Op chain a Library → viewport drop emits. Pure function: same
// inputs → same Op[]. The store applies the chain via `dispatchAtomic` so
// the drop is one atomic undo entry (acceptance #1).
//
// Op chain (NEXT_SESSION P1, Wave B):
//   1. addNode GltfAsset
//   2. addNode Transform
//   3. connect gltf.out → transform.target
//   4. addNode Group
//   5. connect transform.out → group.children
//   6. connect group.out → scene.children
//
// REF: THESIS.md §14, §39; krama K2.

import type { Op } from '../../core/dag/types';
import type { Vec3 } from '../../nodes/types';

export interface DropChainArgs {
  assetRef: string;
  sceneNodeId: string;
  position?: Vec3;
  /** Override the new node IDs (tests pass deterministic ids). */
  ids?: { gltf: string; transform: string; group: string };
}

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  // Random suffix avoids collisions across restarts that share counter=0;
  // node ids are UI artifacts (not pure-evaluator values), so randomness
  // here doesn't violate V2.
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `n_${prefix}_${counter.toString(36)}${r}`;
}

export function buildAssetDropOps(args: DropChainArgs): Op[] {
  const ids = args.ids ?? {
    gltf: uniqueId('gltf'),
    transform: uniqueId('tx'),
    group: uniqueId('grp'),
  };
  const position = args.position ?? [0, 0, 0];
  return [
    { type: 'addNode', nodeId: ids.gltf, nodeType: 'GltfAsset', params: { assetRef: args.assetRef } },
    {
      type: 'addNode',
      nodeId: ids.transform,
      nodeType: 'Transform',
      params: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
    {
      type: 'connect',
      from: { node: ids.gltf, socket: 'out' },
      to: { node: ids.transform, socket: 'target' },
    },
    { type: 'addNode', nodeId: ids.group, nodeType: 'Group', params: {} },
    {
      type: 'connect',
      from: { node: ids.transform, socket: 'out' },
      to: { node: ids.group, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: ids.group, socket: 'out' },
      to: { node: args.sceneNodeId, socket: 'children' },
    },
  ];
}

/** Test-only — reset the monotonic counter so id sequences are reproducible. */
export function __resetDropCounterForTests(): void {
  counter = 0;
}
