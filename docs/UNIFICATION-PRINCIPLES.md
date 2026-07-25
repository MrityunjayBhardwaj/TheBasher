# Unification principles — what our shared surfaces key on, and what survives a node-based UI

Written 2026-07-25, while planning #458 (the shared inspector section-body dispatcher) as the
prerequisite for #387 (the camera split).

Two questions came up that are worth answering once, in writing, because the answer decides the
shape of every future consolidation:

1. **How have the surfaces unified so far actually been built — do curve, light, modifiers and the
   rest follow the same principle?**
2. **If Basher later grows a full node-based interface where things are composed from subgraphs,
   does any of this still hold? A subgraph instance has no fixed node type.**

The short version: there is a consistent principle, it was arrived at by repeated correction rather
than by design, and it happens to be exactly the property that survives subgraphs. One shipped
surface does not follow it, and that surface is the one #458 fixes.

---

## 1. What the shipped unifications key on

Each row is a real consolidation that shipped, with what it uses to decide.

> Line references in this section describe the code **as it stood before #458**, which is what the
> argument is about. The last row is the gap #458 closes; §3 records what actually changed.

| Unification                           | Decided by                                               | Node-type list?             | Reaches through `data`?    |
| ------------------------------------- | -------------------------------------------------------- | --------------------------- | -------------------------- |
| `modifierSource` (#377)               | evaluated **value kind**, `never`-closed switch          | no                          | yes — one `Object` arm     |
| `canModifyGeometry` (#377)            | evaluate the node, then ask the value                    | **deleted one**             | via `modifierSource`       |
| `resolveDataParamOwner` (#427 / #450) | **possession** — "are these params under this root key?" | no                          | yes                        |
| `iconKindForNode` (#414)              | the data node's type, resolved by **stem**               | partial (7 arbitrary cases) | yes                        |
| `bareChannelNodesForSubject` (#386)   | takes **both ids** explicitly                            | no                          | caller passes `dataId`     |
| `recomposeLightObject` (#386)         | value shape; `null` means "not a split light"            | no                          | yes, 4 call sites          |
| `LinkedDataSections` curve arm (#385) | **hardcoded `sectionId === 'curve'`**                    | —                           | **duplicated, not shared** |

Source: `src/app/modifierGeometry.ts:108` and `:168`, `src/app/resolveDataParamOwner.ts:72`,
`src/app/SceneTreeIcon.tsx:132` and `:76`, `src/app/nodeChannels.ts:77`,
`src/nodes/lightRecompose.ts:38`, `src/app/NPanel.tsx:2735`.

### The through-line

> **Capability is decided by structure or possession, never by identity — and the reach through
> `data` lives in exactly one function per concern.**

`canModifyGeometry` is the clearest instance. It _deleted_ a node-type set
(`SUPPORTED_BASE_TYPES = new Set(['BoxMesh','SphereMesh','BakedMesh'])`, which by then held a
retired type and had never gained `Object`) and replaced it with: evaluate the node, and ask whether
the resulting value is a modifier source. The question stopped being "what is this?" and became
"what does this have?".

`resolveDataParamOwner` is the same move on params: it asks whether a node's params contain the
requested root key, then reaches through `data` and asks the identical question of the data half.
No type appears anywhere in it.

### Where a type list is still legitimate

`kindForNodeType` (`src/app/SceneTreeIcon.tsx:76`) keeps seven hardcoded cases. That is not a
violation — it is a _presentation_ mapping (which glyph to draw), which is arbitrary by nature. Two
things keep it honest: a registry test forces it to stay complete, and the data-node path is
**derived by stem** rather than listed, so `LightData` → light and `CameraData` → camera fall out
without anyone maintaining a list. The comment there records that a blanket
`endsWith('Data') → mesh` was tried first and rejected precisely because it would have drawn a cube
for the kinds that had not shipped yet.

So the rule is a discriminator, not a ban:

> **A node-type gate may select _which_ control a polymorphic surface renders.
> It must never decide _whether_ that surface renders at all.**

### The one surface that does not follow it

The curve split (#385) added the data-half's section control by **copying** the arm into
`LinkedDataSections` rather than sharing it. That was a conscious local patch, and the gap was filed
immediately as #458 rather than left implicit.

The tell that it is an outlier and not a convention: of the five inspector sections that have exactly
one custom control, **four are already ungated by node type** — `modifier`, `constraint`, `driver`
and `curve` (`src/app/NPanel.tsx:3024`, `:3032`, `:3042`, `:3048`). Only `camera` carries a type gate
(`:3016`), and it predates the object↔data split. It is an artifact, not a principle.

### A third mechanism, easy to miss

There are not two dispatch mechanisms in the inspector but three. Besides the section-keyed controls
in the main-node block and in `LinkedDataSections`, `ParamRow` has its own **param-keyed**
special-case (`src/app/NPanel.tsx:2005`, `paramPath === 'material'` → material editor). That third
one is already convergent — both sites render `ParamRow`, so it cannot drift — but any guard over
"does this section render anything?" must count it, or it will report false gaps on every
`mesh`/`material` data section. This is also _why_ the box and sphere splits never surfaced the
empty-section bug: their data sections route through that special-case, so a data node with a genuine
custom section control was unprecedented until the curve.

---

## 2. Does this survive a node-based / subgraph interface?

### What is already decided

`docs/OBJECT-DATA-SPLIT-DESIGN.md` places templates/HDA at **Milestone 2, with its own design doc**,
explicitly not fused with the split work (§2.3 row 4), and explicitly **not** introducing contexts,
network levels or subnets (§2.2). Two of its findings decide the answer here:

- **Basher is already the flat resolution model.** §299, grounded on Houdini: depth is irrelevant,
  `/obj/geo/subnet/inner/tx` resolves identically at any nesting. Even in Houdini, containment is an
  _authoring_ convenience over a _flat_ resolution model. A node-based subgraph UI is therefore a
  layer above resolution, not a change to it.
- **The blocker is a missing noun, not an architectural wall.** The evaluator has no word for
  "instantiate this subgraph with these bindings"; `SolverInput` is already a promoted parameter
  hard-coded as a dedicated leaf type because that word does not exist. On a DAG, a template instance
  is _the same edge_ as fan-out with a non-empty override map.

So subgraphs arrive as **a node the evaluator understands** — a `body` input plus named parameter
inputs. There will still be a node, and it will still have a type; but the type will be something
like `TemplateInstance`, and its _interface_ will come from the definition, not from a static
registry row.

### The durability ranking

Sort the keying strategies by what survives a subgraph wrapping the node:

| Keyed by                                                                             | Survives?                 | Why                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| **evaluated value kind** (`modifierSource`)                                          | yes, untouched            | a subgraph still outputs an `ObjectData` / `SceneChild`; how it was built is invisible |
| **possession** (`resolveDataParamOwner`)                                             | yes                       | "does this node own a param under this root" is true of a promoted parm too            |
| **declaration** (`inspectorSections`)                                                | only if resolved per-node | it is currently a static per-**type** property                                         |
| **type string** (camera gate, `MaterialOverride`, `GltfChild`, keyframe-channel set) | no                        | a subgraph wrapping a camera has type `TemplateInstance`                               |

This is the answer to "does it hold cohesively": **the value-keyed and possession-keyed unifications
hold; the type-string-keyed ones do not.**

That is not a coincidence, and it is worth noticing _why_. Nobody was designing for subgraphs. Every
unification that moved closer to the value — because a type list had just drifted, or a retired type
had been left in a set — independently became more subgraph-durable. The forces that produced good
consolidation today and the forces that produce durability under a future node UI turn out to be the
same force.

### The one thing that genuinely would not hold

Not the dispatch — the **declaration lookup**. `inspectorSections` is read as a static per-type
constant at exactly two sites (`src/app/NPanel.tsx:2695`, `:2778`), both as
`getNodeType(node.type)?.inspectorSections`. A template instance's sections must come from its
promoted parameters, i.e. per-_node_, not per-_type_.

That is a one-line indirection today — `sectionsOf(state, nodeId)` wrapping the current lookup with
identical behaviour — and it is the single seam that decides whether the inspector needs _reworking_
when subgraphs land, or merely a new implementation behind one call.

### What this does not justify

Building subgraph support now. Templates are deferred on **sequencing** grounds, their real
prerequisite is the evaluator noun rather than any UI work, and nesting is still an open research
question for that milestone. Keying on possession and adding one indirection cost nothing today and
foreclose nothing; anything beyond that is speculative work against a milestone that has not been
designed.

---

## 3. What this changed in practice (#458)

The first version of the #458 plan said "port all twelve control sites verbatim." Applying the
principle above changed three things:

1. **The table is type-free.** Every node-type gate in the section dispatch has a possession-based
   restatement that is correct today and durable later. The camera gate is dropped outright:
   declaring the section _is_ the assertion that the node owns camera params. Porting it verbatim
   would have meant `CameraData` never matching, and the lens panel rendering empty — the exact bug
   #458 exists to remove.

   **Possession has to be asked of the node's declared _schema_, not of its live params object** —
   a distinction the first draft of this document got wrong, and which the implementation caught.
   A params object is a snapshot, not a statement of ownership:
   - zod `.default(…)` values materialize only when a node is CREATED (`applyAddNode` stores
     `paramSchema.safeParse(op.params).data`). Loading a project parses the generic node shape and
     never re-parses per-type schemas, so a param added to a type without a version bump is simply
     absent from every older save. `Group.pivot` is exactly that, so `'pivot' in params` would have
     dropped Set Origin for legacy Groups.
   - an `.optional()` param never materializes at all. `MaterialOverride.slotIndex` is optional
     with no default, so `'slotIndex' in params` is false until a slot is chosen — with the very
     selector the predicate was gating. That one is self-locking, not merely a legacy edge.
   - and a section's params need not be named after it: the Scene owns `envSource`,
     `envIntensity`, `envRotationY`, `envBackground`. There is no `environment` param to possess,
     so `environment` joins `camera` as declaration-keyed.

   The reliable ones are `materials` (a captured array, genuinely about the instance's contents)
   and the channel `extendBefore`/`modifiers` keys, whose v1→v2 migration backfills them
   explicitly. The rest ask `getNodeType(type).paramSchema`.

2. **The dispatcher context carries two ids.** The camera's lens control resolves effective focus as
   `|position − lookAt|`, so it reads pose from the Object while its own params live on the data
   half. One id cannot serve both. `bareChannelNodesForSubject` had already hit this and solved it by
   taking both ids explicitly; the dispatcher follows that shape rather than inventing one.
3. **`sectionsOf(state, nodeId)` lands now**, for the reason in §2 and for no benefit today.

---

## Confidence

Section 1 is read from source, with line references above; the behaviour of each helper was read, not
executed. Section 2's claims about templates are quoted from `OBJECT-DATA-SPLIT-DESIGN.md`, which
records its own probe results.

Section 3 has since been RUN, and the correction recorded there is the result. The original
"possession form" restatements were a reading of five existing gates rather than something executed,
and three of the five were wrong once checked against the schemas — which is worth keeping visible,
because the failure mode was specific: reading a params object looks like asking what a node owns,
and is actually asking what a node happens to have stored right now. The corrected predicates are
pinned by unit tests that fail if possession is asked of the instance again, and the sections whose
gates changed were observed in a browser (camera lens, scene environment, channel extend, set
origin, glTF material authoring, curve points on the linked data half). The slot selector has no
end-to-end coverage in the suite — a pre-existing gap, and the one control here resting on unit
tests alone.
