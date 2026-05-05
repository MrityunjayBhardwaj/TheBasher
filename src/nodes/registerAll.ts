// Register all v0.5 P0 node types. Called once during boot (K1 step 2).
// Idempotent: skips re-registration if already present so HMR works.

import { getNodeType, registerNodeType } from '../core/dag/registry';
import type { NodeDefinition } from '../core/dag/types';
import { BoxMeshNode } from './BoxMesh';
import { DirectionalLightNode } from './DirectionalLight';
import { PerspectiveCameraNode } from './PerspectiveCamera';
import { RenderOutputNode } from './RenderOutput';
import { SceneNode } from './Scene';

const ALL: NodeDefinition[] = [
  PerspectiveCameraNode as unknown as NodeDefinition,
  DirectionalLightNode as unknown as NodeDefinition,
  BoxMeshNode as unknown as NodeDefinition,
  SceneNode as unknown as NodeDefinition,
  RenderOutputNode as unknown as NodeDefinition,
];

let registered = false;

export function registerAllNodes(): void {
  if (registered) return;
  for (const def of ALL) {
    if (!getNodeType(def.type)) registerNodeType(def);
  }
  registered = true;
}

/** Test-only re-seed; pairs with __resetRegistryForTests. */
export function __reseedAllNodesForTests(): void {
  registered = false;
  registerAllNodes();
}
