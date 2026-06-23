# #231 — Unified-Object Data-Model Parity (Design Milestone)

Design doc for the **first** slice of Blender data-model parity (#231): make
lights & cameras first-class **groupable / parentable objects**, and give the
scene a real **multi-camera "active" model**. This is the architectural keystone
the rest of #231 (Collections, the object↔data split, glTF-children-first-class)
build on.

> **Status:** DESIGN — awaiting checkpoint approval before any code.
> **Branch:** `ux-overhall`. **Tracking issue:** #231 (sub-issues filed per increment on approval).
> **Companion study:** `docs/BLENDER-INTERACTION-PARITY-STUDY.md` (§1 data model, §6 items 13/19/16).

---

## 0. Locked decisions (from the planning fork)

| # | Decision | Choice |
|---|----------|--------|
| Scope | Which #231 sub-problems first | **Unified-Object foundation** — groupable/parentable lights & cameras (A) + multi-camera active (B) + path to glTF-children-first-class (E). Collections (C) and the object↔data split + size-vs-scale (D) are **later milestones**. |
| Parent socket | How lights/cameras become groupable | **One unified `SceneObject` socket** — mesh/light/camera/group all output `'SceneObject'`; `Scene.children` & `Group.children` accept it. Mirrors Blender's "everything is an Object." |
| Active camera | Multi-camera "active" model | **`CameraSelect` node** (the ClipSelect / LightProfileSelect / LightRig pattern, V63) — active choice is a keyframeable param → camera cuts fall out for free. |
| Collections (later) | Org grouping | **Collection node**, DAG-resident (V34). Out of scope for this milestone; recorded for the later one. |

---

## 1. The two reference models (grounded)

### Blender (the baseline — grounded in the bundled manual)
- **Everything is an Object.** An *Object* datablock owns transform + parent +
  collection membership; the *data* it points at (mesh verts / camera lens /
  light power) is a separate datablock. Lights and cameras are ordinary Objects,
  so they **parent and group like anything else** (`scene_layout/object/editing/parent.rst`
  — "the parent object can be of any type").
- **Parenting:** select children, parent last, **Ctrl-P**; at most one parent;
  a hidden **parent-inverse** matrix keeps the child from jumping (Keep
  Transform). **Alt-P** clears, keeping transform.
- **Multiple cameras, one active.** Many cameras coexist; the scene holds **one
  active-camera pointer** (per-scene). **Ctrl-Numpad0** sets the selected camera
  active; the active one shows a **solid filled triangle**. Camera cuts via
  **Bind Camera to Markers (Ctrl-B)** — a marker switches the active camera at
  its frame (`editors/3dview/navigate/camera_view.rst`, `animation/markers.rst`).

### Basher today (grounded in source)
- **Strict string-typed sockets** — `ops.ts:181` throws on
  `inputDesc.type !== outputDesc.type`. So a `'Light'`/`'Camera'` output
  **physically cannot** connect to a `children: 'Mesh'` socket. *This is the
  root cause of "lights/cameras can't be grouped."*
- `Scene` sockets: `camera` single `'Camera'`, `lights` list `'Light'`,
  `children` list `'Mesh'`, `lightRig` single `'LightRig'` (`Scene.ts:41-49`).
- `Group.children` list `'Mesh'` (`Group.ts:37`).
- **Active camera = the node wired to `Scene.camera`** (`activeCamera.ts:66-77`).
  Wiring a new camera *replaces* the old (single cardinality).
- **Cameras are already enumerated globally** for selectable frustums —
  `cameraNodeIds = Object.values(state.nodes).filter(type==='*Camera')`
  (`SceneFromDAG.tsx:200-206`, #165). Camera *bodies* are NOT in
  `value.scene.children`.
- **Render bands** (`SceneFromDAG.tsx:230-309`): three parallel walks —
  `value.scene.lights[i]` → `LightNode` (id via `lightRefs[i].node`),
  `rigLights[i]` → `LightNode` (id via `rigLightSources[i]`, V63), and
  `value.scene.children[i]` → `SceneChildNode` (id via `childRefs[i].node`).
  Each keyed by **edge-order index-correspondence** (V44).
- **`SceneObject` value union already partially exists in spirit** —
  `types.ts:10-12`: "P1 widens three unions (Camera / Light / SceneChild) so the
  existing socket types carry richer variants without the DAG type system needing
  to grow." The values are ready; only the *socket type strings* and the
  *consumer sockets* need to converge.

---

## 2. Target end-state architecture

```
                       output socket type 'SceneObject' (was Mesh|Light|Camera)
  BoxMesh, SphereMesh, BakedMesh, ModifiedMesh, GltfAsset,
  Transform, Group, MaterialOverride, Scatter, Character,        ─┐
  DirectionalLight, PointLight, SpotLight, AreaLight, AmbientLight,│  out: 'SceneObject'
  PerspectiveCamera, OrthographicCamera                          ─┘
                                   │
            ┌──────────────────────┼───────────────────────┐
            ▼                      ▼                        ▼
   Group.children:[SceneObject]  Scene.children:[SceneObject]   CameraSelect.cameras:[SceneObject]
   (nesting → parenting)         (top-level scene list)         │ active = keyframeable param
                                                                ▼  out: 'SceneObject'(a Camera)
                                                          Scene.camera (single) → render viewpoint

  SceneObject (value union) = SceneChild | LightValue | CameraValue
  renderer/outliner/selection switch on value.kind  (the band already does this for SceneChild)
```

Key properties:
- **One socket type, strict equality preserved** (no loosening of `ops.ts:181` —
  the user rejected the multi-type-union option). Every scene object speaks
  `'SceneObject'`.
- **Lights/cameras nestable in a Group** → groupable + parentable, inheriting the
  Group's world transform (the #222/#230 nested-world path).
- **Cameras coexist**; `CameraSelect` picks the active one → `Scene.camera`. The
  selector's `active` is a normal param, so it is **keyframeable** (V57) — camera
  cuts over a shot for free (Blender's bind-to-markers, but animatable).
- **LightRig (V63) is untouched** — rig lights stay their own band by design
  (the studio-lighting profile precedent).

---

## 3. Blast radius (grounded, by concern)

| Concern | File(s) | Change |
|---|---|---|
| Value union | `src/nodes/types.ts` (`SceneChild` :874, add `SceneObject`) | Add `SceneObject = SceneChild \| LightValue \| CameraValue`. |
| Output socket types | every light/camera/`Group` node def | `outputs.out.type: 'Mesh'\|'Light'\|'Camera'` → `'SceneObject'`. |
| Consumer sockets | `Scene.ts:41-49`, `Group.ts:37`, `LightRig.ts:42` | accept `'SceneObject'`. |
| Connect validation | `src/core/dag/ops.ts:181` | UNCHANGED (strict equality still holds — types converge, rule doesn't loosen). |
| Renderer bands | `SceneFromDAG.tsx:230-309`, `GroupR` :2635-2662, `SceneChildNode` kind switch :539/:913 | `GroupR` child walk + `SceneChildNode` gain light/camera `kind` branches; nested light/camera world via the #230 `resolveParentWorldMatrix`. |
| World transform | `src/app/resolveWorldTransform.ts` | nested light/camera compose parent world (reuse #230 path). |
| Active camera | `src/app/activeCamera.ts:66`, `EditorViewCamera.tsx`, `renderImageAction.ts`, `renderAnimationAction.ts` | `selectActiveCameraNode` resolves through `CameraSelect` (fallback: direct `Scene.camera`). |
| Outliner | `src/app/sceneTreeWalk.ts`, `SceneTree.tsx`, `SceneTreeIcon.tsx` | project nested lights/cameras; reparent-drag `canReparent` (children socket now `SceneObject`); icons exist. |
| Selection / gizmo | `selectableNodes.ts`, `Gizmo.tsx` | `getManipulable` already lights up any node with `position` — nested light/camera gizmo reuses #230. |
| Duplicate / delete / reparent | `src/app/sceneNodeActions.ts` | `HIERARCHY_SOCKETS`/`reparentSocket` already key on `children` — work once it's `SceneObject`. |
| Migration | `src/core/project/migrations.ts` + tests | see §4. |

---

## 4. Invariant discipline & migration (the crux)

Three project invariants govern correctness here:

- **V44 — correspondence by stable id, never re-derived name.** When lights join
  the `children` band, their per-node addressing (DirectChannelsR / Constrained /
  click-select) must key off the **child node id** (`childRefs[i].node`), exactly
  as meshes do today. *This is strictly more correct than the current parallel
  `lights` band* (which already keys by `lightRefs[i].node`).
- **V10 / H14 — two-layer defaults, byte-identical render for saved projects.**
  Every new field defaults to identity in BOTH the zod `.default` and the
  evaluator/consumer.
- **V63 — LightRig index-correspondence stays byte-identical.** The rig band is
  not merged into children.

**Migration risk R1 (gates the whole milestone):** does loading a saved project
**re-validate socket types**? Connect-time validation (`ops.ts:181`) runs on
`connect` ops, not necessarily on hydration. If hydration does NOT re-type-check
existing edges, then **renaming an output socket type string is zero-migration
and byte-identical** — the edges are `{node, socket}` refs that don't carry the
type. *This must be proven first* (a migration test loading a pre-change project
+ asserting identical evaluated scene) before relying on it. If hydration DOES
re-validate, Increment 1 needs a migration that is still a pure string remap.

---

## 5. Increment sequence (each: own gate `typecheck && eslint src/ && test` + live observation + atomic commit + push + self-review + catalogue/memory update)

### Inc 1 — Socket convergence (foundational, byte-identical) ⟶ unlocks the type system
- Add `SceneObject` value union (`types.ts`).
- Retype every scene-object node's output to `'SceneObject'`; retype
  `Group.children` / `Scene.children` / `Scene.lights` / `Scene.camera` /
  `LightRig.lights` consumers to `'SceneObject'`.
- **No behavior change.** Renderer still reads `value.scene.lights/.camera/.children`
  separately. Prove R1: a migration/hydration test loads a saved project →
  byte-identical evaluated scene + render. **Gate + observe before commit.**
- *Risk:* `Scene.lights`/`Scene.camera` now loosely accept any `SceneObject`
  (a mesh could be mis-wired into `lights`). Acceptable transitionally; the
  full fix is Inc 4 (flatten). **OPEN QUESTION Q-A** (see §7).

### Inc 2 — Groupable / parentable lights & cameras (capability A) — SPLIT 2a/2b
Split into 2a (lights, DONE) and 2b (cameras, deferred to fold with Inc 3) once
grounding revealed the camera coupling (see the note after 2a).

**Inc 2a — LIGHTS ✅ SHIPPED** (`b9a77d3` capability + `7ea7bf9` authoring + `5e6c1c7`
catalogue):
- `GroupValue.children: readonly SceneObject[]`; `MeshChild` gains light kind
  cases → `LightKindR`. A nested light inherits the group's WORLD via `GroupR`'s
  `<group>` nesting (render == resolver, H40) — the world resolver needed NO
  change (its `walk`/`childEdges`/`localMatrix` already descend `Group.children`
  and handle a light's TRS, so nested-light world + the #230 gizmo parent-world
  resolve through the existing path).
- Outliner: top-level lights now project as rows (`buildSceneTreeRows` walks
  `scene.lights`); kind-aware reparent (`SceneTree.canReparent`/`reparentSocket`)
  — a light drags into a Group's `children` and back to `scene.lights` (its rich
  band).
- OBSERVED: `p231-grouped-light` (rendered light at group-composed world [6,0,0]
  == resolver, new `__basher_light_world_positions` seam) + `p231-light-reparent`.
- KNOWN-LIMITS (v1): a nested light renders STATIC — its direct-channel
  animation / Track-To / viewport helper stay on the top-level band (nodes still
  in the DAG → no data loss; reparent-back restores). [[V78]] status extended.

**Inc 2b — CAMERAS (DEFERRED → fold with Inc 3).** Grounding finding: a camera is
NOT in `children`/`lights` — it's wired to `Scene.camera`, a SINGLE socket. Making
a camera groupable cleanly needs Inc 3's model first (cameras coexist + a
`CameraSelect` picks active), because with one camera socket "a camera nested in a
group" is awkward to wire. And the nested-camera POSE work — frustum-at-world
(`resolveWorldTransform` camera branch :290 ignores parent;
`resolveParentWorldMatrix` short-circuits cameras :419), look-through, render
camera (all read LOCAL pose via `cameraPoseFromNode`) — is the SAME
camera-pose-under-parent machinery Inc 3 touches. So do Inc 3 first (or combined),
then nested-camera pose builds on it.

### Inc 3 — Multi-camera active model (capability B) + cameras-grouping (2b)
- New `CameraSelect` node (ClipSelect pattern): `cameras: list 'SceneObject'`,
  param `active` (index or name), output single `'SceneObject'` → `Scene.camera`.
- `selectActiveCameraNode` resolves through `CameraSelect` (fallback to direct
  `Scene.camera` for pre-change projects).
- UI: camera list + "Set Active" (Ctrl-Numpad0 analog) + active indicator
  (Blender's solid triangle). `active` keyframeable → camera cuts.
- **Observe:** two cameras, switch active → look-through + render follow;
  keyframe `active` → render cuts at the frame. e2e + screenshot.

### Inc 4 — (stretch / optional this milestone) Flatten Scene top-level
- Migrate `Scene.lights` + the camera *body* into `Scene.children` so top-level
  lights/cameras are also "in children" (the fully-flat Blender model). Deepest
  migration; **A + B already deliver the director-facing parity**, so this can be
  its own increment or deferred. Resolves Q-A's transitional looseness.

### Path to E (glTF children first-class) — follow-on milestone
- Promote `GltfChild` proxies to real `SceneObject` nodes (reparentable out of
  the asset), governed by V44. Out of this milestone's core; noted for sequencing.

---

## 6. Risks

- **R1 hydration re-validation** — gates Inc 1's zero-migration claim. *Prove first.*
- **R2 nested light/camera world** — reuse #230 `resolveParentWorldMatrix`; do
  NOT invent a parallel walk (Chesterton — the resolver mirrors the renderer).
- **R3 V44 band addressing** — lights-in-children must key by node id.
- **R4 V63 LightRig** — rig band stays separate; don't merge.
- **R5 camera double-render** — cameras-in-children must render only the frustum
  helper (already state-driven, #165), never a geometry body; the active one
  feeds the view, not the scene graph.
- **R6 #229 CameraGizmo / look-through / render camera** — must keep working when
  cameras are also children (the gizmo + roll/aim bijection V77 are unchanged;
  only "where the camera node lives" changes).

---

## 7. Open questions for the checkpoint

- **Q-A (Inc 1 scope):** In Inc 1, do we (i) retype `Scene.lights`/`Scene.camera`
  loosely to `'SceneObject'` and accept transitional impurity until Inc 4
  flattens, or (ii) pull Inc 4's flatten forward so there's never a loose
  `lights` socket? (i) is smaller/safer per increment; (ii) is purer but a bigger
  first migration. **Recommendation: (i)** — ship A + B on a safe substrate, then
  flatten.
- **Q-B (CameraSelect addressing):** `active` by **index** (edge order, like
  ClipSelect) or by **name** (stable across reorder)? **Recommendation: index**
  for parity with the existing ClipSelect/LightProfileSelect precedent; revisit
  if reorder churn bites.
- **Q-C (Inc 4 in or out):** is flattening Scene top-level part of THIS milestone
  or the next? **Recommendation: out** (separate increment after A + B land).
