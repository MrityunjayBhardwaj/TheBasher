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

/** Quaternion stored as xyzw (THREE convention). */
export type Quat = readonly [number, number, number, number];

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
  | CharacterValue
  | AnimationLayerValue;

// ---------------------------------------------------------------------------
// P3 — Animation channels + layers + shots (THESIS §42)
//
// KeyframeChannel<T>: separate node types per T (Number / Vec3 / Quat / Color)
// for clean V2 pure-flag handling, but all output the same 'KeyframeChannel'
// socket type so AnimationLayer can accept any of them in a list socket. The
// `valueType` discriminator on the value lets consumers switch on the variant.
//
// AnimationLayer: aggregator. Filters channels by mute / solo / boneMask,
// scales by weight, and wraps a single `target` SceneChild whose params are
// patched by active channels at evaluator time.
//
// Shot / Cut: editorial layer. Shot ties a time range to a camera + scene.
// Cut sequences two shots with an optional transition.
// ---------------------------------------------------------------------------

export type Easing = 'linear' | 'cubic';

/** Bezier handle expressed as an offset from the keyframe (time, value). */
export interface BezierHandle<T> {
  readonly time: number;
  readonly value: T;
}

export interface KeyframeNumber {
  readonly time: number;
  readonly value: number;
  readonly easing: Easing;
  readonly inHandle?: BezierHandle<number>;
  readonly outHandle?: BezierHandle<number>;
}

export interface KeyframeVec3 {
  readonly time: number;
  readonly value: Vec3;
  readonly easing: Easing;
  readonly inHandle?: BezierHandle<Vec3>;
  readonly outHandle?: BezierHandle<Vec3>;
}

export interface KeyframeQuat {
  readonly time: number;
  readonly value: Quat;
  readonly easing: Easing;
  // Quaternion handles are deferred — slerp interpolation only in v0.5.
}

export interface KeyframeColor {
  readonly time: number;
  /** Hex color string, e.g. '#ff8800'. HSL-lerp interpolation. */
  readonly value: string;
  readonly easing: Easing;
}

export type KeyframeValueType = 'number' | 'vec3' | 'quat' | 'color';

interface KeyframeChannelValueBase {
  readonly kind: 'KeyframeChannel';
  /** Display name for the dopesheet row. */
  readonly name: string;
  /** Target node id whose params this channel writes through. */
  readonly target: string;
  /** Path within target.params — e.g. 'position', 'material.color'. */
  readonly paramPath: string;
}

export interface KeyframeChannelNumberValue extends KeyframeChannelValueBase {
  readonly valueType: 'number';
  readonly value: number;
}

export interface KeyframeChannelVec3Value extends KeyframeChannelValueBase {
  readonly valueType: 'vec3';
  readonly value: Vec3;
}

export interface KeyframeChannelQuatValue extends KeyframeChannelValueBase {
  readonly valueType: 'quat';
  readonly value: Quat;
}

export interface KeyframeChannelColorValue extends KeyframeChannelValueBase {
  readonly valueType: 'color';
  readonly value: string;
}

export type KeyframeChannelValue =
  | KeyframeChannelNumberValue
  | KeyframeChannelVec3Value
  | KeyframeChannelQuatValue
  | KeyframeChannelColorValue;

export interface AnimationLayerValue {
  readonly kind: 'AnimationLayer';
  readonly name: string;
  /** Channels passing the mute/solo gate (post-filter). */
  readonly active: readonly KeyframeChannelValue[];
  readonly weight: number;
  readonly boneMask: readonly string[];
  readonly mute: boolean;
  readonly solo: boolean;
  /** Wrapped target — null when unwired. Layer is transparent in scene. */
  readonly target: SceneChild | null;
}

export interface ShotValue {
  readonly kind: 'Shot';
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly camera: CameraValue | null;
  readonly scene: SceneValue | null;
}

export interface CutValue {
  readonly kind: 'Cut';
  readonly from: ShotValue | null;
  readonly to: ShotValue | null;
  /** Transition length in frames. 0 = hard cut. */
  readonly transitionFrame: number;
}

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
