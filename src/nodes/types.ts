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

export type Vec2 = readonly [number, number];

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

/**
 * ONE UV placement — tiling / offset / rotation. Named once because the shared
 * placement and each per-map placement (#550) are the SAME shape and must stay so:
 * a per-map value REPLACES the shared one, so anything the shared value can express
 * a per-map value must express too.
 *
 * Deliberately NOT a general 2D transform. The family is closed under neither
 * composition nor inversion (a rotation after a non-uniform scale is a shear), which
 * is exactly why per-map placement replaces rather than layers.
 */
export interface UvPlacement {
  readonly tiling: readonly [number, number];
  readonly offset: readonly [number, number];
  readonly rotation: number;
}

/** The 6 texture-map slots the inline material carries (W5 populates; null = none). */
export interface InlineMaterialMaps {
  readonly albedo: BakedTextureRef | null;
  readonly normal: BakedTextureRef | null;
  readonly roughness: BakedTextureRef | null;
  readonly metalness: BakedTextureRef | null;
  readonly emissive: BakedTextureRef | null;
  readonly ao: BakedTextureRef | null;
}

/**
 * What a `'Material'` socket carries (#394 D1) — the FINISHED material, tagged.
 *
 * Tagged, not a bare `InlineMaterialSpec`, because neither reference hands over an
 * untagged struct: Blender reaches material content through a named socket type
 * (`NodeSocketShader`) and its material is itself a tagged ID; MaterialX's
 * `mtlxsurfacematerial` outputs the named type `material`. The tag is what lets a
 * consumer narrow without knowing which node produced it.
 *
 * It carries the AUTHORED IR — a compile *input*, not a resolved snapshot (#394 D8).
 * That is the axis: `InlineMaterialSpec` is the source, `BakedMaterialSpec` is a
 * three.js-shaped compile *result*. Sockets carry sources; the source-vs-snapshot
 * split belongs downstream at the compile boundary, where it already lives
 * (`openpbrToThree` compiles the IR, `BakedMeshR` rebuilds a snapshot).
 *
 * `spec` is the whole finished material, so HOW the Material node finished it stays
 * private to that node — whether the lobes come from params today, from input sockets
 * (textures as nodes), or from a nested shader graph later, this contract is unchanged.
 */
export interface OpenPBRMaterialValue {
  readonly kind: 'OpenPBRMaterial';
  readonly spec: InlineMaterialSpec;
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
   * v0.6 #3 (#181) — the UV placement used by every map slot that does NOT carry
   * its own in {@link InlineMaterialSpec.mapUvTransforms} (three.js
   * Texture.repeat=tiling / .offset / .rotation). IDENTITY default (tiling [1,1],
   * offset [0,0], rotation 0) → saved projects render byte-identically.
   *
   * ⚠️ The PIVOT is a property of the ROAD, not of this value: the authored road
   * applies it about `.center=[.5,.5]` (`materialRegistry.ts`), the glTF road about
   * `.center=[0,0]` (`SceneFromDAG.tsx`, matching GLTFLoader). Neither glTF
   * KHR_texture_transform nor Blender's mapping node pivots about the centre — both
   * use the UV origin — so `[.5,.5]` is our own authoring convention, not parity (#551).
   */
  readonly uvTransform: UvPlacement;
  /**
   * #550 — PER-MAP placement. A slot listed here uses its own placement INSTEAD of
   * the shared {@link InlineMaterialSpec.uvTransform}; a slot not listed uses the
   * shared one. REPLACEMENT, never a delta composed over the shared value — the
   * `{tiling, offset, rotation}` family is not closed under composition (a rotation
   * after a non-uniform scale is a shear it cannot represent), and both references
   * store absolute per-slot placement: glTF KHR_texture_transform is per-slot with no
   * shared layer, and Blender reuses ONE mapping node rather than layering deltas.
   *
   * 🔴 OPTIONAL WITH NO `.default()` IN THE SCHEMA, DELIBERATELY BREAKING THIS FILE'S
   * "every field carries a default" rule — and it must stay that way. `materialKeyOf`
   * walks own enumerable keys, so a materialised `mapUvTransforms: {}` keys
   * DIFFERENTLY from an absent one and would re-mint EVERY existing material's
   * identity on first load after the version bump. MEASURED: `.optional()` omits the
   * key (safe), `.optional().default({})` emits it (re-mints). Absent means absent.
   */
  readonly mapUvTransforms?: { readonly [K in keyof InlineMaterialMaps]?: UvPlacement };
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

/**
 * A mesh's material assignment: which slots the object declares, and which slot each face
 * uses (#634).
 *
 * `indices` is `null` when the geometry carries no `material_index` attribute at all — a
 * road with no data half yet (glTF / baked). That is NOT "every face uses slot 0"; it is
 * "this geometry cannot say", and the difference is why it is a null rather than a
 * synthesised array of zeros. The readers live in `src/app/materialAssignment.ts`.
 */
export interface MaterialAssignment<M> {
  readonly slots: readonly M[];
  readonly indices: ArrayLike<number> | null;
}

import type { MeshUVRead } from '../app/uvAttributes';

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
  // (geometryRegistry.getForRead(source)) then applies the op. `array` replicates the
  // source `count` times, each translated by `i*offset` (local space), and merges.
  // Sync-buildable when the source is sync-buildable (box/sphere) — a glTF/baked
  // source is a follow-up (its geometry is async, outside the sync registry).
  | {
      readonly kind: 'array';
      readonly source: GeometryRef;
      readonly count: number;
      readonly offset: Vec3;
      /**
       * The CANONICAL component-scope query, when this generator is scoped (ns-2 D9).
       *
       * Absent means unscoped, and absent rather than `undefined`: `descriptorParamFields`
       * reads `Object.keys`, and a written `undefined` would announce a field the producer
       * has no param for. Always canonical, because the two key builders in
       * `modifierGeometry.ts` canonicalise on the way in — so two spellings of one scope
       * share a cached build, and the descriptor never carries a query the parser refuses.
       *
       * 🔴 IT IS A FIELD ON THE EXISTING VARIANTS AND NOT A COMPOSABLE `subset` KIND, and
       * the reason is the reference's own wording. Houdini's Mirror SOP preserves the
       * *input geometry* while *Group* names the *primitives to mirror*, so a scoped
       * generator keeps the WHOLE input and generates from the subset —
       * `mirror(subset(x))` cannot see the whole `x` and yields 36 where the grounded
       * figure is 54. A `subset` kind is a different operator (Houdini's Blast).
       */
      readonly scope?: string;
    }
  // `mirror` (epic #201, #209) — the SECOND modifier: reflect the source across the
  // plane perpendicular to `axis` at `offset` along it (offset 0 = the LOCAL origin,
  // Blender's default) and merge the reflection back with the original → a symmetric
  // whole. A non-zero offset separates the halves (useful for v1's geometry-centered
  // primitives, where an origin mirror would overlap the source exactly). The
  // reflection has determinant −1, so the registry reverses the reflected copy's
  // triangle winding (else the mirrored half renders inside-out). Same sync scope.
  | {
      readonly kind: 'mirror';
      readonly source: GeometryRef;
      readonly axis: MirrorAxis;
      readonly offset: number;
      /** The CANONICAL component-scope query, when scoped — see the `array` variant. */
      readonly scope?: string;
    };

/** The axis a `mirror` modifier reflects across (the negated component). */
export type MirrorAxis = 'x' | 'y' | 'z';

/**
 * A LOOKUP KEY into one process-wide, content-derived geometry cache — NOT a
 * per-object container.
 *
 * #605 — nothing per-object may be attached here, and the reason is measurable
 * rather than stylistic: two nodes with equal descriptors resolve to the SAME
 * `BufferGeometry` instance (`geometryRegistry` caches on `key`, and
 * `geometrySharing.gate.test.ts` pins the identity). So an attribute hung off
 * this handle would be hung off something several objects hold at once. Material
 * is the concrete case: two same-size boxes shaded differently would either
 * collide, or force material into the key and shatter the sharing the cache
 * exists to provide — a box per material instead of a box.
 *
 * This is why the reference-substrate move of carrying material as a
 * primitive-class attribute riding along in the geometry container does not
 * transfer as-is. There, the container is the object's own data; here it is a
 * shared, content-addressed entry. Per-object substance belongs on the DATA half
 * of the object/data pair (`BoxData` = geometry + material), which is already
 * where it lives.
 *
 * ── #638 (ns-1b) — THE ONE THING THAT DOES RIDE ALONG, AND WHY IT IS NOT A
 *    CONTRADICTION OF THE PARAGRAPHS ABOVE ─────────────────────────────────────
 *
 * The prohibition above is on the MATERIAL and on the object's SLOT TABLE. It is
 * not on the per-face INDEX that says which slot each face uses.
 *
 * The distinction is the one both reference systems draw, and it is what makes
 * variation over shared geometry possible at all: the table is object-level
 * substance, the index is part of what the geometry IS. Two boxes pointing their
 * faces at slots {0,1} in the same pattern are the same geometry however the two
 * objects fill those slots, and they still share one `BufferGeometry`.
 *
 * It has to be here rather than beside the handle because the group layout that
 * carries an index to the GPU lives on the `BufferGeometry` INSTANCE — three.js
 * has no per-object group layout. Two objects needing different face→slot layouts
 * would otherwise have to disagree about one shared array. That is unavailable,
 * not merely expensive, and it is the whole reason the index enters identity.
 *
 * `attributeKey` is the content key of the geometry's own attribute set (see
 * `src/nodes/attributeKey.ts`), and it is ABSENT — not `undefined` — when the
 * geometry carries no attributes. The two states are kept distinct because
 * `{field: undefined}` and a missing field hash differently, and a field that
 * materialises as `undefined` re-keys every mesh value in every project with no
 * error. The builders in `src/app/modifierGeometry.ts` are the only things that
 * may write it, and they refuse an unanswered `undefined` by name.
 *
 * ── ns-2 (D8) — WHY THERE IS NO `kind` FIELD HERE ────────────────────────────
 *
 * There used to be one, hand-written beside `descriptor` and spelled as its own
 * six-member union, and every construction site wrote the same word twice. What a
 * handle IS, is what its descriptor says it is; a second field carrying that answer
 * can only ever agree or be wrong, and nothing asserted it agreed. Read the kind off
 * `ref.descriptor.kind` — one field, one answer, and a disagreement between them now
 * has no constructor.
 *
 * 🔴 The duplicate's cost was not hypothetical, and it is recorded here because it was
 * measured rather than argued. `availabilityOf` (`src/app/geometryRegistry.ts`) closes
 * an exhaustive `switch` on a `never` and said so in capitals — *"adding a kind without
 * declaring how it becomes available is a COMPILE ERROR"*. The `never` was honest, but
 * it closed on the HAND-WRITTEN union, while a new geometry kind arrives in
 * `GeometryDescriptor`, which is where the kind's data has to live. Measured by adding a
 * seventh descriptor arm: `faceCountOf` and `rebuildGeometryRef` both failed to compile,
 * and `availabilityOf` — the one whose comment promised it — compiled clean. **A `never`
 * closed on a second spelling of its subject guards the spelling, not the subject.**
 */
export interface GeometryRef {
  readonly key: string;
  readonly descriptor: GeometryDescriptor;
  /**
   * The content key of this geometry's own attribute set, folded into {@link key}.
   * ABSENT when there is none — never present-and-`undefined`.
   */
  readonly attributeKey?: string;
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
 * The uniform consumed mesh face — one shape every mesh-producing kind projects to, so no
 * consumer grows a second path.
 *
 * ── #636: THE TWO SIBLING FIELDS ARE GONE, AND WHAT REPLACED THEM ─────────────────────
 *
 * This struct used to carry `uvs: EvaluatedUVs | null` and `material: Spec | null` as peers
 * of the geometry handle. Both are deleted, because both could hold exactly one value and a
 * mesh has never been limited to one:
 *
 *   - `material` could name ONE material. A mesh whose faces are assigned across two slots
 *     had no way to say so, which made a per-face assignment not merely unimplemented but
 *     unrepresentable. {@link MaterialAssignment} replaces it: the object's slot table
 *     paired with the geometry's per-face index into it. The INDEX belongs to the geometry
 *     and the TABLE is object-level — the line both reference systems draw, and what lets
 *     two objects share one mesh and still look different.
 *   - `uvs: null` carried THREE situations with three different correct responses — bytes
 *     in flight, buffers in a loaded asset clone, and no UV layer at all. `uvRead` replaces
 *     it with an answer that says which, so a consumer can no longer render an untextured
 *     mesh during a load and call it correct.
 *
 * Nothing has an escape hatch back to a single value. If one turns out to be needed it gets
 * named, counted and justified on its own rather than left as the default shape.
 *
 * `geometry` is a {@link GeometryRef} HANDLE into the geometry registry, NEVER inlined
 * buffers — heavy arrays stay out of Ops / undo / hashing. The attributes behind it live in
 * the attribute store, reached by the content keys the producing node minted.
 */
export interface EvaluatedMesh {
  readonly geometry: GeometryRef;
  /**
   * #635 — the UV read: the island projection when there is one, and otherwise WHICH kind
   * of absence this is. Waiting, look-elsewhere and genuinely-none are three different
   * answers requiring three different responses, and the single nullable field this
   * replaced could carry only their union.
   */
  readonly uvRead: MeshUVRead;
  /**
   * #634 — the WHOLE material assignment: the object's slot table paired with the
   * geometry's per-face index into it.
   *
   * A mesh whose faces point at two slots reports two, which is what the single `material`
   * field this replaced could never do. Read it through `assignedMaterials` /
   * `primaryMaterial` rather than by indexing, so "which materials is this made of" has one
   * answer and not one per caller.
   */
  readonly materials: MaterialAssignment<InlineMaterialSpec | BakedMaterialSpec | null>;
  readonly transform: MeshTransform;
}

// ---------------------------------------------------------------------------
// Meshes (socket type: 'SceneObject') — recursive union
// ---------------------------------------------------------------------------

// #365 Phase 5a (Slice 2): the fused `BoxMeshValue` is RETIRED — a box is now an `Object`
// (transform) pointing at a `BoxData` (geometry + material) through its `data` socket. Old
// saves are split on load by the migration (the `BoxMesh` node type stays a migration-only
// relic). No value kind carries the fused box any longer, making it unrepresentable.

// #384 Stage C: the fused `SphereMeshValue` is RETIRED — a sphere is now an `Object`
// (transform) pointing at a `SphereData` (geometry + material) through its `data` socket, exactly
// like the box. Old saves are split on load by the migration (the `SphereMesh` node type stays a
// migration-only relic). No value kind carries the fused sphere any longer, making it
// unrepresentable at runtime.

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
 * renderer (ModifiedMeshR) reads it via `geometryRegistry.getForRead` (sync, no
 * suspense). A `muted` modifier passes its source through unchanged at
 * `evaluate`, so there is no muted ModifiedMeshValue — mute is identity.
 */
export interface ModifiedMeshValue {
  readonly kind: 'ModifiedMesh';
  readonly geometry: GeometryRef;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  /**
   * Inherited from the source mesh: an inline OpenPBR IR (box/sphere/inline-data
   * source) or the rich baked spec a BakedMesh / baked-data source carries (#358).
   * Widened to the union the read side carries in its material SLOTS (see
   * {@link MaterialAssignment}), so the evaluate road no longer silently drops a baked
   * source's material.
   */
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
  /**
   * The slot table and its index, carried through the recomposition (#638, ns-1b step 6).
   *
   * This is the FLAT shape an `Object → …Op → ModifiedData` pair is recomposed into before
   * it reaches the renderer, so these two fields have to exist here as well or the
   * assignment is dropped at exactly the seam whose whole job is not to drop things — the
   * mesh would draw one material and every count downstream would agree with itself.
   * Same pairing rule as on {@link ModifiedDataValue}: both present, or neither.
   */
  readonly materialSlots?: readonly (InlineMaterialSpec | BakedMaterialSpec | null)[];
  readonly attributeKey?: string;
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

// #296 (Epic 1, transform-channel controllers) — a Null is a physical, transformable
// SCENE OBJECT with NO geometry (Blender's Empty / Houdini's Null): a first-class
// controller you grab with the gizmo, that shows in the Outliner, and whose transform
// channels (tx…sz) a driver can read. It carries only a TRS — the renderer draws a
// selectable axis glyph (editor chrome), never render geometry. A dedicated `kind`
// (not a childless Transform) so the exhaustive scene-child switches flag every site
// that must handle it, and so it renders as a leaf object, not an empty container.
export interface NullValue {
  readonly kind: 'Null';
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

// #321 (Phase 3, the camera rig) — a Curve was a PATH scene object (TRS + control points +
// baked samples). RETIRED (#385 S4, Stage C · C2): a curve is now an `Object` (the pose)
// pointing at a `CurveData` (the points), exactly as a box/sphere became Object + BoxData/
// SphereData. No value kind carries the fused curve any longer, making it unrepresentable at
// runtime. The `samples`/`closed` it once held live on `CurveDataValue` above; the world
// arc-length seam (curveSampleSource.ts) still measures those LOCAL samples in world (#349
// unchanged). Old saves split on load (migrateFusedCurveToSplit).

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

// ---------------------------------------------------------------------------
// #361 — Object↔data split (Phase 1). The `data` half and the `Object` half.
//
// The domain both Blender, Houdini AND Maya converge on: an Object OWNS the
// transform; the data it points at (geometry now; camera/light later) is a
// SEPARATE node reached through the typed 'ObjectData' socket. Phase 1 lands
// these BESIDE the fused nodes (BoxMesh/…): nothing migrates, and an
// `Object → MeshData` pair renders byte-identically to the fused mesh.
// See docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1.
// ---------------------------------------------------------------------------

/**
 * The data half — geometry + material, and DELIBERATELY NO transform. Carries
 * the same `GeometryRef` handle every mesh/baked/array value already uses (never
 * inline buffers), so the Object that points here renders through the identical
 * geometryRegistry path.
 *
 * `material` is INLINE ONLY, and the narrowing is the point. It used to admit a
 * `BakedMaterialSpec` too, on the reasoning that "a data node can hold either without a
 * per-kind switch" — but no producer ever emitted one: `BoxData`/`SphereData` hydrate an
 * inline IR and nothing else evaluates to a `MeshData`. That arm was DEAD WIDTH: the type
 * admitted a payload every consumer narrowed straight back out, so five branches sat
 * unexercised and `npm run typecheck` waved an incompatible baked payload through to the
 * browser, where it rendered as the grey fallback. A baked mesh has its own member of the
 * `ObjectData` union now (#388), which is where the per-kind switch genuinely belongs —
 * the two roads are not interchangeable (sync registry + inline IR vs async OPFS Suspense
 * + a flat six-slot spec), and pretending otherwise in the type is what hid that.
 */
export interface MeshDataValue {
  readonly kind: 'MeshData';
  readonly geometry: GeometryRef;
  readonly material: InlineMaterialSpec | null;
  /**
   * #536 S1 — the material's IDENTITY, minted by evaluation after the full fold
   * (param → socket → operator stack), null exactly when `material` is.
   *
   * Two objects whose materials resolve to the same thing carry the same key, so
   * "do these draw one material?" is answered by the graph rather than rediscovered
   * downstream by content-hashing the compiled spec (which is what `materialRegistry`
   * does today, and what S2 replaces with this).
   *
   * ⚠️ DELIBERATELY A SIBLING, NOT A HANDLE WRAPPING THE IR. A `{ key, spec }` handle
   * mirroring `GeometryRef` was tried first and measured wrong: the animation overlay
   * addresses values by a path mirroring the PARAM path, so the extra hop would make an
   * animated material freeze on screen. `materialKey.ts` carries the full argument.
   *
   * ⚠️ AND THIS IS THE ONLY MEMBER OF `ObjectData` THAT CARRIES ONE (#542). The invariant
   * is stated over the whole union and minted here alone, from two producers. `BakedData`
   * and `ModifiedData` hold a material with no key, for two DIFFERENT reasons — baked does
   * not share at all, while modified shares this very registry and re-derives the key
   * downstream through `materialKeyOf`, the same function minting it here. The reach is
   * spelled out in docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4 ("How far this reaches
   * today") and its counts are pinned by `materialKeyReach.gate.test.ts`, so widening the
   * mint reds a test until that section is updated with it.
   */
  readonly materialKey: string | null;
  /**
   * #633 — the geometry's ATTRIBUTE SET identity, minted by evaluation alongside
   * `materialKey`, null when this producer derives no attributes (glTF / baked, whose
   * buffers this value never sees).
   *
   * 🔴 IT IS A COMPONENT OF `GeometryRef.key`, and this block used to argue that it must
   * never be. That argument was true of the READ half and #638 is what answered it, so the
   * paragraph is inverted rather than merely lagging — it carried the reasoning AGAINST the
   * thing that shipped, on the first doc block anyone reads before touching attribute
   * identity. The shape: an unattributed box keys as `box|1,1,1`, and the SAME box carrying a
   * face-domain assignment keys as `box|1,1,1|a:<content hash>` — that trailing fragment IS
   * the fold.
   *
   * ⚠️ NO HASH IS QUOTED HERE ON PURPOSE. `attributeKey.test.ts` pins the four base TEMPLATES
   * verbatim and INTERPOLATES the hash beside them, so a content hash is free to move without
   * a test or a comment going stale. A literal hash in prose is unpinned by construction — the
   * issue that asked for this correction quoted one that no longer reproduces on any fixture in
   * the file, which is the argument for the convention rather than against it.
   *
   * WHY THE FOLD RATHER THAN A SIBLING: a parallel key alone could not make two same-size
   * boxes with different per-face assignments render differently — they resolved to one
   * shared `BufferGeometry`. It has to be the geometry key because the group layout lives on
   * the `BufferGeometry` INSTANCE and three.js has no per-object group layout.
   *
   * AND THE COST IT WAS FEARED TO CARRY IS ANSWERED, NOT OVERRIDDEN: sharing survives
   * because the component is CONTENT-derived, so two objects with the same assignment still
   * land on one entry; and two objects do not collide precisely because a differing
   * assignment differs in the component.
   *
   * ⚠️ STILL A SIBLING FIELD, THOUGH — the fold is about the geometry KEY, not about this
   * field moving. The per-element INDEX is geometry-level and the slot TABLE is
   * object-level, which is the split both reference systems make and #638 implements.
   *
   * The argument, the four references that agree with it and the assertions enforcing it
   * live in `attributeKey.ts` and `attributeKey.test.ts` — pointed at rather than restated,
   * because restating it here is what let the two drift apart in the first place.
   *
   * The set itself lives in `attributeStore`, keyed by this string. It is not serialized —
   * it is re-derived from params on every evaluation, which is free under a content key.
   */
  readonly attributeKey: string | null;
  /**
   * #634 — the object-level material SLOT TABLE, when it has more than one entry.
   *
   * Absent is the common case and means "one slot: the `material` above". The table is
   * object-level and the per-face index is geometry-level, which is the line both reference
   * systems draw and the reason two objects can share one mesh and still look different.
   *
   * ⚠️ Read it through `materialSlotsOf`, never directly — one derivation site is what keeps
   * this from becoming a second spelling of `material` that agrees today and diverges later.
   */
  readonly materialSlots?: readonly (InlineMaterialSpec | null)[];
}

/**
 * The curve's data half — control points, closure, and the baked LOCAL-space
 * polyline (`samples`), and DELIBERATELY no transform (the Object owns the TRS).
 *
 * The FIRST non-mesh member of `ObjectData` (#385, Stage C · C2). Unlike
 * MeshData a curve is NOT render geometry — no `GeometryRef`, no material: it is
 * editor chrome the viewport draws as a line and the render hide-pass excludes
 * (V37). It carries exactly the fields the fused `CurveValue` did MINUS the TRS,
 * so an `Object → CurveData` pair draws byte-identically to the fused Curve.
 * `#349` (which world a followed curve's points live in) is unchanged: `samples`
 * stay LOCAL and the world arc-length table lives in the seam (curveSampleSource).
 */
export interface CurveDataValue {
  readonly kind: 'CurveData';
  /** The authored control points, LOCAL to the owning Object's TRS. */
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  /** The baked local-space polyline (curveMath.sampleCurve); closed curves repeat
   *  the first point as the last, so consumers walk a flat strip with no wrap. */
  readonly samples: readonly Vec3[];
}

/**
 * The light's data half — the SHADING (kind + intensity/colour/falloff/aim), and
 * DELIBERATELY no transform (the Object owns the TRS). Post-split the node wired
 * into a light socket is an `Object` posing a `LightData`; `recomposeLightObject`
 * (lightRecompose.ts) reconstitutes the flat `LightValue` the renderer's light band
 * consumes, at BOTH gathers (Scene + LightRig) and at ObjectR's nested-light arm.
 *
 * ONE discriminated node, not four (#386, Stage C · C3): `light` is the kind enum
 * that collapses the four fused light NODES into one Light datablock, Blender-style.
 * The per-kind shading fields are all present (the schema defaults them) but a given
 * kind reads only the subset it owns. AmbientLight is NOT here — ambient is a World
 * datablock (only 4 light OBJECT types split), so it stays a bare fused node.
 */
export interface LightDataValue {
  readonly kind: 'LightData';
  readonly light: 'Directional' | 'Point' | 'Spot' | 'Area';
  readonly intensity: number;
  readonly color: string;
  readonly distance: number;
  readonly decay: number;
  readonly angle: number;
  readonly penumbra: number;
  readonly width: number;
  readonly height: number;
  readonly target: Vec3;
  readonly lookAt: Vec3;
  /** #205 — optional HDR/EXR emitter texture (env-hdri assetRef) for a studio area light. */
  readonly tex?: string;
}

/**
 * The camera's data half — the LENS (projection + focal length/zoom, clip planes,
 * sensor, depth of field) and the authored aim (`lookAt`/`roll`, parity-first #387
 * D1), and DELIBERATELY no position (the Object owns it).
 *
 * ONE discriminated node, not two (#387, Stage C · C4): `projection` is the enum that
 * collapses the two fused camera NODES into one Camera datablock, Blender-style. The
 * per-projection fields are all present (the schema defaults them) but a given
 * projection reads only the subset it owns — `fov` is inert for an orthographic
 * camera, `zoom` for a perspective one.
 *
 * ⚠️ Unlike LightData, this value is NOT what frames the shot. `recomposeCameraObject`
 * turns the pair into the flat `CameraValue` the DAG's camera consumers read, but that
 * value reaches the renderer only as a render-cache-key ingredient. What actually
 * draws is a `CameraPose` built from RAW params by `activeCamera.ts`. Both roads have
 * to be taught the pair; neither substitutes for the other.
 */
export interface CameraDataValue {
  readonly kind: 'CameraData';
  readonly projection: 'Perspective' | 'Orthographic';
  /** Vertical FOV in degrees. Required with no schema default — see CameraData.ts. */
  readonly fov: number;
  /** Orthographic scale. Read by nothing today (#478); owned here regardless. */
  readonly zoom: number;
  readonly near: number;
  readonly far: number;
  readonly sensorSize: number;
  readonly dofEnabled: boolean;
  readonly focusDistance: number;
  readonly fStop: number;
  readonly focusOnTarget: boolean;
  readonly lookAt: Vec3;
  /** Roll about the view axis, in DEGREES (#229). */
  readonly roll: number;
}

/**
 * The baked mesh's data half — an authoritative OPFS-backed geometry handle plus
 * the rich captured material, and DELIBERATELY no transform (the Object owns it).
 *
 * ⚠️ THIS IS DELIBERATELY NOT A `MeshDataValue`, even though the field lists match
 * (#388, Stage C · C5). The two are the same SHAPE and different CONTRACTS, and the
 * difference was measured, not reasoned: patching a `MeshData` producer to emit
 * baked payloads renders a baked material as the grey `#808080` fallback (ObjectR
 * narrows with `'base' in mat`, and a baked spec has no `base` key) and renders a
 * baked geometry as NOTHING AT ALL (`geometryRegistry.getForRead` returns null for baked
 * refs by design, and the renderer returns null on a miss). Both silent; typecheck
 * clean throughout. The axis underneath is RECIPE vs BUFFER — `BoxData`/`SphereData`
 * are rebuildable-from-params and resolve SYNCHRONOUSLY through the registry, while a
 * baked buffer is authoritative, content-hashed, and arrives ASYNCHRONOUSLY through
 * OPFS + Suspense. Separate members keep that in the type system: a consumer that has
 * not learned the async road gets a COMPILE ERROR rather than an empty viewport.
 *
 * `material` is non-nullable, matching the fused `BakedMeshValue` — a bake always
 * captures a resolved material (primitives leave the map refs null; a glTF bake
 * captures the post-override material including textures).
 */
export interface BakedDataValue {
  readonly kind: 'BakedData';
  /** Always `GeometryRef{kind:'baked'}` — an OPFS handle, never rebuildable. */
  readonly geometry: GeometryRef;
  /**
   * Carries a material and NO minted identity, deliberately (#542). Nothing shares it:
   * `BakedMeshR` builds its own `THREE.Material` in a per-component `useMemo` and disposes
   * it itself, so there is no shared instance for a key to disambiguate. If this road ever
   * routes through `materialRegistry`, it needs a key FIRST — see
   * docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4 "How far this reaches today".
   */
  readonly material: BakedMaterialSpec;
}

/**
 * A geometry modifier's output, as data (#415). Exactly {@link ModifiedMeshValue}
 * MINUS the TRS — a data node has no pose to carry, because the Object above the
 * stack owns it.
 *
 * That subtraction is GROUNDED IN BOTH REFERENCES, not argued from symmetry:
 *  - Houdini states it as an invariant (`ref/houdini/SOP.md:128`, S8): a modifier
 *    authors in local/object space and the object transform is inherited above the
 *    stack, "applied once, never baked into a modifier's local output".
 *  - Blender DEMONSTRATES it (measured live, v5.1.1 — see
 *    `ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §3): the evaluated mesh datablock
 *    has no `matrix_world` and no `location`, its local vertex coords are unchanged
 *    by a non-uniform object pose, and the world position is recovered only by
 *    `object.matrix_world @ local`.
 *
 * `material` keeps the WIDE union — deliberately NOT `MeshDataValue`'s narrower
 * `InlineMaterialSpec | null`. A modifier over a `BakedData` source carries a
 * `BakedMaterialSpec`, and #388 narrowed `MeshDataValue.material` to Inline-only
 * because nothing ever produced the baked arm there. Emitting this as a
 * `MeshDataValue` would give that material nowhere to go — the identical shape #388
 * MEASURED before it started (material → grey `#808080`, geometry → mesh count 3→0,
 * typecheck clean the whole way). Hence its own member. → [[H213]] · [[B31]]
 *
 * Material inheritance surviving the move is likewise observed, not assumed: Blender
 * attaches material to the DATA by default (`material_slots[n].link === 'DATA'`) and
 * the material survives modifier evaluation (§4 of the same doc). Dropping it here
 * would silently strip every modifier's source material.
 *
 * NOTE: no producer yet. The `ArrayModifier`/`SolidifyModifier` retype that mints this
 * lands with the socket flip and the format migration, which `ops.ts`'s exact-string
 * socket equality forces into ONE atomic commit.
 */
export interface ModifiedDataValue {
  readonly kind: 'ModifiedData';
  readonly geometry: GeometryRef;
  /**
   * Carries a material and no minted identity (#542) — and unlike `BakedData`, this road
   * DOES share. `ModifiedMeshR` goes through the same `usePrimitiveMaterial` seam as the
   * keyed road, so a modifier's inline material lands in the same content-keyed
   * `materialRegistry`. What keeps it in agreement with a keyed object is that the seam's
   * fallback calls `materialKeyOf` — the same function the evaluator mints with, over the
   * same IR — so equal materials collide onto one instance across both roads by
   * construction rather than by coincidence.
   *
   * ⚠️ The moment this kind mints its own key, that key joins the S3 ownership rule: a
   * writer patching an evaluated value owns the identity on it, so `overlayWithIdentity`
   * must clear it for this band too. Until then the downstream re-derivation cannot go
   * stale, because it is computed from the content it is handed.
   * See docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4 "How far this reaches today".
   */
  readonly material: InlineMaterialSpec | BakedMaterialSpec | null;
  /**
   * The slot TABLE, when an operator wrote a per-face assignment (#638, ns-1b step 6).
   *
   * Absent means "one material", and that absence is the shipped behaviour rather than a
   * missing feature: `SetMaterialOp` over a full face range REPLACES, exactly as it always
   * has, and emits no table. A table appears only for a partial range — a state the node
   * could not express before this phase — so no existing graph changes shape.
   *
   * ⚠️ Read through `materialSlotsOf`, never directly, so the single `material` field and
   * this one cannot be read as two different answers to the same question.
   */
  readonly materialSlots?: readonly (InlineMaterialSpec | BakedMaterialSpec | null)[];
  /**
   * The content key of the geometry's attribute set — the INDEX half of the pair whose
   * other half is `materialSlots` (#638). Present exactly when the table is, because
   * neither half means anything alone: an index with no table points nowhere, and a table
   * with no index has nothing selecting between its entries.
   */
  readonly attributeKey?: string;
}

/**
 * The value union flowing through the 'ObjectData' socket. Phase 1 seeded it with
 * MeshData (box/sphere); #385 adds CurveData — the first non-mesh member, so a
 * consumer that assumed MeshData must now discriminate on `value.kind` (ObjectR
 * gains a curve arm; elsewhere it was ABSORBED by `data.kind !== 'MeshData'` guards —
 * see #388 below for why that shape was a defect and where all three now discriminate).
 * #386 adds LightData — the second non-mesh member; ObjectR gains a light arm that
 * recomposes it into a LightValue and renders it through the shared light band.
 * #387 adds CameraData — the third, and the first whose renderer does not read the
 * evaluated value at all (the pose road builds from raw params instead), so ObjectR's
 * arm for it draws NOTHING: a camera's frustum is editor chrome from a separate band.
 * #388 adds BakedData — the first member whose geometry is ASYNCHRONOUS (an OPFS
 * buffer reached through Suspense, not a synchronously rebuildable registry entry),
 * which is exactly why it is its own member rather than a second `MeshData` producer.
 * #415 adds ModifiedData — the first member produced by an OPERATOR rather than by a
 * leaf, which is what moves the modifier stack onto the data lane
 * (`BoxData → ArrayModifier → Object`). It is also the first member whose material
 * union is WIDER than MeshData's, and that asymmetry is the reason it cannot simply
 * BE a MeshData: a modifier over a baked source carries a BakedMaterialSpec, which
 * MeshData no longer admits (#388 narrowed it). See ModifiedDataValue above.
 * (The same "one socket, discriminate on value.kind" discipline V78 uses for
 * 'SceneObject'.)
 */
export type ObjectData =
  | MeshDataValue
  | CurveDataValue
  | LightDataValue
  | CameraDataValue
  | BakedDataValue
  | ModifiedDataValue;

/**
 * The Object half — owns the transform, points at data. Renders `data.geometry`
 * at its own TRS, exactly as a fused mesh renders its geometry at its TRS, so an
 * `Object → MeshData` pair is byte-identical to the fused node beside it.
 * `data: null` is an Empty (the Group/Null/Transform collapse, a later phase).
 */
export interface ObjectValue {
  readonly kind: 'Object';
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  readonly data: ObjectData | null;
  /**
   * #645 — the OBJECT half of the material slot table: "this Object's slot *n* points
   * somewhere else", leaving the data node untouched. Keyed by decimal slot index.
   *
   * This is the field the rest of this file has been promising since #638. The paragraphs
   * at `:540`, `:634` and `:1212` all say the slot TABLE is object-level and that this is
   * what lets two objects share one mesh and still look different — and until this existed
   * they described a road that was not built: `materialSlots` sat on the data types only,
   * so two Objects reading one data node received the identical table with nothing in the
   * type system able to make them differ. What shipped was the reference's `link == DATA`
   * case, correctly, and nothing else.
   *
   * ── PRESENCE IS THE LINK MODE, AND THERE IS NO ENUM ────────────────────────────────
   *
   * The reference stores a per-slot `link` of `OBJECT | DATA` beside a material that may
   * independently be empty, which makes "link is OBJECT but no material is set" a real and
   * separately-handled state. Here an entry's PRESENCE is `link == OBJECT` and its absence
   * is `link == DATA`, so that state has no constructor rather than a guard — the same rung
   * of the ladder the rest of this union sits on.
   *
   * ── WHY A RECORD AND NOT A SPARSE ARRAY ────────────────────────────────────────────
   *
   * An array would have to spell "inherit this slot" as a hole, and JSON has no holes: a
   * hole serializes to `null`. `null` is already a MEANING on the data-side table — it is
   * how {@link MeshDataValue.materialSlots} says "this slot has no material at all" — so
   * an array representation would make "inherit from the data" and "explicitly nothing"
   * the same bytes on reload. The record cannot express either confusion.
   *
   * ⚠️ NOT the same axis as `MaterialOverrideValue.slotIndex`, which addresses the i-th
   * `isMesh` in a cloned glTF's traverse order. Two different meanings of "slot"; do not
   * route one through the other.
   *
   * ⚠️ Read through `objectSlotsOf`, never directly, and never alongside a bare
   * `materialSlotsOf(data)` — a data-side read agrees with the correct answer for every
   * object that overrides nothing, and disagrees only on the case under test.
   */
  readonly slotOverrides?: Readonly<Record<string, InlineMaterialSpec>>;
}

export type SceneChild =
  | BakedMeshValue
  | ModifiedMeshValue
  | GltfAssetValue
  | TransformValue
  | NullValue
  | GroupValue
  | MaterialOverrideValue
  | ScatterValue
  | CharacterValue
  // #361 — the Object half of the object↔data split (Phase 1, coexists w/ fused).
  | ObjectValue;

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

/** #283 Phase 1 (NLA) — how a channel COMPOSES with other channels on the same
 *  (target,param). Canonical here (the base module) so the fold reducer
 *  (foldChannel.ts) and the 7 channel schemas bind to ONE list, no drift.
 *  'replace' = the legacy last-writer lerp (default → byte-identical); 'combine'
 *  = additive / manifold layer over the per-type identity. */
export const CHANNEL_BLEND_MODES = ['replace', 'combine'] as const;
export type ChannelBlendMode = (typeof CHANNEL_BLEND_MODES)[number];

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
  /**
   * Per-channel SOLO (#263). When ANY channel in a fold is solo'd, only solo'd
   * channels contribute (the rest are gated like mute) — scoped to the channel set
   * overlayChannels receives (per-object/per-fold). Optional + absent-means-false so
   * a channel that predates solo, and every driver/strip value, is byte-identical.
   */
  readonly solo?: boolean;
  readonly weight: number;
  /**
   * #283 Phase 1 (NLA) — layer COMPOSITION over the fold reducer. `blendMode`
   * selects how this channel composes with others on the same (target,param):
   * 'replace' (legacy last-writer lerp) or 'combine' (additive/manifold over the
   * per-type identity). `order` is the bottom→top fold position. Both
   * default-identity (blendMode:'replace', order:0) → an un-migrated channel and
   * every existing channel are byte-identical (single Replace @ order 0 == today's
   * last-writer). REF: docs/NLA-DESIGN.md §3.1; vyapti V88 D2/D3.
   */
  readonly blendMode: ChannelBlendMode;
  readonly order: number;
  /**
   * #283 Phase 3 (NLA crossfade) — OPTIONAL time-varying influence. When present,
   * the fold uses `influenceAt(sampleTime)` in place of the static `weight` (a
   * Strip authoring blendIn/blendOut attaches an `effectiveInfluence` ramp closure).
   * Absent for bare channels + non-crossfade strips → static `weight` path →
   * byte-identical. REF: docs/NLA-DESIGN.md §Phase 3 (I-7); vyapti V88 I-7.
   */
  readonly influenceAt?: (seconds: number) => number;
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

export interface KeyframeChannelVec2Value extends KeyframeChannelValueBase {
  readonly valueType: 'vec2';
  sample(seconds: number): Vec2;
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

/** A discrete (step) STRING channel — prompt travel: `CLIPTextEncode.text` holds
 *  a value from its key until the next (COMFYUI-KEYFRAME-COMPILER-DESIGN.md §6.4).
 *  No interpolation. */
export interface KeyframeChannelTextValue extends KeyframeChannelValueBase {
  readonly valueType: 'text';
  sample(seconds: number): string;
}

/** A discrete (step) IMAGE-REFERENCE channel — the reference-image trigger: a
 *  `LoadImage.image` filename held from its key until the next (design §6.4). The
 *  sampled value is the image reference (an uploaded filename); no interpolation. */
export interface KeyframeChannelImageValue extends KeyframeChannelValueBase {
  readonly valueType: 'image';
  sample(seconds: number): string;
}

export type KeyframeChannelValue =
  | KeyframeChannelNumberValue
  | KeyframeChannelVec2Value
  | KeyframeChannelVec3Value
  | KeyframeChannelQuatValue
  | KeyframeChannelColorValue
  | KeyframeChannelTextValue
  | KeyframeChannelImageValue;

// ---------------------------------------------------------------------------
// NLA / Action Strips — motion-space layering (epic #283, docs/NLA-DESIGN.md §3.3)
// ---------------------------------------------------------------------------

/**
 * One channel of an {@link ActionValue}: a target-LESS, relative-path keyframe
 * spec. It is exactly a `KeyframeChannel*Params` with the bound `target` removed
 * (the Strip supplies the concrete target at placement, I-1) plus a `valueType`
 * discriminant. The remaining fields (`keyframes`, `modifiers`, `axisModifiers`,
 * `extend*` — and the inert `mute`/`weight`/`blendMode`/`order`, which are owned
 * by the Strip at Action scope, kept only so a strip resolver can feed the spec
 * to `build{Type}Sampler` unchanged, V57/DRY) mirror the channel schema so an
 * Action never drifts from it. Concrete per-type shapes live in `Action.ts`
 * (the zod discriminated union); this alias is the value-side view.
 * REF: docs/NLA-DESIGN.md §3.3; vyapti V57/V88 D2.
 */
export type ActionChannelSpec = {
  readonly valueType: KeyframeChannelValue['valueType'];
  readonly paramPath: string;
} & Record<string, unknown>;

/** A reusable, target-less animation performance — a bundle of relative-path
 *  channel specs (a "walk", authored once, placed by Strips). Immutable source
 *  (I-1): edits live on the Strip placement, never rewrite the Action. */
export interface ActionValue {
  readonly kind: 'Action';
  readonly name: string;
  readonly channels: readonly ActionChannelSpec[];
}

/** A non-destructive PLACEMENT of an {@link ActionValue} onto the timeline,
 *  bound to a concrete `target` (edge-less id-ref, V57). Carries retime
 *  (start/timeScale/repeat/reverse/extrapolate — I-6), blend mode + static
 *  influence (I-7), and a mute gate. Enumerated + folded by the resolver scan,
 *  never wired by edge. Phase 2 = scene-node targets only (camera strips are a
 *  documented known-limit — the camera pose scan does not fold yet). */
export interface StripValue {
  readonly kind: 'Strip';
  readonly name: string;
  /** Action node id (edge-less ref). */
  readonly action: string;
  /** Target node id whose params the placed Action drives (edge-less ref). */
  readonly target: string;
  readonly start: number;
  readonly timeScale: number;
  readonly repeat: number;
  readonly reverse: boolean;
  readonly extrapolate: StripExtrapolate;
  readonly blendMode: ChannelBlendMode;
  /** Static influence ∈ [0,1] (Phase 2). Time-varying ramps/crossfades = Phase 3. */
  readonly influence: number;
  /** Lead-in / lead-out crossfade ramp durations (seconds), #283 Phase 3. >0 → the
   *  strip authors a time-varying influence via an `effectiveInfluence` ramp. */
  readonly blendIn: number;
  readonly blendOut: number;
  readonly muted: boolean;
}

export const STRIP_EXTRAPOLATES = ['hold', 'nothing', 'hold-forward'] as const;
export type StripExtrapolate = (typeof STRIP_EXTRAPOLATES)[number];

/** An ordered mute/solo container of Strips (edge-less id-refs). The reducer
 *  folds a track's strips bottom→top; tracks themselves fold in `order` rank.
 *  `solo` on any track silences non-solo tracks (global). */
export interface TrackValue {
  readonly kind: 'Track';
  readonly name: string;
  /** Ordered Strip node ids (a strip belongs to exactly one Track — single-owner). */
  readonly strips: readonly string[];
  readonly order: number;
  readonly mute: boolean;
  readonly solo: boolean;
}

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
  /** Bypass — a muted constraint contributes nothing (the constraint stack). */
  readonly mute: boolean;
  /** Position in the target's ordered constraint stack (low → high, bottom → top).
   *  Edge-less operators order by this field, not by a wire (the geometry stack's
   *  sub-chain model doesn't fit — a constraint has no data edge). Mirrors
   *  `ParamDriver.order`. Default 0 → every pre-stack project is a single-member
   *  stack in table order, byte-identical to the old first-wins scan. */
  readonly order: number;
}

/**
 * A Follow-Path constraint value (issue #339). The POSITION-band twin of
 * `TrackToConstraintValue`: same edge-less species (enumerated + seam-resolved — a path
 * is another object's world geometry, unreachable from a pure `evaluate`), different
 * band. Track-To derives rotation from where the object IS; this derives position from
 * the path, so the two compose on one target with nothing to order.
 *
 * `evalTime` here is the AUTHORED param. The resolver reads it through
 * `resolveEvaluatedParam` so keyframes/drivers on it are honoured — this value is for
 * agent/introspection completeness, like Track-To's.
 */
export interface FollowPathConstraintValue {
  readonly kind: 'Constraint';
  readonly constraintType: 'followPath';
  readonly name: string;
  /** The constrained node id whose position this derives. */
  readonly target: string;
  /** The Curve node followed. Empty / not a Curve → degenerate, contributes nothing. */
  readonly curve: string;
  /** Fraction of the path's world ARC LENGTH: 0 = start, 1 = end. Closed paths wrap. */
  readonly evalTime: number;
  /** Added to `evalTime` before sampling (spread objects along one animated path). */
  readonly offset: number;
  /** Bypass — a muted constraint contributes nothing (the constraint stack). */
  readonly mute: boolean;
  /** Position in the target's ordered constraint stack (low → high, bottom → top). */
  readonly order: number;
}

export type ConstraintValue = TrackToConstraintValue | FollowPathConstraintValue;

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
  /** Solo (AE): when any layer in a comp is solo, only solo layers composite. */
  readonly solo: boolean;
  /** Lock: protects the layer from timeline edits (trim/slide/reorder). */
  readonly locked: boolean;
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
