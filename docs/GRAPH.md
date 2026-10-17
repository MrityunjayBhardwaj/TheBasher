# The Basher graph

This is the one place that says what the Basher graph is. The design docs it links to hold
the detail and the history; when they and this page disagree, this page is the spec and the
other doc needs fixing.

**In one sentence:** Basher's graph is one flat, typed graph of nodes, and that graph is the
saved document. Every relationship in it is a **wire**, a **reference** or an **attribute**.
Everything else (the outliner, the modifier stacks, the inspector, the node view) is a view
of the graph, and every change to it is one of the **9 operations**.

## 1. The document

The saved project is a `DagGraph` (`src/core/dag/state.ts`): a map of nodes by id, plus
named `outputs` (`scene`, `render`) that say which nodes the app draws and renders. Wires are
stored on the consuming node's inputs. There is no other document state: no hierarchy
table, no selection-owned data, no side store a reload depends on (#1565 audits this).

The graph changes only through these operations (`OpSchema`, `src/core/dag/types.ts`):

| Operation                            | What it does                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `addNode` / `removeNode`             | Add a node (optionally with its wires) or delete it                                        |
| `connect` / `disconnect`             | Add or remove a wire into a socket                                                         |
| `setParam`                           | Change a parameter value                                                                   |
| `setMeta`                            | Rename a node, or place it in the node view (#1562)                                        |
| `setSpareParam` / `removeSpareParam` | Add or remove a user parameter on any node                                                 |
| `setOutput`                          | Bind `scene` or `render` to a node (#1550); its doors keep the render on the scene (#1674) |

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

A wire says what it owns on the socket it enters (`owns` on the input, `InputDescriptor` in
`src/core/dag/types.ts`), and `wireOwnership` (`src/core/dag/idRefSweep.ts`) is the one reader:

| The socket says  | Deleting the node that holds it                                                                             | Examples                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `owns: 'always'` | takes what is wired in, when nothing else reads it or names it                                              | an Object's `data`, `pose` and `children`; a driver's `in`    |
| `owns: 'stack'`  | on its own: the node is spliced out and the stack stays whole. Reached as owned: the rest of the stack goes | a modifier's chain socket; a pose layer's and a Rig's `pose`  |
| `body: true`     | takes the whole sub-network behind it                                                                       | a Solver's `body` and `bodies`; a Rig's `body`                |
| nothing          | leaves it alone                                                                                             | a Material; the camera a pass renders; a collection's members |

So deleting a cube takes its modifiers and data, a driver on it, the Solver only that driver
read and everything inside that Solver; a Material or an Action it used stays, because a
picker still lists it. Every input socket is in one row of this table or the other: a test
lists the ones that own nothing (`SHARED_WIRES`, `src/nodes/idRefAcknowledged.ts`), so a new
socket has to choose. One delete function applies it (`buildDeleteNodesOps`,
`src/app/sceneNodeActions.ts`), for the Delete key, the outliner, the agent and the buttons
that remove a driver. Children still go with a deleted parent; handing them up to the
grandparent is #1517, which waits on the keep-position reparent in #1516.

Duplicate reads the same table (`buildDuplicateNodesOps`, same file). A **deep** duplicate
(Shift+D) copies what the original owns by wire, whole sub-networks included, and the sidecars
that name it as their subject (channels, constraints, drivers, strips); what it does not own
stays shared (a Material, an aim target, an Action). A **linked** duplicate (Alt+D) copies the
object, its children and its sidecars, and shares everything else it reads, so editing the
mesh, a modifier or the pose changes both. Several nodes duplicated together share one id
map, so a reference between two of them lands on the copies. A copy of a named node takes the
name with the next free number, and a copy that followed another node's name follows that
node's copy when it was copied too.

Two things differ from Blender on purpose. A linked duplicate shares its modifiers along with
its mesh, because here they sit on the data wire and in Blender they belong to the object.
And a parent's children are copied with it, where Blender copies only what is selected.

One reference is stored outside the parameters: a node whose name follows another's holds that
node's id in `meta.nameFrom`. The same walker reads it, so deleting the followed node clears
the link and the follower keeps the name it has. `relationsOf` (`src/core/dag/idRefSweep.ts`)
answers every relationship of a node at once: wires in and out, references in and out, name
followers and sub-network membership. A loop that runs through a reference is stored and
named by `referenceCycles`, not refused; a loop of wires alone is still refused.

A reference can also be aimed at nothing: a node that is gone, or a parameter path the target
does not have. What happens depends on the door, as in Blender. The agent's authoring door
refuses a path that is certainly missing and lists what does animate; "certainly" means the
measured list of animatable paths placed that kind of node and has no such path, and the
node's own schema drops a value written there. A raw operation and a loaded project keep such
a reference, so an older project still loads, and `brokenReferences`
(`src/app/animatableParams.ts`) lists it. Nothing is stored to mark it, so a reference that
resolves again simply leaves the list.

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
   is the closure behind a node's inputs declared `body: true` (the Solver and the Rig
   today, Templates next). Every wire leaving a sub-network ends inside it or in its owner's
   body sockets, so a node belongs to at most one sub-network and the outside reaches it
   only through the owner (`src/core/dag/subnetworks.ts`, #1547). The owner declares the
   sub-network's **named inputs** (`bodyInputs`), and a `BodyInput` leaf inside reads one by
   name; the owner binds a value to each name when it cooks the sub-network (#1548). A
   stateful owner (the Solver) is cooked per frame by its replay seam, and the evaluator asks
   that seam whenever a walk reaches a stateful node, so a sub-network can hold another: each
   cook is its own evaluation with its own bindings (#1558). One thing is refused for now: a
   Lag or Solver inside a Solver's sub-network reading that Solver's own inputs. Its history
   is replayed apart from the Solver around it, where those inputs are not bound, so it would
   read 0; the wire is refused with what to do instead (#1579). A stateless one (the
   Rig, #1357) needs no cook: each named input is the owner's own socket of that name, and
   the evaluator makes the leaf read exactly what that socket's producer evaluates to, whether
   it is asked through the owner or of a node inside on its own. The node view's levels
   are computed from this, so the saved format has no nesting to migrate. Why flat:
   [OBJECT-DATA-SPLIT-DESIGN §2.2](OBJECT-DATA-SPLIT-DESIGN.md) ("on a DAG, pointer and
   containment are the same edge") and §2.4.
3. **Membership is reachability.** An object is in the scene if the scene's wires reach it
   (`children`, `lights`, `camera`, collection `members`). Every door that adds or removes
   a wire keeps nodes reachable. Decided in #1519.
4. **Time lives inside values.** A channel's value carries `sample(seconds)`, the Scene owns
   its frame range, and nothing cooks per frame. That keeps the content-keyed cache flat
   when you scrub ([NORTH-STAR §4.4](NORTH-STAR.md)).
5. **Every gesture records graph data through the 9 operations.** Nothing in the document
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

| #   | Area      | Basher                                                                                                                            | Houdini                                                                                                                                     | Reason                                                                                                                                       | Source                                           | Status                      |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| 1   | Structure | One flat graph                                                                                                                    | Contexts (/obj, SOP, CHOP, VOP, DOP, LOP)                                                                                                   | The difference is expressed in the socket type, not a network wall; containment without contexts would be cargo cult                         | OBJECT-DATA-SPLIT §2.2                           | Deliberate                  |
| 2   | Structure | One node registry, typed sockets for every domain                                                                                 | A network type per context                                                                                                                  | SOP/CHOP/VOP differ only by wire type; a class above them would be ceremony                                                                  | OPERATORS-AND-LIGHTING §2.1                      | Deliberate                  |
| 3   | Structure | The stack's main input is the named `chain` socket                                                                                | Input 0 by position                                                                                                                         | Sockets are a named record, so position is unavailable                                                                                       | `InputDescriptor` docs, `src/core/dag/types.ts`  | Deliberate                  |
| 4   | Structure | No saved sub-networks yet                                                                                                         | Digital assets (HDAs)                                                                                                                       | Sequencing, not architecture: Templates come after the body-input work (#1548, #1557)                                                        | OBJECT-DATA-SPLIT §12                            | Planned                     |
| 5   | Data      | Object → data over a `data` wire                                                                                                  | The geo object contains its SOP network                                                                                                     | On a DAG, pointer and containment are the same edge; take the Object/data boundary all three DCCs share                                      | OBJECT-DATA-SPLIT §2.2, §2.3                     | Deliberate                  |
| 6   | Data      | Modifiers are wired operators on the data chain                                                                                   | Wired SOP chain                                                                                                                             | A match: wiring from Houdini, the stack UI from Blender                                                                                      | NORTH-STAR §4.3                                  | Match                       |
| 7   | Data      | Domains point / edge / face / corner; no detail domain                                                                            | Point / vertex / primitive / detail                                                                                                         | Edge data is a parameter channel between operators (Blender's bevel weight); detail has no consumer yet and can be added without a migration | `ref/architecture/polygonal-atoms.md`            | Edge deliberate; detail gap |
| 8   | Data      | Component groups on faces only                                                                                                    | Point, primitive, edge and vertex groups                                                                                                    | Other domains are the same mechanism without a consumer yet; seams are the first (#1528)                                                     | `src/nodes/ComponentGroupOp.ts`                  | Gap                         |
| 9   | Data      | Array and Mirror copy buffers                                                                                                     | Copying a packed primitive copies a reference                                                                                               | None: recorded as a defect                                                                                                                   | #606                                             | Gap                         |
| 10  | Data      | Imported meshes stored in the project                                                                                             | Referenced by default                                                                                                                       | User decision: an import is the same as local geometry; a referenced form answered none of the parity questions                              | NORTH-STAR (one geometry model)                  | Deliberate                  |
| 11  | Data      | Four skin weights per point                                                                                                       | Variable-length `boneCapture`                                                                                                               | three.js draws exactly four and glTF carries four per set                                                                                    | Skinning grounding                               | Deliberate                  |
| 12  | Data      | One skeleton input, no separate capture pose                                                                                      | Capture pose and rest pose                                                                                                                  | Accepted cost in #393                                                                                                                        | #393                                             | Deliberate                  |
| 13  | Data      | Spare parameters on every node                                                                                                    | Spare parameters                                                                                                                            | A match, chosen to follow Houdini                                                                                                            | `setSpareParam`                                  | Match                       |
| 14  | Animation | Keyframes are channel nodes that reference their target                                                                           | Channels live on parameters                                                                                                                 | Edge-less in the value graph, edge-ful in the dependency graph; `sample(seconds)` keeps cache keys stable                                    | `src/nodes/KeyframeChannelNumber.ts`             | Treated as a match          |
| 15  | Animation | Constraints resolve in the scene, by reference                                                                                    | Constraint CHOP networks                                                                                                                    | A constraint needs world position, so it can't be a wired sub-chain (#204)                                                                   | `src/app/operatorStack.ts`                       | Deliberate                  |
| 16  | Animation | Drivers are nodes (ParamDriver, Math, Fit, Clamp), no expressions                                                                 | `ch()` and HScript expressions                                                                                                              | An expression string is sugar over the same primitives; an Expression node is a later escape hatch                                           | Drivers grounding                                | Deferred                    |
| 17  | Animation | Time sampled inside a value                                                                                                       | SOPs cook per frame                                                                                                                         | Frame-keyed geometry thrashes the content-keyed cache                                                                                        | NORTH-STAR §4.4                                  | Deliberate                  |
| 18  | Animation | NLA strips for parameters, wired pose layers for bones                                                                            | CHOPs and KineFX motion clips                                                                                                               | Basher is curve-based like Blender; a scanned strip can't reach the armature deform and a wired layer can                                    | [NLA-DESIGN](NLA-DESIGN.md)                      | Deliberate                  |
| 19  | Animation | No CHOP networks, VEX, VOPs or wrangles                                                                                           | All four                                                                                                                                    | **No recorded reason.** Fenced out as "a separate roadmap"                                                                                   | #1545                                            | Open                        |
| 20  | Look      | A parametric über-shader (OpenPBR)                                                                                                | VOP shader graphs                                                                                                                           | For a director-first, agent-native tool a great über-shader is the right altitude; a material graph is still planned                         | OPERATORS-AND-LIGHTING §6                        | Deliberate                  |
| 21  | Look      | Per-face material reference (decided); per-face slot index (shipped)                                                              | Per-face `shop_materialpath`                                                                                                                | See §5                                                                                                                                       | #1544, #1554                                     | Migrating to match          |
| 22  | Scene     | Collections, membership by wires                                                                                                  | Bundles                                                                                                                                     | **No recorded comparison with bundles.** Collections follow Blender: independent of parenting                                                | `src/nodes/Collection.ts`, #1545                 | Open                        |
| 23  | Scene     | Separate `viewport` and `render` visibility                                                                                       | One display flag at /obj gates both                                                                                                         | Blender keeps them apart (measured in 5.1.1), and Basher follows Blender here                                                                | `src/nodes/visibilityParams.ts`                  | Deliberate                  |
| 24  | Scene     | Inspector organised by object, no display flag on chains                                                                          | Display flag and a parameter pane per node                                                                                                  | Showing the graph too early is the failure mode of Houdini-for-everyone                                                                      | THESIS §16                                       | Deliberate                  |
| 25  | Scene     | The graph is the scene document                                                                                                   | USD / Solaris stage                                                                                                                         | Right shape, wrong cost for now; USD is planned as interchange                                                                               | THESIS §4                                        | Deliberate                  |
| 26  | Execution | Content-hash cache keys                                                                                                           | A time-dependence flag per node                                                                                                             | One animated chain in twenty costs the same to scrub as fully static                                                                         | NORTH-STAR §4.4                                  | Deliberate                  |
| 27  | Execution | Overlays found by node id                                                                                                         | Found by path                                                                                                                               | Independent of depth by construction                                                                                                         | NORTH-STAR §4.4                                  | Deliberate                  |
| 28  | Execution | Deformation on the GPU                                                                                                            | Cooked on the CPU                                                                                                                           | Right for a realtime viewport                                                                                                                | NORTH-STAR §4.4                                  | Deliberate                  |
| 29  | Execution | Renders through `outputs.render`, RenderJob and the ComfyUI/fal bridges                                                           | ROP networks                                                                                                                                | **No recorded reason**                                                                                                                       | #1545                                            | Open                        |
| 30  | Authoring | The agent is a first-class author; every change is an operation with a source                                                     | No equivalent                                                                                                                               | If the agent could bypass the operations, every cross-cutting feature would need two cases                                                   | THESIS §18, §50                                  | Deliberate                  |
| 31  | Authoring | The graph is hidden by default; the node view is read-only                                                                        | Graph-first                                                                                                                                 | Showing the graph too early is the failure mode of Houdini-for-everyone                                                                      | THESIS §16                                       | Deliberate                  |
| 32  | Structure | A Number converts into a Vector3 input (the number on all three axes) and a Vector3 into a Number input (the average of its axes) | Blender converts both the same way; Houdini documents float to vector as converting on the wire, and says nothing found for vector to float | A match with Blender. A type a socket already accepts is never converted, so a driver still knows whether a Number or a Vector3 arrived      | `src/core/dag/socketConversion.ts`, #1549, #1590 | Match                       |

Rows 19, 22 and 29 have no recorded reason yet. #1545 records a decision for each (keep,
change or defer, and why), here.

## 7. Where the detail lives

- [GRAPH-ROADMAP](GRAPH-ROADMAP.md): the order this milestone is built in, and why.
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
