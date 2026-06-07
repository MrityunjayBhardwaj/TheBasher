# Basher as a Platform — the Unified-Graph Vision (end-to-end)

> **Status:** Forward-looking architecture + competitive-landscape record, consolidated 2026-06-07/08.
> This is the companion to THESIS **§59a** (UI-projection engine) and **§59b** (unified 2D/3D image
> domain). It is **not** a v0.6 commitment — v0.6 ships ease-of-use + materials + UV + Spline-grade
> chrome (see `docs/SPLINE-UI-REFERENCE.md`). The direction below is **v0.7+**, captured now because the
> design discussion produced a coherent thesis and a deep-research pass found the target is open
> whitespace. **Scope discipline (§196):** everything here is _implementation substrate + a revealable
> node domain_, never a second app and never the graph-first on-ramp.

---

## 0. The one-paragraph picture

Basher's wedge is a **director composing a film as a procedural graph, with an agent as co-author**
(THESIS §27, §55). Underneath, _everything is one DAG_: every edit is an `Op` (§50), the graph is
**deterministic + serializable** (§48–51), and the **agent edits the same Ops a human does** (§18). That
substrate has three compounding consequences, each a layer of the same idea:

1. **UI is a projection of the DAG** (§59a) — a node's parameter UI is generated from its schema; the
   inspector, the DAG view, gizmos, and interactions are all _projections_ of the same graph.
2. **Interaction is composition, not bespoke code** (§59a, Layer 2.5) — manipulation decomposes into
   declarative primitives bound to the DAG and committing Ops; the agent can author tools, not just edit
   scenes.
3. **2D and 3D can live in one graph** (§59b) — a rendered 3D frame and 2D compositing/image ops are the
   _same kind of evaluated output_, so they belong in the _same_ DAG, with the loop:
   **3D render → composite/grade → use as a texture back on 3D.**

Deep research (2026-06) found that **no shipping product or research project combines all four of**
{unified 2D/3D in one DAG, web-native, agent-authors-the-graph, deterministic serializable IR}. It is an
**open gap.** Basher already has three of the four; the fourth (unified 2D/3D) is the v0.7 reach.

---

## 1. The substrate (what makes the rest possible)

| Property                          | Where it lives today                                                                                         | Why it matters downstream                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **One DAG**                       | `core/dag` evaluator; every node resolves to an evaluated output (`EvaluatedMesh`, render `RenderOutput`, …) | A 2D image is "just another evaluated output" — `EvaluatedImage`. No new paradigm.                               |
| **Op system**                     | `core/dag/ops`, the only mutation path (§50)                                                                 | Any future surface — paint, composite, a custom tool — inherits undo / redo / replay / multiplayer **for free**. |
| **Determinism + serializable IR** | §48–51; JSON project, content-hashed stores                                                                  | The rarest property in the landscape (see §4). The thing competitors don't have.                                 |
| **Agent = privileged user**       | `agent/` edits via the same Ops (§18)                                                                        | "Agent authors the graph" is already real here; in the landscape it's the second-rarest property.                |
| **Projection inspector**          | `NPanel` renders `node.params` generically (~70% projection today)                                           | The seed of the whole platform play — see §2.                                                                    |

---

## 2. The UI-projection engine (recap — full detail in THESIS §59a)

Layers, framed as **compose vs. author-once** (not easy/hard):

- **L0** node param schema (exists, Zod, agent-introspectable).
- **L1** inspector = pure projection of the schema (exists, ~70%; bespoke sections = signal L2 is thin).
- **L2** projection vocabulary as DATA (grouping, conditional visibility, widget hints, gizmo binding).
  Same engine retargets to the read-only DAG view (v0.6 #5) and the v0.7 node editor.
- **L2.5** interaction-as-composition: `trigger · pick · gesture · bind · constrain · feedback · commit(Op)`.
  Move/rotate/scrub = one machine, different bindings; Op-backed so every custom interaction inherits
  undo/replay/agent-authoring. Precedent: Unreal Interactive Tools Framework, Houdini handles, Blender
  `GizmoGroup`.
- **L3** thin irreducible residue (new affordance widgets + nonlinear/solver binds — authored **once**,
  registered back) + each app's **authored taste** (chrome/palette/onboarding — stays curated, §196).

**Platform consequence:** Layers 0–2.5 are the seam where Basher becomes a base other web 3D apps build
on (define a node → get its parameter UI, DAG-view projection, and composable interactions for free).
The differentiator is **not** "UI is a projection" (Houdini/Blender got there first) — it is the
**substrate** (web, deterministic, Op-backed, agent-authorable). The escape hatch is mandatory:
declarative-by-default, always able to drop to imperative code (no-code ceiling kills systems that can't).

---

## 3. The unified 2D/3D procedural image domain (the v0.7 reach)

### 3.1 What it is

A **node domain** (not a separate app) where image/compositing operations live in the _same_ DAG as the
3D scene. A rendered frame (the AI-render bridge and render-to-PNG `RenderOutput` already produce one)
flows into compositing nodes (grade, blur, merge, mask, generate, AI-filter), and the result can flow
**back** as a texture onto a 3D material — the **feedback loop** no source in the landscape describes.

### 3.2 The fork that decides the cost (do NOT blur these)

- **Compositing / procedural image graph** (Nuke / Fusion / Substance / Graphite model) — nodes operate
  on whole images. **Low stretch, on-wedge** (it's _finishing the film_), reuses the DAG/Op/agent
  substrate wholesale. The "engine inside the node" is small, well-understood (filters = shaders), and
  **rides the v0.7 WebGPU + TSL renderer bet**. → **This is the "when, not if."**
- **Direct-paint raster app** (Photoshop / Procreate / PixiEditor) — freeform pixel painting. **High
  stretch, off-wedge.** The DAG makes the _architecture_ free, **not the paint engine** (brush capture,
  pressure, tile/GPU compositing, huge-canvas memory) — a product-sized effort, exactly parallel to
  "projection makes the inspector free, not the renderer." And it serves a _different user_ (a painter,
  not a director), competing with beloved incumbents where Basher has no edge. → **"probably never, and
  that's fine."**

### 3.3 The engine-vs-plumbing principle (the recurring lesson)

> The DAG / projection gives you the **plumbing** (organization, connection, evaluation, undo, agent) for
> free. It never gives you the **engine** (renderer, paint engine, solver) — that is domain-specific
> machinery you **adopt or build**, and it must be (a) web-native / same-runtime and (b) wired into
> Basher's Op/DAG. You adopted **three.js** as the 3D engine this way (a TS/web library through your own
> DAG). The 2D analog is to adopt a **web-native raster engine** (see §6), **not** to port a desktop app.

### 3.4 Why it's on-thesis, not a bolt-on

THESIS §27: _"A film is a graph that evaluates to a sequence of frames."_ Operating on frames _is_ the
back half of that sentence. The render bridge already emits images into the graph; a compositing domain
is the natural completion of the render pipeline, and it compounds with §59a (an image node is another
schema → projected inspector; the 2D canvas is L2.5 composition; a brush is an L3 author-once primitive).

---

## 4. Competitive landscape (deep research, 2026-06 — adversarially verified)

**Method:** 5 search angles → 17 sources → 70 claims → 25 adversarially verified (3-vote, 2/3 to kill) →
20 confirmed. **Verdict: the full four-property combination is an open gap.**

### 4.1 The four-property matrix

| Tool                                |    ① 2D+3D one DAG    |   ② Web-native   | ③ Agent authors graph | ④ Deterministic serializable IR  |  Score  |
| ----------------------------------- | :-------------------: | :--------------: | :-------------------: | :------------------------------: | :-----: |
| **ComfyUI + ComfyGPT / ComfyUI-R1** |   ✗ (2D diffusion)    |        ✓         |           ✓           |           ✓ (JSON DAG)           | **3/4** |
| **Graphite**                        |      ✗ (2D only)      |        ✓         |           ✗           |                ✓                 |   2/4   |
| **ShapeCraft** (arXiv, NeurIPS '25) |      ✗ (3D only)      |   ✗ (Blender)    |           ✓           |        ✓ (GPS DAG/JSONL)         |   2/4   |
| **Figma Weave** (~$200M acq.)       |     ✗ (2D media)      |        ✓         |       ✗ (human)       |        ✗ (none published)        |   2/4   |
| **Adobe Project Graph**             |    ✗ (Firefly 2D)     |        ✓         |    ✗ (AI in nodes)    |             ~partial             |   2/4   |
| **Runway Workflows**                | ✗ (img/vid/txt/audio) |        ✓         |   ✗ (LLM = a node)    |               ~DAG               |   2/4   |
| **LL3M** (arXiv)                    |        ✗ (3D)         |        ✗         |           ✓           |        ✗ (imperative bpy)        |   1/4   |
| **Houdini COPs / Nuke / Fusion**    |           ✓           |        ✗         |           ✗           |        ✗ (.hip / native)         |   1/4   |
| **PixiEditor 2.0**                  |     ✗ (2D raster)     | ✗ (.NET desktop) |           ✗           | ~node graph, not serializable IR |  ~1/4   |
| **Basher (target)**                 |           ✓           |        ✓         |           ✓           |                ✓                 | **4/4** |

### 4.2 Closest prior arts & exactly where they fall short

- **Graphite** ([github](https://github.com/GraphiteEditor/Graphite)) — closest _web-native deterministic
  procedural-DAG_ tool (Rust→Wasm, WebGPU, serializable IR). **Misses:** 2D-only (no 3D current _or_
  roadmap) + no agent layer. The nearest "web-native Substance," deliberately not going 3D.
- **ShapeCraft** ([arXiv 2510.17603](https://arxiv.org/html/2510.17603v1)) — closest
  _agent-authored-graph-IR_; LLM agents author/refine a serializable DAG ("GPS"). **Misses:** 3D-only,
  desktop/Blender.
- **ComfyUI + ComfyGPT / ComfyUI-R1** ([2503.17671](https://arxiv.org/html/2503.17671v2),
  [2506.09790](https://arxiv.org/html/2506.09790v1)) — highest at **3/4**: browser, agents that
  autonomously generate + self-correct a serializable JSON node-graph. **Misses the one that matters:**
  ComfyUI treats 2D and 3D as _separate task categories_, never one graph.

The structural pattern: **the web/agent/IR crowd is 2D-media or 3D-only; the unified-2D/3D crowd
(Houdini/Nuke) is desktop, no agent, no web IR.** Nobody bridges them. The bridge + the
render→composite→texture loop is the whitespace.

### 4.3 Adjacent threats (well-funded, racing the web + node-graph axes)

- **Figma Weave** ([blog](https://www.figma.com/blog/welcome-weavy-to-figma/)) — browser AI node-canvas,
  ~$200M acquisition, shipping. 2D media only.
- **Adobe Project Graph**
  ([blog](https://blog.adobe.com/en/publish/2025/11/25/introducing-project-graph-creative-workflows-reimagined))
  — visual node editor wiring Firefly models. 2D, human-authored (agentic NL is a _separate_ assistant).
- **Runway Workflows** ([runwayml.com/workflows](https://runwayml.com/workflows)) — node DAG chaining
  media + LLM nodes. No 3D socket; LLM nodes are components, not graph authors.

None has announced 3D-in-the-graph _or_ autonomous agent-authoring of the graph structure — but they're
2/4 and fast. **The risk is timing, not concept.**

### 4.4 Basher's defensible moat (in this matrix)

The combination, anchored on the **two rarest bars**: **agent-authors-the-graph × determinism × unified
2D/3D in one web IR.** The **3D → composite → texture-back-on-3D** loop is the single primitive no source
describes.

### 4.5 Research caveats (intellectual honesty)

"Open gap" = absence of a _shipping/published_ match, not proof nothing is in private development. The
frontier moves monthly (every strong entrant is <12 months old, several alpha/early-access). Some sources
are vendor blogs (corroborated by trade press). A stealth startup matching all four would not surface on
GitHub/arXiv/Product Hunt. **→ Re-run the research directive (§7) before committing the phase.**

---

## 5. PixiEditor — a REFERENCE, not the base

**Facts (verified 2026-06-08):** PixiEditor is **C# / .NET (~5.5M LOC) + Avalonia UI + a Skia-based
renderer ("Drawie"), LGPL-3.0, desktop** (Steam/download), 7.7k★, actively maintained. **PixiEditor 2.0
is node-based:** _"All layers, effects and the layer structure are nodes… PixiEditor exposes a node graph
for every document… procedural art/animations."_

**Why we do NOT port it (three reasons, each mapping to a thread above):**

1. **It's a rewrite, not a port.** 5.5M LOC of C#/Avalonia/Skia → a TS/R3F/three.js stack shares _zero_
   runtime. "Porting" = reimplementing in TS with PixiEditor as a spec.
2. **Embedding it (.NET→WASM) makes a foreign island.** It would run its _own_ node graph, document
   model, undo stack, and Skia renderer, and **cannot see Basher's DAG/Ops/IR** — two graphs that don't
   talk. That is the §809 two-pipelines failure made literal, and it **detonates the moat** (a WASM
   island isn't in the deterministic IR and isn't agent-authorable through Ops). The whole point was
   "one graph."
3. **LGPL-3.0** adds relink/source obligations — manageable, but moot given (1)/(2).

**Why it IS a great reference:** PixiEditor 2.0 already validated **"model a 2D raster/compositing editor
as a node graph where layers ARE nodes"** — exactly the model we'd want for the 2D domain. Study it the
way we studied Spline: **for the model (nodes-as-layers, effect-graph topology, how brushes attach to a
node), not the code.** ([github.com/PixiEditor/PixiEditor](https://github.com/PixiEditor/PixiEditor))

---

## 6. The "adopt the engine the three.js way" path (if/when we build the 2D domain)

Adopt a **web-native raster/compositing engine as a library**, projected through Basher's Op/DAG — never a
desktop app:

- **CanvasKit** — _the same Skia PixiEditor renders with_, compiled to WASM (it powers Flutter Web). A
  real raster/compositing backend, in-browser, callable from TS. The most direct "Skia without the
  desktop app."
- **A WebGPU compositor** — image-node ops as compute shaders; aligns with the v0.7 WebGPU + TSL bet.
- **Konva / Fabric.js** — lighter 2D-canvas, for modest needs.

In every case the library is the **engine inside the node**; the irreducible work is **wiring it into
Basher's Op/DAG** so it inherits determinism, undo, and agent-authoring. Same shape as adopting three.js
for 3D.

---

## 7. RESEARCH DIRECTIVE — run before scoping/building this domain

> **Instruction to whoever picks this up (future session / planner):** the landscape in §4 moves monthly.
> Before locking scope for the 2D/3D image domain, **run a fresh deep-research pass** (the
> `/deep-research` harness) over **all** the sources below, and refresh the §4 matrix + threats. Treat
> §4 as a snapshot dated 2026-06, not current truth.

**Sources to deep-research (refresh + go deeper than the snapshot):**

- **Closest prior art / competitors:** Graphite (`github.com/GraphiteEditor/Graphite`), Figma Weave
  (`figma.com/blog/welcome-weavy-to-figma`), Adobe Project Graph (Adobe blog 2025-11), Runway Workflows
  (`runwayml.com/workflows`).
- **Agent-authored graphs (research):** ComfyGPT (`arXiv:2503.17671`), ComfyUI-R1 (`arXiv:2506.09790`),
  LL3M (`arXiv:2508.08228`), ShapeCraft (`arXiv:2510.17603`). Also scan arXiv for newer "LLM authors node
  graph" / "agentic procedural 3D" papers.
- **Node-raster design reference:** PixiEditor 2.0 node system
  (`github.com/PixiEditor/PixiEditor`); Graphite's Graphene node engine; Houdini COPs (Copstance:
  `github.com/emllnd/copstance`); Nuke/Fusion 3D+2D graph models.
- **Engine-adoption candidates:** CanvasKit / Skia-WASM; WebGPU compute compositing libraries; survey
  current web raster/compositing engines (2025–2026).
- **Net-new hunts:** browser-native Nuke/Substance equivalents; any startup announcing unified 2D/3D in
  one graph OR a 3D socket added to a web node tool; determinism/serializable-IR claims with an agent
  layer; the explicit **3D→composite→texture feedback loop** as a node primitive anywhere.

**Output of that pass:** refreshed matrix, refreshed closest-prior-art, refreshed threats + time horizon,
and a go/no-go on whether the open gap still holds.

---

## 8. Roadmap placement

- **v0.6** — _not here._ Ease-of-use + materials + UV + Spline-grade chrome (`SPLINE-UI-REFERENCE.md`).
- **v0.7** — projection engine (L2/L2.5) + the unified 2D/3D **compositing** domain as a rider on the
  WebGPU + TSL renderer migration. Paint tools deferred indefinitely (off-wedge).
- **Platform/SDK** — Layers 0–2.5 exposed as a node-UI + node-interaction SDK; the 2D/3D domain is the
  flagship proof that "one deterministic, agent-authorable web graph" spans both worlds.

---

## 9. North Star — what it enables, why it's superlinear, and who it's for

### 9.1 The integrating insight: 6 mechanisms, 1 purpose

The north star is **not a feature list**. It is **one purpose served by six mechanisms, all riding one
substrate.** The purpose is the last item, not a separate one:

```
                         ONE SUBSTRATE  (one DAG · one Op · one IR · agent = privileged user)
                                   │
        ┌──────────┬──────────┬────┴─────┬──────────┬───────────┐
   #1 no-cliff  #3 AI-native  #2/#6      #4 AI×CG   #5 renderer  …each a MECHANISM
   skill ramp   cheap/local   modular    control    as adapter
                              platform    dial
                                   │
                                   ▼
                    #7  empower the overlooked individual creator
                        to do the WHOLE creative act  ←  the PURPOSE
```

**The values and the architecture are the same decision.** Corporate suites gate on price + complexity
_because_ they lack one substrate — they cannot deliver the full act cheaply or simply. Determinism,
modularity, and local-AI aren't chosen for elegance; they are the _only_ delivery mechanism for the
mission. That top-to-bottom coherence (values → architecture) is what no competitor can copy by shipping
a feature.

### 9.2 The seven enablers (sharpened, each with its mechanism + condition)

1. **No learning cliff — a ramp, not a wall.** Today Spline→Blender is a _cliff_ (different tool, total
   re-learn, lossy export). Basher's simple and deep controls are the _same objects at different
   disclosure depths_ (projection + §17a progressive disclosure), so depth opens where you reach for it —
   no re-learn, no export, no second tool. _Condition:_ "advanced" must be the same graph revealed, never
   a bolted-on second UI, or the cliff returns.
2. **Fully modular UI = platform; nobody reinvents the wheel.** New functionality is a node + a
   projection, not a new app — so a downstream tool inherits inspector, DAG-view, interactions, undo, and
   agent for free (§59a/§2). The end of rebuilding the same plumbing per creative tool. _Condition:_
   "near-zero bloat" decays unless substrate purity is defended (engine-vs-plumbing still holds — you
   don't get a renderer/paint-engine for free).
3. **AI-native on the graph → cheap, local, no MCP tax.** The agent emits _typed, validated Ops on a
   compact JSON graph_ — not "drive a GUI" / "write freeform code" / "reason over N MCP schemas." Tiny
   typed action space + small context → **small/local models succeed**, errors are catchable (zod +
   deterministic replay → cheap verify-retry), and there is **one** interface (no per-tool integration
   tax). _Nuance:_ a spectrum — local for mechanical Op-emission, a strong model for high-level creative
   reasoning. Stays cheap only while the **Op vocabulary stays small** (the load-bearing discipline).
4. **The AI×CG control dial — the thing nobody has.** Not "AI _or_ manual" but a **continuum on every
   node**: generate it, hand-tune it, or let the agent do part. Every external model (image-gen, img2img,
   text-to-motion, image-to-3D) is _just a node_ producing an evaluated output into the same graph, with
   a human-or-agent dial on each. Target workflows, all without leaving Basher:
   - **(a)** kitbash + photobash → generate an image (e.g. Nano Banana) → image-to-3D (e.g. Tripo) →
     manipulate → blend into the scene.
   - **(b)** short film: storyboard → build scene → animate the actor via text-to-motion + point-and-click
     → control the camera → render via video-to-video / img2img (e.g. Seedance, or local models), full
     control end to end.
   - **(c)** base a vertical app (e.g. auto product-photography editing) on the platform → shippable in
     **weeks, not months**, with full fidelity (true for the projectable layer; domain adapters still
     cost).
   - **THE CRUX to design in:** generative models are _stochastic_ and break pure determinism. Reconcile
     it the way Basher already content-hashes assets — **pin the seed + cache the generated output as a
     content-hashed asset.** The _model_ isn't reproducible; the _graph_ is, because it references the
     pinned result. This single decision is what lets "AI" and "deterministic IR" coexist.
5. **Renderer as a swappable adapter.** Because the IR is renderer-agnostic (V32 — renderer = compile
   target), a Rust/native renderer plugs in behind an adapter spec and everything works. The WebGPU + TSL
   migration is the first proof. _Condition:_ the spec must be complete enough that a new backend covers
   it without leaking renderer-specific assumptions (determinism-across-backends discipline).
6. **The ComfyUI community is the warmest beachhead.** ComfyUI proved the appetite for node-based AI; its
   pain is exactly Basher's fix — powerful graphs, but a fixed/clunky UI, no path from "my workflow" to "a
   real product," 2D-only. The projection engine turns a graph into a branded, modular app with a real UI
   for free. (Deep research found ComfyUI+agents is the closest prior art at 3/4.) _Move:_ a ComfyUI
   import/interop adapter as a deliberate wedge.
7. **The community of misfits — the purpose, not a feature.** A tool _for the overlooked individual
   creator_ (no studio, no budget, no pipeline, no permission) is the _sharpest_ version of the strategy,
   not a softer one: beloved tools built by/for the underserved compound into a moat corporate suites
   never get. Enablers #1–6 are the means; this is the end.

### 9.3 Why it's superlinear (not additive)

Most tools are **integrations of separately-built subsystems**, so each capability pays an **N×N wiring
tax** (export seams, a second undo stack, "the agent only works in the chat panel"). Basher collapses N
subsystems into one substrate → the tax goes to **N×1**: a capability added in one domain is instantly
expressible in every domain, and every cross-feature interaction is _free_ instead of a new project.
Concrete multipliers:

- **AI output becomes editable substrate, not a black-box clip** — the render is a node in a deterministic
  editable graph, so generation becomes _direction_ (the wedge vs flat prompt-to-video, §17 failure-mode
  A).
- **The data flywheel** — every film is a reproducible `(intent → Op-sequence → exact frame)` trace across
  the _whole_ act; uniquely clean agent training/eval data competitors (tool-fragmented, lossy) cannot
  match. Compounds with usage.
- **Emergent cross-domain ops with no name today** — "keyframe a composite grade on the same timeline as
  the 3D camera move"; "mask a 2D grade with a 3D object's depth/ID pass." Trivial with one graph + one
  time model; a manual roundtrip otherwise.
- **Incumbents can't follow without re-founding** — their architectures _are_ the N×N tax; copying this is
  a rewrite, so they bolt AI on instead.

### 9.4 The one condition (and why nothing like this exists yet)

**Superlinearity is conditional on substrate purity.** Every enabler degrades the instant the substrate
leaks: a domain with a side-channel (state outside the IR), a stochastic AI node left unpinned, a
ballooning Op set, or an "advanced mode" that's secretly a second UI. **Refusing the expedient shortcut
_is_ the mission, in code.** Early tells already exist (bespoke `MATERIAL_LOBES` sections = code where
there should be data).

Why no one has built it yet: **(1) timing** — capable web (WebGPU/OPFS/Wasm) _and_ LLMs-good-enough-to-be-
a-primary-surface only converged ~2024–26; **(2) incumbent structure** — the big tools can't refactor to
one substrate without a rewrite; **(3) it's unglamorous** — the value is foundational discipline that
doesn't demo well early; **(4) it needs a contrarian belief held at once** — hide the graph, agent
co-equal, determinism everywhere.
