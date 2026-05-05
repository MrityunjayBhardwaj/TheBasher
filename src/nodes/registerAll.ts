// Register all v0.5 node types. Called once during boot (K1 step 2).
// Idempotent: skips re-registration if already present so HMR works.

import { getNodeType, registerNodeType } from '../core/dag/registry';
import type { NodeDefinition } from '../core/dag/types';
import { AmbientLightNode } from './AmbientLight';
import { AreaLightNode } from './AreaLight';
import { BoxMeshNode } from './BoxMesh';
import { DirectionalLightNode } from './DirectionalLight';
import { GltfAssetNode } from './GltfAsset';
import { GroupNode } from './Group';
import { MaterialOverrideNode } from './MaterialOverride';
import { OrthographicCameraNode } from './OrthographicCamera';
import { PerspectiveCameraNode } from './PerspectiveCamera';
import { PointLightNode } from './PointLight';
import { RenderOutputNode } from './RenderOutput';
import { ScatterNode } from './ScatterNode';
import { SceneNode } from './Scene';
import { SpotLightNode } from './SpotLight';
import { TransformNode } from './Transform';

const ALL: NodeDefinition[] = [
  // Cameras
  PerspectiveCameraNode as unknown as NodeDefinition,
  OrthographicCameraNode as unknown as NodeDefinition,
  // Lights
  DirectionalLightNode as unknown as NodeDefinition,
  AmbientLightNode as unknown as NodeDefinition,
  PointLightNode as unknown as NodeDefinition,
  SpotLightNode as unknown as NodeDefinition,
  AreaLightNode as unknown as NodeDefinition,
  // Meshes
  BoxMeshNode as unknown as NodeDefinition,
  GltfAssetNode as unknown as NodeDefinition,
  TransformNode as unknown as NodeDefinition,
  GroupNode as unknown as NodeDefinition,
  MaterialOverrideNode as unknown as NodeDefinition,
  ScatterNode as unknown as NodeDefinition,
  // Aggregators
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
