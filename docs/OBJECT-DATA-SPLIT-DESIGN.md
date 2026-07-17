# Object↔Data Split — One Thing That Owns A Transform

**Status:** DESIGN / proposed — **not approved for implementation.** No code until the Phase-0 checkpoint.
**Tracking:** #231 (D — object↔data split + size-vs-scale; E — glTF children first-class). Sub-issues filed per phase on approval.
**Supersedes the narrow framing of:** #356 (glTF constrainable-but-inert), #357 (the ghost's kind switch) — both become slices that fall out of this refactor.
**Companion docs:** `docs/BLENDER-DATA-MODEL-PARITY-231-DESIGN.md` (Inc 1 shipped the socket convergence this completes), `docs/UNIFICATION-DESIGN.md` (the precedent: same shape, one concern earlier), `.anvi/dcc-reference.md` §24 (templates — the follow-on milestone).
**Catalogue anchors:** V78 (one socket type — the half that shipped), V58 (the "parent" is NodeDefinition + typed sockets, NOT a base class), V34 (one substrate), V104 (a band applies on top), V64 (the modifier substrate), V67 (the transformable import-root Group), H170 (the road set), H171 (discriminator-too-broad), H172 (capability-as-predicate — the root cause), H173 (take the boundary, never the mechanism — **it fired FOUR times inside this one document**: pointer-vs-containment §2.2 · foreign-vs-converted §2.1.1 · convert-on-import as "parity" §2.1.1 · "skinning is a unit" §2.1.1's correction), V105 (containment ≡ pointer on a DAG), H164/V101 (a vocabulary is a projection, never a parallel list — the law behind glTF's kind, the two material specs, and the `weights`-field temptation), H59/V20/H36 (shared-vs-fresh — the landmine).

---

## 0. TL;DR

**#231 Inc 1 made every scene object _speak_ one type (`'SceneObject'`, V78). Nothing made every scene object _be_ one.**

So "can this thing be posed?" is not a contract — it is a **runtime string check**, asked independently in three places on two different layers:

| site                                                       | layer               | check                                  |
| ---------------------------------------------------------- | ------------------- | -------------------------------------- |
| `src/viewport/SceneFromDAG.tsx:1745` (`ConstrainedR`)      | evaluated **value** | `if (followed && 'position' in rec)`   |
| `src/app/resolveEvaluatedTransform.ts:304` (the read side) | evaluated **value** | `if (!isVec3(c.position)) return null` |
| `src/app/Gizmo.tsx:162-165` (`getManipulable`)             | node **params**     | `if (!isVec3(p.position)) return null` |

Three duck-types, two layers, no relationship between them. **This is the root of the whole defect family** — every road, every kind, and every band re-answers "is this posable?" by hand, nothing forces the set to be finished, and a miss is **silent** (a `false`, a `null`, a `default: return null` — never an error).

> **Correction (verified Phase 0, 2026-07-17).** An earlier draft named `DiffOverlay.tsx:120` as the third `'position' in rec` duck-type. **That check no longer exists there** — the diff ghost was refactored (PR #354's arc) into a `switch(value.kind)` (`GhostChild`, `DiffOverlay.tsx:86`), whose `case 'GltfAsset': return null` (`:139-140`) is #357 itself. **The disease did not disappear; it changed form** — from a duck-type (H172) to a **parallel list** (H164/V101). So the live `'position' in rec` duck-types are `SceneFromDAG.tsx:1745` and `resolveEvaluatedTransform.ts:304` (plus `isVec3(p.position)` at `Gizmo.tsx:165`), **and** a growing kind-switch surface (`DiffOverlay`, `resolveEvaluatedMesh.ts:133/171/213/269`, …). The surface map (Phase 0) found the same predicate at **~a dozen** sites total. Both shapes — the duck-type and the parallel list — collapse under the split: one contract, checked by the compiler.

**Decision:** adopt the reference model both DCCs independently converge on — **an Object owns the transform; the data it points at is a separate node** — expressed natively as a **typed `data` input socket**. Every Object then carries a transform _by construction_, the duck-type checks die, and the four kind-specific pose roads collapse toward one.

**The finding this document converged on, and the sentence to read if you read nothing else:**

> **The domain has genuine joints. The job is not to eliminate seams — it is to SORT them.** Every "special case" in this arc was one of three things, and the whole design is deciding which:

| kind                           | what it is                                              | the move     | examples                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. False seam**              | a distinction we _invented_; the domain doesn't have it | **collapse** | glTF-is-foreign (§2.1.1) · convert-on-import (§2.1.1) · skinning-is-a-unit (§2.1.1) · material's-"home" (§2.1.2) · templates-as-a-distinct-mechanism (§12)               |
| **2. Real seam, noun present** | a genuine joint we have _already named correctly_       | **keep**     | skeleton-as-data (`SkeletonValue`) · `Scene.camera` (which-camera-renders, a pointer) · parenting-as-an-edge (§2.3 row 2)                                                |
| **3. Real seam, noun ABSENT**  | a genuine joint the domain has and we _have not named_  | **build**    | **transform ↔ data (this document)** · material-as-a-node (§2.1.2) · per-element attributes (§2.1.1, `SOP.md` S14) · n-ary role-typed inputs (S15) · the deform relation |

**A missing noun is NOT the absence of a seam — it is an UNBUILT one.** The five false seams did not prove "there are no seams"; they proved we keep **inventing fake ones (cat. 1) and fusing real ones (cat. 3).** The real joints were there the whole time — skeleton had its noun, `Scene.camera` had its noun — and the domain's other joints sit in both references waiting to be named. A category-3 seam is confirmed the same way the split is: **two independent references treat it as first-class** (per-element attributes are demanded by material AND skinning, from two directions — that is how you know it is real, not aesthetic).

> **So: "Basher is not missing features; it is missing NOUNS" — and every noun is a seam we have not built yet.** The Object↔data split is the first and biggest cat-3 build; it is what makes the rest sayable.

**And it is ONE pattern, not four — `V58` verbatim: _"the 'parent' is the existing `NodeDefinition` + typed sockets, NOT a base class."_**

```
Object ──data──▶ MeshData          Object ──material──▶ Material
                                   mesh + skeleton ──deform──▶ geometry
```

**A typed socket pointing at a data node.** That is the whole design. **The arc's real finding is that V58 was right and we applied it to ONE concern out of four** — and the evidence is a control group already sitting in the codebase:

| concern              | the noun           | a socket pointing at it                                 | result                    |
| -------------------- | ------------------ | ------------------------------------------------------- | ------------------------- |
| **skeleton**         | ✅ `SkeletonValue` | ✅ `GltfSkeleton` projects in; `PosedSkeleton` consumes | **no defect family**      |
| **material**         | ✅ `MaterialValue` | ❌ trapped in a wrapper                                 | **3 vocabularies + #358** |
| **transform ↔ data** | ❌                 | ❌                                                      | **this entire document**  |

Same substrate, same team, same era. **The only variable is whether something points at the noun** — and it predicts the defect count exactly. The Object↔data split is the first and load-bearing noun; it is what makes the others sayable.

This is multi-session and migration-bearing (V4). It must be sliced — each phase gated (`typecheck`/`eslint`/`test`/`license-audit`) **and** observed on the real app, one atomic commit each.

---

## 1. The problem

### 1.1 The asymmetry, by node

**17 node types declare an inspector `'transform'` section:**
`AmbientLight` · `AreaLight` · `BoxMesh` · `BakedMesh` · `Curve` · `DirectionalLight` · `GltfAsset` · `GltfChild` · `Group` · `OrthographicCamera` · `Null` · `PointLight` · `PerspectiveCamera` · `ScatterNode` · `SphereMesh` · `Transform` · `SpotLight`

They do **not** agree on what that means:

| node                     | owns TRS params?                           | evaluates to a value with `position`?                          | posable in fact?             |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------- | ---------------------------- |
| `BoxMesh` / `SphereMesh` | ✅                                         | ✅                                                             | ✅                           |
| `Group` / `Null`         | ✅                                         | ✅ (container)                                                 | ✅                           |
| `PerspectiveCamera`      | ✅ (position + lookAt + roll, **not** TRS) | ✅ (own shape)                                                 | ✅ via its own resolver      |
| lights                   | ✅                                         | ✅                                                             | ✅ via their own road (#343) |
| **`GltfAsset`**          | ❌ **none**                                | ❌ `{ kind, assetRef }` (`GltfAsset.ts:109-120`)               | ❌ **inert**                 |
| **`AmbientLight`**       | ❌ **none**                                | ❌ `{ kind, intensity, color }` (`AmbientLight.ts:25-27`)      | ❌ **inert**                 |
| **`ScatterNode`**        | ❌ top-level (per-instance only)           | ❌ top-level (TRS is inside `instances[]`, `types.ts:748-761`) | ❌ **inert** at top level    |

`GltfAsset.ts:108` declares `['mesh','transform','constraint','driver','material']` — advertising Object capabilities on a node with **no transform at all**. The Constraints panel offers "+ Follow Path"; `resolveConstraintPosition` resolves a world point; `'position' in rec` is `false`; the band writes nothing. **No error.** That is #356.

> **Verified Phase 0 (2026-07-17): #356 is not one node — it is three.** The surface map found **three** of the 17 types declaring a `'transform'` section while owning no top-level TRS: `GltfAsset` (above), **`AmbientLight`** (`inspectorSections: ['transform','constraint','driver']`, `AmbientLight.ts:24`, but evaluates to `{kind,intensity,color}` — an ambient light is omnipresent and has **no position at all**), and **`ScatterNode`** (`['mesh','transform','constraint','driver','material']`, `ScatterNode.ts:46`, TRS living per-instance inside the generated `instances[]`, never at the node). All three offer a Constraints panel that moves nothing. This is precisely why the `inspectorSectionsRegistry.test.ts:151` pin does **not** catch them: it equates "posable" with _declares a transform section_, never with _evaluates to a value carrying `position`_ — so all three sail through green (the §9 pin closes exactly this gap, now with a confirmed third witness).

Its transform lives instead on a **separate node** — the transformable import-root `Group` (V67, #222). Which means:

> **Basher already does the object↔data split — for glTF, ad hoc, without naming it.** The import-root Group _is_ the Object. `GltfAsset` _is_ the data. Everything else fuses the two.

### 1.2 The duck-type inventory (the real root)

The three checks in §0 are not a tidiness problem. They are the mechanism by which the following all became **silently possible**:

- a kind that is constrainable in the UI and inert in the engine (#356)
- a kind with no ghost, so an agent proposal is judged over an unchanged viewport (#357, #355)
- a band applied at one road and skipped at another (#339 → #343 → #352: three consecutive authors, each holding H170's road table, each shipping a miss)
- a band applied in one _direction_ and skipped in the other (the rotation half of #352, found in self-review — the fix's own defect surviving one band over)

Six sites apply the pose bands and **they disagree** (three apply both bands, three position-only — the latter correctly, because a camera aims by lookAt and a light by `.target`). The fatality threshold is 3.

### 1.3 Why this is structural, not a missing feature

Per the project's own fatality test, applied exactly as `UNIFICATION-DESIGN.md` §1.3 applied it one concern earlier:

- **hetvabhasa clustering:** H170 (5 roads) + H171 + #355/#356/#357 + the #352 rotation miss all cluster at one boundary — _"something that places an object for a human to judge."_ Well past 3.
- **vyapti span:** V78's promise ("every scene object speaks one type") spans every node def, the renderer, every resolver, the gizmo, the outliner and the ghost — and is **enforced nowhere**, because the value union does not back the socket union.
- **krama crossing:** placement crosses render/read/camera/light/ghost boundaries repeatedly, each crossing re-deciding membership by hand.

**The organization is the bug.** The concern _"a thing that has a transform"_ has no home; it is re-derived, per surface, by string check.

**This is the same disease the v0.7 unification cured for a different concern.** That refactor asked "animate a node's params over time" → found three mechanisms → picked the proven road → generalized → sliced → migrated → retired the holdout. It worked, and it stopped regressing. This doc does that for **placement**.

> **The meta-failure worth naming.** `UNIFICATION-DESIGN.md` §2.2 named the producer/non-producer trap **three sessions before we hit it**. `ref/houdini/NETWORK-META.md` graded us **I5 PARTIAL** and **I6 GAP/VIOLATED** ("Basher resolves via render tree that drops node-ids") — which is #346 — before it was filed. **We keep writing the diagnosis down and then rediscovering the disease empirically.** Phase 0 should ask why the catalogue's prose didn't fire, and the answer is this doc's whole thesis: a checklist a human must remember is not a mechanism.

---

## 2. The decision

### 2.1 The reference models (grounded)

|             | "Object" (owns transform)                                                                                     | "data"                                                                                                  | mechanism                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Blender** | Object datablock — transform + parent + constraints                                                           | Mesh / Camera / Light datablock                                                                         | **pointer** — _"Objects reference Object Data such as meshes or lights"_ [`scene_layout/scene/introduction.rst`]                  |
| **Houdini** | **OBJ** context node — `worldTransform()` = "parm transformation… pretransformations, parent transformations" | **SOP** network inside it                                                                               | **containment** (context level) [`ref/houdini/NETWORK-META.md` §65-80]                                                            |
| **Maya**    | **transform** node — _"handles transformations (translate, rotate, and scale)"_                               | **shape** node (mesh/camera/light) — _"handles geometry… does not maintain transformation information"_ | **containment** — the shape is a DAG **child** of the transform [`help.autodesk.com/.../DAG_Hierarchy_Transforms_and_shapes.htm`] |
| **Basher**  | — **fused** —                                                                                                 |                                                                                                         | —                                                                                                                                 |

**Three mature DCCs, the same joint — and one of them makes fusion structurally impossible.** Blender expresses it as a pointer, Houdini and Maya as containment; the _mechanism_ differs (each downstream of its own substrate, H173) but the _boundary_ is identical across all three. That triple convergence is the evidence: the boundary is the domain's, not one app's taste. Basher is the outlier, and the outlier is the one generating the defect family in §1.2.

> **Maya is the strongest of the three (grounded Phase 0, all Autodesk official docs).** It does not merely _permit_ the split — it **forbids fusion**: _"Any piece of geometry requires two DAG nodes above it, a shape node immediately above it, and a transform node above the shape node"_ and _"A shape node does not maintain transformation information"_ [`.../DAG_Hierarchy_Transforms_and_shapes.htm`]. There is no fused transform+shape node in Maya at all. Two further confirmations land for free: **(fan-out)** _"a single shape node can have multiple paths from the root of the DAG"_ — native multi-parent instancing, the exact analogue of Decision 3's fan-out (`MDagPath.isInstanced()`); and **(row 8)** the `shadingEngine` node _"associates shaders with geometry"_ as a separate node connected to the shape, independently corroborating material-as-a-node. Honest residual: Maya lands on **containment** (shape-as-DAG-child), like Houdini, not Blender's lateral pointer — which is exactly what §2.2 predicts collapses to one edge on a DAG.

**Survey bar (updated Phase 0):** Blender, Houdini **and Maya** now surveyed and concordant. C4D and 3ds Max remain unsurveyed — still one short of `dcc-reference.md`'s five-DCC bar, but the structural finding is now confirmed by **three** independent references, one of which forbids the fusion outright. Recorded as **grounded at the three-reference bar**.

### 2.1.1 How each reference handles **glTF** specifically — the row-7 grounding

The question this answers: _"do you GUARANTEE CHOPs/SOPs work with any object end to end, without special treatment?"_ For SOPs on glTF the honest answer was **no**, and the reason assumed was **foreignness**. It isn't. Both references get an imported glTF's geometry **into the geometry-operator chain** — by opposite mechanisms, each downstream of that reference's own substrate (**H173**).

|             | mechanism                                                                                                                                                                                                                                                                                                                                                                                                                              | why — its substrate                                                                     | do geometry ops reach it?                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Blender** | **Converts once, at import.** The `scene_gltf2` add-on builds native datablocks: _"the add-on will construct a set of Blender nodes to replicate each glTF material as closely as possible"_; `Pack Images` = _"Pack all images into the blend-file"_. **No link/reference mode for glTF exists** — the import options are conversion knobs only (Merge Vertices, Shading, Bone Direction, …). After import the `.glb` is irrelevant.  | **Retained-datablock** app: to exist, a thing must _be_ a datablock.                    | ✅ — it is a normal Mesh datablock now                                                   |
| **Houdini** | **Reads at cook time.** The **glTF SOP** takes a file-path param and _"loads a glTF file and translates the scene, node, mesh, mesh primitive, or material into a geometry representation."_ `Import Node Geometry As` → **Packed Primitive** (_"the world-space transform of the source glTF node will be applied to the packed primitive"_) or Flattened. **Never "imported"** — the path is a parameter; the SOP re-cooks on dirty. | **Cook/dataflow** app: a file param re-reads on dirty; nothing is permanently absorbed. | ✅ — packed prims flow down the SOP chain; **Unpack** is the explicit opt-in to vertices |
| **Basher**  | drei caches ONE `GLTF` per URL; `GltfAssetR` clones per instance. `GltfAsset` evaluates to `{kind, assetRef}` (`types.ts:575-576`).                                                                                                                                                                                                                                                                                                    | —                                                                                       | ❌ — `sourceGeometryRef` (`modifierGeometry.ts:44-69`) falls to `default: return null`   |

**Both references reach it. Basher is the only one that doesn't** — the same outlier finding as the split itself, one level down.

**What a packed primitive IS** (in-envelope, `ref/houdini/SOP.md` §6, per-claim SideFX URLs): it _"express[es] a procedure to generate geometry at render time"_ — **a lightweight reference to geometry plus a single transform, NOT a duplicate of points/prims/attributes**. _"Copying a packed prim copies the reference, not the data."_ To edit vertices you must **Unpack**, explicitly. SOP.md's invariant #7 — _"Carry geometry as a rebuildable reference + transform; materialize real buffers only when an op must read/edit concrete geometry; unpack is explicit"_ — is **already graded COVERED[S2] for Basher**.

⇒ **`GeometryRef` IS Basher's packed primitive, and `BakedMesh` IS Basher's Unpack.** Every piece of Houdini's mechanism is already shipped except one projection:

| Houdini                                  | Basher (shipped)                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| packed primitive (reference + transform) | `GeometryRef` — **COVERED[S2]**                                          |
| cook-time materialization                | `geometryRegistry` builds descriptors on demand                          |
| **Unpack** (explicit → real buffers)     | **`BakedMesh`** — OPFS content-hashed bytes; **observed arraying today** |
| cook-time file load                      | the `#258` null-until-primed async path                                  |
| **glTF SOP → a handle**                  | **MISSING** — `assetRef` is not a `GeometryRef`                          |

#### The deeper finding — **`GltfAsset` should not be a value KIND at all**

The row-7 framing above ("give glTF a `GeometryRef` projection") is **understated by one level**, and the question that exposed it was: _"it's not foreign data if it's already imported — why do we have the distinction?"_

**Neither reference keeps "came from a glTF" as a property of the value.** Blender's importer emits Objects + Mesh datablocks + Armatures + Actions + Materials — it projects glTF's **entire vocabulary into Blender's entire vocabulary**, and afterwards there is no "the imported glTF", just objects. Houdini's glTF SOP addresses _into_ the file (`Load: Scene | Node | Mesh | Primitive | Material`, with Scene/Node/Mesh/Primitive IDs) and emits geometry; downstream SOPs neither know nor care. **In both, provenance lives in a node (or a past operation) — never in the data's type.** Granularity ("a `.glb` is a scene, not a mesh") is therefore **not** a seam: both references answer it by **decomposing**, and Basher already decomposes the _hierarchy_ (import-root Group + `GltfChild` + `childHierarchy`, V67/#222).

**Basher inverted it.** `{kind:'GltfAsset', assetRef}` makes "came from glTF" a **permanent, load-bearing fact about the value** that every consumer must switch on. Basher is the only one of the three with a `GltfAsset` value kind at all. And the distinction is not principled — `GeometryRef.kind` is **already** a discriminated union over wildly different provenances, unified behind one handle:

```
box    → procedural descriptor      baked  → OPFS content-hashed bytes
sphere → procedural descriptor      array  → composed from another ref
                    ⇒ gltf = the FIFTH entry, exactly in-pattern
```

A packed prim does not care whether it references a file, a memory chunk, or a procedure. Neither does `GeometryRef`.

**WHY the distinction exists — two reasons, and only one is real:**

1. **Mechanical:** `GltfAssetR` clones and renders `gltf.scene` **as a unit**, which is _why_ `GltfChild` is a non-producer (the #88/H45/B12 double-render guard). Basher is the only one of the three that keeps the imported scene **indivisible**. Blender decomposes at import; Houdini at cook. We never decomposed, so the whole scene needed one handle.
2. **The one that actually explains it — and it is this doc's thesis:** **V101 says an external vocabulary must be a PROJECTION, never a parallel list. But a projection needs a TARGET vocabulary, and ours does not exist yet.** You cannot project glTF's _"a node with a transform, pointing at a mesh"_ into Basher when Basher has **no word for "an Object pointing at data."** There was nothing to project _into_ ⇒ **glTF got its own kind by default, not by decision.**

⇒ **`GltfAsset`-as-a-value-kind and the object↔data fusion are THE SAME DEFECT** — both are _"we had no word for a thing that owns a transform and points at data."_ So the split does not merely _not foreclose_ the glTF fix: **it CREATES the target vocabulary that makes the projection expressible.** The follow-up is **downstream of** this milestone, not adjacent to it. Fix the vocabulary and `GltfAsset` stops being a kind — every `case 'GltfAsset'` (#357's ghost switch, `sourceGeometryRef`'s `default`, `'position' in rec`) **evaporates, because there is nothing left to discriminate.**

#### There is NO seam — it is vocabulary all the way down

> **CORRECTED 2026-07-17 — H173's FOURTH firing, inside the very section that states H173.** An earlier draft of this subsection claimed _"the one honest seam that survives is skinning — a skinned character genuinely **is** a unit."_ **False.** It was grounded in `SkeletonUtils.clone` rebinding bones across the scene graph — **three.js's MECHANISM**, downstream of three.js's own choice to have `SkinnedMesh` hold a `Skeleton` object reference. That says nothing about what skinning **is**. Left visible rather than rewritten: four mechanism-for-boundary errors in one arc is this doc's own best evidence for its thesis.

**Both references decompose skinning completely** — weights are a property of the DATA, bones are transforms, and the deform is a RELATION:

- **Blender:** weights live on the **data** — `MeshVertex.groups`, _"Weights for the vertex groups this vertex is member of"_ (per-vertex, on the mesh). Bones are _"The Armature **Object**"_ — its own Object. The deform is the Armature **modifier** on the mesh Object, whose `object` param is _"Armature object to deform with"_ — **a pointer to a separate Object.**
- **Houdini (KineFX) — further still:** the skeleton is not even a special type. _"A KineFX hierarchy requires that joints have a name and transform attribute. **Each joint in the skeleton is represented by a point**, where the P and transform (matrix3) attributes contain the joint's transform."_ Weights are the **`boneCapture` point attribute** (_"for each point on the geometry, a pair of values is stored for every joint that has an effect on the point"_). The deform is a plain SOP — **Joint Deform** _"requires **three inputs** — the skin geometry with capture weights as the boneCapture point attribute, the capture pose skeleton as its second input, and the animated skeleton as its third input."_

⇒ **"Skinning" decomposes into FOUR words — and the one that sounded hardest already ships:**

| word                     | status                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **skeleton-as-data**     | ✅ **SHIPPED** — `SkeletonValue` (`types.ts:803`); `GltfSkeleton` = _"a PURE read-only projection of a glTF asset's captured skin bind data into a `Skeleton` value"_ ⇒ **V101's projection is already proven on the piece I called indivisible** |
| **weights-as-attribute** | ❌ per-class attributes — **pre-catalogued GAP (`SOP.md` S14)**                                                                                                                                                                                   |
| **deform-as-operator**   | ❌ n-ary role-typed inputs — **pre-catalogued GAP (`SOP.md` S15)**; our SOPs are unary (`inputs: { target: … 'single' }`)                                                                                                                         |
| **geometry-as-handle**   | ❌ row 7's `GeometryRef` projection                                                                                                                                                                                                               |

**Both blockers were graded GAPs in `ref/houdini/SOP.md` BEFORE this discussion** — S14: _"Basher S-set has no per-class attribute-carriage invariant; it implicitly assumes point-class only"_; S15: _"S1 asserts output-type==input-type for a **unary** chain; says nothing about arity>1 or input roles."_ **The §1.3 meta-failure fired a THIRD time inside the session that wrote it into this doc: I called skinning a seam instead of reading our own gap list.**

**What already works vs what does not — the DAG owns more than I claimed.** The DAG **already owns the skeleton AND the pose** (`Skeleton.ts` / `PosedSkeleton.ts` / `GltfSkeleton.ts`, retarget — all shipped). three.js owns **only the vertex deform** (`SkinnedMesh` + `SkeletonUtils.clone`, `SceneFromDAG.tsx:2372+`). **Skinned glTF plays back correctly today.** The ONE thing that is impossible is running a SOP **downstream of a deform** (array a posed character, scatter on a deformed surface). That is a **want** — Houdini's whole point — **not a wall, and it blocks nothing here.**

**Perf is not a counterargument.** Decomposing the MODEL does not force CPU skinning: the renderer can recognise `Object + meshData(weights) + skeleton` and build a three.js `SkinnedMesh` with GPU skinning — exactly the handle-not-buffers pattern we already grade **COVERED[S2]**. Both DCCs decompose the model and deform efficiently. **The model never dictated the execution.**

**But vocabulary ≠ cheap.** S14 is foundational (_"S13 and S15/S16 all assume a real per-class attribute model"_), and Blender's importer is enormous for precisely this reason. ⇒ **No architectural seam; a real amount of vocabulary to build. That is SCOPE, sequenced after the split — not a wall.**

> **THE TEMPTATION TO REFUSE NOW, before someone reaches for it:** bolting a `weights` field onto the mesh value to skip the attribute model is **a parallel list** — the identical error to glTF's kind, the two material vocabularies (§2.1.2) and the three duck-types (§0). **Real attributes or nothing.** §8's own rule already forbids the speculative build: **no consumer ⇒ no build** (the `setAtPath` precedent). A Deform SOP with nothing downstream of it is exactly that.

**ORDER:** split (the Object/data word) → glTF as a handle (row 7) → per-point attributes (S14) → n-ary role-typed inputs (S15) → **the Deform SOP then falls out nearly mechanically.** _"Just add a SOP" feels like the fix because the node is the visible thing. The node is cheap; the words its sockets need are the expensive part_ — the same shape as "just add a `GeometryRef` projection", where the projection was trivial and the missing target vocabulary was the whole problem.

**Why (b) "convert to native MeshData on import" is rejected:** it is **Blender's mechanism on Houdini's substrate** — H173's error a second time in this doc (§2.2 was the first). It is expensive _because_ it is mismatched, and the reference that implements it concedes its importer **guesses**: `Guess Original Bind Pose` _"attempts to guess the pose that was used to compute the inverse bind matrices"_; `Bone Direction`'s _"Fortune setting may cause inaccuracies in models that use non-uniform scaling."_ Choosing (b) buys ownership of heuristics Blender itself calls guesses. **Basher is a cook/dataflow engine ⇒ Houdini's mechanism is the substrate-matched one.**

> **Correction on the record (2026-07-17).** This section supersedes a claimed finding from the prior session: _"Blender IMPORTS (converts ⇒ you CAN Array an imported mesh); Basher REFERENCES (foreign forever) ⇒ SOPs never will."_ **Wrong on both halves.** Blender's link + **library override** path (which _does_ support _"Adding new modifiers and constraints, anywhere in the stack"_ on foreign data) applies to **`.blend` libraries, not glTF** — two different Blender mechanisms, conflated. And "foreign forever ⇒ SOPs never" is falsified in our own codebase: **`BakedMesh` carries foreign-origin bytes (a baked glTF) and arrays today** — observed, `ArrayModifier.test.ts` "a baked source → a ModifiedMesh … (not a passthrough)", `out.geometry.kind === 'array'`. **Foreignness was never the gate.** The gate is the missing `GeometryRef`. The prior "finding" was an inference that read neither `sourceGeometryRef` nor the glTF importer docs — **H172's meta-failure firing on the very session that catalogued it.**

**Provenance:** the glTF SOP node page is an **[EXTERNAL]** WebFetch (`sidefx.com/docs/houdini/nodes/sop/gltf.html`), not project-scoped. The packed-primitive semantics it rests on are **[in-envelope]** (`ref/houdini/SOP.md` §6).

> **✅ Phase-0 Ground Truth pass DONE (2026-07-17) — this section is now locked grounding.** All four load-bearing claims confirmed **verbatim** against `sidefx.com/docs/houdini/nodes/sop/gltf.html` + `sidefx.com/docs/houdini/model/packed.html`: (1) _"The glTF 2.0 SOP loads a glTF file and translates the scene, node, mesh, mesh primitive, or material into a geometry representation"_ (cook-time read; the "GLTF File" path param re-cooks on dirty — nothing is permanently imported); (2) "Import Node Geometry As" → **Packed Primitive** (_"the world-space transform of the source glTF node will be applied to the packed primitive"_) vs **Flattened Geometry** (_"bake the world-space transform… into the mesh point positions"_) — the Flattened option independently corroborates the design's `GeometryRef`(packed)=handle vs **`BakedMesh`(flatten)=baked** mapping; (3) _"Packed primitives express a procedure to generate geometry at render time"_ / _"Copying a packed primitive copies the reference rather than the geometry itself"_ / _"Packed primitives cannot be edited… use the Unpack node to extract"_; (4) the "Load: **Scene | Node | Mesh | Primitive | Material**" granularity selector — exact set and order. No claim in this section contradicts the source. (One out-of-band cleanup logged separately: `ref/houdini/SOP.md` §6 misattributes a pack-side quote to Unpack — a catalogue fix, does not touch this doc.)

### 2.1.2 Material — the SAME consolidation, and the worst instance of it (grounded — resolves §10.1, locks row 8)

> **This section was rewritten 2026-07-17.** Its first draft asked _"material: on the data or the Object?"_ and locked _"on the data, overridable at the Object."_ **That question imports the fused framing** and had to go: it asks which of **two** existing things owns the material, when both references answer **neither — the material is a THIRD thing, and they merely point at it.**

**Blender: `Material(ID)` — a DATABLOCK.** Its own first-class thing, exactly like Mesh, Armature or Object. Assignment is three levels, and every level is a pointer or an attribute:

```
Material datablock   ◀──pointed at by──  material SLOT   ◀──indexed by──  MeshPolygon.material_index
   (its own ID)                       (on Object or Mesh —              ("Material slot index of this
                                       the `link` toggle)                face" — per-face, ON THE DATA)
```

**Houdini: the same shape, different mechanism.** The material is **its own node**; the assignment is _"a material assignment to the geometry with the `shop_materialpath` attribute, and then overloading its parameter values with the `material_overrides` attribute"_ — **a pointer carried as an attribute**, at a class, so it can be per-primitive (and a packed prim **is** one primitive ⇒ N instances of one geometry, each with its own look).

⇒ **THE BOUNDARY BOTH AGREE ON (H173 — take the boundary, never the mechanism): the material is its OWN DATA, and the assignment is a POINTER.** Blender's `link: Literal['OBJECT','DATA']` (default `'DATA'`) is **not** deciding where the material lives — the material always lives in its own datablock. **It only decides WHO HOLDS THE POINTER.** That is a per-slot affordance, not an architecture decision. _"If connected to the object, you can have several instances of the same Object Data using different materials. If linked to mesh data, you cannot."_ [`render/materials/assignment.rst`]

> **⚠️ This CORRECTS `dcc-reference.md` §24** (amended alongside this doc). That entry states shared data _"cannot express per-instance variation… variations require a Full Copy. **That is exactly fan-out's ceiling.**"_ **True for geometry; FALSE for material** — the object-linked slot exists **precisely** to break that ceiling. Fan-out reaches **further** than §24 claimed, on the axis a director cares about most (look / colour / texture): _"one hero rig, forty variants"_ is **partially reachable by fan-out** — geometry params stay shared, but the common case lands **without** templates.

#### The noun already exists. Nothing points at it. That is the entire defect.

`MaterialValue` is **`kind: 'Material'` (`types.ts:147`) — already a first-class value kind.** But no socket points at it. It is **trapped inside a wrapper**: `MaterialOverrideValue = { kind:'MaterialOverride', child, material: MaterialValue }` — an operator holding the material **inline**, where Blender points a slot and Houdini writes an attribute.

And beside it, **two more vocabularies grew — with the violation confessed in a docstring**:

> _"Scalar names mirror {@link MaterialValue} **1:1** (Chesterton — the renderer/override/inspector already speak those names)."_ [`types.ts:318`, on `BakedMaterialSpec`]

**A mirror IS a parallel list.** Three vocabularies for one concern — `MaterialValue` (`:147`), `InlineMaterialSpec` (`:224`), `BakedMaterialSpec` (`:324`) — one of which **documents itself as a copy of another and cites Chesterton as the reason.** That is worse than glTF's two, and it is V101 violated in writing.

#### THE CONTROL GROUP — we did this correctly exactly once, and it is the strongest evidence in this document

| concern              | the noun           | a socket pointing at it                                                               | result                    |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------- | ------------------------- |
| **skeleton**         | ✅ `SkeletonValue` | ✅ `GltfSkeleton` projects into it; the `Skeleton`/`PosedSkeleton` family consumes it | **no defect family**      |
| **material**         | ✅ `MaterialValue` | ❌ trapped in a wrapper                                                               | **3 vocabularies + #358** |
| **transform ↔ data** | ❌                 | ❌                                                                                    | **this entire document**  |

**Where we applied the pattern, it works. Where we stopped at the noun, we got parallel lists. Where we did neither, we got the roads-and-bands mess (§1.2).** The skeleton is the control group: same substrate, same team, same era — the only difference is that something points at it.

#### #358, explained mechanically

Because there is **no socket**, every operator must **hand-carry** the material forward — `sourceMaterial(src)`, `sourceTransform(src)` (`modifierGeometry.ts`). One vocabulary did not fit through, so it returned `null`:

```
BOX   → material: {"name":"boxmat","color":"#ff0000"}   ← survives
BAKED → geometry: array   ← survives
BAKED → material: null    ← THE-BAKED-MATERIAL dropped
```

**Root cause is the TYPE, not the function:** `sourceMaterial` returns `null` for a `BakedMesh` because `ModifiedMeshValue.material` (`:545` — `InlineMaterialSpec | null`) left no room for a `BakedMaterialSpec` (`:324`). The **read** side had already unified them (`:470` — `InlineMaterialSpec | BakedMaterialSpec | null`); the modifier's output type had not. **H172 one level down** — `sourceGeometryRef` and `sourceMaterial` are two switches over the same value union, in the same file, covering **different kind sets**, nothing forcing agreement, and the miss is a `null`, never an error.

**But the deeper reading: the bug is not in `sourceMaterial` — it is that the function has to EXIST AT ALL.** With a `material` socket there is nothing to hand-carry, no per-kind switch to disagree with its sibling, and **#358 becomes unrepresentable** rather than fixed. **Filed as #358 — live on `main`, independent of the split, fixable now.** (`ArrayModifier.ts`'s header is stale here too: it claims a baked source "passes THROUGH unchanged" — it does not; only glTF does.)

#### The consolidation reaches one step further than expected

**Per-face material assignment needs the SAME missing word as skin weights**: a per-element attribute (`MeshPolygon.material_index` / `boneCapture`). The same gap (`SOP.md` S14), arrived at from two unrelated directions in one session. That is the fatality signal doing its job — when two independent concerns demand the same absent noun, the noun is the work.

#### The §4 payoff — the landmine stops being a landmine

Today, sharing is **implicit**: three.js `Mesh.copy` does `this.material = source.material` — **no clone** — so the clone, the drei cache and every other clone of that URL share ONE Material object, invisibly (`ref/GROUND_TRUTH_GLTF.md`; #99/H59/V20/H36). That invisibility **is** the landmine; the escape hatch already exists (`Material.clone()` preserves the subclass and copies map refs by reference ⇒ _"a distinct object safe to retint"_).

**With a Material node and a `material` socket, sharing becomes VISIBLE IN THE GRAPH.** You can _see_ twenty Objects wired to one Material node. Change it once, twenty change — **obvious, not a trap.** The pre-mortem in §4 ("an artist makes twenty linked copies, changes one's material, all twenty change") stops being a surprise and becomes **the drawn, readable meaning of the edges.**

⇒ **This is a better answer to §4 than the band table alone.** The table documents where the surprises are; the socket **removes the surprise**. The table is still required (geometry, transform, channels, constraints, skinning), but the material row — the worst offender — is answered structurally rather than documented.

### 2.2 Mechanism: on a DAG, "pointer" and "containment" are the same edge

This was nearly mis-decided. The dichotomy dissolves on our substrate:

```
pointer:      Object.data ──▶ MeshData.out
containment:  Object.body ──▶ <chain>.out   and "the contents" = closure(<chain>.out)
```

**The same edge.** `Solver.ts:17-23` proves it in shipped code: _"its `body` input is wired to the sub-network's OUTPUT node; the seam cooks that node's **dependency closure** once per frame."_ A container in a DAG is **the dependency closure of the node you point at** — derived, not stored. `DagState` stays flat (`{nodes: Record<id, Node>}`); there is no nesting to build.

**Houdini needs OBJ-contains-SOP only because it has _contexts_** — different data types on the wire per context, so it needs walls. Basher deliberately took the other road: **N1/I1 — "one cook substrate: all contexts are node networks on one cook engine; only the wire data-type differs" → COVERED** (one DAG of typed NodeDefinitions), and V34 ("one substrate… no second pipeline"). We express the difference in the **socket type**, not a network level.

⇒ **From the references take the _boundary_ (both agree), not the _mechanism_ (each is downstream of its own substrate).** Copying containment without contexts would be cargo cult.

Corroborating, from the containment reference itself: **§159 — Houdini resolves against a "flat global namespace" at cook time; "depth is irrelevant: `/obj/geo/subnet/inner/tx` resolves identically whether `inner` is one level deep or ten."** Even in Houdini, containment is an _authoring_ convenience over a _flat_ resolution model. Basher already **is** the flat resolution model.

**V58 is honoured verbatim:** _"the 'parent' is the existing `NodeDefinition` + typed sockets, NOT a new base class."_ A `data` socket is exactly that. No class hierarchy, no second paradigm beside the data-oriented one.

### 2.3 Locked decisions

| #   | Decision                                 | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mechanism                                | **`data` = a typed input socket.** Pointer ≡ containment on a DAG (§2.2). V58 honoured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | Parenting                                | **Unchanged** — stays an edge (`children`), which is already Houdini's model (§73: "connecting the output of object A to the input of object B makes A the parent"). Do **not** adopt Blender's parent pointer; mixing idioms is worse than either.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | Shared-**RESULT** instancing             | **Fan-out** — two Objects wired from one data node = a linked duplicate. Free, arrives with the split.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Shared-**DEFINITION** templates (HDA)    | **Its own milestone, afterwards — but NOT because it is "a second distinct mechanism."** On a DAG a template instance is **the SAME edge as fan-out with a non-empty override map** (§12) — `SolverInput` is already a promoted parameter, hard-coded as a leaf because we lack the word. It stays a later milestone on **SEQUENCING** grounds (named params + an instance node the evaluator understands + the UI + nesting = real work), **not** architectural ones. Still does **not** reopen B27 (no new eval contract). **Do not fuse with this work.** (`dcc-reference.md` §24, amended.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | Scope                                    | Split + road collapse + glTF-as-Objects (#231 E) + size-vs-scale (#231 D). **Collections deferred.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Camera pose shape                        | An Object carries TRS. `lookAt`+roll becomes a **derived/constraint** concern (already true since #204 moved the camera's aim onto Track-To). Resolve the migration path in Phase 0 — this is the deepest cut.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | **glTF's data contract**                 | **The `data` socket carries a `GeometryRef` HANDLE, never vertices** — already the shipped SOP contract (§2.1.1). Neither (a) "SOPs never will" nor (b) "convert on import": both false. **`GltfAsset` should not be a value KIND at all** — "came from a glTF" is a fact about a NODE, never a permanent property of the value (neither reference does otherwise). It became a kind only because **V101's projection had no TARGET vocabulary to project into** — the same defect as the object↔data fusion. ⇒ **the glTF fix is DOWNSTREAM of this milestone, not adjacent to it: the split creates the vocabulary that makes the projection expressible.** Follow-up issue, out of scope here. **THERE IS NO SEAM — not even skinning** (§2.1.1): it decomposes into four words, one of which (`SkeletonValue`) already ships, and the other two blockers are pre-catalogued gaps (S14 attributes, S15 n-ary roles). **Every special case in this arc — glTF, material, skinning — reduces to "we lack a word", never "the domain is like that."**                                                                                                   |
| 8   | **Material** — _the same shape as row 1_ | **The material is its OWN DATA NODE; assignment is a typed `material` SOCKET.** Both references agree: `Material(ID)` is a datablock / a SHOP node, and the assignment is a **pointer** (Blender's slot + per-face `material_index`; Houdini's `shop_materialpath` attribute) — §2.1.2. **The noun ALREADY EXISTS: `MaterialValue`, `kind:'Material'` (`types.ts:147`) — it is merely trapped inside `MaterialOverride`'s wrapper, and two more vocabularies grew beside it** (one whose docstring admits it _"mirror[s] MaterialValue 1:1"_ = a parallel list, V101). **Object-vs-data is NOT "material's home"** — the home is always its own node; Blender's `link` (default `'DATA'`) only picks **who holds the pointer**, a per-slot affordance, not an architecture decision. **Per-face assignment needs per-element attributes — the SAME missing word as skin weights (S14).** Consequences: the 3 vocabularies collapse to 1; `sourceMaterial`/hand-carrying disappear; **#358 becomes unrepresentable**; and **§4's landmine becomes VISIBLE IN THE GRAPH** (twenty edges to one Material node) instead of an invisible three.js reference. |

### 2.4 What we are explicitly NOT doing

- **Not** introducing contexts / network levels / subnets (§2.2).
- **Not** a base class (V58).
- **Not** building templates/HDA in this milestone (§2.3 row 4) — the requirement is real and stated, and it is a _different axis_.
- **Not** the literal "make a BoxMesh a GltfChild" unification — `UNIFICATION-DESIGN.md` §2.1 rejected it, for reasons that still hold (loses parametric geometry, couples primitives to the import pipeline).

---

## 3. Target architecture

### 3.1 The shape

```
                      out: 'SceneObject'
  Object ──────────────────────────────────▶ Scene.children / Group.children
    · position / rotation / scale                (parenting = the children edge, unchanged)
    · constraint stack   (V104 bands apply here)
    · driver stack
    · free-floating channels target it (V57)
    │
    └── data: 'ObjectData' ◀── MeshData | CameraData | LightData | GltfData | (none = an Empty)

  modifiers sit UPSTREAM on the DATA chain:
      BoxData ──▶ ArrayModifier ──▶ Object
      (both references agree on the ORDER: data → modifiers → object transform → world.
       Blender: mesh datablock → the OBJECT's modifier stack → object transform.
       Houdini: SOP chain in object space → the OBJ transform. Drawn flat, that is this line.)
```

> ⚠️ **This is a real change to the operator substrate — NOT "V64/OperatorStack unchanged"** (an earlier draft of this doc claimed that; it was wrong). Shipped `ArrayModifier` is `target: {type: 'SceneObject'}` → `SceneObject` and **inherits** the source's transform via `sourceTransform(src)`. Moving it onto the data chain changes its socket type and deletes that inheritance.
>
> **The rewrite is evidence FOR the split, not a cost against it.** `sourceTransform(src)` / `sourceMaterial(src)` (`modifierGeometry.ts`) exist **only because** a mesh value fuses geometry + transform + material. After the split a data node has no transform, so a modifier has nothing to carry forward and both helpers evaporate. That is the boundary paying off — but it must be **scoped as work** (§7), not waved through in a parenthetical.

Key properties:

- **Every Object has a transform by construction.** `Posable` stops being a duck-type and becomes the type.
- **One data socket, many data kinds** — discriminate on `value.kind`, exactly as V78 already has consumers do.
- **Instancing = fan-out** — two Objects, one `MeshData`.
- **An Empty is an Object with no data** — which is what `Group` and `Null` already are.
- **The modifier stack's position becomes principled** rather than incidental: modifiers are geometry→geometry (SOP, V64), so they belong on the data chain, upstream of the Object.

### 3.2 What becomes unrepresentable

This is the point of the whole exercise — each row is a defect class that stops being _possible_, not one that gets fixed:

| today                                                         | after                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| a kind constrainable in the UI, inert in the engine (#356)    | an Object always has TRS; a data node never declares `'constraint'` |
| `'position' in rec` × 2 + `isVec3(p.position)` × 1, unrelated | one contract, checked by the compiler                               |
| `getManipulable` "lights up any node with a `position` param" | the gizmo takes Objects                                             |
| a band applied at one road, skipped at another                | one road pair for scene children (§3.3)                             |

### 3.3 The road collapse — real, and honestly partial

Cameras and lights become Objects ⇒ they become **scene children** ⇒ the mesh render/read roads reach them. **H170's four kind-roads collapse toward one pair.** This is #343's deferred "option B", _unblocked by the split_ — it was impossible before only because a camera's pose was a different shape.

**Partial, deliberately:**

- `LightRig` (V63) **stays its own band** by design — the studio-profile precedent.
- `Scene.camera` remains the _which-camera-renders_ pointer (CameraSelect's job, V79) — that is a different question from _where the camera is_.
- The **diff ghost** stays a separate _surface_ (it draws a proposed fork), but it walks the same value tree and gets the band from the same contract.
- The applied-on-top consumers (box-select #342, gizmo seed #348) remain — V104 is unchanged and still governs them.

### 3.4 What stays unchanged (Chesterton)

- **V57** — free-floating channels targeting a node's dagId, one overlay primitive, two callers. Channels target the **Object** for transform bands, the **data** node for data params (e.g. `size`). This is a Phase-0 question (§10.4), not an assumption.
- **V104** — the band applies _on top_ of the pure walk; band inputs read pure. The split changes _what carries a position_, never _where the band applies_.
- **V64 / `OperatorStack`** — the geometry modifier chain, now with a principled home (§3.1).
- **V67** — the import-root Group keeps its bbox-centre pivot. After the split it is simply _an Object_, which is what it always was.
- **V44** — index-correspondence by stable id.
- glTF children remain **non-producers of scene geometry** — three keeps owning what gets _rendered_ (`UNIFICATION-DESIGN.md` §3.5, the #88/H45/B12 double-render guard). **Note the scope carefully:** that guard is about **who renders**, and it is a different question from **whether the data lane can hand a SOP a `GeometryRef`** (§2.1.1). Houdini keeps a glTF foreign _and_ SOPs it, via the packed-prim handle; the double-render guard is untouched by that, because a handle is not a second renderer. Do not cite #88/H45/B12 as grounds for "SOPs can never see a glTF" — it does not say that.

---

## 4. ⚠️ Shared-vs-fresh — the landmine, and a required deliverable

**This outranks every other risk in this doc.**

Basher **already instances at the three.js layer**, and it is the worst neighbourhood in the codebase: drei caches ONE `GLTF` per URL and `GltfAssetR` clones per instance. From `ref/GROUND_TRUTH_GLTF.md`:

> **"Whether a given object in the clone is FRESH or SHARED-by-reference is the single most bug-dense fact in the pipeline"**

— and **Material is shared by reference**, so mutating one instance mutates _every_ instance **and the cache** (#99 / H59 / V20 / H36).

Decision 3 (instancing = fan-out) walks straight into this neighbourhood. Therefore:

> **REQUIRED PHASE-0 DELIVERABLE — the shared-vs-fresh band table.** For every band (geometry, material, transform, channels, constraints, skinning), state which side of shared/fresh each datum is on when two Objects fan out from one data node. A band whose side is unstated is a shipped bug. This is a table in the doc, not a risk row.

#### The band table (DELIVERED, Phase 0 — grounded in `ref/GROUND_TRUTH_GLTF.md` Stage 6 for three.js semantics, `src/` read directly for Basher)

Two Objects fan out from one data node. For each band: which side each datum lands on, and whether that is safe or a landmine.

| band               | side when fanned out                    | evidence                                                                                                                                                                                                 | verdict                                                                                                                                                                                 |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **geometry**       | **SHARED** by reference (content-keyed) | `GeometryRef` handle, content-addressed (`types.ts:366-427`); registry `get` (`SceneFromDAG.tsx:2008`); three `Mesh.copy` shares `geometry`, no clone (GT Stage 6, `objects/Mesh.js:61`)                 | **SAFE** — buffer is read-only; a destructive edit bakes a **new** `baked` handle (`types.ts:513-521`), never mutates the shared one                                                    |
| **transform**      | **FRESH** per Object                    | each Object owns pos/rot/scale by construction; three `Object3D.copy` copies TRS by value (GT Stage 6, `core/Object3D.js:977-983`); per-instance clone + in-place write (`SceneFromDAG.tsx:2367-2379`)   | **SAFE** by construction — this is the whole point of the split                                                                                                                         |
| **material**       | **SHARED** by reference at three layer  | POJO on the value (`types.ts:485,520,745`); three `Mesh.copy` shares `material`, no clone (GT Stage 6/B7, `objects/Mesh.js:60`); Basher clones before retint (`SceneFromDAG.tsx:2564-2567,2634`)         | **LANDMINE** — safe only via clone-before-write (`Material.clone`, `materials/Material.js:424-426`); the per-Object override must clone, never mutate. **#358 is a live instance**      |
| **channels** (V57) | **FRESH** per Object (resolved — §10.4) | channel binds by `params.target` node-id + `paramPath` (`types.ts:1019-1022`); enumerator is id-based, kind-agnostic (`nodeChannels.ts:40-96`); each Object has its own id                               | **SAFE once locked** — transform channels target the **Object** id (auto-correct, since the Object inherits the old id, §5); data-param channels re-target to the **data** node         |
| **constraints**    | **FRESH** / per-Object (and must be)    | edge-less table scan by `params.target` (`nodeConstraints.ts:301-311,324-334`); a constraint acts on a **world pose**, which only an Object has                                                          | **SAFE** — the target-picker must offer **Object** ids only; a data-node target is incoherent (a data node has no world pose)                                                           |
| **skinning**       | **Skeleton FRESH** (only via the clone) | `cloneSkinned` / `SkeletonUtils.clone` remaps bones per clone (`SceneFromDAG.tsx:35,2371-2379`; GT Stage 6, `SkeletonUtils.js:379-388`); a plain `Object3D.clone` **shares** the skeleton → T-pose (H45) | **LANDMINE** — the split's new clone site **MUST** use `cloneSkinned`, never `Object3D.clone`; each Object gets its own skinned clone (a shared clone = a bone single-writer collision) |

**THE ARCHITECTURAL ANCHOR (upstream of transform/material/skinning — the real shape of the landmine).** Today one `GltfAssetR` instance == one clone (`useMemo([gltf.scene])`, `SceneFromDAG.tsx:2379`), and the single-writer invariant (V20) holds **per clone**. The split **must** give each Object its own clone. If two Objects ever share one clone, the transform, material and skeleton writers **all collide silently at once** — three landmines detonating together. This is the single highest-leverage thing to pin in Phase 1: **one Object ⇒ one clone**, asserted, not assumed. The evaluator memo (§10.7) correctly returns the **same value reference** to both fanned-out consumers (`evaluator.ts:119-121`) — so the freshness must be enforced at the render/clone layer, exactly where V20 already lives, not at eval.

**Net:** geometry / transform / constraints / channels are safe (channels after the §10.4 lock). Material and skinning are conditionally safe — safe **only** as long as the existing clone-before-write (`Material.clone`) and `cloneSkinned` guards are carried into every new write/clone site the split introduces. Those two are the Phase-1/Phase-3 gates.

> **⚠️ UPDATE (2026-07-17) — the MATERIAL row is answered STRUCTURALLY, not documented (§2.1.2, row 8).** The landmine is not that material is shared; it is that the sharing is **INVISIBLE** — a three.js reference nobody can see. **Give material its own node and a `material` socket, and the sharing becomes the drawn meaning of the edges**: twenty Objects wired to one Material node, change it once, twenty change — _obvious_. The §4 pre-mortem stops being a surprise and becomes the readable graph. **The table is still required for the other five bands; material — the worst offender — stops needing a warning because it stops being able to surprise.** _General form worth keeping: a band table documents where the traps are; the right noun removes the trap. Prefer the noun; table what's left._

The pre-mortem: an artist makes twenty linked copies of a prop, changes one's material, and all twenty change. That is not hypothetical — it is the documented current behaviour of the clone path, and fan-out makes it reachable by design rather than by accident.

---

## 5. Migration (V4 — mandatory)

Retiring the fused nodes is a **breaking shape change** for every saved `.basher`.

**The precedent that worked:** `migrateAnimationLayers` — a load-time **graph** pass (not a single-node `migrations` entry) that reversed `addLayer`'s rewire. Same play here:

- **Per fused node:** emit `Object(TRS)` + `<Kind>Data(rest)`, wire `data`, re-point every consumer edge from the fused id to the **Object** id, re-target every channel/constraint that names it (transform bands → Object; data params → the data node), delete the fused node.
- **Id stability is the crux.** The **Object** should inherit the old node id — every channel `target`, every constraint `target`, every saved selection, every agent closure and every test fixture names it. The _data_ node gets the fresh id. Getting this backwards silently orphans every channel in the project.
- **Read-shim for one release** so old files open.
- **Gate:** `migrations.test.ts` with a **byte-identical-render** fixture per kind (mesh, light, camera, glTF, Group, Curve).
- **Two-layer guard (V10/H14):** any newly-read field defaults safely at the evaluator **and** every consumer.

**Bundled examples must be re-saved or migrated** — verify with a grep before Phase 5, the way the unification doc verified `AnimationLayer` was absent from `src/core/project`.

---

## 6. Invariants — preserved & new

**Preserved:** V34 (one substrate) · V58 (typed sockets, no base class) · V57 (one animation road) · V104 (band applies on top) · V64 (modifier substrate) · V67 (import-root Group) · V44 (id correspondence) · H40 (render == read).

**Amended:**

- **V78** — currently _"every scene object speaks ONE socket type."_ Becomes: _…**and every scene object IS one**: an Object owning a transform, pointing at its data. The socket union and the value union are the same set._ The gap between those two halves is this entire document.

**New (to add on implementation):**

- **V-object (proposed):** _A transform is owned by exactly one node kind — `Object`. Data nodes never carry TRS and never declare `'constraint'`/`'transform'`. "Posable" is the `Object` type, never a runtime property test._
- **H-ducktype (proposed):** the trap of leaving one surface on a `'position' in value` / `isVec3(params.position)` check while the others moved to the contract → the check silently passes for a data node and the surface poses the wrong thing. (An H170 instance specific to this retirement.)

---

## 7. Phasing

Each phase: own gate (`typecheck && eslint && test && license-audit`) + **live observation** + atomic commit + self-review + catalogue/memory update.

**Phase 0 — Surface map, locked decisions, no code. ✅ DELIVERABLES COMPLETE (2026-07-17) — AT THE CHECKPOINT.**
Map every producer/consumer/serializer/test of a TRS param across the 17 fused types. Produce the **§4 shared-vs-fresh table**. Add **Maya's transform↔shape** as the third reference. **Ground-Truth the Houdini glTF SOP** (§2.1.1 currently rests on an [EXTERNAL] fetch). **Scope the §3.1 modifier move** — `ArrayModifier`'s socket change + the `sourceTransform`/`sourceMaterial` retirement — into a phase (candidate: fold into Phase 4, which already un-conflates size-vs-scale in the same helpers). **File the glTF `GeometryRef` projection as a data-lane follow-up issue (row 7) — out of this milestone, spec'd by Houdini's packed-prim/unpack model, precedent `BakedMesh`.** Resolve §10. File sub-issues. **CHECKPOINT.**

> **Phase-0 status (2026-07-17):**
>
> - ✅ **§4 shared-vs-fresh band table** — delivered (§4). Six bands stated; the architectural anchor (one Object ⇒ one clone) named as the real landmine.
> - ✅ **Maya third reference** — added (§2.1). Confirms the boundary; forbids fusion; corroborates fan-out + row 8.
> - ✅ **Houdini glTF-SOP Ground Truth** — done (§2.1.1); all four claims verbatim-confirmed; `[EXTERNAL]` gate discharged.
> - ✅ **§3.1 modifier move scoped** → folded into **Phase 4** (below); 5-file edit list recorded there.
> - ✅ **§10 resolved** — all seven items closed (§10), each grounded and the two structural calls (Transform-doesn't-survive, fan-out-safe) verified by direct read.
> - ✅ **Surface map** — 17-type map produced; expanded #356 from 1 vestigial type to **3** (§1.1); corrected the stale §0 duck-type row (`DiffOverlay` is now a parallel list, not a duck-type).
> - ⏳ **Remaining before code (needs the checkpoint's go-ahead):** file the phase sub-issues + the row-7 glTF `GeometryRef` follow-up; the small `ref/houdini/SOP.md` §6 catalogue fix. **No implementation code until this checkpoint is approved.**

**Phase 1 — `Object` + `data` land, coexisting.** New node types; nothing migrates; fused nodes untouched. Byte-identical.
_Observe:_ an Object+MeshData pair renders identically to the fused BoxMesh beside it.

**Phase 2 — The pose contract + road collapse.** `Posable` becomes the type; the three duck-types die; cameras/lights become scene children; the band applies at one road pair.
_Observe:_ the p343 kind-coverage e2e passes with **glTF added to the kind set** — the case that could not exist before.

**Phase 3 — glTF as Objects (#231 E).** The import builds Object(s) + data. `GltfAsset` stops declaring Object sections.
_Observe:_ select the imported model, add Follow Path from the real panel, it rides the path.

**Phase 4 — size-vs-scale (#231 D) + the §3.1 modifier move (folded, scoped Phase 0).** `size` is data; `scale` is Object. Un-conflates `getManipulable`'s `sizeFallback` (`Gizmo.tsx:168`).
The §3.1 modifier move rides here because both touch the same helpers. **5-file edit list (grounded):** (1) `ArrayModifier.ts` — socket `SceneObject`→data, drop TRS+material from output; (2) `MirrorModifier.ts` — identical (the only other caller of the doomed helpers); (3) `modifierGeometry.ts` — **delete `sourceTransform` + `sourceMaterial`** (their only callers are these two modifiers; all other `sourceTransform` grep hits are the unrelated driver binding), **keep** `sourceGeometryRef`/`arrayGeometryRef`/`mirrorGeometryRef`; (4) `resolveEvaluatedMesh.ts:276-329` — drop `source.transform`/`source.material` from the array+mirror branches; (5) `types.ts:538-547` — `ModifiedMeshValue` loses its TRS band + material. **Tests that break (expected):** `ArrayModifier.test.ts` / `MirrorModifier.test.ts` (transform+material assertions; **geometry survives**), `resolveEvaluatedMesh` branch tests. This confirms §3.1's thesis: `sourceTransform`/`sourceMaterial` **exist only because a mesh value fuses geometry+transform+material** — with a data-node source there is nothing to carry, so both evaporate. **Caveat:** sequence `sourceMaterial`'s deletion with row 8's `material` socket (or keep an interim shim) — do not strand material mid-flight.

**Phase 5 — Retire the fused nodes + migrate.** The only breaking phase; gated behind §5.
_Observe:_ open a pre-split `.basher` → renders identically, channels still bound, constraints still aim.

**Phase 6 — Catalogue + memory.** Promote V-object, amend V78, re-derive dharana boundaries, retire the stale road-table prose in H170.

**→ Milestone 2 — Templates / HDA.** Own design doc. **Nesting is its research question, up front** (`Solver.ts:40`: "Nested Solvers… out of scope"). Survey game-engine prefabs first (`dcc-reference.md` §24's own highest-value gap).

> Phases 1–4 are independently shippable and parity-preserving. **If scope must shrink, stopping after Phase 3 still kills #356/#357 and the duck-types** — the split coexists with fused nodes indefinitely.

---

## 8. Risks

| Risk                                                                                                 | Mitigation                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared-vs-fresh (§4)** — fan-out makes the most bug-dense area in the codebase reachable by design | The §4 band table is a **Phase-0 gate**, not a note. No fan-out UI until it exists.                                                                      |
| **Camera pose (V56/lookAt+roll)** — the deepest cut                                                  | #204 already moved the aim onto Track-To; `cameraOrientationQuat` ↔ `lookAtRollFromQuat` is a bijection. Phase-0 decides the path; parity e2e per phase. |
| **Migration orphans every channel**                                                                  | Object inherits the old id (§5). Byte-identical fixture per kind.                                                                                        |
| **Node count doubles** → outliner soup                                                               | The outliner projects **Objects only**; data is a property row, not a tree row (B12 — projection, not render inputs).                                    |
| **Agent vocabulary regresses** — "add a box" becoming 2 nodes + an edge                              | It stays **one** mutator emitting the pair. Pin with a V14 contract test + re-run #330's 10-prompt ladder.                                               |
| **Big-bang temptation**                                                                              | Strict slicing; fused coexists until Phase 5; each phase gated + observed.                                                                               |
| **Speculative generality**                                                                           | Templates explicitly out (§2.3 row 4). Collections out. The `setAtPath` precedent: no consumer ⇒ no build.                                               |

---

## 9. Test strategy

- **Unit:** Object/data evaluate parity vs the fused node (Phase 1); migration byte-identity per kind; the band contract.
- **The pin that ends the class:** _every node declaring `'constraint'` evaluates to a value carrying `position`_ — a red test. This is what the current `inspectorSectionsRegistry.test.ts` should have been (it only pins that mesh-primary nodes _lead_ with `'mesh'`, which is why glTF sailed through).
- **Ghost kind exhaustiveness** (#357): a `never` default + an explicit, justified `GHOSTLESS_KINDS` opt-out. Note exhaustiveness alone would **not** have caught glTF (it has a deliberate `return null`) — **the opt-out list is what turns a buried decision into a visible one.**
- **e2e:** per phase, drive the REAL affordance (H165 — a test that reaches past the affordance cannot test it). Boundary-pair per phase: the resolver vs the live three.js graph.
- **Falsifiability probe per phase** (mandatory, targeted inverse edit — never `git checkout`): state up front which single test goes red and why.
- **Discriminators (H171):** filter by the subject's own signature, never by a family flag. The p352 spec is the template.

---

## 10. Open questions — ✅ ALL RESOLVED IN PHASE 0 (2026-07-17)

1. ~~**Material — on the data or the Object?**~~ **RESOLVED → §2.1.2, locked as §2.3 row 8 — but note the QUESTION ITSELF was wrong.** "On the data or the Object?" imports the fused framing: it asks which of two existing things owns the material, and both references answer **neither — the material is its OWN data node, and they merely point at it.** The real answer: **a `material` socket; `MaterialValue` already exists and nothing points at it.** Object-vs-data only picks **who holds the pointer** (Blender's `link`, default `'DATA'`). Surfaced the control group (§0), a live bug (**#358**), a correction to `dcc-reference.md` §24, and the discovery that **per-face material needs the same missing word as skin weights**. _Kept visible: an open question can be wrong in its own framing, and a "resolved" answer to a mis-framed question is a locked-in error._
2. ~~**Three things currently play Object** — `Group`, `Null`, `Transform`. Does `Empty = Object with no data` collapse all three? Does `Transform` survive at all?~~ **RESOLVED (verified Phase 0).** All three own a full TRS and identical `'transform'/'constraint'/'driver'` sections (`Group.ts:39`, `Null.ts:39`, `Transform.ts:30`); they differ **only** by children-edge arity — `Null` = 0 children (`inputs:{}`), `Group` = a `children` **list**, `Transform` = a single `target` child (`Transform.ts:28`, evaluates `{kind:'Transform', pos/rot/scale, child: inputs.target ?? null}`). ⇒ **`Empty = Object-with-no-data` collapses all three: cardinality (0/N/1) is an edge property, not a type**, once parenting is the children edge (Decision 2, already locked). Group's `pivot` (V67) moves onto the Object. **`Transform` does NOT survive as a distinct kind** — it is Object-no-data wrapping one child ≡ Group with a one-element list; keep it at most as authoring **sugar**, not a value kind. _(Verified by direct read of the three node defs.)_
3. ~~**`GltfChild`** — data, or an Object in its own right?~~ **RESOLVED → an Object (Phase 3 / #231 E).** `GltfChild` is `inputs:{}, outputs:{}` — a **non-producer** (the #88/H45/B12 double-render guard, `GltfChild.ts:86-88`); it owns only a local **TRS override** + an `overridden` dirty-triple (`GltfChild.ts:57-63`), applied back by name. Both references treat a glTF node's transform as an **Object** property. ⇒ **`GltfChild` becomes an Object** (its geometry is data owned by the clone); **preserve the non-producer guard** (a handle is not a second renderer, §3.4). The `overridden` flag is a fusion artefact to re-examine on implementation, not load-bearing.
4. ~~**Channel targeting (V57)**~~ **RESOLVED — the migration crux, and the enumerator needs no change.** Channels bind by `params.target` (node-id) + `paramPath` (field); the enumerator (`nodeChannels.ts:40-96`) is **purely id-based and kind-agnostic**, and application `writeAt` is a **silent no-op on a missing path** (`overlayChannels.ts:118-120`) — the orphan mode. Because **the Object inherits the old id** (§5), transform channels (`paramPath ∈ {position,rotation,scale}`) **auto-correct** to the Object; migration re-targets **only** data-param channels (`paramPath ∈ {size,radius,material.*,…}`) to the fresh data-node id. **The §9 red test is the gate**: assert every channel's `paramPath` resolves on its target's value — that turns the silent no-op into a failure. This also settles the §4 band-4 flag: **channels are FRESH per-Object, not shared.**
5. ~~**`ScatterNode` / `BakedMesh` / `Character`**~~ **RESOLVED.** — **`ScatterNode` → DATA** (a generator with per-instance internal TRS, `ScatterNode.ts:66-77`; both Houdini and Blender put scatter on the data side); drop its Object sections; a downstream Object places the whole scatter as a unit. — **`BakedMesh` → PURELY DATA** (it IS Basher's Unpack, §2.1.1; identity TRS baked into verts, `BakedMesh.ts:8-11,85`) — a `GeometryRef{baked}` + a material spec, with the identity TRS being exactly the fusion artefact the split removes; **this retires #358 structurally** (no fused material band to drop). — **`Character` → OUT OF SCOPE** — its position/heading are **driven** by an upstream `LocomotionState` and it declares **no** `inspectorSections` (`Character.ts:30-37,43-44`); not one of the 17 fused types; revisit under the skinning milestone.
6. ~~**Maya's transform↔shape** — add as the third reference before locking §2.~~ **DONE (Phase 0) → §2.1.** Maya **CONFIRMS** the boundary and is the strongest of the three (it forbids fusion outright); native multi-parent instancing corroborates fan-out; `shadingEngine` corroborates row 8.
7. ~~**Does fan-out survive the evaluator's assumptions?**~~ **RESOLVED → SAFE, no evaluator change.** The cache key is **per node-id** (`evaluator.ts:174`); the per-call memo (`evaluator.ts:119-121`) exists **explicitly** for "multiple downstream consumers share an upstream" — so a shared data node is ordinary out-degree-2 and cooks once per call. The memo returns the **same value reference** to both consumers ⇒ the §4 shared-vs-fresh discipline (clone-before-mutate; `overlayChannels.ts:60` already does this) is what keeps that safe. The §4 landmine is a **three.js render-layer** concern, **not** an evaluator break. V42/V43 structural-sharing is unaffected. _(Verified by direct read of the memo + cache-key.)_

---

## 11. Catalogue impact (on implementation)

- **vyapti:** add **V-object**; amend **V78** (§6); amend **V104** (its consumer list shrinks when the roads collapse); confirm **V58** unchanged (it predicted this shape).
- **hetvabhasa:** **H170** — the road table shrinks from five to two-plus-surfaces; add the retirement instance **H-ducktype**; the entry's own "shelf life" warning gets its proof.
- **dharana:** re-derive the placement boundary (the one this doc is named for); **B27 explicitly NOT triggered** (§2.3 row 4) — record why, so the next author doesn't reopen it on sight of the word "container".

**Added by the design discussion itself (2026-07-17) — these do NOT wait for implementation:**

- **H173 — amend with the FOUR-INSTANCE record.** One document produced four mechanism-for-boundary errors: pointer-vs-containment, foreign-vs-converted, convert-on-import-as-parity, and "skinning is a unit". **All four were caught by the same question from outside — "why is that actually true?" — and none by the entry itself.** That is the entry's own sharpest evidence: **an author holding H173 committed H173, four times, while writing H173 down.** ⇒ its "detection signal" needs the cheap universal probe: _if you are about to call something an honest seam, name the reference that would disagree — and go read it._
- **H164/V101 — amend with the ROOT-CAUSE half this discussion found.** V101 says "project, never a parallel list", but never said **why** parallel lists get written. The answer: **a projection needs a TARGET VOCABULARY, and when the target doesn't exist the parallel list is the only expressible move.** `GltfAsset`-as-a-kind is not laziness — it is what you get when there is no word for "an Object pointing at data". ⇒ **before condemning a parallel list, ask whether the target noun exists; if it doesn't, THAT is the bug.** **Second amendment, from the material grounding: a noun can EXIST and still get parallel lists if NOTHING POINTS AT IT.** `MaterialValue` (`kind:'Material'`) has existed all along, trapped inside a wrapper — and two vocabularies grew beside it anyway, one whose docstring states it _"mirror[s] MaterialValue 1:1"_ and cites **Chesterton** as the justification. ⇒ **a mirror IS a parallel list, and "the names already match" is the excuse that writes one.** The detection signal is cheap and textual: **grep your own docstrings for "mirror", "same shape as", "parallel to", "matches X 1:1".**
- **V58 — promote from "honoured" to THE FINDING.** This doc has been treating V58 (_"the 'parent' is the existing `NodeDefinition` + typed sockets, NOT a base class"_) as a constraint it respects. It is actually **the whole answer, and the arc is evidence that we applied it to one concern out of four.** The control group (§0) is the proof: **skeleton** has the noun **and** a socket → **no defect family**; **material** has the noun and **no** socket → 3 vocabularies + #358; **transform↔data** has neither → this document. Same substrate, same era; **the only variable is whether something points at the noun, and it predicts the defect count exactly.** ⇒ record the control group in V58 itself — it is the cheapest available argument for the next author, and it is empirical, not aesthetic.
- **A new vyapti candidate — "a shared datum must be shared VISIBLY."** §4's landmine is not that three.js shares materials by reference; it is that **the sharing is invisible**. The fix is not a warning, it is a **drawn edge**: N Objects wired to one Material node **is** the sharing, on screen. ⇒ _a band table documents where the traps are; the right noun removes the trap. Prefer the noun; table what's left._
- **`dcc-reference.md` §24 — AMENDED already** (fan-out's "ceiling" is true for geometry, false for material — §2.1.2).
- **`ref/houdini/SOP.md` S14/S15 — promote from "gap" to _named blockers_ of the deform road** (§2.1.1). They were graded gaps **before** this discussion and still did not fire; record them where a skinning question will actually hit them.
- **A new hetvabhasa candidate — "the visible node is not the work."** _"Just add a Deform SOP" / "just add a GeometryRef projection"_ both feel like the fix because **the node is the visible artefact**. The node is cheap; **the words its sockets require are the expensive part.** Fired twice this session. Promote if it recurs.
- **A new hetvabhasa candidate — "one word, two jobs" (an H173 cousin about your OWN vocabulary, not a reference's).** The term _"seam"_ was used across this whole arc to mean **both** _"a false distinction that dissolves"_ (cat. 1) **and** _"a real joint we keep/build"_ (cat. 2/3). The overload silently hid a category error: a missing noun got filed as _"not a seam"_ when it is an **unbuilt** seam. Detection signal: **the same word yields opposite verdicts in two sentences** ("no seam survived" vs "these aren't seams"). The fix is the three-category sort (§0). General form: when a load-bearing word starts producing contradictory calls, the word is fused — split it before you trust either verdict. (Same shape as H172 one level up: an unstable predicate re-answered per use.)

---

## 12. Appendix — why templates are a later milestone (a SEQUENCING claim, not an architectural one)

**The DCCs' "two mechanisms" is downstream of THEIR substrates, not the domain's boundary (H173, again).** Blender needs two because a linked duplicate shares a **datablock pointer** while a node group is a **node tree** — two different kinds of thing. Houdini needs two because it has contexts plus a separate asset system. **On our one substrate the two collapse to one edge with a knob** — exactly as §2.2 collapsed pointer≡containment, one level up:

```
fan-out            = two Objects ──▶ one MeshData        (override map EMPTY  → shared RESULT)
template instance  = two nodes   ──▶ one <subgraph>       (override map FULL   → shared DEFINITION)
                     …the SAME edge; the only difference is whether the map is empty.
```

Blender's manual (_"variations require a Full Copy"_) states **fan-out's ceiling for GEOMETRY** — real, and it is why templates are a later milestone. It is **not** an architectural wall: `SolverInput` is **already a promoted parameter** (`Solver.ts` — _"the live-input leaf … A pure 0-leaf here; the seam injects the value per frame"_), hard-coded as one dedicated leaf type because we lack the word _"named knob on a subgraph."_

### What the engine actually does — MEASURED 2026-07-17, correcting this section's own prior claims

An earlier draft asserted _"cache discrimination ✓ by design; edit-propagation and partial sharing fall out **unpaid**."_ A probe (20 instances of one subgraph, each injecting a different value into a promoted-parameter leaf, counting cooks of the shared-upstream node) found **both halves of that were wrong, in opposite directions:**

| claim (old §24 / this appendix)            | observed                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| partial sharing "falls out unpaid"         | **FALSE as built.** Both override call sites (`statefulOps.ts:327,440`) pass **NO cache** ⇒ the shared upstream cooked **20×, not 1×.** Nothing is shared; it is not even happening.                    |
| "instance B can't read instance A's cache" | **TRUE, but VACUOUSLY** — it can't because there is no cache. Safety from **absence, not design.** And those two claims contradict: no-cache buys the safety AND destroys the sharing. §24 banked both. |
| _(my counter-doubt: cache would poison)_   | **ALSO FALSE.** Pass a cache and it works: upstream cooked **1×**, downstream **20×**, results `[100,101,102]` **not** `[100,100,100]`. The content-hash key discriminates correctly.                   |

**Net: §24's CONCLUSION survives, its EVIDENCE did not.** Partial sharing is real and correct **the moment an override evaluate passes a cache** — one option away, plus a Chesterton check on why the Solver seam deliberately omits it (temporal replay needs no-poisoning across FRAMES; the template case is across INSTANCES — different need, same mechanism). The engine is **more there than feared, but "one option away," not "unpaid."**

### The real blocker found by the read — the sixth firing of this arc's law

`overrides` is **one map per `evaluate()` call, keyed by `NodeId`** (`evaluator.ts:100`). Twenty instances of one template all name the **same** leaf id ⇒ **two instances cannot coexist in a single `evaluate()` call** — each needs its own call + its own map, which is why instantiation lives in a **seam OUTSIDE the evaluator** (`statefulOps.ts`). **That is the actual reason behind `Solver.ts`'s _"Nested Solvers … are out of scope"_: the seam cannot re-enter itself** — a nested instance inside a closure has nobody to call `evaluate` for it.

⇒ **the seam is a workaround for a missing noun, sixth time this arc.** If a template instance were **a node the evaluator understood** (a `body` input + named parameter inputs), the evaluator would just walk it, and **nesting would fall out by recursion.** `SolverInput` = a hard-coded leaf standing in for "named knob"; the override map = a side-channel standing in for "argument binding." Both exist because the evaluator has **no word for _"instantiate this subgraph with these bindings."_** _(Observed: the 20×/1× cook counts. Read-not-observed: the single-call collision — it follows from the API shape; flagged as such.)_

**Sequencing (unchanged conclusion, corrected grounding):** the split first — it generates live bugs _and_ makes "an instance **of what**" well-defined. Templates second, on the same engine, once instantiation is a node the evaluator walks (which is also what dissolves nesting). **Do not fuse them.**

_Findings filed: #359 (the cache-key comment drift), #360 (override evaluate passes no cache + the NodeId-keyed single-call collision). `.anvi/dcc-reference.md` §24 amended with the measured numbers._
