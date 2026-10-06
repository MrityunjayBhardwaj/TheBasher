# The Basher graph

This is the one place that says what the Basher graph is. The design docs it links to hold
the detail and the history; when they and this page disagree, this page is the spec and the
other doc needs fixing.

**In one sentence:** Basher's graph is one flat, typed graph of nodes, and that graph is the
saved document. Every relationship in it is a **wire**, a **reference** or an **attribute**.
Everything else (the outliner, the modifier stacks, the inspector, the node view) is a view
of the graph, and every change to it is one of the **8 operations**.

## 1. The document

The saved project is a `DagGraph` (`src/core/dag/state.ts`): a map of nodes by id, plus
named `outputs` (`scene`, `render`) that say which nodes the app draws and renders. Wires are
stored on the consuming node's inputs. There is no other document state: no hierarchy
table, no selection-owned data, no side store a reload depends on (#1565 audits this).

The graph changes only through these operations (`OpSchema`, `src/core/dag/types.ts`):

| Operation                            | What it does                                        |
| ------------------------------------ | --------------------------------------------------- |
| `addNode` / `removeNode`             | Add a node (optionally with its wires) or delete it |
| `connect` / `disconnect`             | Add or remove a wire into a socket                  |
| `setParam`                           | Change a parameter value                            |
| `setMeta`                            | Rename a node (node positions join it in #1562)     |
| `setSpareParam` / `removeSpareParam` | Add or remove a user parameter on any node          |

Every operation carries its source: `user`, `agent`, `macro` or `render` (`OpSource`,
`src/core/dag/store.ts`). The agent has no other door into the document (THESIS §18,
§50).

## 2. Three kinds of relationship, and nothing else

| Kind          | What it means                                                                       | Where it lives                                                                                                                                               | Examples                                                                                                                 | How a view shows it                                             |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Wire**      | Data flows from one node's output into another node's typed socket                  | An edge on the consumer's input                                                                                                                              | data → modifiers → Object; Object → parent; Scene `children`; Collection `members`; Material → `material`; Solver `body` | A wire in the node view, a row in a stack, an outliner branch   |
| **Reference** | A node aims at another node, or at one of its parameters, without taking its output | A parameter holding a node id (and optionally a parameter path), declared in the node type's `idRefs` with a `role` and, if it owns the target, `owns: true` | Keyframe channels, constraints, drivers and NLA strips → target + parameter path; `scene.camera`; the active collection  | A tint on the parameter, and dependency lines in the node view  |
| **Attribute** | Data inside a geometry, one value per element                                       | Named per-element arrays on the mesh, on the `point`, `edge`, `face` or `corner` domain (`KNOWN_DOMAINS`, `src/nodes/attributes.ts`)                         | UV sets (corner); face groups; seams (edge); material assignment (face, #1554); skin weights (point)                     | A spreadsheet (#1556), the UV editor, the viewport; never nodes |

`role` answers "the target was deleted, what happens to me?"; `owns` answers "I was deleted,
what happens to the target?" (see the `idRefs` doc comment in `src/core/dag/types.ts`).
Delete (#1560), duplicate (#1561) and the agent's view of a node (#1553) are derived from
these three relationships, not written per node type.

## 3. The node families

```
SCENE ───── Scene (frame range, camera reference, active collection reference)
  │           ├── Collection (members: wires; viewport/render visibility)
  │           └── children: Object ── parent wires ── Object
OBJECT ──── Object (transform, visibility, material slot overrides)
  │           ▲ data wire
DATA ────── generators and imports → mesh · skeleton · curve · camera · light
  │           ▼ chain (the named spine socket)
OPERATORS   modifiers · UV operators · group operators · material assignment · bake
LOOK ────── Material (OpenPBR) ◄─ Image Texture ◄─ Image (#513)
ANIMATION   channels · constraints · drivers · NLA (Action / Strip / Track)  ← references
            pose layers (wired, on the bone wire)
COMPUTE ─── Math / Fit / Clamp · Solver (body) · Rig (body, #1357) · Template (body, #1557)
OUTPUTS ─── outputs.scene · outputs.render
```

## 4. Six rules

1. **A thing is a node only if it has its own inputs, parameters or animation.** Bones,
   keyframes, UV islands and face groups are data inside a value, not nodes.
2. **Flat storage, derived nesting, single owner.** The graph is stored flat. A sub-network
   is the closure behind a node's inputs declared `body: true` (the Solver today, the Rig
   and Templates next). Every wire leaving a sub-network ends inside it or in its owner's
   body sockets, so a node belongs to at most one sub-network and the outside reaches it
   only through the owner (`src/core/dag/subnetworks.ts`, #1547). The node view's levels
   are computed from this, so the saved format has no nesting to migrate. Why flat:
   [OBJECT-DATA-SPLIT-DESIGN §2.2](OBJECT-DATA-SPLIT-DESIGN.md) ("on a DAG, pointer and
   containment are the same edge") and §2.4.
3. **Membership is reachability.** An object is in the scene if the scene's wires reach it
   (`children`, `lights`, `camera`, collection `members`). Every door that adds or removes
   a wire keeps nodes reachable. Decided in #1519.
4. **Time lives inside values.** A channel's value carries `sample(seconds)`, the Scene owns
   its frame range, and nothing cooks per frame. That keeps the content-keyed cache flat
   when you scrub ([NORTH-STAR §4.4](NORTH-STAR.md)).
5. **Every gesture records graph data through the 8 operations.** Nothing in the document
   is mutated outside an operation, and the agent issues the same operations as the UI.
   Where a gesture edits geometry, it adds an operator rather than changing data in place:
   moving UVs adds a UV edit operator, marking a seam writes an edge group, assigning a
   material adds an assignment operator. Those three are not built yet (milestone "Textures
   & UVs", #1554); #1567 checks every gesture against this rule.
6. **Blender in front, Houdini behind.** Panels, stacks, the slot list and collections
   follow Blender. Storage and evaluation (attributes, wires, operators, references) follow
   Houdini. Where the two disagree, [NORTH-STAR §4.3](NORTH-STAR.md) says which to follow
   per concern.

## 5. Decisions recorded here

- **Material assignment is a per-face material reference** (#1544, decided 2026-10-06).
  Each face stores a reference to its material node; the panel's slot list is derived from
  the distinct values, and Object-level overrides are keyed by material. This follows
  [NORTH-STAR §4.3](NORTH-STAR.md) and Houdini's per-face `shop_materialpath`, and avoids
  two Blender behaviours we observed: removing a slot silently moves its faces to the
  previous slot, and Join renumbers every face. **Today the code still stores Blender's
  `material_index` into a slot table**; the build and migration are #1554.
- **Scene membership is reachability** (#1519, decided 2026-10-06). See rule 3.
- **A sub-network has one owner** (#1547). See rule 2.

## 6. Where Basher differs from Houdini, and why

Houdini facts here are documentation-tier: Houdini is closed source, and the grounding in
`GROUND_TRUTH_HOUDINI_*` says so. "Deliberate" means a reason is written down at the source;
"gap" means the difference is a missing feature, not a choice.

| #   | Area      | Basher                                                                        | Houdini                                       | Reason                                                                                                                                       | Source                                          | Status                      |
| --- | --------- | ----------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------- |
| 1   | Structure | One flat graph                                                                | Contexts (/obj, SOP, CHOP, VOP, DOP, LOP)     | The difference is expressed in the socket type, not a network wall; containment without contexts would be cargo cult                         | OBJECT-DATA-SPLIT §2.2                          | Deliberate                  |
| 2   | Structure | One node registry, typed sockets for every domain                             | A network type per context                    | SOP/CHOP/VOP differ only by wire type; a class above them would be ceremony                                                                  | OPERATORS-AND-LIGHTING §2.1                     | Deliberate                  |
| 3   | Structure | The stack's main input is the named `chain` socket                            | Input 0 by position                           | Sockets are a named record, so position is unavailable                                                                                       | `InputDescriptor` docs, `src/core/dag/types.ts` | Deliberate                  |
| 4   | Structure | No saved sub-networks yet                                                     | Digital assets (HDAs)                         | Sequencing, not architecture: Templates come after the body-input work (#1548, #1557)                                                        | OBJECT-DATA-SPLIT §12                           | Planned                     |
| 5   | Data      | Object → data over a `data` wire                                              | The geo object contains its SOP network       | On a DAG, pointer and containment are the same edge; take the Object/data boundary all three DCCs share                                      | OBJECT-DATA-SPLIT §2.2, §2.3                    | Deliberate                  |
| 6   | Data      | Modifiers are wired operators on the data chain                               | Wired SOP chain                               | A match: wiring from Houdini, the stack UI from Blender                                                                                      | NORTH-STAR §4.3                                 | Match                       |
| 7   | Data      | Domains point / edge / face / corner; no detail domain                        | Point / vertex / primitive / detail           | Edge data is a parameter channel between operators (Blender's bevel weight); detail has no consumer yet and can be added without a migration | `ref/architecture/polygonal-atoms.md`           | Edge deliberate; detail gap |
| 8   | Data      | Component groups on faces only                                                | Point, primitive, edge and vertex groups      | Other domains are the same mechanism without a consumer yet; seams are the first (#1528)                                                     | `src/nodes/ComponentGroupOp.ts`                 | Gap                         |
| 9   | Data      | Array and Mirror copy buffers                                                 | Copying a packed primitive copies a reference | None: recorded as a defect                                                                                                                   | #606                                            | Gap                         |
| 10  | Data      | Imported meshes stored in the project                                         | Referenced by default                         | User decision: an import is the same as local geometry; a referenced form answered none of the parity questions                              | NORTH-STAR (one geometry model)                 | Deliberate                  |
| 11  | Data      | Four skin weights per point                                                   | Variable-length `boneCapture`                 | three.js draws exactly four and glTF carries four per set                                                                                    | Skinning grounding                              | Deliberate                  |
| 12  | Data      | One skeleton input, no separate capture pose                                  | Capture pose and rest pose                    | Accepted cost in #393                                                                                                                        | #393                                            | Deliberate                  |
| 13  | Data      | Spare parameters on every node                                                | Spare parameters                              | A match, chosen to follow Houdini                                                                                                            | `setSpareParam`                                 | Match                       |
| 14  | Animation | Keyframes are channel nodes that reference their target                       | Channels live on parameters                   | Edge-less in the value graph, edge-ful in the dependency graph; `sample(seconds)` keeps cache keys stable                                    | `src/nodes/KeyframeChannelNumber.ts`            | Treated as a match          |
| 15  | Animation | Constraints resolve in the scene, by reference                                | Constraint CHOP networks                      | A constraint needs world position, so it can't be a wired sub-chain (#204)                                                                   | `src/app/operatorStack.ts`                      | Deliberate                  |
| 16  | Animation | Drivers are nodes (ParamDriver, Math, Fit, Clamp), no expressions             | `ch()` and HScript expressions                | An expression string is sugar over the same primitives; an Expression node is a later escape hatch                                           | Drivers grounding                               | Deferred                    |
| 17  | Animation | Time sampled inside a value                                                   | SOPs cook per frame                           | Frame-keyed geometry thrashes the content-keyed cache                                                                                        | NORTH-STAR §4.4                                 | Deliberate                  |
| 18  | Animation | NLA strips for parameters, wired pose layers for bones                        | CHOPs and KineFX motion clips                 | Basher is curve-based like Blender; a scanned strip can't reach the armature deform and a wired layer can                                    | [NLA-DESIGN](NLA-DESIGN.md)                     | Deliberate                  |
| 19  | Animation | No CHOP networks, VEX, VOPs or wrangles                                       | All four                                      | **No recorded reason.** Fenced out as "a separate roadmap"                                                                                   | #1545                                           | Open                        |
| 20  | Look      | A parametric über-shader (OpenPBR)                                            | VOP shader graphs                             | For a director-first, agent-native tool a great über-shader is the right altitude; a material graph is still planned                         | OPERATORS-AND-LIGHTING §6                       | Deliberate                  |
| 21  | Look      | Per-face material reference (decided); per-face slot index (shipped)          | Per-face `shop_materialpath`                  | See §5                                                                                                                                       | #1544, #1554                                    | Migrating to match          |
| 22  | Scene     | Collections, membership by wires                                              | Bundles                                       | **No recorded comparison with bundles.** Collections follow Blender: independent of parenting                                                | `src/nodes/Collection.ts`, #1545                | Open                        |
| 23  | Scene     | Separate `viewport` and `render` visibility                                   | One display flag at /obj gates both           | Blender keeps them apart. The code comment saying Houdini does too is wrong (#1546)                                                          | `src/nodes/visibilityParams.ts`                 | Deliberate                  |
| 24  | Scene     | Inspector organised by object, no display flag on chains                      | Display flag and a parameter pane per node    | Showing the graph too early is the failure mode of Houdini-for-everyone                                                                      | THESIS §16                                      | Deliberate                  |
| 25  | Scene     | The graph is the scene document                                               | USD / Solaris stage                           | Right shape, wrong cost for now; USD is planned as interchange                                                                               | THESIS §4                                       | Deliberate                  |
| 26  | Execution | Content-hash cache keys                                                       | A time-dependence flag per node               | One animated chain in twenty costs the same to scrub as fully static                                                                         | NORTH-STAR §4.4                                 | Deliberate                  |
| 27  | Execution | Overlays found by node id                                                     | Found by path                                 | Independent of depth by construction                                                                                                         | NORTH-STAR §4.4                                 | Deliberate                  |
| 28  | Execution | Deformation on the GPU                                                        | Cooked on the CPU                             | Right for a realtime viewport                                                                                                                | NORTH-STAR §4.4                                 | Deliberate                  |
| 29  | Execution | Renders through `outputs.render`, RenderJob and the ComfyUI/fal bridges       | ROP networks                                  | **No recorded reason**                                                                                                                       | #1545                                           | Open                        |
| 30  | Authoring | The agent is a first-class author; every change is an operation with a source | No equivalent                                 | If the agent could bypass the operations, every cross-cutting feature would need two cases                                                   | THESIS §18, §50                                 | Deliberate                  |
| 31  | Authoring | The graph is hidden by default; the node view is read-only                    | Graph-first                                   | Showing the graph too early is the failure mode of Houdini-for-everyone                                                                      | THESIS §16                                      | Deliberate                  |

Rows 19, 22 and 29 have no recorded reason yet. #1545 records a decision for each (keep,
change or defer, and why), here.

## 7. Where the detail lives

- [OBJECT-DATA-SPLIT-DESIGN](OBJECT-DATA-SPLIT-DESIGN.md): the Object/data boundary, flat
  storage, and why Templates come later (§12).
- [UNIFICATION-PRINCIPLES](UNIFICATION-PRINCIPLES.md): what shared surfaces key on, and why
  that survives a node view.
- [NORTH-STAR](NORTH-STAR.md): the one geometry model, and which reference to follow per
  concern.
- [OPERATORS-AND-LIGHTING-DESIGN](OPERATORS-AND-LIGHTING-DESIGN.md): operators, socket
  types and shading.
- `THESIS.md`: the product, the agent as a privileged user (§18) and the operation system
  (§50).
