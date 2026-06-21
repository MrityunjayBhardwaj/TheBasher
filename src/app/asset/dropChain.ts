// Build the Op chain a Library → viewport drop emits. Pure function: same
// inputs → same Op[]. The store applies the chain via `dispatchAtomic` so
// the drop is one atomic undo entry (acceptance #1).
//
// Op chain (#222 — the import root is ONE transformable Group, no separate
// Transform wrapper; matches buildGltfImportOps + Blender's parent/Empty):
//   1. addNode GltfAsset
//   2. addNode Group (carries the drop position — selecting it shows the gizmo)
//   3. connect gltf.out → group.children
//   4. connect group.out → scene.children
//
// REF: THESIS.md §14, §39; krama K2.

import type { Op } from '../../core/dag/types';
import type { Vec3 } from '../../nodes/types';

export interface DropChainArgs {
  assetRef: string;
  sceneNodeId: string;
  position?: Vec3;
  /** Override the new node IDs (tests pass deterministic ids). */
  ids?: { gltf: string; group: string };
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
    group: uniqueId('grp'),
  };
  const position = args.position ?? [0, 0, 0];
  return [
    {
      type: 'addNode',
      nodeId: ids.gltf,
      nodeType: 'GltfAsset',
      params: { assetRef: args.assetRef },
    },
    {
      // #222 — the Group itself is transformable (no nested Transform). A
      // catalog drop has no parsed glTF to measure, so pivot stays identity
      // (the asset moves about the origin; the glTF parse path bakes a centre).
      type: 'addNode',
      nodeId: ids.group,
      nodeType: 'Group',
      params: { position, rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
    },
    {
      type: 'connect',
      from: { node: ids.gltf, socket: 'out' },
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
