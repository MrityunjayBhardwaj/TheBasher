# Basher — the ideal state

**What this folder is.** One place that states, thoroughly, what Basher is *meant to be* — and
points to the authoritative source for every claim. It is an **index and a synthesis, not a copy.**
The design docs, the north star, the catalogues and the thesis remain the sources of truth; when
this page and a source disagree, **the source wins and this page is what needs fixing.** (That rule
is itself the ideal state: one projection, never a parallel list — see §6.)

**Why it exists.** The ideal state is real and written down, but it's scattered across the repo
(`THESIS.md`, `docs/`), the private Anvi store (`~/.anvideck/projects/basher/`) and session memory.
A reader who wants "what is Basher trying to be, end to end?" had nowhere single to stand. Now they
do.

**How to read a citation.** `[repo]` = in this repository (relative link resolves). `[store]` =
`~/.anvideck/projects/basher/…`, machine-local framework material. `[memory]` = session memory,
machine-local. `[issue]` = GitHub `MrityunjayBhardwaj/TheBasher`.

---

## 0. The one sentence

> **A film is a graph that evaluates to a sequence of frames. The director — human, agent, or both
> — edits the graph. The graph evaluates the film.**

Everything below follows from this. Procedural is the substrate, not a feature; generative is one
node type, not a bolt-on. — `THESIS.md` §I.2 `[repo]`

---

## 1. The thesis — why Basher exists at all

**A procedural, agent-native, director-first AI video platform built on a single primitive.** The
right primitive is neither raw language (prompt tools lose structure) nor geometry primitives (3D
pipelines lose intent) — it is **the directorial unit**, composed so it is editable, reproducible,
and machine-readable, and that humans *and* AI agents author into the same way.

- **Source of truth:** `THESIS.md` `[repo]` — the why, the what, the how; drives every architectural
  decision v0.5 → v1.0.
- **Mission, distilled:** `project_mission.md` `[memory]`.

---

## 2. What the system IS — the graph

> Basher's graph is one flat, typed graph of nodes, and that graph **is** the saved document. Every
> relationship in it is a **wire**, a **reference**, or an **attribute**. Everything else (outliner,
> modifier stacks, inspector, node view) is a *view* of the graph, and every change is one of a
> small fixed set of **operations**.

- **THE spec:** `docs/GRAPH.md` `[repo]` — the one place that says what the graph is (the three
  relationships, the node families, the rules, every difference from Houdini). **This is the top of
  the design-doc hierarchy; the per-epic docs hold detail and history under it.**

---

## 3. What the data IS — the one geometry model (the north star)

> **Basher is a procedural DCC whose primary representation is a polygonal geometry data model with
> typed per-element attributes. Every source of geometry — a primitive recipe, an imported file, a
> simulation cache, a baked buffer — enters through that one representation. No format is a
> first-class citizen; a format is an importer that fills the primary model and then stops
> existing.**

Three testable corollaries: no downstream surface branches on provenance; an imported mesh can do
everything a generated one can; the format is gone the moment the file is read (as in Blender and
Houdini).

- **The objective, stated falsifiably + the measured distance + the phased route:**
  `docs/NORTH-STAR.md` `[repo]`.
- **THE FINAL GOAL + the done-test + the route, injected at the boundary by the hook:**
  `.anvi/dharana.md` §0 `[store]`. The done-test: *take any question the model answers for a box
  (face count, arity, polygon layout, point identity, component selection, an attribute at any
  domain) and ask it of an imported mesh; every `null` is distance remaining.*
- **The atoms the model is built from:** `ref/architecture/polygonal-atoms.md` `[store]`,
  `project_atoms-and-recipes.md` `[memory]` (Blender = the default *recipe* built from atoms, never
  a code special case).
- **North-star detail in memory:** `project_north-star.md` `[memory]` (authoritative + active).
- **Epic:** #628 `[issue]`.

---

## 4. The structural laws — unification (the heart of the ideal state)

The ideal state is **unified**: one substrate, one road per concern, no parallel lists. The recurring
defect is the opposite — a concern handled N ways that grew at different times. The standing work is
collapsing those.

- **Object ↔ data split** — a scene object is an `Object` (pose) pointing at a data node (geometry +
  material). This is the joint the domain has; fusing it was the bug. `docs/OBJECT-DATA-SPLIT-DESIGN.md`
  `[repo]` (authoritative, merged). Design map in `project_object-data-split.md` `[memory]`.
- **One animation road** — native meshes, glTF children, cameras and lights animate the *same* thing
  (a node's params over time); the ideal collapses the three historical mechanisms onto one
  direct-channel + pure-resolver road. `docs/UNIFICATION-DESIGN.md` `[repo]`.
- **The subject is the unit (open)** — surfaces must not each re-reach across the object↔data split;
  the unit they consume should be the *subject* `{object, dataHalf}`, so reaching is structural, not
  opt-in. The in-flight generalization of the split-reach family. Issue #1968 `[issue]`;
  the pattern it closes is catalogued (management surfaces keyed by id).
- **The laws these rest on** (Anvi invariants, `.anvi/vyapti.md` `[store]`):
  - **A vocabulary is a projection, never a parallel list** — V101.
  - **A split object surfaces by class: an EDITING surface separates the halves, a MANAGING surface
    aggregates them under the object** — V112.
  - **Provenance beats resolution: a row generated FROM a node writes back to THAT node; the
    ownership oracle is only for callers with no row** — V142.

---

## 5. The pillars — the ideal per domain

Each links to the doc that owns that domain's end-state.

| Domain | Ideal-state source |
| --- | --- |
| Operators & lighting | `docs/OPERATORS-AND-LIGHTING-DESIGN.md` `[repo]` |
| Blender data-model parity (#231) | `docs/BLENDER-DATA-MODEL-PARITY-231-DESIGN.md` `[repo]` |
| Relational operators (constraints, drivers, CHOP) | `docs/RELATIONAL-OPERATORS-DESIGN.md` `[repo]`; `project_drivers-controllers-opnet.md`, `project_relational-operators-and-camera-rig.md` `[memory]` |
| Render-resource identity | `docs/RENDER-RESOURCE-IDENTITY-DESIGN.md` `[repo]` |
| Sub-element identity (points, keys, slots) | `docs/SUB-ELEMENT-IDENTITY-DESIGN.md` `[repo]`; `project_sub-element-identity.md` `[memory]` |
| Material architecture (OpenPBR IR → MeshPhysicalMaterial) | `project_material_architecture.md` `[memory]` |
| Animation parity (F-Curve + NLA) | `docs/NLA-DESIGN.md` `[repo]`; `project_animation-parity.md` `[memory]` |
| Compositor (one AE-style layer timeline over the DAG) | `docs/COMPOSITOR-DESIGN.md` `[repo]`; `project_compositor.md` `[memory]` |
| ComfyUI keyframe compiler | `docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md` `[repo]`; `project_comfyui-keyframe-compiler.md` `[memory]` |
| UI / editor shell | `docs/UI-SPEC.md` `[repo]`; `editor-design-v1` `[memory]` |
| AI track (generation as a citizen of the graph) | `ref/architecture/ai-track.md`, `ref/architecture/AI-RESEARCH-GATES.md` `[store]`; `project_ai-track.md` `[memory]` |
| Pro rigging | `ref/architecture/native-character-plan.html`, `skeleton-object-1056` `[store]`; `project_pro-rigging.md` `[memory]` |
| Frame pipeline (React ↔ R3F loop) | `ref/architecture/frame-pipeline-plan-2026-10-28.md` `[store]` |

---

## 6. How the ideal is kept honest — the method

The ideal state is not aspiration; it is **measured distance**. The discipline that enforces it:

- **Every behavioural claim is marked how it is known** — *measured* (read from a running system),
  *documented* (a reference's own words), or *unmeasured* (a hypothesis + the probe that settles it).
  `docs/NORTH-STAR.md` §1 `[repo]`; `feedback_measurement-discipline.md` `[memory]`.
- **The reference systems define "natural"** — Blender and Houdini, grounded to source in the Ground
  Truth docs (`ref/GROUND_TRUTH_*.md` `[store]`), not inferred.
- **The four Anvi catalogues are the living record** of invariants (`vyapti`), error patterns
  (`hetvabhasa`), lifecycles (`krama`) and project focus (`dharana`) — `~/.anvideck/projects/basher/.anvi/`
  `[store]`. `dharana.md` §0 is the final goal, read at the boundary by a hook.
- **The phase plan** sequences the route: `project_phases.md` `[memory]`.

---

## The ideal state in five lines

1. **One graph** is the document; every relationship is a wire, a reference, or an attribute. (§2)
2. **One geometry model** with typed per-element attributes; a format is an importer that fills it and
   then stops existing. (§3)
3. **One road per concern** — animation, the object↔data split, the subject — no parallel lists. (§4)
4. **Human and agent author the same graph** the same way; generation is one node type. (§1)
5. **Distance to all of the above is measured, not asserted**, against Blender and Houdini. (§6)

---

*Index assembled by consolidating the sources above. It holds no design authority of its own — it
points at the documents that do. Keep it in step with them; if it drifts, fix the index, not the
source.*
