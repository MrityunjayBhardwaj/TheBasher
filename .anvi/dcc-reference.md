# DCC Reference — Industry-Standard Conventions for Basher's Decisions

> Canonical lookup for every "which convention?" decision Basher faces.
> When a new field, units boundary, axis question, or default value
> needs choosing, consult this doc FIRST. Each section captures the
> standard across Blender, Houdini, Cinema 4D, 3ds Max, Maya — plus the
> relevant game engines (Unity, Unreal, Godot) and the glTF spec where
> it applies — alongside Basher's choice and the reasoning.
>
> Status legend: **DECIDED** (in code) / **TBD** (will land in a named
> phase) / **DEFERRED** (waiting on a trigger).
>
> Authority order when sources disagree:
>   1. **glTF 2.0 spec** — wins for asset interchange (it's the import/
>      export contract).
>   2. **THREE.js / R3F runtime** — wins for engine-layer details we
>      can't override cheaply.
>   3. **Majority DCC convention** — wins for user-facing UI, params,
>      and agent prompts.
>   4. **Blender alone** — used as a tiebreak for FOSS-aligned defaults.
>
> Cross-references are to `.anvi/hetvabhasa.md` (H#), `.anvi/vyapti.md`
> (V#), `.anvi/dharana.md` (B#), `.anvi/krama.md` (K#), and `THESIS.md`
> sections.

---

## Decision Index

1. [Rotation units (degrees vs radians)](#1-rotation-units)
2. [Position / size units (meters vs cm vs feet)](#2-position--size-units)
3. [World coordinate system (Y-up vs Z-up)](#3-world-coordinate-system)
4. [Forward / front axis (asset orientation)](#4-forward--front-axis)
5. [Color space (linear math, sRGB display)](#5-color-space)
6. [Color storage format (hex / float / 0-255)](#6-color-storage-format)
7. [Time representation (seconds vs frames vs normalized)](#7-time-representation)
8. [Frame rate default (24 vs 30 vs 60)](#8-frame-rate-default)
9. [Camera FOV (horizontal vs vertical)](#9-camera-fov)
10. [Aspect ratio handling (explicit vs viewport-derived)](#10-aspect-ratio)
11. [Material model (PBR metalness/roughness vs spec/gloss)](#11-material-model)
12. [Light intensity unit (lumens vs unitless multiplier)](#12-light-intensity-unit)
13. [Tone mapping (ACES vs filmic vs neutral)](#13-tone-mapping)
14. [Euler rotation order (XYZ, ZYX, ...)](#14-euler-rotation-order)
15. [Quaternion component order (xyzw vs wxyz)](#15-quaternion-component-order)
16. [Animation interpolation (bezier / linear / step / hermite)](#16-animation-interpolation)
17. [Skinning weights per vertex (4 vs 8)](#17-skinning-weights-per-vertex)
18. [IK solver default (FABRIK vs CCD vs analytic)](#18-ik-solver-default)
19. [Render output color space (linear vs sRGB)](#19-render-output-color-space)
20. [Anti-aliasing (SMAA vs FXAA vs MSAA vs TAA)](#20-anti-aliasing)
21. [Stylized render conventions (P5)](#21-stylized-render-conventions-p5)

---

## 1. Rotation units

**Scenario:** how to store and display 3D rotations in DAG params, agent
tool args, and the inspector.

**Basher's choice:** **degrees in DAG params, radians at the THREE seam.**
Status: **DECIDED** (H20).

| App        | UI display | Scripting / storage API                     | Internal math      |
| ---------- | ---------- | ------------------------------------------- | ------------------ |
| Blender    | degrees    | radians (Python `obj.rotation_euler`)       | matrices + quat    |
| Maya       | degrees    | degrees (MEL `rotate -ro 45 0 0`)           | matrices           |
| 3ds Max    | degrees    | degrees (MAXScript `rotateX 45`)            | matrices           |
| Cinema 4D  | degrees    | radians (Python API)                        | matrices           |
| Houdini    | degrees    | radians in VEX; `radians()` / `degrees()`   | radians            |

| Engine     | UI                  | Code                                         | Internal     |
| ---------- | ------------------- | -------------------------------------------- | ------------ |
| Unity      | degrees (Inspector) | degrees (`Quaternion.Euler(45,0,0)`)         | quaternions  |
| Unreal     | degrees (Details)   | degrees (`FRotator` yaw/pitch/roll)          | quaternions  |
| Godot 4    | degrees (Inspector) | both: `rotation` (rad), `rotation_degrees`   | quaternions  |
| THREE.js   | n/a                 | radians (`Object3D.rotation` is `Euler`)     | quat / matrix|

**Recommendation:** degrees for user-facing storage; convert at the
engine seam. Reason: 45/90/180 are readable, π/4/π/2/π are not. THREE
forces radians at consumption — convert there.

**Cross-refs:** H20, `src/viewport/rotation.ts`, AGENT.md §A.

---

## 2. Position / size units

**Scenario:** what unit a `position: [x, y, z]` and `size: [w, h, d]` is in.

**Basher's choice:** **meters everywhere.** Status: **DECIDED** (implicit
since P0; THREE is unitless but seed scene + tests treat 1 unit = 1 m).

| App        | Default unit | Configurable?                     |
| ---------- | ------------ | --------------------------------- |
| Blender    | meters       | yes (Scene Properties → Units)    |
| Maya       | centimeters  | yes (Settings → Working Units)    |
| 3ds Max    | inches (US)  | yes (Customize → Units Setup)     |
| Cinema 4D  | centimeters  | yes (Project Settings)            |
| Houdini    | meters       | yes (Edit → Preferences → Hip)    |

| Engine     | Default unit                                       |
| ---------- | -------------------------------------------------- |
| Unity      | meters                                             |
| Unreal 5   | centimeters (legacy); meters supported via UWS     |
| Godot      | meters                                             |
| glTF 2.0   | **meters** (spec-mandated)                         |
| THREE.js   | unitless (convention is meters)                    |

**Recommendation:** **meters.** Aligns with Blender, Houdini, Unity,
Godot, and the glTF spec. Aligns with physics if/when we add it. Aligns
with film/VFX convention.

**Why not cm:** Maya's centimeters and old Unreal's centimeters are
historical. Both are migrating toward / supporting meters. Cm makes
exterior environments produce huge numbers (a 100m hallway = 10000 in
Maya) — cognitively expensive.

**Cross-refs:** AGENT.md §A.

---

## 3. World coordinate system

**Scenario:** which axis is "up", which is "forward", left- or right-handed.

**Basher's choice:** **Y-up, right-handed, -Z forward.** Status:
**DECIDED** (inherited from THREE.js / glTF).

| App        | Up   | Forward | Handedness |
| ---------- | ---- | ------- | ---------- |
| Blender    | **Z** | -Y      | right-handed |
| Maya       | Y    | -Z      | right-handed |
| 3ds Max    | **Z** | -Y      | right-handed |
| Cinema 4D  | Y    | +Z      | left-handed (legacy); right-handed (config) |
| Houdini    | Y    | -Z      | right-handed |

| Engine     | Up   | Forward | Handedness |
| ---------- | ---- | ------- | ---------- |
| Unity      | Y    | +Z      | left-handed |
| Unreal     | **Z** | +X      | left-handed |
| Godot      | Y    | -Z      | right-handed |
| glTF 2.0   | Y    | -Z      | **right-handed** (spec-mandated) |
| THREE.js   | Y    | -Z      | right-handed |

**Recommendation:** **Y-up, -Z forward, right-handed.** Matches glTF,
THREE, Maya, Houdini, Godot. Diverges from Blender / Max (Z-up). The
glTF spec wins per our authority order.

**Implication:** when importing from Blender, the glTF exporter rotates
the scene 90° around X to convert Z-up → Y-up. We accept that
conversion at the import boundary; the DAG sees Y-up.

**Cross-refs:** future H entry if we hit "imported asset is sideways"
debugging.

---

## 4. Forward / front axis

**Scenario:** for an asset (character, vehicle), which direction is the
"front" pointing in the source file.

**Basher's choice:** **+Z forward (glTF convention).** Status:
**DECIDED** (assets imported via library.import inherit the glTF orientation).

| Source     | Front-facing axis (asset author convention)            |
| ---------- | ------------------------------------------------------- |
| Blender    | -Y (default front); Empire-of-Code mods use +Y         |
| Maya       | +Z (default character orientation)                      |
| 3ds Max    | -Y                                                      |
| Cinema 4D  | +Z                                                      |
| Houdini    | -Z (varies by asset)                                    |
| glTF 2.0   | conventionally **+Z** for characters; not spec-mandated |
| Unity      | +Z                                                      |
| Unreal     | +X                                                      |
| Godot      | -Z                                                      |

**Recommendation:** **+Z forward** for character assets, document at
import. If a file ships -Y forward (Blender default), the agent / human
adds a Transform with `rotation: [0, 90, 0]` or similar to align.

**Cross-refs:** AGENT.md §6.5 (animation preview). Possible future tool
`asset.normalizeOrientation`.

---

## 5. Color space

**Scenario:** when colors are sampled, mixed, sent to GPU, displayed.

**Basher's choice:** **linear-space math, sRGB display.** Status:
**DECIDED** (THREE default + R3F's `gl={{ outputColorSpace: 'srgb' }}`).

| App        | Authoring color picker | Math    | Display              |
| ---------- | --------------------- | ------- | -------------------- |
| Blender    | sRGB → linear         | linear  | sRGB (Filmic/AgX OCIO)|
| Maya       | sRGB                  | linear  | sRGB                 |
| 3ds Max    | sRGB                  | linear (gamma 2.2 / OCIO) | sRGB |
| Cinema 4D  | sRGB                  | linear  | sRGB                 |
| Houdini    | linear (default!)     | linear  | sRGB (OCIO)          |

| Engine     | Authoring | Math   | Display              |
| ---------- | --------- | ------ | -------------------- |
| Unity      | sRGB      | linear | sRGB                 |
| Unreal     | sRGB      | linear | sRGB                 |
| Godot      | sRGB      | linear | sRGB                 |
| THREE.js   | sRGB textures, linear math | linear | sRGB (`outputColorSpace`) |

**Recommendation:** **linear math, sRGB display, sRGB-tagged texture
inputs.** Only Houdini diverges by treating its picker as linear (which
matters in compositing context — Houdini's authoring is more pipeline-
y). Everyone else: pick a hex like #5af07a in sRGB, internal math in
linear, output transformed to sRGB.

**Cross-refs:** `PostFx.tsx` (current ACES tonemap + sRGB output).

---

## 6. Color storage format

**Scenario:** how colors live in DAG params + serialized projects.

**Basher's choice:** **CSS hex strings (`#rrggbb`).** Status: **DECIDED**.

| App        | Storage in scene file                            |
| ---------- | ------------------------------------------------ |
| Blender    | float [0..1] RGBA in .blend                      |
| Maya       | float [0..1] in .ma; hex in .json export         |
| 3ds Max    | 0-255 integers in legacy; float in newer         |
| Cinema 4D  | float [0..1]                                     |
| Houdini    | float [0..1]                                     |
| glTF 2.0   | **float [0..1]** linear RGBA (spec-mandated)     |

| Engine     | Inspector edit       | Storage              |
| ---------- | -------------------- | -------------------- |
| Unity      | hex + RGBA picker    | float [0..1]         |
| Unreal     | hex + RGBA picker    | float [0..1]         |
| Godot      | hex + RGBA picker    | float [0..1]         |

**Recommendation:** **hex strings in DAG params** for v0.5 (readable, web
native, agent-friendly). Convert to float at the THREE seam (THREE.Color
takes hex). For glTF export (P7), serialize as float [0..1] per spec.

**Why not float [0..1] in DAG:** the agent and humans both think in hex.
"#ff0000" is unambiguous in chat; "[1.0, 0.0, 0.0]" is more bytes and
more error-prone (RGB vs BGR mistakes).

**Cross-refs:** `BoxMesh.ts` material schema, AGENT.md §A.

---

## 7. Time representation

**Scenario:** how time flows through the DAG (TimeSource, animation
clips, render jobs).

**Basher's choice:** **dual representation — `seconds` (continuous,
authoritative) + `frame` (computed from seconds × fps) + `normalized`
[0..1] (clip-relative).** Status: **DECIDED** (TimeSource node, P2).

| App        | Primary unit  | Secondary                      |
| ---------- | ------------- | ------------------------------ |
| Blender    | frames        | seconds (frames / fps)         |
| Maya       | frames        | seconds (frame / fps)          |
| 3ds Max    | frames + ticks (4800 ticks/s) | seconds         |
| Cinema 4D  | frames        | seconds                        |
| Houdini    | frames        | seconds (`@Time = $T`)         |

| Engine     | Primary                      |
| ---------- | ---------------------------- |
| Unity      | seconds (`Time.deltaTime`)   |
| Unreal     | seconds (`DeltaSeconds`)     |
| Godot      | seconds (`process(delta)`)   |

**Recommendation:** **seconds-primary** (matches game engines + the
underlying THREE.Clock) but expose `frame` as a derived field on the
TimeSource value so dopesheet UIs (P3) can pin to integer frames. DCCs
historically used frames because film/TV cuts on integer frames; we
inherit that for animation while staying seconds-native everywhere else.

**Cross-refs:** `src/nodes/TimeSource.ts`, V3 (Time-as-socket invariant).

---

## 8. Frame rate default

**Scenario:** what fps a new project starts at.

**Basher's choice:** **TBD** — likely 24 fps. Status: **TBD** (P3 wires
the timeline; default lands then).

| App        | Default fps                |
| ---------- | -------------------------- |
| Blender    | 24                         |
| Maya       | 24 (film) or 30 (NTSC)     |
| 3ds Max    | 30 (NTSC default)          |
| Cinema 4D  | 30                         |
| Houdini    | 24                         |

| Engine     | Default                              |
| ---------- | ------------------------------------ |
| Unity      | uncapped (vsync) — no fixed fps      |
| Unreal     | uncapped — Sequencer defaults to 30  |
| Godot      | uncapped                             |

**Recommendation:** **24 fps default** (film convention; matches
Blender, Maya-film, Houdini). Easy override in project settings.
Director-first framing — Basher targets short film output, not
real-time games.

**Cross-refs:** P3 phase (TimeSource fps field).

---

## 9. Camera FOV

**Scenario:** what units a camera's FOV is stored in (vertical or
horizontal angle).

**Basher's choice:** **vertical FOV in degrees.** Status: **DECIDED**
(inherited — `PerspectiveCamera.fov` from THREE/R3F is vertical degrees).

| App        | FOV interpretation              |
| ---------- | ------------------------------- |
| Blender    | focal length (mm) primary; vertical FOV derived |
| Maya       | horizontal focal length / FOV   |
| 3ds Max    | horizontal FOV                  |
| Cinema 4D  | horizontal FOV                  |
| Houdini    | vertical aperture (mm) primary  |

| Engine     | FOV                                       |
| ---------- | ----------------------------------------- |
| Unity      | vertical FOV (degrees)                    |
| Unreal     | horizontal FOV (degrees)                  |
| Godot      | vertical FOV (degrees)                    |
| glTF 2.0   | **vertical FOV (radians)** (`yfov`)       |
| THREE.js   | vertical FOV (degrees) — `Camera.fov`     |

**Recommendation:** **vertical FOV in degrees.** Matches THREE, glTF
(via converter), Unity, Godot. Diverges from Maya/Max/Unreal (horizontal).

**Why vertical:** scene height stays constant when you change aspect
ratio; horizontal would force-zoom the side regions. THREE made this
choice; glTF agreed; modern engines followed.

**Cross-refs:** `src/nodes/PerspectiveCamera.ts`.

---

## 10. Aspect ratio

**Scenario:** how a camera's aspect ratio is determined for render.

**Basher's choice:** **viewport-derived in v0.5; explicit per-Shot in
P3+.** Status: **TBD** (P4 render passes need explicit aspect).

| App        | Source of aspect ratio                         |
| ---------- | ---------------------------------------------- |
| Blender    | Render Properties (output resolution + pixel ratio) |
| Maya       | Render Globals                                 |
| 3ds Max    | Render Setup                                   |
| Cinema 4D  | Render Settings                                |
| Houdini    | Camera node `Resolution` parameter             |

**Recommendation:** **explicit on the camera or shot node.** Don't read
from viewport DOM. P3's `Shot` node should carry `resolution: [w, h]`
or `aspect: number`; cameras stay aspect-agnostic. Matches every DCC.

**Cross-refs:** P3 (Shot node), P4 (RenderJob node).

---

## 11. Material model

**Scenario:** which BRDF / material parameterization to ship.

**Basher's choice:** **PBR metalness/roughness (Disney-ish).** Status:
**DECIDED** (P1, vyapti V9 — "Materials are data, not code in v0.5").

| App        | Default model                                  |
| ---------- | ---------------------------------------------- |
| Blender    | Principled BSDF (metalness/roughness + sheen + clearcoat) |
| Maya       | aiStandardSurface (Arnold) — metalness/roughness |
| 3ds Max    | Physical Material — metalness/roughness        |
| Cinema 4D  | Standard / Redshift Material — metalness/roughness primary |
| Houdini    | Principled Shader — metalness/roughness        |

| Engine     | Default                                        |
| ---------- | ---------------------------------------------- |
| Unity HDRP | metalness/roughness                            |
| Unreal     | metalness/roughness (UE4+)                     |
| Godot      | metalness/roughness                            |
| glTF 2.0   | **metalness/roughness** (PBR Metallic-Roughness, spec-mandated core) |
| THREE.js   | MeshStandardMaterial = metalness/roughness     |

**Recommendation:** **metalness/roughness.** Universal modern standard.
Spec/gloss is dead in mainstream pipelines (deprecated in glTF, removed
from Substance Designer's defaults).

**Cross-refs:** V9, `src/nodes/MaterialOverride.ts`.

---

## 12. Light intensity unit

**Scenario:** what unit a light's intensity is stored in.

**Basher's choice:** **unitless multiplier in v0.5; lumens/lux in P4+
(physical mode flag).** Status: **DECIDED v0.5; PARTIAL** for P4.

| App        | Default                                              |
| ---------- | ---------------------------------------------------- |
| Blender    | watts (Cycles physical) or unitless (Eevee non-physical) |
| Maya       | unitless (legacy) → lumens (Arnold physical)         |
| 3ds Max    | candela / lumens (mr/Arnold physical)                |
| Cinema 4D  | lumens / unitless toggle                             |
| Houdini    | watts / lumens / unitless                            |

| Engine     | Default                                              |
| ---------- | ---------------------------------------------------- |
| Unity HDRP | lumens (physical) / unitless (legacy URP)            |
| Unreal     | lumens (physical) / unitless (legacy)                |
| Godot      | lumens                                               |
| glTF 2.0   | **lumens** (KHR_lights_punctual extension)           |
| THREE.js   | unitless (`Light.intensity` is a multiplier)         |

**Recommendation:** start unitless (matches THREE, simpler authoring),
add a "physical mode" toggle in P4 that interprets values as lumens
+ scales by the engine's physical unit. Document the scale clearly.

**Why not lumens day one:** the user types "make the sun intensity 5";
they expect a 5x multiplier, not 5 lumens (which is dim). Physical mode
matters for AI render bridge (P5) where ComfyUI expects PBR-physical.

**Cross-refs:** `src/nodes/DirectionalLight.ts` (intensity field).

---

## 13. Tone mapping

**Scenario:** the tonemap operator applied between linear render output
and sRGB display.

**Basher's choice:** **ACES filmic (default)** with selectable presets.
Status: **DECIDED** (PostFx.tsx).

| App        | Default                              | Available                                |
| ---------- | ------------------------------------ | ---------------------------------------- |
| Blender    | AgX (3.6+) or Filmic (older)         | AgX, Filmic, Standard, Khronos PBR Neutral |
| Maya       | aiStandard / Reinhard                | ACES, Reinhard, Hable, custom OCIO      |
| 3ds Max    | ACES (Arnold)                        | ACES, Reinhard, custom                   |
| Cinema 4D  | ACES                                 | ACES, Reinhard, others via Redshift      |
| Houdini    | Reinhard (default), ACES popular     | ACES, AgX, Reinhard, custom OCIO         |

| Engine     | Default                              |
| ---------- | ------------------------------------ |
| Unity HDRP | ACES (URP: Neutral/ACES toggle)      |
| Unreal     | ACES                                 |
| Godot      | Filmic (default), ACES, Reinhard     |
| THREE.js   | None (set via `gl.toneMapping`)      |

**Recommendation:** **ACES** as v0.5 default (matches Unreal, Unity,
modern Maya/Max/C4D). AgX as a preset (Blender 3.6+ shifted; some users
prefer it for color rendition). Khronos PBR Neutral for product-vis
content (P5+).

**Cross-refs:** `src/render/PostFx.tsx`.

---

## 14. Euler rotation order

**Scenario:** when applying X, Y, Z rotations in sequence — which order.

**Basher's choice:** **XYZ.** Status: **DECIDED** (THREE's `Euler` default).

| App        | Default order                |
| ---------- | ---------------------------- |
| Blender    | XYZ (per-object configurable to ZYX/ZXY/...) |
| Maya       | XYZ (per-object configurable) |
| 3ds Max    | XYZ                          |
| Cinema 4D  | HPB (Heading-Pitch-Bank, custom) — converts to XYZ for export |
| Houdini    | XYZ                          |

| Engine     | Default                              |
| ---------- | ------------------------------------ |
| Unity      | ZXY                                  |
| Unreal     | YXZ (yaw-pitch-roll)                 |
| Godot      | YXZ                                  |
| glTF 2.0   | quaternion (no Euler order question) |
| THREE.js   | XYZ (default for `Euler`)            |

**Recommendation:** **XYZ.** Matches THREE default, Blender, Maya, Max,
Houdini. Game-engine quirks (Unity ZXY, Unreal YXZ) come from their
yaw-pitch-roll-first conventions. We're a film-content tool, not an FPS
engine; XYZ wins.

**Implication:** if a user types `rotation: [90, 90, 0]` they get X
first, then Y. Changing this would require explicit per-object Euler
order metadata (Blender lets you, but it's edge-case).

**Cross-refs:** `src/viewport/rotation.ts` (no order param yet —
THREE.Euler default applies).

---

## 15. Quaternion component order

**Scenario:** when serializing a quaternion to an array of 4 numbers.

**Basher's choice:** **TBD; probably xyzw.** Status: **DEFERRED** (no
quaternion fields in DAG yet; lands in P3 if KeyframeChannel<quat> is
added).

| App / format | Order   |
| ------------ | ------- |
| Blender      | wxyz (.blend Python) |
| Maya         | xyzw                 |
| 3ds Max      | xyzw                 |
| Cinema 4D    | xyzw                 |
| Houdini      | xyzw                 |
| glTF 2.0     | **xyzw** (spec-mandated) |
| Unity        | xyzw (`Quaternion.x,y,z,w`) |
| Unreal       | xyzw (`FQuat.X,Y,Z,W`) |
| Godot        | xyzw                 |
| THREE.js     | xyzw (`Quaternion.x,y,z,w`) |

**Recommendation:** **xyzw.** Universal except Blender's Python API
(which is wxyz internally). glTF, THREE, every engine, every other
DCC: xyzw. Don't fight gravity.

**Cross-refs:** P3 trigger.

---

## 16. Animation interpolation

**Scenario:** how a KeyframeChannel between two keyframes computes
intermediate values.

**Basher's choice:** **TBD — bezier (with weighted handles), linear,
step, hermite as options.** Status: **TBD** (P3).

| App        | Defaults / available                          |
| ---------- | --------------------------------------------- |
| Blender    | bezier (default), linear, constant; weighted handles |
| Maya       | spline (TCB / Hermite), linear, step, plateau, auto |
| 3ds Max    | bezier (default), linear, step, custom curves |
| Cinema 4D  | spline (custom), linear, step                 |
| Houdini    | linear (default), bezier, cubic, ease, custom |

| Engine     | Default                                       |
| ---------- | --------------------------------------------- |
| Unity      | linear, hermite (default for Animation), step |
| Unreal     | bezier (Sequencer default), linear, constant  |
| Godot      | linear (default), nearest, cubic              |
| glTF 2.0   | **linear, step, cubicspline** (spec-mandated) |

**Recommendation for P3:** **bezier with weighted handles as the default
authoring mode**, with linear/step/cubicspline as gamut for glTF
export. Matches Blender + Max + Unreal (the "creative" tools). Weighted
handles are the differentiator (Maya has them; Blender added them
recently). Without weighted handles you can't author dramatic ease-out
shots.

**For glTF export (P7):** bake bezier → cubicspline samples per the
glTF spec. One step at the export boundary.

**Cross-refs:** P3 phase, future Curve<T> node design.

---

## 17. Skinning weights per vertex

**Scenario:** how many bone influences a single vertex carries.

**Basher's choice:** **4 (glTF default).** Status: **DEFERRED** (P2
ships Character with no skinning yet; P3+ when we wire skinned meshes).

| App / format | Default weights/vertex |
| ------------ | --------------------- |
| Blender      | 4 (glTF export); 32 internal max |
| Maya         | 4 default; configurable        |
| 3ds Max      | 4 default                      |
| Cinema 4D    | 4 default                      |
| Houdini      | 4 default                      |
| glTF 2.0     | **4 per JOINTS_0/WEIGHTS_0 set; multiple sets (8, 12) supported via _1, _2 ...** |
| Unity        | 4 (default), 8 (HDRP / DOTS-Animation) |
| Unreal       | 8 (since 4.x)                  |
| Godot 4      | 4 default; 8 supported         |
| THREE.js     | 4 (`SkinnedMesh.skin.bones`)   |

**Recommendation:** **4.** Default everywhere. Bumping to 8 needs
runtime support + bigger vertex buffers; not worth it for v0.5.

**Cross-refs:** P3 trigger.

---

## 18. IK solver default

**Scenario:** which inverse-kinematics solver runs for a Character's
LocomotionState foot-IK / hand-IK.

**Basher's choice:** **TBD — probably FABRIK or two-bone analytic.**
Status: **DEFERRED**.

| App        | Default solver(s)                               |
| ---------- | ----------------------------------------------- |
| Blender    | iTaSC (default), Standard (CCD-like), Splat IK  |
| Maya       | RP (Rotate-Plane), SC (Single-Chain), Spline IK |
| 3ds Max    | HI (History-Independent, IK-FK blend) Solver    |
| Cinema 4D  | XPresso IK / standard                           |
| Houdini    | Two-Bone, Multi-Bone (FABRIK-flavor), Channel IK|

| Engine     | Default                                         |
| ---------- | ----------------------------------------------- |
| Unity      | Animation Rigging package — FABRIK + two-bone   |
| Unreal     | FBIK (Full-Body), Two-Bone IK, FABRIK           |
| Godot      | FABRIK                                          |

**Recommendation for P3 wire-up:** **FABRIK + two-bone analytic** as the
two starter solvers. FABRIK for chains (arms, spines), analytic for
limbs (knees, elbows). Matches Unity/Unreal/Godot. Avoid CCD (Maya RP
solver substitute) — it's older and more iteration-hungry.

**Cross-refs:** P3 trigger.

---

## 19. Render output color space

**Scenario:** the color space of pixels written to disk by RenderJob.

**Basher's choice:** **TBD — likely linear EXR for AOVs, sRGB PNG/JPEG
for beauty preview.** Status: **TBD** (P4).

| App        | Default beauty output | AOV output            |
| ---------- | --------------------- | --------------------- |
| Blender    | sRGB PNG (default Filmic) | linear EXR        |
| Maya       | sRGB / linear toggle  | linear EXR (Arnold)   |
| 3ds Max    | sRGB                  | linear EXR (Arnold/V-Ray) |
| Cinema 4D  | sRGB                  | linear EXR            |
| Houdini    | linear EXR (mantra/karma) | linear EXR        |

**Recommendation:** **linear EXR for AOVs (depth, normal, motion-vec,
ID); sRGB-encoded PNG for beauty/preview**. Matches every DCC for
compositing-pipeline AOVs. Beauty-as-sRGB matches what users post.

**Cross-refs:** P4 phase, RenderJob node.

---

## 20. Anti-aliasing

**Scenario:** which AA method runs by default.

**Basher's choice:** **SMAA in P0 viewport.** Status: **DECIDED v0.5
viewport**; render-time AA TBD in P4.

| App / engine | Real-time viewport      | Render               |
| ------------ | ----------------------- | -------------------- |
| Blender      | OpenGL MSAA (workbench), Eevee TAA | Cycles supersample |
| Maya         | viewport 2.0 MSAA       | Arnold supersample  |
| 3ds Max      | viewport MSAA           | Arnold supersample  |
| Cinema 4D    | viewport MSAA           | Standard / Redshift supersample |
| Houdini      | OpenGL MSAA             | Mantra/Karma supersample |
| Unity HDRP   | TAA (default)           | TAA / SMAA           |
| Unreal       | TSR (UE5 default), TAA  | TSR                  |
| Godot        | MSAA / TAA              | MSAA / FXAA          |
| THREE.js     | None default (MSAA via `antialias: true`) | post-process |

**Recommendation:** **SMAA for viewport** (sharp, predictable, no
temporal artifacts). **TAA optional** for higher quality but may lose
sharpness (gaming compromise). For renders (P4) — supersample at 2x
and downsample (cleanest, easy to author).

**Cross-refs:** `src/render/PostFx.tsx`.

---

## 21. Stylized render conventions (P5)

**Scenario:** when the AI render bridge produces a stylized frame and
stitches frames into video, what conventions govern color space, frame
numbering, codec id, and the prev-frame placeholder name?

**Basher's choice:**

| Decision                  | Value                                           | Rationale |
| ------------------------- | ----------------------------------------------- | --------- |
| Stylized output color     | **sRGB PNG (rgba8)**                            | Matches raw passes (Beauty/Depth/Normal). ControlNet's input contract assumes sRGB; emitting linear here would force a per-pass conversion in the encoder. |
| Frame numbering           | **`frame.toString().padStart(4, '0')` — 4-digit zero-pad** | Matches `framePath` in `runRenderJob.ts` so a beauty + stylized pair sit adjacent (`beauty_0000.png` next to `stylized_stylizedRealism_0000.png`). 4 digits cover up to 9999 frames (333s @ 30fps) — generous for v0.5 demos. |
| WebCodecs codec id (Wave D) | **`'avc1.42E01F'`** at the seam, **`'h264'`** as user-facing label | `'avc1.42E01F'` = H.264 Baseline 3.1 — broadest player support. Surfacing the `avc1.*` literal in the UI confuses users; `'h264'` is the friendly label. |
| Container (Wave D)        | **MP4 (H.264 in mp4 container)**                | Universal browser playback; user-shareable without conversion. AV1 / VP9 deferred until WebCodecs encode support stabilizes across browsers. |
| Prev-frame placeholder    | **`prev_frame_image`**                          | The workflow JSON references this key; the execute layer fills it with frame N-1's stylized output (or a zero/black image on frame 0). The literal name appears in preset workflow JSON files; renaming it requires a coordinated migration of every preset. |

**Status:** DECIDED v0.5. Re-evaluate at v0.6 when meta-prompt-authored
presets land — they may need additional placeholder names that get
cataloged here as they appear.

**Cross-refs:** `src/render/runComfyUIWorkflow.ts` (frame numbering
applied via `framePath`); `src/render/dryRun.ts` (probe writes via
same formula); `src/agent/strategy/presets/stylizedRealism.ts` (Wave C
— the workflow JSON references `prev_frame_image`); project_p5_context
D-04, D-05.

**Failure modes this catalogues:**
- Renaming the placeholder in code without migrating the preset JSON
  → the preset substitutes the wrong key → ControlNet receives no
  prev-frame conditioning → output flickers between frames.
- Switching to linear color or 16f format without updating ControlNet
  inputs → ControlNet over- or under-conditions.
- Padding < 4 digits in frame numbers → file-system sort order
  differs from frame order (`stylized_10.png` sorts before
  `stylized_2.png`); stitch order at Wave D's VideoStitch breaks.

---

## How to extend this doc

When a new convention question arises:

1. **Survey the same five DCCs + three engines + glTF + THREE.** Don't
   skip any — partial surveys produce wrong recommendations (we
   discovered this with rotation: only checking THREE gave us radians;
   only checking Blender gave us radians-via-Python; only the full
   survey showed degrees as the universal user-facing convention).
2. **State Basher's choice with a status.** DECIDED / TBD / DEFERRED.
3. **Justify against the authority order** at the top of this doc.
4. **Cross-link** to relevant H#/V#/B#/K# entries.
5. **Update AGENT.md §A** if it's a user/agent-facing convention.

When a hetvabhasa entry catalogues a units / convention bug, add a
"Cross-refs" line pointing here. When a vyapti entry codifies a span
(like "all rotations in degrees"), add a Cross-refs to the relevant
section of this doc.
