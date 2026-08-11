# Basher North Star

**Status:** consolidated 2026-08-11. Supersedes no document; sits above
`OBJECT-DATA-SPLIT-DESIGN.md`, `OPERATORS-AND-LIGHTING-DESIGN.md` and the per-epic
design docs, and under `THESIS.md`.

**What this is.** The objective stated precisely enough to be falsified, the reference
model that defines it, the measured distance between here and there, and a route with
entry and exit criteria per phase. Every behavioural claim below is marked with how it
is known: **measured** (a value read from a running system), **documented** (a
reference's own published description, where source is unavailable), or **unmeasured**
(stated as a hypothesis, with the probe that would settle it).

---

## 1. The objective

> **Basher is a procedural DCC whose primary representation is a polygonal geometry
> data model with typed per-element attributes. Every source of geometry — a primitive
> recipe, an imported file, a simulation cache, a baked buffer — enters through that one
> representation. No format is a first-class citizen; a format is an importer that fills
> the primary model and then stops existing.**

Three corollaries, each of which is independently testable:

1. **No downstream surface may branch on provenance.** A modifier, a constraint, a UV
   tool, a material assignment, a gizmo, an exporter — none of them may ask "did this
   come from glTF?" If any does, the objective is not met at that surface.
2. **Everything an object can carry is an attribute at a declared domain.** Material
   assignment, UVs, normals, skin weights, and any user-authored data live _on the
   geometry_ at the correct element class, not as sibling fields next to it.
3. **Materialisation is explicit.** Operators compose references and transforms; real
   buffers appear only where something actually needs bytes, at a named step. Copying
   does not copy data.

### What this objective is NOT

- It is **not** "support more formats." Format breadth is an output of the model, not a
  goal in itself.
- It is **not** "rewrite the DAG." The node substrate, the op system, the cook model and
  the overlay system are the parts that already work and are explicitly out of scope for
  replacement (§2).
- It is **not** "match Houdini feature-for-feature." Two places where Basher already
  diverged from the reference and _won_ are recorded in §4.4; the route must not
  regress them in the name of parity.
- It is **not** a destructive-modelling tool. That is a decision, recorded in §9, not an
  omission.

---

## 2. What Basher already is — the spine that must not be rebuilt

Stating this precisely matters, because the route below touches the geometry layer and
nothing else, and a reader who mistakes the scope will propose a rewrite.

| Capability                                                                             | Status                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| One node substrate; every context is a typed node network on one engine                | **works**                                                                    |
| Op system as the only mutation path; undo/redo; project format with a migration ladder | **works**                                                                    |
| Content-derived cache keys; O(changed) re-cook                                         | **works**                                                                    |
| Overlay addressing by flat id lookup — depth-independent by construction               | **works** (was graded a gap; re-measured closed)                             |
| Scrub cost independent of static-node count                                            | **works** (measured: 1 of 20 chains animated costs the same as fully static) |
| Keyframe channels with per-axis extrapolation and cycle modifiers                      | **works**                                                                    |
| NLA-style action/strip/track layering                                                  | **works**                                                                    |
| Constraint and driver stacks, with ordering                                            | **works**                                                                    |
| Object↔data split for box, sphere, curve, light, camera, baked                         | **works**                                                                    |
| Material as an IR with a content-keyed registry                                        | **works**                                                                    |
| Render passes, compositor, agent/LLM control surface                                   | **works**                                                                    |

**The achievement to protect:** everything is a node, nothing is destructive, and the
graph re-cooks correctly and cheaply. That is the hard part of a procedural DCC and it is
done. What follows is about _what flows through the wires_, not the wires.

---

## 3. The root defect, in one sentence

> **Basher has no geometry data model.** `GeometryDescriptor` is a union of four _build
> recipes_ (`box`, `sphere`, `array`, `mirror`) with two _references_ bolted on (`gltf`,
> `baked`). There is nowhere to put an attribute — not a weaker model, but none, with no
> home to add one to.

Everything in §5 derives from this one fact. The four issues that look like separate
problems (#605 material placement, #607 component groups, #395 per-element attributes,
#496 recipe-vs-buffer typing) are one gap seen from four sides.

### The symptom that makes it concrete

`EvaluatedMesh` carries `{geometry, uvs, material, transform}` as **sibling fields**.
Because they are siblings, each can be independently declined — and each declined field
grew its own bespoke mechanism:

- glTF returns `material: null` → a separate zustand store publishing a read-only
  material projection from the renderer, because the inspector cannot reach the scene.
- glTF and baked return `uvs: null` → a separate resolver arm reading the mounted clone.

**Measured, and it corrects the obvious story:** the two nulls do **not** share a cause.
`uvs: null` is an _async availability_ limit and applies to baked geometry too — and the
baked arm _fills_ material. `material: null` is glTF alone, and its cause is that glTF has
no data half. One field filled and its supposed sibling declined, on the same arm, is
proof that "glTF is special" cannot explain both.

### Where glTF is special today — census, measured

| Concern               | Shared or special          | Where                                                                                                                                     |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Material              | **special**                | `resolveEvaluatedMesh.ts:171` returns `material: null`; a separate material store exists to compensate                                    |
| UVs                   | **special path**           | `resolveMeshUVSpace.ts` clone arm; its own header calls the aggregate case "the one named exception to capability-keying"                 |
| Modifiers / operators | **excluded**               | `geometryRegistry.get()` opens with `if (ref.kind === 'gltf') return null`                                                                |
| Object↔data split     | **special — no data half** | every other kind has one; glTF does not (#389)                                                                                            |
| Transform             | **partly special**         | glTF-child TRS resolution and glTF-specific baked-channel roads                                                                           |
| Textures              | **partly special**         | the cleared-map sentinel exists specifically for glTF map clearing                                                                        |
| Rigging               | **mixed**                  | the DAG owns skeleton/pose; a glTF-specific skeleton node sits in that set                                                                |
| Morph targets         | **absent entirely**        | censused 858 tracked source files: the only occurrence accounts for byte usage in the VRAM sweep. Nothing creates, drives or exposes them |

**Four production consumers each carry their own "the registry returned null, go ask the
clone" arm** — the sample source, the UV resolver, the override-slot resolver and the
apply-transform road. That is one rule enforced in four modules, which is the structural
signal that the boundary is drawn in the wrong place.

---

## 4. The reference model

### 4.1 Blender — measured 2026-08-11, live

Probed directly, with the two recorded instrument traps respected: the depsgraph was
re-fetched after every mutation (a stale evaluated datablock reads as a missing feature),
and every table carries a positive control so a uniform negative column is readable.

**Attribute domains.** Blender exposes seven: `POINT · EDGE · FACE · CORNER · CURVE ·
INSTANCE · LAYER`. On a plain cube:

| attribute                       | domain     | type         |
| ------------------------------- | ---------- | ------------ |
| `position`                      | POINT      | FLOAT_VECTOR |
| `UVMap`                         | **CORNER** | FLOAT2       |
| `material_index`                | **FACE**   | INT          |
| `sharp_face`                    | FACE       | BOOLEAN      |
| `.corner_vert` / `.corner_edge` | CORNER     | INT          |
| `.edge_verts`                   | EDGE       | INT32_2D     |

Two of these upgrade previously documentation-only claims into measured facts in a second
independent reference: **material assignment is a face-domain attribute**, and **UVs are
corner-domain** — which is the measured basis for "UV seams require per-corner data."
Positions and topology are themselves attributes. `material_slots[*].link == DATA`.

**Shape keys (morph targets) evaluate BEFORE the modifier stack.** With a key moving one
vertex to x=9 and an Array modifier at constant offset 100:

```
key ON  → moved vertex at x = 9, 109, 209   (3 occurrences, one per copy)
key OFF → no vertex at 9/109/209            (control: 0)
```

The array replicated already-deformed geometry. This is the same law already measured for
curves (data-level generators run first, then the stack), now confirmed on a second data
kind — so it is a general rule of the model, not a per-kind quirk. Shape keys survive
evaluation: the evaluated mesh still reports them after Array _and_ Armature. Storage is a
third thing: created through the Object API, stored as its own datablock referenced from
the mesh data.

**Armature is an ordinary modifier, and the deform is baked into the evaluated data.**
12 of 24 vertices moved, max delta exactly the pose translation, evaluated type `Mesh`
with no bones on the result. The Array ran _before_ the Armature, weights rode onto the
generated copies, and the deform then acted on them.

**Cloth is a modifier in the same ordered stack, carrying a point cache** with
`frame_start`, `frame_end`, `is_baked`, `use_disk_cache`.

**Vertex groups are NOT in the generic attribute system.** Group names live on the Object;
the weights do not appear in the mesh's attribute collection — and a hand-made point
attribute _does_ appear, so the reader works and the absence is real. Blender runs two
parallel systems: generic named attributes, and a legacy vertex-group/deform store. The
weights nonetheless behave like a point attribute where it counts — they survived the
Array and replicated onto new components.

**The measured pipeline, end to end:**

```
base mesh
  → [data-level generators: shape keys, curve bevel/extrude]   ← evaluate FIRST
  → [ordered modifier stack: array → armature → cloth (+cache)]
  → evaluated Mesh: NO transform, HAS materials, HAS shape keys
  → object transform, applied once above the stack
  → world
```

### 4.2 Houdini — documented (closed source; this is the published description)

- Geometry **is** data: points, vertices, primitives, details carrying typed named
  attributes. Material is a primitive-class attribute, so an operator that copies
  primitives copies material assignment for free.
- A **packed primitive** is a reference plus one transform. Copying it copies the
  reference, not the data. Editing requires an explicit **unpack**.
- A file is loaded by a source node that fills the same container.
- Skin weights are point attributes.

### 4.3 Where the references disagree — and which to follow, per concern

They agree on evaluation _order_ and disagree on nearly everything else. Choosing per
concern rather than picking a side is the whole design.

| Concern                               | Blender                                        | Houdini                       | **Basher follows**                                                  |
| ------------------------------------- | ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Modifier attachment                   | list on the Object                             | wired upstream nodes          | **Houdini** — the substrate already models operators as wired nodes |
| Evaluation order                      | data generators, then stack, then transform    | SOP chain, then OBJ transform | **both** — they agree once flattened                                |
| Material storage                      | on the data, per-slot data/object discriminant | primitive-class attribute     | **Houdini**, with Blender's per-slot override as a later capability |
| Skin weight storage                   | separate legacy store                          | point attribute               | **Houdini** — one system, not two                                   |
| Where deformation executes            | CPU, baked into evaluated data                 | CPU, cooked geometry          | **neither — see 4.4**                                               |
| Morph target position in the pipeline | data-level, below the stack                    | n/a                           | **Blender** (measured)                                              |
| Simulation                            | modifier + point cache                         | solver network + cache        | **both** — same shape                                               |

### 4.4 Where Basher already diverged and won — do not regress these

- **Time-dependence.** Graded the highest missing invariant against the reference. Closed
  — not by adding a flag but by content-derived cache keys, where time enters the key only
  for impure nodes. Measured: one animated chain in twenty costs the same to scrub as
  fully static.
- **Overlay addressing.** Graded violated. Closed — flat id lookup makes it
  depth-independent by construction, rather than by traversing correctly.
- **Deformation execution.** Blender bakes skinning into CPU geometry. Basher drives bone
  transforms in the DAG and lets the GPU deform. **This is correct for a realtime viewport
  and must be preserved.** It is the one place where copying the measured reference would
  be a regression.

---

## 5. Target architecture

### 5.1 The primary representation

A geometry value is **typed named attributes at declared domains**, held out-of-band under
a content-derived key, referenced from the DAG by handle.

- Minimum domains: **point, edge, face, corner.** Corner is not optional — UVs live there,
  and so do hard-edge normals.
- The DAG carries the **handle**, never the buffers. This preserves the existing cost
  model, which is load-bearing: the DAG state is the save format, and project save is
  already O(scene).
- **The pattern already exists.** `BakedData` is an out-of-band buffer behind a
  content-addressed handle with a proper data half that rides the ordinary object/data
  road. Generalising it is the work; inventing it is not.

### 5.2 The object/data boundary

Unchanged from what is already shipped and measured in both references: **the object owns
the transform; the data owns geometry, attributes and material; the transform is applied
once above the operator chain and never baked into an operator's local output.**

### 5.3 The operator contract

An operator takes geometry and emits geometry — closed under the data kind, exactly as
measured in Blender where a modifier's output is a `Mesh`.

**Operators compose references and transforms. They do not resolve buffers.** An array of
N copies is N `(reference, transform)` pairs. Materialisation happens at an explicit
unpack, or at the renderer.

This shape is **already in production at one consumer**: the geometry sample source
consumes a list of `{positions, index, matrix}` and folds over it, with the registry arm
producing a one-element list and the glTF arm producing N. It grew there precisely
because merging was unavailable for glTF — which is evidence the shape works at a
byte-needing consumer, not merely that it is theoretically nice.

### 5.4 Deformation — three classes, and they are not one problem

This is the part most likely to be got wrong by treating "animation of geometry" as a
single concern.

**Class A — driver-small, deform on the GPU: skinning and morph targets.**
The inputs are tiny (bone matrices, morph weights); the output is large but never needs to
exist on the CPU. The current split is already correct and must be preserved: the DAG owns
skeleton and pose, the renderer deforms. What the model must add is the **bind data as
attributes** — skin weights at point domain, morph targets as named point-position deltas —
so that operators can read and transfer them and so the binding survives import.
Morph targets are a **data-level stage below the operator chain** (measured, §4.1).

**Class B — pure per-frame geometry: vertex caches, Alembic, VAT.**
Deterministic given `(inputs, params, time)`, so it fits the existing cache model _if_ the
key includes time. The hazard is real and already observed in another form: a
content-derived key that changes every frame re-mints every frame and cascades downstream.
This class therefore needs its own **storage class** — streamed and evicted, not
registry-cached indefinitely. The geometry lifetime/sweep/eviction machinery is the
foundation for it.

**Class C — stateful solvers: cloth, softbody, particles.**
Frame _f_ depends on frame _f−1_, so purity does not hold. **The contract for this already
exists in the codebase** — stateful nodes are declared deterministic given a seed and an
_interval_, not a point in time, with the real value produced by a replay seam. That
contract is live for channel operators. What does not exist is the **geometry-side replay
or cache seam** — which is exactly the point cache measured on Blender's cloth modifier.
Backward scrub over a solver requires replay-from-seed or a bake; this is a timeline
property as much as a geometry one.

### 5.5 Formats as source operators

A format importer is a source node that fills the primary model. It produces geometry into
the store, a scene graph of objects, and materials as attributes or nodes. Nothing
downstream knows the provenance.

Polygonal formats (OBJ, STL, FBX, glTF) map onto this cleanly. **USD is explicitly out of
this claim** — its model is composition and layering over prims, a different axis, and no
ground truth exists for it here.

---

## 6. The measured gap

Re-graded 2026-08-11 against current code. Grades from the 2026-08-09 analysis that have
since closed are shown, because scheduling against a stale grade is how #367 failed three
times.

### Closed since the last analysis

| item                                 | evidence                                    |
| ------------------------------------ | ------------------------------------------- |
| overlay addressing by tree walk      | flat id lookup in the cook state            |
| time-dependence flag                 | content-derived keys; measured scrub parity |
| per-channel extrapolation and cycles | shipped                                     |
| socket type sets                     | shipped                                     |

### Open, ranked by blast radius

| #   | gap                                         | measured state                                              | blocks                                                   |
| --- | ------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| 1   | **Attribute domains** (#395)                | no model; material and UVs are sibling fields               | material, UVs, normals, skin weights, morphs, user data  |
| 2   | **Component groups** (#607)                 | **zero occurrences** in the source                          | every operator is whole-mesh and cannot be otherwise     |
| 3   | **N-ary role-typed inputs** (#396)          | in flight; sockets can declare type sets, arity still unary | boolean, copy-to-points, attribute transfer, ray/project |
| 4   | **Topology-change attribute interpolation** | absent                                                      | every topology-changing operator silently drops data     |
| 5   | **glTF data half** (#389)                   | absent                                                      | material, the whole special-case cluster                 |
| 6   | **Operator reference model** (#367 / #606)  | operators resolve and merge buffers eagerly                 | arraying any import; the whole packed model              |
| 7   | **Instancing in the renderer**              | **zero occurrences** across 537 production files            | scene scale; materialise-at-render                       |
| 8   | **Attribute promotion between classes**     | absent                                                      | depends on #1                                            |
| 9   | **Constraint parameters**                   | no track/up axis, no maintain-offset, no influence          | constraints that animate rather than demo                |
| 10  | **Constraint breadth / IK**                 | 2 kinds of ~11; **zero** IK occurrences                     | character work                                           |
| 11  | **Node error surfacing**                    | **zero** occurrences                                        | a failed node renders nothing, silently                  |
| 12  | **Generative determinism**                  | the workflow node carries no seed                           | **a shot cannot be re-rendered identically**             |
| 13  | **Lock / freeze**                           | absent                                                      | pinning an expensive import                              |

Items 2, 7, 10, 11 were each verified as literal zero-occurrence censuses, not impressions.

---

## 7. The route

Each phase states its goal, entry condition, exit criterion, and — critically — the
**discriminating observation**: the thing that would be true if the phase worked and false
if it merely appeared to. A phase without one is not ready to start.

### Phase 1 — The attribute domain model

**Goal.** A geometry value carries typed named attributes at point, edge, face and corner
domains.

**Entry.** None. This is the root; nothing above it can be done properly first.

**Exit.** Material assignment is a face-domain attribute; UVs are corner-domain; both are
read through the attribute system by every consumer that reads them today. `EvaluatedMesh`
no longer carries `uvs` and `material` as sibling fields.

**Discriminating observation.** A mesh whose face-domain `material_index` holds two
distinct values is reported as two by every read-side consumer — inspector, UV editor,
gizmo, apply-transform, agent — with the sibling fields gone. A model that only handles one
material per object passes a naive test and fails this.

> **Split, 2026-08-11 (measured).** This phase was originally stated to exit on _"a geometry
> whose material assignment varies per face **renders correctly**."_ That is unreachable from
> this phase's own work: the renderer never reads `EvaluatedMesh` — `ObjectMeshR` /
> `BakedMeshR` / `ModifiedMeshR` read `MeshDataValue` / `BakedDataValue` / `ModifiedDataValue`
> directly, and `resolveEvaluatedMesh` appears in `SceneFromDAG.tsx` only inside a comment at
> line 594, with no import. Retiring the sibling fields changes the read paths and nothing
> about the pixels. **The render half is now Phase 1b (#638)**, and the exit criterion above is
> the read half only.

### Phase 1b — The resolution level

**Goal.** The per-face index reaches the pixel without shattering geometry sharing. Issue #638.

**Entry.** Phase 1.

**Exit.** A per-face material assignment renders, _and_ two same-size boxes with different
assignments render differently while two boxes with the same assignment still share one
geometry instance.

**Discriminating observation.** The second half. Rendering per-face materials by cloning a
geometry per object satisfies the first half and silently destroys the sharing the registry
exists to provide.

**Why this is a real boundary, not a sizing convenience.** Both references keep material
assignment separable from geometry _specifically so variation is possible over shared
geometry_ — Blender through `MaterialSlot.link` (`'OBJECT' | 'DATA'`, default `'DATA'`:
_"the objects can have different materials and still share the same mesh"_), Houdini through a
per-primitive material attribute, so one packed prim carries its own material. **The line both
draw: the index is geometry, the table is object-level.** Phase 1 owns the index; Phase 1b owns
the table and the draw.

**Notes.** Design as a _domain_ model, not a "four-class" model — Blender's seven domains
are the measured superset and curve/instance domains may matter later. Corner domain is
non-negotiable.

### Phase 2 — Component groups and selection scoping

**Goal.** An operator applies to a named subset of components.

**Entry.** Phase 1 (groups are attributes or are addressed by them).

**Exit.** An existing modifier can be scoped to a group and demonstrably affects only that
group.

**Discriminating observation.** The unscoped case and the scoped-to-everything case
produce byte-identical geometry, _and_ a scoped-to-half case differs from both. Only the
third comparison proves the scoping is real rather than ignored.

### Phase 3 — Topology-change attribute interpolation

**Goal.** Attributes ride onto components created by an operator.

**Entry.** Phases 1–2.

**Exit.** An array of a weighted, UV'd, multi-material mesh produces copies that carry all
three correctly.

**Discriminating observation.** The reference behaviour measured in Blender: weights
replicate onto generated copies (4 weighted verts × 3 copies = 12). Reproduce that
number, in Basher, for weights _and_ UVs _and_ material index.

### Phase 4 — The reference/unpack operator model

**Goal.** Operators compose references and transforms; buffers appear at an explicit
unpack or at the renderer.

**Entry.** Phases 1–3. Also requires renderer instancing (gap #7) to be scheduled
alongside, since "materialise at render" has no draw path today.

**Exit.** The array operator emits N `(reference, transform)` pairs; the renderer draws
them; the apply-transform road unpacks explicitly.

**Discriminating observation.** Arraying a mesh 1000× costs approximately the same CPU and
memory as arraying it 3×. Under the current eager-merge model it cannot.

**This is the phase that closes #606's operator half honestly**, rather than by re-grading.

### Phase 5 — glTF becomes an importer

**Goal.** glTF fills the primary model. No downstream surface branches on provenance.

**Entry.** Phases 1–4.

**Exit.** All four "registry returned null, go ask the clone" arms are deleted. #389 closes.
#605 dissolves. #367 becomes unnecessary rather than done.

**Discriminating observation.** Grep the source for glTF-conditional logic in every
downstream surface — modifiers, UVs, material, constraints, gizmo, export — and find
**zero** outside the importer itself. The count is the test.

**Preserve:** skinned geometry must still deform on the GPU. If Phase 5 produces CPU
deformation, it has failed even if every other criterion passes.

### Phase 6 — Deformation classes B and C

**Goal.** Vertex caches and stateful solvers.

**Entry.** Phases 1–5. Independent of the format work.

**Exit.** Class B: a per-frame geometry source with streamed storage and eviction, whose
scrub cost does not grow with cached frame count. Class C: a stateful geometry operator
with a seed-and-interval replay seam, matching the contract already declared for channel
operators.

**Discriminating observation.** Scrub backwards across a solver and get the same values as
scrubbing forwards to the same frame. That single test distinguishes a real replay seam
from a cache that silently returns stale state.

### Running alongside — small, high-trust items

These are not blocked by anything and pay back disproportionately:

- **Constraint parameters** — track/up axis, maintain-offset, influence. Turns
  constraints from demonstrable into usable.
- **Node error surfacing.** In a tool where the graph _is_ the UI, an invisible failure is
  indistinguishable from an empty result. The rule is: never blank, and say why.
- **A seed on the generative node.** Small change, large claim: without it a shot cannot be
  re-rendered identically, which undermines the procedural premise at its most visible
  point.

---

## 8. What dissolves

Stated explicitly because "issues that stop existing" is a real form of progress and is
easy to miss when tracking closure counts.

| issue                                              | fate                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| #367 (glTF handle for the operator chain)          | **unnecessary** after Phase 5 — neither of its two proposed fixes gets built |
| #605 (material beside geometry)                    | dissolves into Phase 1                                                       |
| #606 (handle-not-buffers unhonoured)               | operator half closes in Phase 4                                              |
| #389 (glTF as object+data)                         | closes in Phase 5                                                            |
| #496 (recipe vs buffer enforced by a runtime null) | subsumed by the primary model                                                |
| the four clone-reaching arms                       | deleted in Phase 5                                                           |

---

## 9. Decisions, not gaps

Recording these so they stop reading as omissions.

- **Destructive mesh modelling is out of scope.** Basher is procedural-first; modelling
  happens elsewhere and is imported. Revisit only with an explicit decision.
- **USD is not covered by "formats as extensions."** Its composition model is a different
  axis and would need its own grounding.
- **Blender's per-slot data/object material override** is a real reference capability
  Basher lacks. Deferred, not forgotten.
- **The renderer, not the reference, decides where deformation executes.** Blender bakes
  on the CPU; we do not.

---

## 10. Risks, and how each is detected

| Risk                                                     | Detection                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Phase 5 pulls deformation onto the CPU                   | frame time on a character scene; the cost curve shows it before a test does                                                   |
| Per-frame geometry re-mints the content key every frame  | scrub cost grows with animated-chain count — the parity measurement that proved time-dependence closed is the same instrument |
| An operator silently drops attributes on topology change | Phase 3's discriminating observation, run as a standing gate                                                                  |
| The attribute model ships without corner domain          | UV seams and hard edges cannot be represented; check before, not after                                                        |
| A grade is marked covered while unhonoured               | **the highest-frequency failure in this project's history** — see §11                                                         |

---

## 11. The meta-risk

The single most expensive failure pattern here has not been a missing feature. It has been
**a claim the code makes about itself that is false, believed because nothing tested the
claim.**

One session alone found four: an export builder documented as a pure read that handed out
live store records; an issue whose premise was already true and also impossible; an
invariant graded covered while the operator half was unhonoured; and an instrument
reporting 1275 vertices while the screen drew 3825.

The third of those is the expensive one. A covered-but-unhonoured grade is **worse than an
open gap**, because open gaps get scheduled and wrong grades get relied upon. That single
false checkmark caused three separate failed attempts at #367, each of which asked _how do
we make the bytes reachable_ instead of _does the operator need bytes at all_.

**The rule this yields:** re-measure a grade before scheduling against it. A lying label
passes every behavioural test.

---

## 12. Provenance and limits

**Measured** (values read from a running system, 2026-08-10/11): Blender's attribute
domains, shape-key evaluation order, armature deform baking, cloth point cache, vertex
group storage; Basher's zero-occurrence censuses for component groups, instancing, IK and
node error surfacing; the four clone-reaching consumer arms; the material/UV decline
asymmetry.

**Documented, not measured**: everything attributed to Houdini. It is closed source; these
are its published descriptions.

**Unmeasured — do not plan against these without checking:**

- Blender's glTF importer internals. This is the exact conversion Phase 5 copies, and it
  deserves its own ground-truth trace before that phase is scoped.
- Morph targets beyond their pipeline position — no reference answer for how they should
  compose with an operator chain that changes topology.
- Cloth beyond the modifier-and-cache shape.
- Whether undo scales with scene size.
- Whether the non-glTF format strings in the source represent real importers.
- Whether the extrude/bevel occurrences are curve-data parameters rather than mesh editing.

**Two instrument errors were made and corrected while producing this document**, both
recorded because both read as missing features: an array offset that scaled with a
deformed bounding box, and a bone driven along its local axis while world-axis
displacement was measured. Both would have been reported as "the reference does not do
this."
