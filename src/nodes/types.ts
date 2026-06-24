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
// Cameras (socket type: 'SceneObject')
// ---------------------------------------------------------------------------

export interface PerspectiveCameraValue {
  readonly kind: 'PerspectiveCamera';
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** Roll about the view axis, in DEGREES (#229). */
  readonly roll: number;
}

export interface OrthographicCameraValue {
  readonly kind: 'OrthographicCamera';
  readonly zoom: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** Roll about the view axis, in DEGREES (#229). */
  readonly roll: number;
}

export type CameraValue = PerspectiveCameraValue | OrthographicCameraValue;

// ---------------------------------------------------------------------------
// Lights (socket type: 'SceneObject')
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
  /** #205 — optional HDR/EXR emitter texture (env-hdri assetRef). When present,
   *  the renderer expands this into the §1.5 studio-light PAIR (a mean-radiance
   *  tinted RectAreaLight + an emissive textured card). Absent → plain light. */
  readonly tex?: string;
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

// Studio lighting — a LightRig (socket type 'LightRig'). Epic #201 / slice #208
// (§7.2/§7.5, V62). A rig = one switchable lighting PROFILE: it groups its lights
// and owns the shared aim CENTRE + radius the panel's pucks orbit (formalizing the
// implicit centre `resolveRigTarget` derived in #206/#207). The lights stay in
// edge order (the renderer recovers their node ids by index-correspondence via
// `resolveRigLightSources`, exactly as the Scene's direct `lights` do).
export interface LightRigValue {
  readonly kind: 'LightRig';
  readonly name: string;
  /** The rig sphere origin every light on the rig aims at (the BLS "handle"). */
  readonly center: Vec3;
  /** The rig sphere radius (default puck distance from the centre). */
  readonly radius: number;
  readonly lights: readonly LightValue[];
}

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
  /**
   * v0.6 #2 (#178, W6 — D-05/D-07) — per-submesh addressing for a MULTI-material
   * glTF target. The override carries an optional slot-index addressing dimension
   * (NOT a new code path — D-05 "submesh index is just an addressing dimension").
   *   - `undefined` (absent) ⇒ apply to EVERY material slot of the wrapped child —
   *     the #99/#124 whole-child behaviour, byte-identical (backward-compat MUST
   *     hold; the p7.13/p124 e2e prove it).
   *   - `i` (a number) ⇒ apply ONLY to the i-th material slot. A "slot" is the
   *     i-th `isMesh` in the cloned glTF's traverse order — the SAME order the
   *     `__basher_gltf_meshes` seam reports, so the e2e's side-A read aligns with
   *     the renderer's apply. Out-of-range `i` matches no slot ⇒ no-op (range-safe).
   * Primitives have exactly one slot, so the field is irrelevant for them.
   */
  readonly slotIndex?: number;
}

// ---------------------------------------------------------------------------
// Inline material spec (v0.6 #2, issue #178) — the OpenPBR-named material IR the
// primitive (Box/Sphere) OWNS and edits directly. Widened from the P0
// {name,color} to the OpenPBR Surface v1.1.1 core-10 vocabulary, lobe-grouped
// (base / specular / coat / transmission / emission / geometry). This struct IS
// the first node of the v0.7 material node graph (THESIS §59/§747) — nothing
// here gets rewritten, only wrapped. [[V32]] — the IR is renderer-agnostic;
// `openpbrToThree` (src/app/material/openpbrToThree.ts) compiles it to a three.js
// `MeshPhysicalMaterial` on the classic WebGLRenderer (D-01); WGSL/TSL is the
// v0.7 compile target, NOT a different IR.
//
// The grouped paramPath is the addressing dimension every surface speaks:
//   base.color · base.metalness · specular.roughness · specular.ior ·
//   coat.weight · coat.roughness · transmission.weight · emission.color ·
//   emission.luminance · geometry.opacity   (e.g. setParam 'material.base.color').
//
// LOSSY (documented at the compile site openpbrToThree.ts):
//   emission.luminance → emissiveIntensity — photometric cd/m² used 1:1 as the
//   unitless three multiplier; the v0.7 TSL backend re-derives true emission.
// The IR stays COMPLETE (every lobe stored, off at weight 0); the WebGL compiler
// emits only the supported subset and tags the rest (`unsupported`) for v0.7.
// ---------------------------------------------------------------------------

/** The 6 texture-map slots the inline material carries (W5 populates; null = none). */
export interface InlineMaterialMaps {
  readonly albedo: BakedTextureRef | null;
  readonly normal: BakedTextureRef | null;
  readonly roughness: BakedTextureRef | null;
  readonly metalness: BakedTextureRef | null;
  readonly emissive: BakedTextureRef | null;
  readonly ao: BakedTextureRef | null;
}

export interface InlineMaterialSpec {
  /** Legacy display label (kept from the P0 {name,color} shape). */
  readonly name: string;
  /** base_color (sRGB hex) + base_metalness [0..1]. */
  readonly base: { readonly color: string; readonly metalness: number };
  /** specular_roughness [0..1] + specular_ior [1.0..2.33]. */
  readonly specular: { readonly roughness: number; readonly ior: number };
  /** coat_weight [0..1] + coat_roughness [0..1]. */
  readonly coat: { readonly weight: number; readonly roughness: number };
  /** transmission_weight [0..1] — auto-sets three `transparent` + `thickness`. */
  readonly transmission: { readonly weight: number };
  /** emission_color (sRGB hex) + emission_luminance (cd/m², 1:1 → emissiveIntensity). */
  readonly emission: { readonly color: string; readonly luminance: number };
  /**
   * geometry_opacity [0..1] — auto-sets three `transparent` when <1.
   * `alphaCutoff` (glTF direct-import, texture-maps milestone) — the alphaTest
   * threshold captured from a glTF `alphaMode:'MASK'` material (default 0.5);
   * absent = not a cutout material (alphaTest 0). `vertexColors` — captured from
   * a primitive's `COLOR_0` attribute so a vertex-coloured mesh is REPRESENTED in
   * the IR (the clone already renders it; this makes it DAG-addressable + survives
   * a from-IR rebuild). Both optional ⇒ pre-milestone saves + native primitives
   * are byte-identical (V10/H14).
   */
  readonly geometry: {
    readonly opacity: number;
    readonly alphaCutoff?: number;
    readonly vertexColors?: boolean;
    /** glTF direct-import — render both faces (three `side=DoubleSide`), captured
     *  from a material's `doubleSided:true`. Absent = front-only (the default). */
    readonly doubleSided?: boolean;
  };
  /** Texture map slots (W5). */
  readonly maps: InlineMaterialMaps;
  /**
   * v0.6 #3 (#181) — ONE shared UV placement applied to ALL loaded map textures
   * (three.js Texture.repeat=tiling / .offset / .rotation, about .center=[.5,.5]).
   * IDENTITY default (tiling [1,1], offset [0,0], rotation 0) → saved projects
   * render byte-identically. Mirrors glTF KHR_texture_transform / Blender mapping
   * node. Per-map transform is a v0.7 follow-up.
   */
  readonly uvTransform: {
    readonly tiling: readonly [number, number];
    readonly offset: readonly [number, number];
    readonly rotation: number;
  };
  /**
   * OpenPBR lobes with NO classic-WebGL MeshPhysical representation
   * (subsurface*, transmission_scatter*, base_diffuse_roughness,
   * coat_ior/color/darkening, dispersion Abbe). STORED for the v0.7 TSL backend,
   * tagged, NOT rendered now.
   */
  readonly unsupported?: Record<string, number>;
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
  /** OPFS key: baked-texture/<hash>.<ext>. EMPTY ('') for the two non-OPFS
   *  sentinels below (cleared, imported) — they reference no OPFS file, so
   *  `collectAssetRefs` skips them and `loadBakedTexture` is never called. */
  readonly hash: string;
  /** map/emissiveMap = 'srgb'; normal/ao/roughness/metalness = 'srgb-linear'. */
  readonly colorSpace: 'srgb' | 'srgb-linear' | 'no-colorspace';
  /** glTF textures are flipY=false; preserve verbatim. */
  readonly flipY: boolean;
  readonly wrapS: number;
  readonly wrapT: number;
  /**
   * glTF direct-import (texture-maps milestone) — the index of the IMPORTED glTF
   * texture this slot was captured from (`json.textures[gltfTexture]`). Present
   * ONLY on a captured-import descriptor (the "lighter" persistence path, V53):
   * the pixel bytes keep riding in the embedded `.glb` (V41), so `hash` is empty
   * and the renderer LEAVES the clone's texture in place (inherit) — the
   * descriptor exists so the slot is inspector-visible + DAG-addressable, not so
   * the renderer re-resolves it. Distinguishes a captured import (`hash:'' +
   * gltfTexture set`) from the CLEARED sentinel (`hash:'' + gltfTexture absent`).
   * Absent on every native baked ref + every pre-milestone save (V10/H14-clean).
   */
  readonly gltfTexture?: number;
  /** glTF direct-import — the texCoord (UV set) the imported texture binds to.
   *  Captured so the UV set is never silently dropped; UV1+ APPLY is a later
   *  slice (the clone already binds the right set, so render is unaffected). */
  readonly gltfTexCoord?: number;
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
  | { readonly kind: 'baked'; readonly hash: string; readonly vertexCount: number }
  // SOP / modifier (epic #201, #209) — a RECURSIVE descriptor: a geometry
  // operator over a `source` handle. The registry builds the source on demand
  // (geometryRegistry.get(source)) then applies the op. `array` replicates the
  // source `count` times, each translated by `i*offset` (local space), and merges.
  // Sync-buildable when the source is sync-buildable (box/sphere) — a glTF/baked
  // source is a follow-up (its geometry is async, outside the sync registry).
  | { readonly kind: 'array'; readonly source: GeometryRef; readonly count: number; readonly offset: Vec3 }
  // `mirror` (epic #201, #209) — the SECOND modifier: reflect the source across the
  // plane perpendicular to `axis` at `offset` along it (offset 0 = the LOCAL origin,
  // Blender's default) and merge the reflection back with the original → a symmetric
  // whole. A non-zero offset separates the halves (useful for v1's geometry-centered
  // primitives, where an origin mirror would overlap the source exactly). The
  // reflection has determinant −1, so the registry reverses the reflected copy's
  // triangle winding (else the mirrored half renders inside-out). Same sync scope.
  | { readonly kind: 'mirror'; readonly source: GeometryRef; readonly axis: MirrorAxis; readonly offset: number };

/** The axis a `mirror` modifier reflects across (the negated component). */
export type MirrorAxis = 'x' | 'y' | 'z';

export interface GeometryRef {
  readonly key: string;
  readonly kind: 'box' | 'sphere' | 'gltf' | 'baked' | 'array' | 'mirror';
  readonly descriptor: GeometryDescriptor;
}

// ---------------------------------------------------------------------------
// Evaluated UVs (v0.6 #3, issue #181) — the real UV layout for DISPLAY only
// ---------------------------------------------------------------------------
//
// THESIS §58 item 3: "view + transform, not surgery". This is a READ-ONLY
// projection of a mesh's UV attribute for the UVEditor panel — never written
// back, never an unwrap. Islands are topological connected components (faces
// sharing vertex indices), a display grouping (Blender shows islands too), NOT
// seam/unwrap editing. The ONE extractor `extractUVIslands` (src/app/uvIslands.ts)
// builds this; box/sphere are populated by the resolver (sync registry geometry),
// glTF/baked are resolved async by UVEditor (geometry outside the pure resolver).

export type UVPoint = readonly [number, number];

export interface UVIsland {
  /** Triangle edges as polyline strokes in 0..1 UV space (the drawer renders these). */
  readonly polylines: readonly (readonly UVPoint[])[];
  /** [minU, minV, maxU, maxV] over this island. */
  readonly bounds: readonly [number, number, number, number];
}

export interface EvaluatedUVs {
  readonly islands: readonly UVIsland[];
  readonly triangleCount: number;
  /** true when the face cap forced stride-decimation of a large mesh (no silent truncation). */
  readonly sampled: boolean;
}

/**
 * The uniform consumed mesh face. `uvs` carries the real UV layout for the SYNC
 * producers (box/sphere — geometry available in the registry); it is null for
 * glTF / GltfChild / BakedMesh, whose geometry is ASYNC (asset clone / OPFS) and
 * outside this pure sync resolver — UVEditor resolves those itself via the SAME
 * `extractUVIslands` (A-2/A-3). `material` is the ONE material face every consumer
 * reads (M6, Phase 151): an `InlineMaterialSpec` for un-baked box/sphere, a rich
 * `BakedMaterialSpec` for a BakedMesh, or null (gltf). Widening to the union means
 * there is exactly ONE material shape consumers branch on, never a second path.
 */
export interface EvaluatedMesh {
  readonly geometry: GeometryRef;
  readonly uvs: EvaluatedUVs | null;
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
  readonly transform: MeshTransform;
}

// ---------------------------------------------------------------------------
// Meshes (socket type: 'SceneObject') — recursive union
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
 * ModifiedMesh (epic #201 / #209) — the output of a geometry MODIFIER (SOP), the
 * geometry half of [[V58]]. A modifier is a `Mesh → Mesh` wrapper sub-chain node
 * (like {@link TransformValue}, but it rewrites the GEOMETRY, not a nesting
 * transform): it consumes its source mesh's geometry handle, wraps it in a
 * recursive {@link GeometryDescriptor} (e.g. `array`), and INHERITS the source's
 * transform + material so the result sits where the source was.
 *
 * Like {@link BakedMeshValue} it carries a `geometry: GeometryRef` handle — but
 * the handle is REBUILDABLE from params (the registry builds it SYNCHRONOUSLY by
 * recursing into the source), not an authoritative OPFS baked buffer. The
 * renderer (ModifiedMeshR) reads it via `geometryRegistry.get` (sync, no
 * suspense). A `muted` modifier passes its source through unchanged at
 * `evaluate`, so there is no muted ModifiedMeshValue — mute is identity.
 */
export interface ModifiedMeshValue {
  readonly kind: 'ModifiedMesh';
  readonly geometry: GeometryRef;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  /** Inherited from the source mesh (box/sphere inline material in v1; null otherwise). */
  readonly material: InlineMaterialSpec | null;
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
   * P151 (Apply-Transform, issue #151) — the sanitised child KEYS whose render
   * is suppressed because the child was baked into a standalone `BakedMesh`.
   * `GltfAssetR` sets `clone.getObjectByName(key).visible = false` per entry, so
   * the asset stops rendering that child by name (no double-render). Default `[]`
   * so pre-151 values are no-ops (V10/H14-clean). Op-backed + undoable via the
   * Apply atomic composite's inverse `setParam`.
   */
  readonly suppressedChildren: readonly string[];
  /**
   * UX #7 / H90 — glTF node INDEX → nodeNameMap KEY, captured at import
   * (`buildNodeNameMap`). This is the one correspondence the producer and three's
   * GLTFLoader clone agree on: the producer's KEY space (sanitizeBoneName + `__n`
   * dedup, `node_i` for unnamed nodes) DIVERGES from the clone's NAME space
   * (sanitizeNodeName + `_n` dedup, `''` for unnamed) on real exports, so ~28% of
   * meshes are unaddressable by name. `GltfAssetR` reads it alongside
   * `gltf.parser.associations` (which records the node index for every loaded
   * object — GLTFLoader.js:4311) to stamp each clone object's
   * `userData.basherGltfChildId`, so viewport drill-in addresses children by a
   * stamped ID, not by name. Default `{}` so pre-UX#7 saves hydrate empty — the
   * renderer + drill fall back to name-match (V10/H14-clean — no version bump).
   */
  readonly keyByGltfNodeIndex: Readonly<Record<string, string>>;
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
  /**
   * #188 (v0.7 Phase 3) — the OpenPBR material(s) captured at import, ONE per
   * mesh primitive (slot) in primitive order, surfaced from `params.materials`
   * so the renderer reads the EVALUATED (channel-overlaid) value, not raw params
   * (the [[H40]] evaluated-read rule, now extended to glTF materials). A material
   * channel (`paramPath = materials.<slot>.<lobe>.<field>`, target = this child's
   * dagId) overlays onto THIS array via the ONE `overlayChannels` primitive (V57),
   * exactly as a transform channel overlays `position`/`rotation`/`scale`. OPTIONAL:
   * absent = a pre-#178 save OR a node with no mesh (empty/bone) → the renderer
   * falls back to the clone's embedded material (V10/H14 backward-compat).
   */
  readonly materials?: readonly InlineMaterialSpec[];
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
  // #222 — a Group is transformable as a unit (Blender's parent/Empty). `pivot`
  // is the local point rotation/scale happen around; the renderer applies
  // Translate(position)·R·S·Translate(-pivot). All default to identity, so a
  // pre-#222 Group renders as a bare in-place group (V10/H14 additive).
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly pivot: Vec3;
  // #231 Inc 2 — a Group holds any SceneObject (mesh, light, camera), not only
  // meshes, so lights & cameras are groupable/parentable (Blender's "everything
  // is an Object"). The renderer (GroupR → MeshChild) and the world resolver
  // (childEdges/localMatrix) discriminate on `kind`; a light nested here renders
  // at the group-composed world via three.js `<group>` nesting.
  readonly children: readonly SceneObject[];
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
  | ModifiedMeshValue
  | GltfAssetValue
  | TransformValue
  | GroupValue
  | MaterialOverrideValue
  | ScatterValue
  | CharacterValue;

// #231 — the UNIFIED scene-object value: anything that flows through a
// 'SceneObject' socket (Scene/Group `children`, `lights`, `camera`, …). It is
// the runtime counterpart of the `'SceneObject'` SocketTypeName: meshes (the
// `SceneChild` union), lights, and cameras all converge here so a Group can hold
// any of them (Blender's "everything is an Object"). Consumers discriminate on
// `value.kind` exactly as the existing scene-child render band does — no DAG
// type-system growth (a single socket type, a tagged value union).
export type SceneObject = SceneChild | LightValue | CameraValue;

// ---------------------------------------------------------------------------
// P3 — Animation channels + shots (THESIS §42)
//
// KeyframeChannel<T>: separate node types per T (Number / Vec3 / Quat / Color)
// for clean V2 pure-flag handling, but all output the same 'KeyframeChannel'
// socket type. The `valueType` discriminator on the value lets consumers switch
// on the variant. v0.7 #199: channels are FREE-FLOATING — each carries its own
// `target` node id + `paramPath` and is overlaid by the one `overlayChannels`
// primitive consumed by both the renderer and the read-side (V57). The legacy
// AnimationLayer wrapper that aggregated channels per target is retired.
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
  /**
   * Per-channel gate + blend (v0.7 #199 — lifted off the retired AnimationLayer
   * wrapper). `mute` true → the channel contributes nothing (overlayChannels
   * skips it). `weight` ∈ [0,1] blends the sampled value toward the base. Both
   * default-identity (mute:false, weight:1) so an un-migrated channel and every
   * direct channel are byte-identical to pre-#199. REF: docs/UNIFICATION-DESIGN.md
   * §3.2 (locked decision 1); vyapti V57.
   */
  readonly mute: boolean;
  readonly weight: number;
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

// ---------------------------------------------------------------------------
// Operator substrate — constraints (CHOP) — epic #201 / V58
// ---------------------------------------------------------------------------

/**
 * A Track-To constraint value (epic #201, slice #204). Like a KeyframeChannel,
 * a constraint is an EDGE-LESS node: it carries the constrained node's id
 * (`target`) and an aim target, and is enumerated from the node table + resolved
 * at the scene-resolution layer (`nodeConstraints.ts`), where world transforms
 * are available — NOT applied inside a bare node `evaluate` (a relationship needs
 * world context). The orientation is DERIVED from positions, never a stored
 * rotation ([[V58]]). evaluate's return is for agent/introspection completeness;
 * the resolver reads params directly (the `resolveActiveCameraPoseAt` pattern).
 */
export interface TrackToConstraintValue {
  readonly kind: 'Constraint';
  readonly constraintType: 'trackTo';
  readonly name: string;
  /** The constrained node id whose rotation this derives. */
  readonly target: string;
  /** Aim at this node's world position when non-empty; else `aimPoint`. */
  readonly aimNode: string;
  /** Fixed-point aim target (world) used when `aimNode` is empty. */
  readonly aimPoint: Vec3;
  /** Roll reference (default +Y). */
  readonly up: Vec3;
  /** Bypass — a muted constraint contributes nothing (the future OperatorStack). */
  readonly mute: boolean;
}

export type ConstraintValue = TrackToConstraintValue;

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
// The Compositor — After Effects-style layer timeline (docs/COMPOSITOR-DESIGN.md).
//
// A `Composition` holds an ordered list of `Layer`s; a Layer wraps a time-varying
// Image `source` (a MediaClip / scene-render / ComfyWorkflow / nested Composition)
// with composite params (transform / opacity / blend / trim). The evaluators are
// pure metadata (V2/V3) — the actual per-frame decode + pixel composite happen at
// the viewer/runtime seam (mirrors Scene→renderer; ImageValue is lazy P4 metadata).
// ---------------------------------------------------------------------------

export type LayerBlendMode = 'normal' | 'add' | 'multiply' | 'screen';

/** 2D composite transform of a layer within its comp (AE-style). rotation in
 *  degrees; anchor/position in comp pixels; scale as a unit multiplier per axis. */
export interface Layer2DTransform {
  readonly anchor: readonly [number, number];
  readonly position: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}

export interface LayerValue {
  readonly kind: 'Layer';
  readonly name: string;
  readonly enabled: boolean;
  /** Position of the layer's in-point on the comp timeline, in comp frames. */
  readonly startFrame: number;
  /** Trim of the SOURCE, in source-local frames. */
  readonly inPoint: number;
  readonly outPoint: number;
  readonly blendMode: LayerBlendMode;
  /** 0..1, keyframeable (V57 channel paramPath 'opacity'). */
  readonly opacity: number;
  readonly transform: Layer2DTransform;
  /**
   * The source Image as evaluated at the incoming ctx. The compositor RE-EVALUATES
   * the source node at a time-shifted ctx (comp playhead → source-local time via
   * startFrame/inPoint) to fetch the actual frame — this field is the structural
   * handle, not the final composited pixels (the remap is a 1d/runtime concern).
   */
  readonly source: ImageValue | null;
}

export interface CompositionValue {
  readonly kind: 'Composition';
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationFrames: number;
  /** Solid background colour (hex) painted under all layers. */
  readonly background: string;
  /** Composite z-order: index 0 = BACK, last = FRONT (renderer composites
   *  bottom→top). The outline UI displays front-on-top by reversing for view. */
  readonly layers: readonly LayerValue[];
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

// UX #9 — scene-level environment (HDRI/IBL) lighting. The env config is a
// Scene-node param (decision 2026-06-15: Scene-level, NOT a separate node), so
// it is one-per-scene by construction. `Scene.evaluate` folds the params into
// this value; the renderer mounts a drei <Environment> from it, setting
// `scene.environment` (a scene PROPERTY, never a traversed object → it survives
// the renderToImage chrome hide-pass and flows into the production render for
// free). See vyapti V47.
export type EnvironmentSource =
  // No environment — the default; the scene stays the dark stage lit only by
  // explicit Light nodes / EditorLights.
  | { readonly kind: 'none' }
  // A drei built-in preset (studio/sunset/…). Fetched from a CDN at runtime →
  // NOT self-contained in a .basher bundle (only `file` embeds, V41).
  | { readonly kind: 'preset'; readonly name: string }
  // An imported .hdr/.exr stored in OPFS and addressed by assetRef → embeds in
  // the .basher bundle (V41). Loaded via environmentTextureLoader (mirrors
  // bakedTextureLoader). `name` is the user's original filename, kept only for
  // display (the assetRef is the content-hash path); optional for back-compat.
  | { readonly kind: 'file'; readonly assetRef: string; readonly name?: string };

export interface EnvironmentValue {
  readonly source: EnvironmentSource;
  /** Maps to `scene.environmentIntensity` (three r169). */
  readonly intensity: number;
  /** Y-axis rotation in DEGREES; maps to `scene.environmentRotation`. */
  readonly rotationY: number;
  /** When true, show the environment as the skybox (`scene.background`). */
  readonly background: boolean;
}

export interface SceneValue {
  readonly kind: 'Scene';
  readonly camera: CameraValue;
  readonly lights: readonly LightValue[];
  readonly children: readonly SceneChild[];
  readonly environment: EnvironmentValue;
  /** #208 — the active lighting PROFILE's rig (the lights it groups + the shared
   *  aim centre/radius), or null when no rig is wired. Kept SEPARATE from `lights`
   *  so the direct-light index-correspondence with `Scene.inputs.lights` stays
   *  byte-identical; the renderer renders `lightRig.lights` as a parallel band,
   *  recovering their node ids via `resolveRigLightSources` (the same edge order). */
  readonly lightRig?: LightRigValue | null;
}

export interface PostFxConfig {
  readonly tonemap: 'ACES' | 'Linear';
  readonly smaa: boolean;
}

export interface RenderOutputValue {
  readonly kind: 'RenderOutput';
  readonly scene: SceneValue;
  readonly postFx: PostFxConfig;
  /** Render output resolution in pixels — the size of the offscreen image a
   *  "Render Image" produces (#168). Decoupled from the viewport/window: a
   *  render is a deterministic product of the project, not transient view
   *  state (Blender F12 semantics). Defaults to 1920×1080. */
  readonly width: number;
  readonly height: number;
}
