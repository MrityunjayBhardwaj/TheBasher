# Procedural Operators & Studio Lighting — Design

> Status: **DESIGN / not yet implemented.** Branch context: `ux-overhall`.
> Captures the end-to-end architecture agreed in design discussion (2026-06-18).
> This is a living contract — the foundation (typed operator chains) is durable;
> the studio-lighting feature is the first consumer that motivated it.

## 0. The shape in one screen

We want a Blender-Light-Studio-style lighting workflow (paint lights onto the
subject, named switchable lighting profiles). Pulling that thread to its root
landed on a foundational decision that is bigger than lighting:

- **Constraints and modifiers are the same architectural pattern** — an *ordered,
  non-destructive chain of typed operators over a base value*. They differ only
  in the data type that flows (transform vs geometry). This is Houdini's
  SOP/CHOP/VOP model.
- **The substrate already exists.** Basher is a typed dataflow DAG. The "parent"
  of SOP/CHOP/VOP is the universal node interface **`NodeDefinition<Params,
  Value>`** + the typed socket system — every node already implements it. We do
  **not** build a new parent class.
- **The one new shared abstraction is `OperatorStack`** — chain wiring + stack UI
  (add/remove/reorder/mute) + serialization + agent op — *polymorphic over the
  value type*. Instantiated twice: a **transform stack** (constraints / CHOP) and
  a **geometry stack** (modifiers / SOP).
- **Shading (VOP) is already done** as a parametric IR (OpenPBR, renderer-agnostic
  → TSL/WGSL later). We deliberately choose a parametric über-shader over an
  arbitrary shader node-graph.
- **Studio lighting is the first consumer** of the constraint stack (lights *aim*
  via a Track-To-style constraint, not stored rotation) and reuses the already-
  unified mesh/material/animation roads.

Sequencing: make **world transform a pure evaluable value** → build
**`OperatorStack`** → **CHOP/constraints** (Track-To + migrate the camera) →
**studio lights** on top → **SOP/modifiers**.

---

## 1. Motivation — the lighting feature (Blender Light Studio)

Source studied: `github.com/nortikin/blender-light-studio` (read end-to-end).

### 1.1 What it actually is
Not the commercial "HDR Light Studio" model (paint into one equirectangular HDRI
at infinity). BLS uses **real, textured emission cards placed on a sphere around
the subject, aimed at center** — finite distance, real position/falloff,
individually selectable & animatable. A flat "2D panel" is only a *controller*
for spherical placement; the output is 3D lights, not a baked image.

### 1.2 The clean data model (the `.bls` JSON — ignore the Blender object soup)
```
Profile {
  name
  handle_position: [x,y,z]        // the rig's aim target (the sphere origin)
  lights: [ Light {
    position: [x,y,z]             // controller's spot on the 2D panel → spherical placement
    radius                        // distance from center (sphere radius)
    scale: [x,y,z]                // light card size → softness + power (area = flux)
    rotation                      // spin of the card
    tex                           // HDR/EXR emitter texture
    Intensity, Opacity, Falloff, Color Saturation, Half   // emission params
    mute
  } ]
}
```
A scene holds **many named profiles**; one is live at a time; profiles
import/export as JSON and copy between scenes.

### 1.3 The signature feature — the Light Brush
`light_brush.py:raycast`. Click the *model surface* in the viewport → raycast →
hit point + normal → compute:
- **Reflection mode:** `reflect(viewDir, normal)` — "where must a light be so its
  *specular highlight* lands exactly where I clicked?"
- **Normal mode:** the surface normal (diffuse placement).

Intersect that ray with the subject sphere (radius = light distance) → 3D light
position → convert back to the 2D controller `(atan2 → x, elevation → y)`.
**You paint the highlight; the light flies to the position that produces it.**
Plus modal Grab / Scale / Rotate (G/S/R).

### 1.4 The two-layer model (important reframe)
BLS never touches the world HDRI. The **global environment / IBL** (Basher already
owns this — scene environment, V47) and the **local studio lights** are two
*separate layers*: HDRI = soft global fill, studio lights = local directional
shaping. Studio lights are **additive** to the env, not a replacement.

### 1.5 The renderer reality (honest constraint)
BLS works because a Cycles area light **can** be textured *and* casts shadows.
three.js (Basher today) can't do either in one object:
- `RectAreaLight` **illuminates** but **can't be textured and casts no shadows**
  (LTC approximation).
- An **emissive textured plane** looks right + shows in reflections but **doesn't
  illuminate** other objects in the raster renderer (no mesh-emitter GI).

So "a textured area light that lights the subject" is **a pair** in our renderer:
a `RectAreaLight` (illumination, driven by the texture's average color +
intensity) **+** an emissive textured card (the visible look + reflections). The
**WebGPU/TSL path-tracing renderer** (v0.7 epic) can make this *one* primitive
later — see `PERFORMANCE.md` / the renderer epic. **Decision:** build the workflow
now against the pair (the placement resolver, panel, brush, profiles are all
renderer-agnostic); let the renderer epic upgrade the light *primitive*
underneath.

---

## 2. The foundational substrate — typed operator chains on the DAG

### 2.1 The parent already exists — do not build a new one
SOP / CHOP / VOP in Houdini are not subclasses of an "Operator" base — they are
**nodes in one graph engine, differentiated only by the data type on their
ports**. Basher is identical: every node type implements **one** interface,
`NodeDefinition<Params, Value>` (params schema + typed inputs/outputs +
`evaluate`). **That is the parent of SOP/CHOP/VOP.** The three categories differ
only by wire type:

| Houdini | flows | Basher socket type | = |
|---|---|---|---|
| **SOP** | geometry | `Mesh` / `Geometry` | **modifiers** |
| **CHOP** | channels / transforms | `Transform` / `KeyframeChannel` | **constraints** |
| **VOP** | shading | the material IR | **shaders** |

Building a class *above* SOP/CHOP/VOP would be ceremony over the thing that
already unifies them.

### 2.2 The one new abstraction worth building — `OperatorStack`
The genuinely shared concern is the **stack**, not the operators: an *ordered,
non-destructive chain over a base value* with add / remove / reorder /
**mute-bypass** / stack-inspector UI / serialization / an agent op ("add a
Subdivide" / "add a Track-To"). Identical for geometry and transform → one thin
**value-type-polymorphic `OperatorStack`**, instantiated as:
- a **transform stack** (constraints), and
- a **geometry stack** (modifiers).

This is a *wiring + UI + serialization* helper, not a god-class over operators.
It is earned by two real consumers (the "build the shared thing when the second
consumer arrives" rule), not speculative.

Internally a stack is a **linear sub-chain in the DAG** (each operator's input =
the previous operator's output). The "stack" is sugar; **reorder = re-wire**.
Blender's clean two-stack UX on top of Houdini's one-graph engine.

### 2.3 Why one substrate, not two systems
Both reduce to the same machine over different types. Blender's depsgraph (which
orders modifiers, constraints, drivers across all objects) is itself a DAG;
Houdini is explicitly a typed node graph. Basher already *is* that DAG — so
modifiers and constraints are new node **categories** + the stack sugar, **not
two new engines.**

---

## 3. What's already unified (grounded — verified in code 2026-06-18)

Primitives and glTF already collapse onto one road on every axis — this is the
precondition that lets the operator chains land on a single type:

| Axis | Mechanism | Status |
|---|---|---|
| Mesh model (geometry+UVs+material+transform) | `resolveEvaluatedMesh` projects BoxMesh / SphereMesh / GltfChild into ONE `EvaluatedMesh`; no consumer branches on kind | ✅ (#150) |
| Transform (TRS) | primitives now carry full position+rotation+**scale** (v0.6 #1 migration); both delegate to the one `resolveEvaluatedTransform` band | ✅ |
| Material | glTF captured into the **same OpenPBR IR** as native (#178); editors converged onto shared `MaterialRows` (#198) | ✅ |
| Animation | native + glTF + camera + agent author/render/read via free-floating direct channels (V57) | ✅ |
| UVs | one producer; box/sphere sync, glTF async via the same `extractUVIslands` | ✅ (async caveat) |

**The one un-unified thing — and it's exactly the constraint gate:** accumulated
**world transform is composed downstream in `SceneFromDAG`**, not as a pure
evaluable value. Local TRS lives in the DAG; "where does this end up in the world"
is assembled at the scene layer. A constraint needs the *target's world
transform* as a pure value. See §4.3.

---

## 4. CHOP — Constraints (the transform operator stack)

### 4.1 The aim model — target, not stored rotation
An object does not store a baked rotation it has to keep in sync. It carries a
**`target`** and *derives* orientation from (position → target) via a pure
resolver — exactly the camera's existing `lookAt` (`resolveActiveCameraPoseAt`,
V56). Two flavors, one resolver:
- **point** (vec3) — aim at a fixed spot (identical to the camera's `lookAt`
  today). The baseline.
- **node reference** — aim at *another node* (e.g. the hero mesh): the resolver
  reads that node's evaluated world position and aims there. This is "Track To a
  moving object" as a **pure read** — no parenting (which would also inherit the
  subject's rotation), no solver, and it keyframes for free.

The BLS "handle" (rig origin/aim center) is modeled as a **`target` value on the
rig**, not a parent in the scene graph — a soft pointer, animatable, with no
structural re-parent edits.

### 4.2 The camera migration IS the proof (dogfood)
The first constraint the system ships is **Track-To**, and the first thing it does
is **absorb the camera's intrinsic `lookAt`** → the camera becomes a normal object
with a Track-To constraint. This (a) deletes the camera's special case (the
inconsistency that motivated the whole thing — camera derives orientation while
every other object stores rotation), (b) dogfoods the stack on a real consumer
before lights exist, (c) proves render parity end-to-end (the camera already
renders through the evaluated scene). Studio lights are then the **second**
consumer of the same Track-To, not a third special case.

### 4.3 The hard gate — world transform as a pure evaluable value
A constraint reads another object's **world** transform. Today that's composed in
`SceneFromDAG`, not in pure evaluation. The core engineering work of CHOP is to
make accumulated world transform a **pure function of (DAG state, time)** that a
constraint can read, so viewport and offscreen render agree (V37). It's solvable
(the composition is already deterministic) but it is *the* foundational task —
build it first.

### 4.4 Evaluation order is already solved
A constraint's target is modeled as a **normal DAG input edge**. The evaluator
already does **topological-sort dependency resolution with cycle detection**
(`src/core/dag/evaluator.ts` — "Resolve dependencies via topological sort";
throws `cycle detected`). So ordering + cycle-breaking come **free** from tested
machinery. This is why a constraint system is *cheaper* in Basher than in a
conventional engine — it fits the grain.

### 4.5 v1 constraint set (north star ≠ v1 scope)
Ship the **framework + a handful**: Track To, Copy Location / Copy Transforms,
Child Of, Limit (Location/Rotation), Follow Path. Blender's full ~25-constraint
list (`docs.blender.org/manual/en/latest/animation/constraints`) is the **north
star, not the v1 scope** — add on demand once the stack + world-transform model
are proven. Do not let "support all of Blender's" become the v1 swamp.

---

## 5. SOP — Modifiers (the geometry operator stack)

Geometry-typed operators (`Geometry → Geometry`) over the unified `EvaluatedMesh`
(§3) — so **no per-source branching** (a modifier doesn't care if the base is a
primitive or a glTF child). Same `OperatorStack`, geometry value type.

- Geometry is a **handle** (`GeometryRef`), never inlined buffers (interface
  depth) — the registry builds box/sphere on demand, glTF geometry from the loaded
  clone. A modifier consumes/produces handles.
- v1 set: Subdivide, Mirror, Array, maybe Solidify/Bevel. Order matters (it's the
  geometry chain). Blender Geometry Nodes is the long-horizon analog; not v1.

(SOP is sequenced *after* CHOP — constraints are the lighting blocker; modifiers
are independent value-add.)

---

## 6. VOP — Shading (already done; a deliberate choice)

- **VOP as a standardized parametric material** (an über-shader with editable
  lobes) → **done.** The OpenPBR IR is renderer-agnostic by design — three.js
  materials today, TSL/WGSL later (the IR is an explicit compile target). Evolving,
  not missing.
- **VOP as an arbitrary procedural shader *graph*** (wire noise → ramp →
  displacement → surface) → **not built, and intentionally deprioritized.**
  OpenPBR is a *fixed* model, not a node graph. For Basher's director-first /
  agent-native positioning, a great über-shader is the right altitude; full
  shader-graph authoring is a power-user feature most users (and the agent) don't
  want. **This is a conscious choice, not an accidental gap.**

---

## 7. Studio Lighting — the first end-to-end consumer

Layered entirely on the foundation above. New parts are small; most falls out of
existing systems.

### 7.1 `StudioLight` (the textured area light)
The render realization of §1.5: a `RectAreaLight` (illumination, color/intensity
driven by the texture's average) **+** an emissive textured card (look +
reflections). Params mirror the `.bls` Light: `position` (spherical, on the rig),
`radius` (distance), `scale` (card size → softness/power), `rotation` (card spin),
`tex` (HDR/EXR from the env asset store, V47/V41 content-hash + `.basher` embed),
`intensity / opacity / falloff / saturation`, `mute`. Every param is animatable
(V57) — keyframe a lighting setup over a shot, which BLS itself can't do.

### 7.2 The `LightRig` (the sphere + aim center)
Holds the `target` (the BLS "handle" — point or node-ref, §4.1) = the sphere
origin every light on the rig aims at, plus the radius/handle. Aiming is the
Track-To constraint (§4) — **the rig is a constraint-stack consumer, not a bespoke
mechanism.**

### 7.3 The 2D control panel
A new 2D surface (sibling of the dopesheet/curve-editor canvases). Maps controller
(x, y) → spherical (azimuth, elevation) around the rig target via **one pure
function** `resolveStudioLightTransform(panelXY, radius, target) → { position,
orientation }` (the V56/V51 "one pure resolver" shape). Render-parity-friendly.

### 7.4 The Light Brush
A viewport modal tool (sibling of the gizmo tools): R3F raycaster against scene
meshes → hit + normal → `reflect(viewDir, normal)` or `normal` → intersect with
the rig sphere (radius) → light transform → write back to the panel coords. Pure-
function core; the modal is just input. G/S/R aux like BLS.

### 7.5 Profiles
Named, switchable lighting setups (one live at a time), JSON import/export, copy
between scenes — mirrors the `.bls` model, and a sibling of Basher's Shot/Cut
node concept. Each profile is a DAG subgraph (a rig + its lights). Switching =
which rig feeds the scene's lights. **Animatable** because the params are
channels — a profile can itself be keyframed.

### 7.6 Layering with the global HDRI
Studio lights are **additive** to the scene environment (V47), not a replacement
(§1.4). HDRI = global ambient; studio lights = local shaping. They coexist.

---

## 8. Invariants this design must hold

- **Render parity (V37/V51):** every operator (constraint, modifier) and every
  resolver (aim, spherical placement, brush) is a **pure function of (DAG state,
  time)**, evaluated identically for the viewport and the offscreen render.
- **One band, no parallel walk (H40):** read animated/evaluated values through the
  existing resolvers (`resolveEvaluatedMesh` / `resolveEvaluatedTransform` /
  `resolveActiveCameraPoseAt`), never a re-implemented walk.
- **The DAG is the engine:** operators are `NodeDefinition`s; targets are edges;
  ordering + cycle detection come from the evaluator. No imperative post-process.
- **Domain-aligned, not premature:** `OperatorStack` is justified by two real
  consumers; we do **not** build a parent above SOP/CHOP/VOP, and we do **not**
  build the full Blender constraint list before the stack + world-transform model
  are proven.

---

## 9. Sequencing / slices

Tracked under **epic #201**; one issue per slice.

1. **World transform as a pure evaluable value** (§4.3, **#202**) — the foundational
   gate shared by constraints (and any "read where it renders" need).
2. **`OperatorStack`** (§2.2, **#203**) — chain wiring + stack UI + mute + serialize
   + agent op; the shared piece, value-type-polymorphic.
3. **CHOP / constraints** (§4, **#204**) — Track-To first; **migrate the camera's
   `lookAt` onto it** (the proof). Then Copy Location/Transforms, Child Of, Limit,
   Follow Path on demand.
4. **`StudioLight` + `LightRig`** (§7.1–7.2, **#205**) — the textured-area-light pair
   + the rig as a Track-To consumer; params + animation fall out of existing systems.
5. **2D control panel** (§7.3, **#206**) — `resolveStudioLightTransform`.
6. **Light Brush** (§7.4, **#207**) — the raycast-to-place modal tool.
7. **Profiles** (§7.5, **#208**) — named/switchable + JSON import/export.
8. **SOP / modifiers** (§5, **#209**) — independent value-add, parallelizable after
   slice 2.

---

## 10. Open questions to pin before/while building

- **Where the stack lives in the DAG:** node-wrapper chain vs a `constraints[]` /
  `modifiers[]` param-list vs explicitly wired nodes. (Leaning: linear sub-chain
  of nodes, presented as a stack — Blender UX over Houdini engine.)
- **World-transform model:** how to expose accumulated world transform purely
  without re-deriving the `SceneFromDAG` walk (Chesterton — reuse the existing
  composition, lift it into pure eval).
- **`RectAreaLight` + emissive-card coupling:** how tightly to bind the
  illumination primitive to the visible card (one `StudioLight` node emitting
  both, vs two cooperating nodes). Shadow support for the area light in three.js
  (none natively — accept, or fake with a proxy).
- **Texture → illumination reduction:** how to derive the `RectAreaLight`
  color/intensity from the HDR card (average? dominant? a small mip read).
- **Profile storage:** DAG subgraph per profile vs a parametric list node; how
  switching links/unlinks (mirror BLS link/unlink, but DAG-native).
- **VOP-as-graph:** confirm we are *consciously* deferring procedural shader
  graphs (§6) — revisit only if a concrete need appears.

---

## 11. References

- BLS source (read end-to-end): `nortikin/blender-light-studio` —
  `light_brush.py` (the brush + raycast), `light_profiles.py` (the `.bls` model +
  profile switching), `light_operators.py` (rig assembly via constraints),
  `common.py` (object/naming schema), `gui.py` (panels).
- Blender constraints (north star): `docs.blender.org/manual/en/latest/animation/constraints`.
- Houdini model: SOP (geometry) / CHOP (channels — constraints are CHOP networks) /
  VOP (shading). Constraints-as-CHOP-networks is the direct precedent for
  "constraints = a typed operator chain."
- Basher mechanisms this builds on: `NodeDefinition` (the universal node
  interface = the parent); `src/core/dag/evaluator.ts` (topo-sort + cycle
  detection); `resolveEvaluatedMesh` / `resolveEvaluatedTransform` (the unified
  mesh + transform bands); `resolveActiveCameraPoseAt` (V56 — the camera look-at
  to migrate); the OpenPBR material IR (VOP-equivalent, V32/V53); the scene
  environment / IBL (V47 — the global layer); free-floating channels (V57 —
  animation); `SceneFromDAG` (where world transform is composed today — the gate).
- Related docs: `UNIFICATION-DESIGN.md` (the V57 animation road), `PERFORMANCE.md`
  / the v0.7 renderer epic (WebGPU/TSL — where the textured-area-light pair can
  become one primitive), `PLATFORM-VISION.md`.
