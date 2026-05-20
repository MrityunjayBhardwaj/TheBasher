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
  /**
   * P7.5 — glTF TRS animation extraction (issue #81).
   *
   * Filled in by `buildGltfImportOps` at drop time: a sanitised
   * scene-node-name → DAG target id map. `GltfAssetR` walks
   * `gltf.scene` via `getObjectByName` and overrides per-child TRS
   * with `transformClip.tracks[name]`. Default `{}` so pre-7.5
   * projects (and the static-only fixture path) hydrate as no-ops.
   */
  readonly nodeNameMap: Readonly<Record<string, string>>;
  /**
   * The selected clip's evaluated TRS at the input Time, sourced from
   * the connected `ClipSelect.out`. `null` when no animation is
   * imported (degenerate path) OR when `selectedClipName` doesn't
   * match any imported clip. The renderer treats null as "no
   * override" — falls back to the cloned scene's static TRS.
   */
  readonly transformClip: TransformClipValue | null;
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

/**
 * P7.5 — glTF TRS animation clip extraction (issue #81).
 *
 * Scene-node-indexed counterpart to {@link AnimationClipValue} (which is
 * bone-indexed and pairs with a Skeleton). A TransformClipValue is the
 * sampled, per-target TRS that the renderer applies to children of a
 * `gltf.scene` walk: `tracks[targetNodeId]` is the evaluated
 * `{position, rotation, scale}` at the input Time. Targets without a
 * keyframe at this sample-time are simply absent from the map — the
 * renderer falls back to the original `gltf.scene` child's TRS for
 * those.
 *
 * **Rotation unit:** degrees Euler XYZ (matches Transform.rotation
 * throughout the codebase; SceneFromDAG.tsx:266,426,449,525). The
 * importer converts glTF quaternions → radians via
 * `quaternionToEulerVec3` → degrees before they land here.
 */
export interface TransformClipValue {
  readonly kind: 'TransformClip';
  readonly name: string;
  readonly duration: number;
  readonly tracks: Readonly<
    Record<
      string,
      {
        readonly position: Vec3;
        readonly rotation: Vec3;
        readonly scale: Vec3;
      }
    >
  >;
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
// P3.1 — Animation import + retargeting (THESIS §42.1)
// ---------------------------------------------------------------------------

/** Source-bone-name → target-bone-name lookup, plus optional human label. */
export interface BoneNameMapValue {
  readonly kind: 'BoneNameMap';
  readonly name: string;
  /** Bone-name pairs as a record. */
  readonly map: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// P4 — Render graph = render nodes (THESIS §43)
//
// `Image` is a lazy value: pre-render it carries only a content-hash + the
// pixel-buffer descriptor (width / height / format). The actual pixels are
// produced at RenderJob execution time (Wave B). Keeping the pure-graph
// value as POJO metadata preserves V2/V3 — pass evaluators stay
// `pure: true` and the agent can deductively reason about whether a pass
// result is reusable from the descriptor + sourceHash alone.
//
// `passKind` discriminates which renderer-side dispatch the pass routes
// through at execution time. Wave A ships beauty + id; the field is open
// so P5+ on-demand passes (depth / normal / albedo / ao / motion) slot in
// without widening the socket type.
// ---------------------------------------------------------------------------

export type ImageFormat = 'rgba8' | 'r8' | 'r16f' | 'rgba16f';
export type ImagePassKind = 'beauty' | 'id' | 'depth' | 'normal' | 'stylized';

export interface ImageDescriptor {
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
}

export interface ImageValue {
  readonly kind: 'Image';
  /** Which pass produced this image — drives execution-side dispatch. */
  readonly passKind: ImagePassKind;
  readonly descriptor: ImageDescriptor;
  /**
   * Stable content hash over (passKind, params, scene, camera, time). Equal
   * sourceHash means the pass would render identical pixels — the agent
   * can describe a pass result by this handle (frame N, kind K, hash H).
   */
  readonly sourceHash: string;
}

/** Default Image descriptor for fresh pass nodes. 1280x720 rgba8 (P4 §43). */
export const DEFAULT_IMAGE_DESCRIPTOR: ImageDescriptor = {
  width: 1280,
  height: 720,
  format: 'rgba8',
};

// ---------------------------------------------------------------------------
// P5 — AI Render Bridge (THESIS §28, §44)
//
// `Prompt` is a pure data node — same shape as BoneNameMap (no inputs,
// params verbatim out). Carries the user's stylization intent for the
// ComfyUIWorkflow node to consume. `negative` and `tags` ship now to keep
// the schema additions ahead of the H14 trap (every later schema add is a
// load-time crash candidate without `?? default` consumers).
// ---------------------------------------------------------------------------

export interface PromptValue {
  readonly kind: 'Prompt';
  readonly text: string;
  readonly negative: string;
  readonly tags: readonly string[];
}

// ---------------------------------------------------------------------------
// VideoValue — VideoStitch's output (metadata only, mirrors JobResult).
//
// Pixel encoding happens at runVideoStitch execution time (Wave D2). The
// evaluator returns a deductive contract: codec, fps, frame count, output
// path, content hash. The agent describes a video by sourceHash without
// loading bytes.
// ---------------------------------------------------------------------------

export type VideoCodec = 'h264';

export interface VideoValue {
  readonly kind: 'Video';
  readonly codec: VideoCodec;
  readonly fps: number;
  readonly frameCount: number;
  /** OPFS path the encoded video is (or will be) at. */
  readonly outputPath: string;
  /** Content hash over (codec, fps, outputPath, upstream stylized hashes). */
  readonly sourceHash: string;
}

// ---------------------------------------------------------------------------
// JobResult — RenderJob's output (a metadata record describing the dispatch)
//
// JobResult is what the RenderJob evaluator returns. It does NOT contain the
// pixel data — pixels go to disk via StorageCapability at execution time
// (runRenderJob, src/render/). The value is a deductive contract: which
// frames will be (or were) rendered, which passes were dispatched, where
// the bytes land. The agent can describe a render plan from this alone
// without needing to actually run it.
// ---------------------------------------------------------------------------

export interface FrameRange {
  readonly start: number;
  readonly end: number;
  readonly fps: number;
}

export interface JobResultValue {
  readonly kind: 'JobResult';
  readonly jobId: string;
  readonly frames: FrameRange;
  readonly passKinds: readonly ImagePassKind[];
  /**
   * Output path prefix in StorageCapability — frames write to
   * `${outputPath}/${passKind}_${frame.toString().padStart(4,'0')}.png`.
   */
  readonly outputPath: string;
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
