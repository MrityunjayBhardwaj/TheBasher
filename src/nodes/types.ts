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

import type { OverriddenSet } from '../core/override/overrideSet';

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

/** The per-field keys a MaterialOverride can explicitly author (#124, V28). */
export type MaterialOverrideField =
  | 'color'
  | 'roughness'
  | 'metalness'
  | 'opacity'
  | 'emissive'
  | 'emissiveIntensity';

export interface MaterialValue {
  readonly kind: 'Material';
  readonly name: string;
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  /**
   * Sparse per-field "authored" set (#124, V28) — which channels the director
   * EXPLICITLY set, carried as an explicit bit (never derived from value≠default;
   * the R-4 single-tier trap). Absent / `{}` ⇒ legacy #99 map-aware behaviour
   * (D-03, backward-compat). Only roughness/metalness consult it (an authored bit
   * forces the scalar even over a source map); the always-applied tint fields
   * (color/emissive/opacity) ignore it because their default is map-identity.
   */
  readonly overridden?: OverriddenSet<MaterialOverrideField>;
  /**
   * #131 (D-05) — the honest wholesale-replace / clay path. When `true` the
   * renderer IGNORES the source material entirely and builds a fresh material
   * from all 7 scalars (the source's maps + subclass are dropped BY INTENT —
   * the intentional version of the old #99 wholesale-replace bug). Coarse and
   * SEPARATE from the per-field `overridden` set: in flatten mode the per-field
   * authored bits are irrelevant (every scalar applies unconditionally).
   * Absent / `false` ⇒ the clone + map-aware merge path (#99 + #124).
   */
  readonly ignoreSourceMaterial?: boolean;
}

// Inline material spec carried by leaf meshes (BoxMesh ships this from P0).
export interface InlineMaterialSpec {
  readonly name: string;
  readonly color: string;
}

// ---------------------------------------------------------------------------
// Baked material (Phase 151 Apply-Transform, D-02 REVISED = lossless) — the ONE
// rich material face a BakedMesh carries (issue #151).
// ---------------------------------------------------------------------------
//
// A persisted texture handle — OPFS content-hashed image bytes + the three.js
// colorspace/wrap/flip state needed to rebuild the Texture identically. Map refs
// are populated in Wave 3 (glTF material capture); a primitive bake leaves all
// map slots null. (RESEARCH §M3.)
export interface BakedTextureRef {
  /** OPFS key: baked-texture/<hash>.<ext>. */
  readonly hash: string;
  /** map/emissiveMap = 'srgb'; normal/ao/roughness/metalness = 'srgb-linear'. */
  readonly colorSpace: 'srgb' | 'srgb-linear' | 'no-colorspace';
  /** glTF textures are flipY=false; preserve verbatim. */
  readonly flipY: boolean;
  readonly wrapS: number;
  readonly wrapT: number;
}

/**
 * The rich PBR material a BakedMesh carries — ONE shape for every source
 * (box, sphere, AND glTF). Scalar names mirror {@link MaterialValue} 1:1
 * (Chesterton — the renderer/override/inspector already speak those names).
 * A primitive bake populates the scalars and leaves all 6 map refs null (M6);
 * a glTF bake captures the resolved post-override material incl. textures
 * (Wave 3/4). `materialClass` selects which three.js ctor BakedMeshR rebuilds.
 */
export interface BakedMaterialSpec {
  readonly materialClass: 'standard' | 'physical' | 'basic';
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly opacity: number;
  readonly transparent: boolean;
  readonly emissive: string;
  readonly emissiveIntensity: number;
  // map refs — null when the source has none (a Box bake leaves all null).
  readonly map: BakedTextureRef | null;
  readonly normalMap: BakedTextureRef | null;
  readonly roughnessMap: BakedTextureRef | null;
  readonly metalnessMap: BakedTextureRef | null;
  readonly aoMap: BakedTextureRef | null;
  readonly emissiveMap: BakedTextureRef | null;
  // physical-only extras (captured only when materialClass==='physical', Wave 3).
  readonly physical?: {
    readonly clearcoat?: number;
    readonly clearcoatRoughness?: number;
    readonly transmission?: number;
    readonly ior?: number;
    readonly sheen?: number;
    readonly specularIntensity?: number;
  };
}

// ---------------------------------------------------------------------------
// EvaluatedMesh — the ONE uniform projected/consumed face (v0.6 #1, issue #150)
// ---------------------------------------------------------------------------
//
// Every mesh-producing kind (BoxMesh / SphereMesh / GltfChild) projects to ONE
// `EvaluatedMesh` via the pure `resolveEvaluatedMesh(node, ctx)` resolver
// (src/app/resolveEvaluatedMesh.ts) — the single consumed face the renderer,
// gizmo, and inspector all read (generalizes the proven `resolveEvaluatedTransform`
// one-producer-many-consumers pattern from transform to the whole mesh).
//
// D-03: `evaluate()` signatures are UNCHANGED; the resolver is a projection
// layer over the existing *Value kinds — box/sphere are consumed as plain
// meshes with ZERO special privileges (a re-parametrizable Box is a CAPABILITY,
// not a privilege; no consumer branches on its kind).
//
// Interface depth (Ousterhout): `geometry` is a `GeometryRef` HANDLE into the
// geometry registry (src/app/geometryRegistry.ts), NEVER inlined BufferGeometry
// — heavy buffers stay out of Ops / undo / hashing.

/** Full TRS transform band (D-01) — separate from the geometry capability. */
export interface MeshTransform {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/**
 * A deterministic handle into the geometry registry (§48). The `key` is built
 * by the resolver from producer identity + params (deterministic string), so
 * identical params yield an identical key (cache hit, no false sharing). The
 * `descriptor` is the minimal data the registry needs to (re)build/lookup the
 * BufferGeometry — NEVER the buffers themselves.
 */
export type GeometryDescriptor =
  | { readonly kind: 'box'; readonly size: Vec3 }
  | {
      readonly kind: 'sphere';
      readonly radius: number;
      readonly widthSegments: number;
      readonly heightSegments: number;
    }
  | { readonly kind: 'gltf'; readonly assetRef: string; readonly childName: string }
  | { readonly kind: 'baked'; readonly hash: string; readonly vertexCount: number };

export interface GeometryRef {
  readonly key: string;
  readonly kind: 'box' | 'sphere' | 'gltf' | 'baked';
  readonly descriptor: GeometryDescriptor;
}

/**
 * The uniform consumed mesh face. `uvs` is null now (populated by #3). `material`
 * is the ONE material face every consumer reads (M6, Phase 151): an
 * `InlineMaterialSpec` for un-baked box/sphere, a rich `BakedMaterialSpec` for a
 * BakedMesh, or null (gltf — #2 fills it). Widening to the union means there is
 * exactly ONE material shape consumers branch on, never a second render path.
 */
export interface EvaluatedMesh {
  readonly geometry: GeometryRef;
  readonly uvs: null;
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
  readonly transform: MeshTransform;
}

// ---------------------------------------------------------------------------
// Meshes (socket type: 'Mesh') — recursive union
// ---------------------------------------------------------------------------

export interface BoxMeshValue {
  readonly kind: 'BoxMesh';
  readonly size: Vec3;
  readonly position: Vec3;
  readonly rotation: Vec3;
  /** v0.6 #1 (D-01) — the non-destructive TRS scale band, distinct from `size`. */
  readonly scale: Vec3;
  readonly material: InlineMaterialSpec;
}

export interface SphereMeshValue {
  readonly kind: 'SphereMesh';
  readonly radius: number;
  readonly widthSegments: number;
  readonly heightSegments: number;
  readonly position: Vec3;
  readonly rotation: Vec3;
  /** v0.6 #1 (D-01) — the non-destructive TRS scale band, distinct from `radius`. */
  readonly scale: Vec3;
  readonly material: InlineMaterialSpec;
}

/**
 * BakedMesh (Phase 151 Apply-Transform, issue #151) — the product of Apply.
 *
 * A standalone scene mesh whose TRS has been composed into its geometry: the
 * `geometry` is a `GeometryRef{kind:'baked'}` handle into OPFS-persisted bytes
 * (authoritative, NOT rebuildable from params — bakedGeometryStore.ts), the
 * transform is IDENTITY (the TRS is baked INTO the verts, so the renderer must
 * render at identity scale — H40 band-drift guard), and `material` is the ONE
 * rich {@link BakedMaterialSpec} (scalars + nullable maps).
 *
 * The 4th `EvaluatedMesh` producer (V29): no consumer branches on this kind;
 * `resolveEvaluatedMesh` projects it to the same uniform face as box/sphere/gltf.
 */
export interface BakedMeshValue {
  readonly kind: 'BakedMesh';
  readonly geometry: GeometryRef;
  readonly position: Vec3;
  readonly rotation: Vec3;
  /** Identity post-Apply (the TRS is baked into the geometry verts). */
  readonly scale: Vec3;
  readonly material: BakedMaterialSpec;
}

/**
 * P7.11 — captured per-skin bind metadata on a `GltfAsset` (issue #100, D-04).
 *
 * Every per-joint array is parallel and indexed in `skin.joints[]` order (the
 * projection spine): `jointKeys[i]`, `bindTRS[i]`, `parentJointIndex[i]`, and
 * `inverseBindMatrices[i]` all describe the joint at joint-list position `i`.
 * This single ordering makes the pure `GltfSkeleton` projection trivial and the
 * H40 render boundary-pair (projected bone i == rendered skeleton bone i) a
 * plain index-by-index check. `inverseBindMatrices` is `[]` when the skin
 * declares none (the loader treats absent as identity).
 */
export interface GltfSkinMetadata {
  readonly jointKeys: readonly string[];
  readonly bindTRS: readonly {
    readonly position: Vec3;
    readonly rotation: Vec3;
    readonly scale: Vec3;
  }[];
  /** Per-joint nearest joint-ancestor index WITHIN jointKeys, -1 for root. */
  readonly parentJointIndex: readonly number[];
  /** Per-joint number[16] column-major model-space inverse-bind matrix. */
  readonly inverseBindMatrices: readonly (readonly number[])[];
  readonly skeletonRootKey?: string;
  readonly name?: string;
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
   * with `transformClip.sample(currentTime)[name]` (P7.10 — the value's
   * sample method replaces the pre-baked `.tracks` shape). Default `{}`
   * so pre-7.5 projects (and the static-only fixture path) hydrate as no-ops.
   */
  readonly nodeNameMap: Readonly<Record<string, string>>;
  /**
   * P7.7 — glTF child DAG addressing (issue #91). Parent-key → child-keys,
   * derived from the glTF `node.children` index arrays at drop time. The
   * outliner (Wave D) reads this to nest child rows — pure PROJECTION, not
   * render `inputs` (R-2 / B12 guard). Default `{}` so pre-7.7 values are
   * no-ops (V10 / H14-clean).
   */
  readonly childHierarchy: Readonly<Record<string, readonly string[]>>;
  /**
   * P7.11 — captured per-skin bind metadata (issue #100, D-04). One entry per
   * glTF skin; the pure `GltfSkeleton` node projects a chosen skin into a
   * `Skeleton` value. Default `[]` so pre-7.11 values are no-ops (V10/H14-clean).
   */
  readonly skins: readonly GltfSkinMetadata[];
  /**
   * The selected clip's evaluated TRS at the input Time, sourced from
   * the connected `ClipSelect.out`. `null` when no animation is
   * imported (degenerate path) OR when `selectedClipName` doesn't
   * match any imported clip. The renderer treats null as "no
   * override" — falls back to the cloned scene's static TRS.
   */
  readonly transformClip: TransformClipValue | null;
}

/**
 * P7.7 — an addressable proxy for ONE glTF scene child (issue #91).
 *
 * Emitted as a real DAG node per scene child at import (gltfImportChain A2),
 * it owns ONLY the child's local TRS override; three.js owns the geometry +
 * skeleton (#88 / H45 / B12). The renderer applies this TRS back onto the
 * named three.js object by name lookup — it is NEVER walked as a scene object.
 *
 * NOT a member of the `SceneChild` union, deliberately: it is not a scene
 * producer (R-1), so it must not be rendered as a scene object (the #88
 * double-render guard). The resolver (Wave C) reads it by id from the DAG;
 * the renderer (Wave B) reads it by assetRef filter.
 *
 * `overridden` is the explicit dirty signal (R-4): the layering primitive
 * branches on these flags, never on value-equality against the base TRS.
 * Rotation is degrees Euler XYZ (the codebase convention).
 */
export interface GltfChildValue {
  readonly kind: 'GltfChild';
  readonly childName: string;
  readonly assetRef: string;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly overridden: {
    readonly position: boolean;
    readonly rotation: boolean;
    readonly scale: boolean;
  };
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
  /**
   * P7.11 (D-03) — OPTIONAL bind-pose scale relative to parent. Absent →
   * treated as [1,1,1]. BVH/FBX `Skeleton` nodes omit it (back-compat); a
   * glTF rig with non-uniform bind scale populates it so the retarget bind
   * pose (specToThreeSkeleton) and the projection stay deform-faithful.
   */
  readonly scale?: Vec3;
  /**
   * P7.11 (D-04) — OPTIONAL number[16] column-major model/skin-space inverse
   * bind matrix, captured from a glTF skin. Absent → none (three.js
   * reconstructs inverses from the bind pose; retarget does not consume it).
   * Rides only on `GltfSkeleton`-produced bones, never round-tripped through
   * the retarget adapter.
   */
  readonly inverseBindMatrix?: readonly number[];
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
 * P7.10 — function-of-time value shape (B13 Pass 3, #114).
 *
 * Scene-node-indexed counterpart to {@link AnimationClipValue} (which is
 * bone-indexed and pairs with a Skeleton). A TransformClipValue is a
 * function-of-time: `sample(seconds)` returns the per-target TRS map at
 * that clip-time. Targets without a keyframe at this sample-time are
 * simply absent from the map — the renderer falls back to the original
 * `gltf.scene` child's TRS for those.
 *
 * **Why function-of-time, not pre-sampled (P7.10):** Pre-P7.10, this
 * value carried a pre-computed `tracks` map sampled at `ctx.time` inside
 * the evaluator. That meant TransformClip's cache key changed every
 * frame (its TimeSource-input hash flipped), forcing the WHOLE React
 * tree downstream of SceneFromDAG to re-walk per playback frame —
 * measured as B13 / H48 (issue #114). Lifting time INTO the value (as a
 * method parameter) makes TransformClip's evaluate genuinely pure with
 * NO Time input, so its cache hits across frames; downstream consumers
 * call `.sample(currentTime)` themselves at their own cadence
 * (renderers via R3F's useFrame; the gizmo/NPanel/resolveEvaluatedTransform
 * static-read path at their resolution time).
 *
 * V3 (amended P7.10): Time may enter an animation evaluator via typed
 * Time input socket OR via typed function parameter. Both forms are
 * structured/typed; closure-over-global remains forbidden. The
 * `sample(seconds: number)` signature IS the typed contract.
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
  /**
   * Sample the clip at clip-time `seconds`. Applies the loop/clamp
   * folding declared at evaluate time; returns the per-target TRS map.
   * Pure function of `seconds` given the captured keyframes — calling
   * twice at the same seconds returns equal TRS values.
   *
   * Caller owns invocation cadence: the renderer calls this from
   * `useFrame` (R3F frameloop, ~60 Hz); the gizmo/NPanel static-read
   * path calls this once at the current time when it needs to resolve.
   */
  readonly sample: (seconds: number) => Readonly<
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
  | BakedMeshValue
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

// P7.12 D-04 (function-of-time, V24/V3-amended) — mirrors the P7.10
// TransformClipValue migration one node-family over. Pre-7.12 each channel
// value carried a single pre-sampled scalar `value: T` (the channel's `time`
// input socket sampled upstream). That made the channel's cache key flip every
// playback frame (its inputs hash included TimeSource's per-frame-flipping
// hash) and forced the React tree downstream to re-walk per frame (H48/H49 at
// the type level). Lifting time INTO the value via a `sample(seconds)` closure
// makes the channel's evaluate truly pure (no `time` input), so its cache hits
// across frames; consumers (AnimationLayer-render useFrame, the Wave-C resolver
// band) call `.sample()` at their own cadence. Dropping `value` entirely (NOT
// keeping it alongside) is required — a residual pre-sampled field IS H49.
// REF: vyapti V24/V3 (amended P7.10); hetvabhasa H48/H49; PLAN 7.12 D-04.
export interface KeyframeChannelNumberValue extends KeyframeChannelValueBase {
  readonly valueType: 'number';
  sample(seconds: number): number;
}

export interface KeyframeChannelVec3Value extends KeyframeChannelValueBase {
  readonly valueType: 'vec3';
  sample(seconds: number): Vec3;
}

export interface KeyframeChannelQuatValue extends KeyframeChannelValueBase {
  readonly valueType: 'quat';
  sample(seconds: number): Quat;
}

export interface KeyframeChannelColorValue extends KeyframeChannelValueBase {
  readonly valueType: 'color';
  sample(seconds: number): string;
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
  /**
   * Wrapped target — null when unwired. Layer is transparent in scene.
   *
   * P7.12 D-04 (shape B-lite): post-migration this is the UN-PATCHED base
   * target. The channels are now function-of-time (no pre-sampled `.value`),
   * so the layer cannot patch a fixed clone at evaluate time. The renderer
   * (`AnimationLayerR`) samples `sampleTarget(seconds)` in a useFrame and
   * renders the patched clone declaratively. The read-side
   * (`resolveEvaluatedTransform`) reads `sampleTarget(ctx.time.seconds)` so
   * gizmo/NPanel match the render (H40).
   */
  readonly target: SceneChild | null;
  /**
   * Sample the channels onto a deep clone of `target` at `seconds`, blended by
   * weight (P7.12 D-04 — function-of-time, V24/H40). Returns the un-patched
   * base when no active channels / no target. The single per-frame consumer
   * (AnimationLayerR useFrame) and the read-side resolver both call this; the
   * channels stay pure function-of-time (the V24/H49 win), only the authored
   * node re-renders per frame (B-lite — accepted, pre-7.10 behavior, this is
   * ONE standalone scene node not 64 bones).
   */
  sampleTarget(seconds: number): SceneChild | null;
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
