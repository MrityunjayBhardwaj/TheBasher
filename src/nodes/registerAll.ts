// Register all v0.5 node types. Called once during boot (K1 step 2).
// Idempotent: skips re-registration if already present so HMR works.

import { getNodeType, registerNodeType } from '../core/dag/registry';
import type { NodeDefinition } from '../core/dag/types';
import { ActionNode } from './Action';
import { AmbientLightNode } from './AmbientLight';
import { AnimationClipNode } from './AnimationClip';
import { ArrayModifierNode } from './ArrayModifier';
// P7.5 — glTF TRS animation extraction (issue #81). Imports stay
// alphabetised so a re-sort doesn't produce noise.
// (TransformClipNode is imported later in the alphabetical block.)
import { AreaLightNode } from './AreaLight';
import { BakedMeshNode } from './BakedMesh';
import { BeautyPassNode } from './BeautyPass';
import { BoneNameMapNode } from './BoneNameMap';
import { BoxMeshNode } from './BoxMesh';
import { BoxDataNode } from './BoxData';
import { SphereDataNode } from './SphereData';
import { ObjectNode } from './ObjectNode';
import { CameraSelectNode } from './CameraSelect';
import { CharacterNode } from './Character';
import { ClipSelectNode } from './ClipSelect';
import { ComfyUIWorkflowNode } from './ComfyUIWorkflow';
import { ColorCorrectNode } from './ColorCorrect';
import { CompositionNode } from './Composition';
import { COMPUTE_NODES } from './computeNodes';
import { LagNode } from './Lag';
import {
  SolverNode,
  PrevFrameNode,
  SolverInputNode,
  PrevFrameVecNode,
  SolverInputVecNode,
} from './Solver';
import { SampleGeometryNode } from './geometryQuery';
import { CutNode } from './Cut';
import { LayerNode } from './Layer';
import { MediaClipNode } from './MediaClip';
import { DepthPassNode } from './DepthPass';
import { DirectionalLightNode } from './DirectionalLight';
import { GltfAssetNode } from './GltfAsset';
import { GltfChildNode } from './GltfChild';
import { GroupNode } from './Group';
import { IDPassNode } from './IDPass';
import { KeyframeChannelColorNode } from './KeyframeChannelColor';
import { KeyframeChannelImageNode } from './KeyframeChannelImage';
import { KeyframeChannelNumberNode } from './KeyframeChannelNumber';
import { KeyframeChannelQuatNode } from './KeyframeChannelQuat';
import { KeyframeChannelTextNode } from './KeyframeChannelText';
import { KeyframeChannelVec2Node } from './KeyframeChannelVec2';
import { KeyframeChannelVec3Node } from './KeyframeChannelVec3';
import { LightProfileSelectNode } from './LightProfileSelect';
import { LightRigNode } from './LightRig';
import { LocomotionStateNode } from './LocomotionState';
import { MaterialOverrideNode } from './MaterialOverride';
import { MirrorModifierNode } from './MirrorModifier';
import { NavmeshNode } from './Navmesh';
import { NormalPassNode } from './NormalPass';
import { OrthographicCameraNode } from './OrthographicCamera';
import { ParamDriverNode } from './ParamDriver';
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
import { StripNode } from './Strip';
import { TimeSourceNode } from './TimeSource';
import { TrackNode } from './Track';
import { TrackToNode } from './TrackTo';
import { FollowPathNode } from './FollowPath';
import { TransformClipNode } from './TransformClip';
import { TransformNode } from './Transform';
import { NullNode } from './Null';
import { CurveNode } from './Curve';
import { CurveDataNode } from './CurveData';
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
  // #361 — object↔data split (Phase 1): the Object half (owns TRS, points at
  // data) + the BoxData half (geometry + material, no transform). Coexist with
  // the fused nodes; nothing migrates yet.
  ObjectNode as unknown as NodeDefinition,
  BoxDataNode as unknown as NodeDefinition,
  // #384 (Stage C · C1) — the sphere's data half. Coexists with the fused
  // SphereMesh below; the split retires the fused value kind in a later slice.
  SphereDataNode as unknown as NodeDefinition,
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
  // #296 — a Null controller: a transformable, geometry-less scene object (Empty).
  NullNode as unknown as NodeDefinition,
  // #321 — a Curve: a transformable PATH scene object (control points + Catmull-Rom).
  CurveNode as unknown as NodeDefinition,
  // #385 (Stage C · C2) — the curve's data half (points/closed/resolution, no
  // transform). The FIRST non-mesh ObjectData. Coexists with the fused Curve
  // above; the split retires the fused CurveValue kind in a later slice.
  CurveDataNode as unknown as NodeDefinition,
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
  KeyframeChannelVec2Node as unknown as NodeDefinition,
  KeyframeChannelVec3Node as unknown as NodeDefinition,
  KeyframeChannelQuatNode as unknown as NodeDefinition,
  KeyframeChannelColorNode as unknown as NodeDefinition,
  KeyframeChannelTextNode as unknown as NodeDefinition,
  KeyframeChannelImageNode as unknown as NodeDefinition,
  // NLA / Action Strips — motion-space layering (epic #283 Phase 2, V88 D2).
  // Three EDGE-LESS sidecar kinds enumerated + folded by the resolver scan (the
  // channel/constraint pattern below), never wired by edge. Registered so their
  // addNode validates (V1). Inert in Slice A (render nothing); wired in Slices C–E.
  ActionNode as unknown as NodeDefinition,
  StripNode as unknown as NodeDefinition,
  TrackNode as unknown as NodeDefinition,
  // Operator substrate — CHOP/constraints (epic #201, V58). Edge-less, enumerated
  // + scene-layer resolved like the channels above (the resolveActiveCameraPoseAt
  // pattern), since a relationship aim needs world context (resolveWorldTransform).
  TrackToNode as unknown as NodeDefinition,
  // #339 — the POSITION-band constraint. Same edge-less species as TrackTo (it reads a
  // Curve's WORLD geometry, so it resolves in the seam, not in evaluate); it joins the
  // SAME stack as a member rather than bringing its own resolver + panel.
  FollowPathNode as unknown as NodeDefinition,
  // Operator substrate — SOP/modifiers (epic #201, #209, V58). A geometry operator
  // is a Mesh→Mesh wrapper sub-chain node (edge-WIRED, unlike the edge-less
  // constraint above) that rewrites its source geometry into a rebuildable handle.
  ArrayModifierNode as unknown as NodeDefinition,
  MirrorModifierNode as unknown as NodeDefinition,
  // Studio lighting — a switchable lighting PROFILE (epic #201, slice #208). A
  // LightRig groups its lights + owns the shared aim centre/radius; a
  // LightProfileSelect (the ClipSelect pattern) picks one to feed the scene.
  LightRigNode as unknown as NodeDefinition,
  LightProfileSelectNode as unknown as NodeDefinition,
  // P7.5 — glTF TRS animation extraction (issue #81); pure node-indexed
  // sampler + multi-clip selector. See TransformClip.ts / ClipSelect.ts.
  TransformClipNode as unknown as NodeDefinition,
  ClipSelectNode as unknown as NodeDefinition,
  // #231 Inc 3 — multi-camera "active" model. CameraSelect (the ClipSelect
  // pattern) picks the active camera by index to feed Scene.camera; `active` is
  // keyframeable → camera cuts. selectActiveCameraNode resolves through it.
  CameraSelectNode as unknown as NodeDefinition,
  ShotNode as unknown as NodeDefinition,
  CutNode as unknown as NodeDefinition,
  // The Compositor — AE-style layer timeline (docs/COMPOSITOR-DESIGN.md).
  CompositionNode as unknown as NodeDefinition,
  LayerNode as unknown as NodeDefinition,
  // First video EFFECT — the V58 lift to the Image socket (Image→Image operator).
  ColorCorrectNode as unknown as NodeDefinition,
  MediaClipNode as unknown as NodeDefinition,
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
  // Compute-node vocabulary — stateless scalar operators for procedural relations
  // (epic #290, Inc 1 #292). Math (op-enum) + Fit/Clamp/CurveRemap/Mix/Noise, all
  // over the ONE shared value-math core (valueMath.ts). A driver (Inc 2) wires one
  // onto a target param via the pull rail.
  ...COMPUTE_NODES,
  // Stateful op — Lag (epic #290 Epic 2, #297). Unlike the stateless compute nodes,
  // its output at frame N depends on its output at N−1 (a first-order recurrence).
  // Declares `stateful: true`; the real value is produced by the replay seam
  // (src/app/statefulOps.ts), not its passthrough evaluate.
  LagNode as unknown as NodeDefinition,
  // Solver meta-op — the 3rd OpNet instance (epic #290 Epic 2). A node owning a
  // user-authored sub-network cooked every frame with a Prev_Frame feedback + seed
  // (Houdini Solver SOP). Generalizes Lag's fixed recurrence to any per-frame rule;
  // PrevFrame/SolverInput are the sub-network's feedback + live-input leaves, injected
  // by the replay seam (statefulOps.ts). Stateful like Lag → replayed, not evaluated.
  SolverNode as unknown as NodeDefinition,
  PrevFrameNode as unknown as NodeDefinition,
  SolverInputNode as unknown as NodeDefinition,
  PrevFrameVecNode as unknown as NodeDefinition,
  SolverInputVecNode as unknown as NodeDefinition,
  // Geometry query — SampleGeometry (epic #290 vec-rail follow-up). The compute rail's
  // GEOMETRY reader: drops a vertical ray onto a terrain mesh and outputs the ground
  // point under a query controller's world XZ. Seam-resolved (needs world triangles →
  // state), so its passthrough evaluate returns the origin (src/app/geometrySampleSource.ts).
  SampleGeometryNode as unknown as NodeDefinition,
  // Driver binding — the PULL half of the overlay rail (epic #290, Inc 2 #293, G1).
  // Edge-less to its target ({target, paramPath}, enumerated + folded by the target's
  // followers like a KeyframeChannel), edge-WIRED to the compute graph via `in`. Its
  // evaluate returns a KeyframeChannelValue so it folds byte-identically to a channel.
  ParamDriverNode as unknown as NodeDefinition,
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
