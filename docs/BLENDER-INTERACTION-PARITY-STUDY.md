# Blender ↔ Basher: Object Interaction Parity Study

A deep comparison of how Blender and Basher each handle **data model → outliner →
selection → transforms → multi-select**, and the full viewport ⇄ outliner ⇄
inspector loop — followed by every gap and the UX a Blender user will expect.

All Basher claims are grounded in code (file:line in the appendix). Blender is the
reference baseline. Produced 2026-06-22 from a four-pillar codebase map
(data-model / outliner / selection+transform / inspector).

> Scope note: this studies the **interaction & data model** for static scene
> objects (meshes, lights, cameras, groups, glTF imports). It does not re-cover
> animation authoring (the v0.7 unification, already shipped) except where the
> transform read/write path touches it.

---

## 1. Data model — "datablocks"

### Blender
Blender has a **three-axis** model that a director's muscle memory depends on:

1. **Object ⟷ Object-Data split.** An *Object* owns transform + name + parent +
   collection membership. Its *data* (Mesh / Light / Camera / Curve…) is a
   **separate, shareable datablock**. Two objects can share one mesh ("linked
   duplicate") — edit once, both change. `matrix_world` is real data on every
   object.
2. **Collections** — Scene → master Collection → nested Collections group objects
   for organization, visibility, and exclusion. Independent of parenting.
3. **Object→Object parenting** — *any* object can parent *any* other (move parent
   → children follow), independent of collection nesting. Lights and cameras are
   ordinary Objects, so they parent and group like anything else. Many cameras can
   coexist; one is "active."

### Basher
Basher collapses all three axes into **one fused renderable-node per scene
object**, assembled by typed DAG input edges:

| Blender concept | Basher reality |
|---|---|
| Object + Mesh datablock | **One fused node** — `BoxMesh`/`SphereMesh` carry geometry params *and* TRS *and* inline OpenPBR material on the same node. No datablock beneath. |
| Object + Light datablock | One `DirectionalLight`/`PointLight`/… node with transform **inline** in its own params. |
| Object + Camera datablock | One `PerspectiveCamera`/`OrthographicCamera` node — lens + `position`+`lookAt` inline. |
| Collection | **Does not exist.** No master/nested collections, no membership/exclusion. |
| Group (as parent/Empty) | `Group` node = transformable wrapper with a `children` list + pivot (Blender's parent/Empty, *not* a Collection). New since #222. |
| Object→Object parenting | **Only via wrapper nodes.** To make B follow A, insert a `Group`/`Transform` and wire both under it. No object→object parent pointer. |
| `matrix_world` | **Not stored.** World transform is composed implicitly by three.js nesting and re-derived purely on demand (`resolveWorldTransform`) for constraints/gizmo. |
| Linked/shared data | **None.** Two cubes are two independent nodes. The geometry cache (`GeometryRef`) is a build-time dedup keyed by params, not a shared datablock. |

**Conceptual fault lines a Blender user hits immediately:**

- **`size` vs `scale` on every primitive.** TRS lives *on the geometry node*, so a
  cube has both a geometry `size` and a transform `scale`. Blender keeps these
  apart (mesh verts vs object scale).
- **Group cannot hold lights or cameras.** `Group.children` is typed `Mesh`;
  lights/cameras wire only to `Scene.lights` / `Scene.camera`. They are pinned flat
  at the scene root, **un-groupable and un-parentable**.
- **One camera per scene, by cardinality.** `Scene.camera` is a single socket —
  wiring a new camera *replaces* the old. No "many cameras, pick active."
- **glTF interior is not real objects.** Imported children are name-addressed
  *proxies* (`GltfChild`, no scene edges); three.js owns the geometry. You **cannot
  reparent a glTF sub-mesh out of its asset**.

---

## 2. The Outliner

### Blender
Tree of Scene → Collections → Objects → data/modifiers/materials. Core actions:
click-select (viewport sync), **ctrl/shift-click multi & range**, **F2/double-click
rename**, **drag to reparent / move between collections**, eye/cursor/camera
**visibility toggles**, expand/collapse *everything*, **right-click context menu**
(delete/duplicate/select hierarchy/new collection), arrow-key navigation, a distinct
**active-vs-selected** highlight, and **auto-scroll/expand** to reveal the active
object on viewport pick.

### Basher
A pure projection of the DAG (`buildSceneTreeRows`), rebuilt on every change.

| Capability | Basher |
|---|---|
| Click-select + viewport/inspector sync | ✅ |
| Type icons | ✅ |
| Search / filter | ✅ (a box Blender lacks here) |
| Sibling reorder via drag (single-undo) | ✅ — **same-parent-same-socket only** |
| Expand/collapse | ⚠️ **glTF subtrees only**; Group/Transform/MaterialOverride chains always fully expanded |
| Multi-select (ctrl/shift/range) | ❌ row click hardcoded single-replace |
| Rename (F2 / double-click) | ❌ **nowhere** — unnamed nodes show raw ids like `n_box_2` |
| Reparent via drag (into/out of a Group) | ❌ only sibling reorder |
| Right-click context menu | ❌ none |
| Visibility / selectability / render toggles | ❌ none |
| Duplicate (Shift-D) | ❌ (project-duplicate only) |
| Delete from outliner | ⚠️ global keyboard only (overloaded w/ keyframe-delete when timeline open) |
| Active-vs-selected distinction | ❌ single "selected" style; can't show a multi-set |
| Scroll-to / expand-to selection on viewport pick | ❌ no `scrollIntoView` |
| Arrow-key tree navigation | ❌ rows aren't focusable |

**Projection artifact:** `Transform` and `MaterialOverride` wrapper nodes appear as
**their own outliner rows wrapping their target** — Blender shows
modifiers/materials *under* the object's data, never as sibling hierarchy rows.

---

## 3. Selection

### Blender
Selected *set* + one *active*. Click = replace; Shift-click = add/toggle and make
active; **box (B) / lasso / circle (C) select**; Select-All (A), Deselect (Alt-A),
Invert (Ctrl-I).

### Basher — the one place the *model* is actually right
`selectionStore` has a real `selectedNodeIds` set **and** a `primaryNodeId`
(= active). Viewport **Shift-click is additive with correct toggle +
active-reassignment** semantics. Select-All / None / Invert exist, plus a bonus
"Select by Type."

But the set is under-exploited and entry points are thin:

| Blender | Basher |
|---|---|
| Box / lasso / circle select | ❌ **none** (only stale "marquee" comments) |
| Select-All = **A** | ⚠️ bound to **Cmd/Ctrl+A**, **top-level** children only |
| Deselect = **Alt-A** | ⚠️ Esc / menu "None" instead |
| Invert = **Ctrl-I** | ⚠️ menu-only, no shortcut, top-level universe |
| Multi-select **in the outliner** | ❌ (viewport only) |
| Active-vs-selected rendering | ❌ only the primary is highlighted |

You *can* build a multi-selection (shift-click in the viewport), but you can't do it
from the outliner, can't box-select it, and **almost nothing downstream consumes the
set** (see §4–§5).

---

## 4. Transforms

### Blender
G/R/S act on the **whole selection** about a configurable **pivot** (median /
individual origins / 3D cursor / active / bbox). **Per-axis constraint** by typing
X/Y/Z; **local vs global** orientation toggle; **snapping** (grid/vertex/edge/face,
angle increments for rotate). Object **origin is editable** (Set Origin). Lights and
cameras transform like any object, including rotation.

### Basher
drei `<TransformControls>` bound to **a single node** (`primaryNodeId`).
`getManipulable` lights up any node with a `position` Vec3 → render==gizmo==inspector
for free (the V37/H40 win).

| Blender | Basher |
|---|---|
| Move/rotate/scale | ✅ (Q/W/E/R, G/R/S) |
| **Multi-object transform about a shared pivot** | ❌ gizmo binds one node; N-select moves only the active |
| Pivot modes (median/individual/cursor/active) | ❌ `viewportStore.pivot` enum exists but the gizmo **never reads it** |
| Per-axis constraint (type X/Y/Z) | ❌ drag-handles only |
| Local vs global orientation | ❌ world-space only |
| Snapping | ⚠️ **translate only**; rotate & scale unsnapped; single world-unit step |
| Set Origin / editable pivot | ❌ no UI; Group `pivot` baked at import, editable only as a stray raw Vec3 row |
| Apply Transform | ✅ (bakes to a `BakedMesh`) |
| Gizmo-move **lights** | ✅ |
| Gizmo-move **cameras** | ⚠️ **translate only** — no rotation param, aim has no handle |
| Gizmo on a **Group-nested child** | ⚠️ **suspected broken** — seeds from the *local* resolver, writes *local* params, no world→local conversion (needs observation) |

---

## 5. The viewport ⇄ outliner ⇄ inspector loop

Where the gaps compound into a workflow that *feels* unlike Blender:

- **Inspector reflects only the single primary node.** N selected looks identical to
  1 selected — no "N objects," no shared-property view. `MULTI_SELECT_SECTIONS` is
  defined but **dead**.
- **No multi-edit.** Every `setParam` targets one node id. No **Alt-click /
  copy-to-selected**. With the single-node gizmo, **the multi-selection set is
  almost inert** — you can delete it, but not transform or edit it together.
- **Lights have no "Light Data" section.** They declare only `transform`;
  intensity/color/distance/decay fall into a generic unrouted bucket.
- **No node rename anywhere.** The inspector header shows the raw `node.id` as static
  text; `meta.name` is only an aria-label.
- **Transform is local-only**, no world readout, no dimensions/bbox, Euler-XYZ only.
  It does correctly match the gizmo during playback (shared resolver).
- **Group pivot** is editable only as an unlabeled raw Vec3 row; no "set origin"
  operator.

---

## 6. End-to-end issue list (prioritized)

**P0 — breaks core muscle memory / suspected correctness**
1. **No multi-object transform** — gizmo hard-bound to one node.
2. **No multi-edit in the inspector** — no Alt-click / copy-to-selected.
3. **No box/lasso/circle select**.
4. **No rename** anywhere — objects stuck as `n_box_2`.
5. **Gizmo on Group-nested children operates in local space** — suspected world-pose bug.

**P1 — major workflow friction**
6. **No outliner multi-select** + **no active-vs-selected distinction**.
7. **No reparent via drag** — only sibling reorder.
8. **No right-click context menu** in the outliner.
9. **No Duplicate (Shift-D)** for scene objects.
10. **Cameras can't be rotated by gizmo / no aim handle** for `lookAt`.
11. **No pivot modes**, **no per-axis constraint typing**, **no local/global toggle**; **rotate/scale unsnapped**.
12. **No Set-Origin / editable-pivot UI**.
13. **Lights & cameras can't be grouped or parented**.

**P2 — conceptual mismatch / polish**
14. **No Collections** layer (only Groups-as-parents).
15. **`size` vs `scale` duplication** on every primitive.
16. **glTF children aren't real objects** — can't reparent out of the asset.
17. **Transform/MaterialOverride wrapper nodes show as outliner rows**.
18. **No visibility/hide toggles** in the outliner; **no environment/world row**.
19. **One camera per scene** by cardinality; no multi-camera "active" model.
20. **No scroll-to/expand-to selection**; **no arrow-key tree nav**; **no "Light Data" inspector section**.

---

## 7. What a Blender user expects, end-to-end

- **"Rename this to `hero_cube`."** → No rename. *(P0 #4)*
- **"Box-select these five props and move them onto the table."** → No box select;
  the gizmo moves one and the inspector edits one. *(P0 #1, #3, #2)*
- **"Shift-select three lights, set intensity = 500 on all."** → No multi-edit; no
  light-data section. *(P0 #2, light)*
- **"Drag the cube into the `set_dressing` group."** → Drag only reorders siblings.
  *(P1 #7)*
- **"Shift-D to duplicate, G to grab."** → No duplicate. *(P1 #9)*
- **"Parent this light to the camera so it follows."** → Lights/cameras can't be
  parented. *(P1 #13)*
- **"R Z 45."** → No per-axis typing; no rotation snap. *(P1 #11)*
- **"Set origin to geometry, then rotate about it."** → No Set-Origin; no pivot
  modes. *(P1 #11, #12)*
- **"Rotate the camera to frame the shot."** → Camera gizmo only translates. *(P1 #10)*
- **"Right-click → Delete Hierarchy."** → No context menu. *(P1 #8)*
- **"Click the cube — show me where it is in the outliner."** → Highlights but
  doesn't scroll/expand. *(P2 #20)*

**The encouraging part:** the *foundations* are sound. The selection model already
has a proper set + active; selection sync across the three panels works; the
gizmo/inspector/render share one resolver so they never disagree; Group parenting and
import pivots are correct. The gaps are overwhelmingly **missing surface area on a
correct substrate** — wire the existing set into the gizmo and inspector; add
box-select, rename, context menu, reparent-drag. The genuinely architectural ones are
the **object/data split, Collections, and making lights/cameras first-class
groupable objects** — those touch the node model.

---

## Appendix — grounding (file:line)

**Data model**
- Node/Op/DAG: `src/core/dag/types.ts:162-251`; evaluator `src/core/dag/evaluator.ts:115-193`; values are POJOs `src/nodes/types.ts:1-7`.
- Scene (camera single, lights/children/lightRig lists): `src/nodes/Scene.ts:41-72`.
- Group (transform + pivot, children list typed `Mesh`): `src/nodes/Group.ts:21-54`; `GroupR` pivot math `src/viewport/SceneFromDAG.tsx:2637-2662`.
- Transform (single `target`): `src/nodes/Transform.ts:15-39`.
- BoxMesh fused geometry+TRS+material; `size` vs `scale`: `src/nodes/BoxMesh.ts:12-25`; `src/nodes/types.ts:467-469`.
- Lights inline transform: `src/nodes/DirectionalLight.ts:5-20`; `AmbientLight.ts:10-13`; values `src/nodes/types.ts:49-110`.
- Cameras inline `position`+`lookAt`: `src/nodes/PerspectiveCamera.ts:5-23`.
- GltfAsset (assetRef + projection meta): `src/nodes/GltfAsset.ts:17-120`. GltfChild (no scene edges): `src/nodes/GltfChild.ts:86-92`.
- World transform re-derivation: `src/app/resolveWorldTransform.ts:6-28,118-213`.
- Identity/naming: `src/app/addPrimitives.ts:41-43,102-107`; `nodeDisplayName` `src/app/sceneTreeWalk.ts:69-73`; glTF content-addressed ids `src/core/import/gltfImportChain.ts:140-168`.

**Outliner**
- Tree projection: `src/app/sceneTreeWalk.ts:81-218`; component `src/app/SceneTree.tsx`; icons `src/app/SceneTreeIcon.tsx`.
- Wrapper rows: `src/app/sceneTreeWalk.ts:115-127`. glTF children projection: `:152-201`.
- Click select: `SceneTree.tsx:191`. Sibling-only drag: `SceneTree.tsx:88-151` (`canDropOn` `:107-112`). glTF-only collapse: `:172,201-215`.
- No rename/context-menu/eye toggle (grep-confirmed absent in `SceneTree.tsx`).

**Selection + transform**
- Store (set + primary): `src/app/stores/selectionStore.ts:13-89`.
- Viewport click + shift-additive: `src/viewport/selectNodeOnClick.ts:30-36`; pick path `src/viewport/SceneFromDAG.tsx:980-1049`; pointer-missed `src/viewport/Viewport.tsx:215-225`.
- Select-All/None/Invert: `src/app/KeyboardShortcuts.tsx:307-311,230-239`; `src/app/MenuBar.tsx:627-657`.
- Gizmo single-node bind + `getManipulable`: `src/app/Gizmo.tsx:86-121,109`; modes/snap `:167-175,305-365`; seeding from local resolver `:177-261`.
- Pivot enum unused by gizmo: `src/app/stores/viewportStore.ts:28,57,170`.
- Local vs world: `src/app/resolveEvaluatedTransform.ts:118-271`; `src/app/resolveWorldTransform.ts` (constraints, not gizmo).
- Apply Transform: `src/app/MenuBar.tsx:585-609`.

**Inspector (NPanel)**
- Drives off `selectedNodeId`(=primary): `src/app/NPanel.tsx:1867-1868`; empty/1/N states `:1953-1973`.
- Section dispatch from `node.inspectorSections`: `:1880-1881,2026`; routing `src/app/inspectorSections.ts:75-212`; dead `MULTI_SELECT_SECTIONS` `:62-66`.
- Per-type sections: see node defs (`Group.ts:39`, `PerspectiveCamera.ts:36`, `GltfChild.ts:92`, `Scene.ts:51`, `PointLight.ts:31`).
- Edit/keyframe model: `NPanel.tsx:204-282,241,414`; transform read-only gate `src/app/resolveTransformParam.ts:71-130`.
- No multi-edit / no node rename (grep-confirmed: no `altKey`, no `meta.name` write in NPanel).
