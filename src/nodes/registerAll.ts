// Register all v0.5 node types. Called once during boot (K1 step 2).
// Idempotent: skips re-registration if already present so HMR works.

import { getNodeType, registerNodeType } from '../core/dag/registry';
import type { NodeDefinition } from '../core/dag/types';
import { AmbientLightNode } from './AmbientLight';
import { AnimationClipNode } from './AnimationClip';
import { AnimationLayerNode } from './AnimationLayer';
// P7.5 — glTF TRS animation extraction (issue #81). Imports stay
// alphabetised so a re-sort doesn't produce noise.
// (TransformClipNode is imported later in the alphabetical block.)
import { AreaLightNode } from './AreaLight';
import { BakedMeshNode } from './BakedMesh';
import { BeautyPassNode } from './BeautyPass';
import { BoneNameMapNode } from './BoneNameMap';
import { BoxMeshNode } from './BoxMesh';
import { CharacterNode } from './Character';
import { ClipSelectNode } from './ClipSelect';
import { ComfyUIWorkflowNode } from './ComfyUIWorkflow';
import { CutNode } from './Cut';
import { DepthPassNode } from './DepthPass';
import { DirectionalLightNode } from './DirectionalLight';
import { GltfAssetNode } from './GltfAsset';
import { GltfChildNode } from './GltfChild';
import { GroupNode } from './Group';
import { IDPassNode } from './IDPass';
import { KeyframeChannelColorNode } from './KeyframeChannelColor';
import { KeyframeChannelNumberNode } from './KeyframeChannelNumber';
import { KeyframeChannelQuatNode } from './KeyframeChannelQuat';
import { KeyframeChannelVec3Node } from './KeyframeChannelVec3';
import { LocomotionStateNode } from './LocomotionState';
import { MaterialOverrideNode } from './MaterialOverride';
import { NavmeshNode } from './Navmesh';
import { NormalPassNode } from './NormalPass';
import { OrthographicCameraNode } from './OrthographicCamera';
import { PerspectiveCameraNode } from './PerspectiveCamera';
import { PointLightNode } from './PointLight';
import { PosedSkeletonNode } from './PosedSkeleton';
import { PromptNode } from './Prompt';
import { RenderJobNode } from './RenderJob';
import { RenderOutputNode } from './RenderOutput';
import { ScatterNode } from './ScatterNode';
import { SceneNode } from './Scene';
import { ShotNode } from './Shot';
import { GltfSkeletonNode } from './GltfSkeleton';
import { SkeletonNode } from './Skeleton';
import { SpotLightNode } from './SpotLight';
import { SphereMeshNode } from './SphereMesh';
import { TimeSourceNode } from './TimeSource';
import { TransformClipNode } from './TransformClip';
import { TransformNode } from './Transform';
import { VideoStitchNode } from './VideoStitch';
import { WalkPathNode } from './WalkPath';

const ALL: NodeDefinition[] = [
  // Time (P2 — the only impure source; pure consumers wire to it)
  TimeSourceNode as unknown as NodeDefinition,
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
  SphereMeshNode as unknown as NodeDefinition,
  GltfAssetNode as unknown as NodeDefinition,
  // P7.7 — addressable proxy per glTF scene child (issue #91). Inputless,
  // non-producing addressing satellite; emitted one-per-child at import
  // (gltfImportChain). Must be registered before its addNode validates (V1).
  GltfChildNode as unknown as NodeDefinition,
  // Phase 151 — the product of Apply-Transform (issue #151). A pure mesh
  // producer carrying a baked GeometryRef handle + identity TRS + rich material.
  // Registered in the Meshes block so its addNode validates at Apply time (V1).
  BakedMeshNode as unknown as NodeDefinition,
  TransformNode as unknown as NodeDefinition,
  GroupNode as unknown as NodeDefinition,
  MaterialOverrideNode as unknown as NodeDefinition,
  ScatterNode as unknown as NodeDefinition,
  // P2 — Character + Move
  SkeletonNode as unknown as NodeDefinition,
  // P7.11 — pure read-only projection of a glTF asset's captured skin bind data
  // into a `Skeleton` value (issue #100, D-02). Registered alongside the rig
  // family it joins.
  GltfSkeletonNode as unknown as NodeDefinition,
  PosedSkeletonNode as unknown as NodeDefinition,
  AnimationClipNode as unknown as NodeDefinition,
  NavmeshNode as unknown as NodeDefinition,
  WalkPathNode as unknown as NodeDefinition,
  LocomotionStateNode as unknown as NodeDefinition,
  CharacterNode as unknown as NodeDefinition,
  // P3 — Timeline = animation nodes
  KeyframeChannelNumberNode as unknown as NodeDefinition,
  KeyframeChannelVec3Node as unknown as NodeDefinition,
  KeyframeChannelQuatNode as unknown as NodeDefinition,
  KeyframeChannelColorNode as unknown as NodeDefinition,
  AnimationLayerNode as unknown as NodeDefinition,
  // P7.5 — glTF TRS animation extraction (issue #81); pure node-indexed
  // sampler + multi-clip selector. See TransformClip.ts / ClipSelect.ts.
  TransformClipNode as unknown as NodeDefinition,
  ClipSelectNode as unknown as NodeDefinition,
  ShotNode as unknown as NodeDefinition,
  CutNode as unknown as NodeDefinition,
  BoneNameMapNode as unknown as NodeDefinition,
  // P4 — Render graph (THESIS §43)
  BeautyPassNode as unknown as NodeDefinition,
  IDPassNode as unknown as NodeDefinition,
  RenderJobNode as unknown as NodeDefinition,
  // P5 — AI Render Bridge (THESIS §28, §44)
  // §43 amendment (D-02): Depth + Normal join the registry only because
  // stylizedRealism's ControlNet inputs demand them. LineArt /
  // Segmentation / AO / Albedo / Alpha / Motion stay deferred to v0.6.
  DepthPassNode as unknown as NodeDefinition,
  NormalPassNode as unknown as NodeDefinition,
  PromptNode as unknown as NodeDefinition,
  ComfyUIWorkflowNode as unknown as NodeDefinition,
  VideoStitchNode as unknown as NodeDefinition,
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
