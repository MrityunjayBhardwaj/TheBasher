// Evaluated-output shapes for v0.5 nodes.
//
// These POJOs are what each node's evaluate() returns. The viewport
// (SceneFromDAG.tsx) walks them and emits R3F primitives. Keeping the values
// plain JS objects (not THREE instances) preserves determinism — the same
// params always serialize to the same content hash.
//
// Discipline: this file declares NO behavior. It is contract-only.
//
// P1 widens three unions (Camera / Light / SceneChild) so the existing socket
// types (`Camera` / `Light` / `Mesh`) carry richer variants without the DAG
// type system needing to grow.

export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Cameras (socket type: 'Camera')
// ---------------------------------------------------------------------------

export interface PerspectiveCameraValue {
  readonly kind: 'PerspectiveCamera';
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
}

export interface OrthographicCameraValue {
  readonly kind: 'OrthographicCamera';
  readonly zoom: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
}

export type CameraValue = PerspectiveCameraValue | OrthographicCameraValue;

// ---------------------------------------------------------------------------
// Lights (socket type: 'Light')
// ---------------------------------------------------------------------------

export interface DirectionalLightValue {
  readonly kind: 'DirectionalLight';
  readonly intensity: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly color: string;
}

export interface PointLightValue {
  readonly kind: 'PointLight';
  readonly intensity: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly color: string;
  readonly distance: number;
  readonly decay: number;
}

export interface SpotLightValue {
  readonly kind: 'SpotLight';
  readonly intensity: number;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly color: string;
  readonly angle: number;
  readonly penumbra: number;
  readonly distance: number;
  readonly decay: number;
}

export interface AreaLightValue {
  readonly kind: 'AreaLight';
  readonly intensity: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly color: string;
  readonly width: number;
  readonly height: number;
  readonly lookAt: Vec3;
}

export interface AmbientLightValue {
  readonly kind: 'AmbientLight';
  readonly intensity: number;
  readonly color: string;
}

export type LightValue =
  | DirectionalLightValue
  | PointLightValue
  | SpotLightValue
  | AreaLightValue
  | AmbientLightValue;

// ---------------------------------------------------------------------------
// Materials (V9 — preset + scalar/texture only; no shader-as-code in v0.5)
// ---------------------------------------------------------------------------

export interface MaterialValue {
  readonly kind: 'Material';
  readonly name: string;
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
}

// Inline material spec carried by leaf meshes (BoxMesh ships this from P0).
export interface InlineMaterialSpec {
  readonly name: string;
  readonly color: string;
}

// ---------------------------------------------------------------------------
// Meshes (socket type: 'Mesh') — recursive union
// ---------------------------------------------------------------------------

export interface BoxMeshValue {
  readonly kind: 'BoxMesh';
  readonly size: Vec3;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly material: InlineMaterialSpec;
}

export interface SphereMeshValue {
  readonly kind: 'SphereMesh';
  readonly radius: number;
  readonly widthSegments: number;
  readonly heightSegments: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly material: InlineMaterialSpec;
}

export interface GltfAssetValue {
  readonly kind: 'GltfAsset';
  readonly assetRef: string;
}

export interface TransformValue {
  readonly kind: 'Transform';
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly child: SceneChild | null;
}

export interface GroupValue {
  readonly kind: 'Group';
  readonly children: readonly SceneChild[];
}

export interface MaterialOverrideValue {
  readonly kind: 'MaterialOverride';
  readonly child: SceneChild | null;
  readonly material: MaterialValue;
}

export interface ScatterInstance {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly assetIndex: number;
}

export interface ScatterValue {
  readonly kind: 'Scatter';
  readonly seed: number;
  readonly count: number;
  readonly instances: readonly ScatterInstance[];
  readonly assets: readonly SceneChild[];
}

// ---------------------------------------------------------------------------
// P2 — Time, Character, Skeleton, Animation, Navmesh, Locomotion
//
// Time enters as a typed socket value (THESIS.md §49). The TimeSource node
// is the only impure source; pure consumers receive `TimeValue` as an input
// and remain bit-exact reproducible given (params, inputs).
// ---------------------------------------------------------------------------

export interface TimeValue {
  readonly frame: number;
  readonly seconds: number;
  readonly normalized: number;
}

/** A single bone in a skeleton hierarchy. P2 keeps it data-only (V9). */
export interface BoneSpec {
  readonly name: string;
  /** Parent bone index, or -1 for root. */
  readonly parent: number;
  /** Bind-pose translation (relative to parent). */
  readonly position: Vec3;
  /** Bind-pose Euler rotation (relative to parent). */
  readonly rotation: Vec3;
}

export interface SkeletonValue {
  readonly kind: 'Skeleton';
  readonly bones: readonly BoneSpec[];
}

export interface BonePose {
  /** Index into the skeleton's `bones`. */
  readonly bone: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
}

export interface PosedSkeletonValue {
  readonly kind: 'PosedSkeleton';
  readonly skeleton: SkeletonValue;
  readonly poses: readonly BonePose[];
}

/** A single keyframe targeting a bone (by index) at a given clip-time. */
export interface AnimationKeyframe {
  readonly bone: number;
  readonly time: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
}

export interface AnimationClipValue {
  readonly kind: 'AnimationClip';
  readonly name: string;
  readonly duration: number;
  /** Sampled pose at the input `Time`, given the clip's keyframes. */
  readonly pose: PosedSkeletonValue;
}

export interface NavmeshValue {
  readonly kind: 'Navmesh';
  /** Half-extents of the ground-plane navmesh primitive (P2 hardcoded source). */
  readonly halfSize: readonly [number, number];
  /** Listed obstacles (axis-aligned boxes) on the navmesh, projected to the ground plane. */
  readonly obstacles: readonly {
    readonly center: readonly [number, number];
    readonly halfSize: readonly [number, number];
  }[];
}

export interface WalkPathValue {
  readonly kind: 'WalkPath';
  readonly samples: readonly Vec3[];
  /** Total path length (sum of segment lengths). */
  readonly length: number;
}

export interface LocomotionStateValue {
  readonly kind: 'LocomotionState';
  readonly position: Vec3;
  readonly heading: number;
  readonly pose: PosedSkeletonValue;
}

export interface CharacterValue {
  readonly kind: 'Character';
  readonly name: string;
  readonly position: Vec3;
  readonly heading: number;
  readonly pose: PosedSkeletonValue;
}

export type SceneChild =
  | BoxMeshValue
  | SphereMeshValue
  | GltfAssetValue
  | TransformValue
  | GroupValue
  | MaterialOverrideValue
  | ScatterValue
  | CharacterValue;

// ---------------------------------------------------------------------------
// Scene (socket type: 'Scene')
// ---------------------------------------------------------------------------

export interface SceneValue {
  readonly kind: 'Scene';
  readonly camera: CameraValue;
  readonly lights: readonly LightValue[];
  readonly children: readonly SceneChild[];
}

export interface PostFxConfig {
  readonly tonemap: 'ACES' | 'Linear';
  readonly smaa: boolean;
}

export interface RenderOutputValue {
  readonly kind: 'RenderOutput';
  readonly scene: SceneValue;
  readonly postFx: PostFxConfig;
}
