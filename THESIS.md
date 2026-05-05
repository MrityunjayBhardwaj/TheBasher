# Basher — A Thesis

**Subtitle:** A procedural, agent-native, director-first AI video platform built on a single primitive.

**Version:** Thesis v1.0 — written before P0 begins. This document is the why, the what, and the how. It is the source of truth for every architectural decision in v0.5 through v1.0.

**Status:** Draft for execution. Every section here drives concrete tasks in the phase plan.

---

## Part I — The Argument

### 1. The problem is the wrong layer of abstraction

The current generation of AI video tools is split across two failure modes:

**Failure mode A — flat prompt-to-video.** The user types a sentence. A black-box model produces a clip. Re-prompts produce different clips. Continuity is incidental. Editorial control is a hack. The user is a passenger, not a director.

**Failure mode B — traditional 3D pipeline with AI sprinkled on top.** The user opens Blender or Unreal, builds a scene the conventional way, then sends frames to a stylization model. AI is a render filter. The user is a 3D generalist before they are a director. The on-ramp is a year long.

Both failures share a root cause: **the wrong abstraction is exposed to the user.** Prompt tools expose *language* and lose structure. 3D pipelines expose *geometry primitives* and lose intent.

The right primitive is neither. It is **the directorial unit** — the shot, the scene, the move, the look — composed in a way that is *editable, reproducible, and machine-readable*, and that humans and AI agents can both author into.

### 2. The thesis

> **A film is a graph that evaluates to a sequence of frames. The director — human, agent, or both — edits the graph. The graph evaluates the film.**

Everything follows from this. Procedural is not a feature; it is the substrate. Generative is not bolted on; it is one node type among many. Animation, rendering, lighting, character behavior, and AI restyle all inherit from one primitive: **a typed, lazily-evaluated node in a DAG with deterministic evaluation given a seed.**

The user does not see this. The user sees a viewport, a timeline, a chat window, and a library. The DAG is the implementation. The directorial surface is the product.

### 3. Why now

Three forces converge:

1. **Browser 3D matured.** WebGPU, R3F, drei, Theatre.js, gaussian-splats-3d. The runtime is good enough that an editor in the browser is competitive with a desktop app for a focused use case.
2. **Tool-calling LLMs matured.** Claude/GPT can drive typed APIs reliably enough that "agent as privileged user" is a viable interaction primitive, not a demo.
3. **The procedural-as-substrate idea has reference implementations.** Houdini, USD, Substance, Geometry Nodes. The pattern is proven; nobody has shipped it as the *default* for a director-first AI video tool. There is room.

### 4. Why not just X?

| Alternative | Why it loses |
|---|---|
| Sora / Runway / Veo | Editorial control absent. Continuity per-scene is fragile. No graph to edit. |
| Blockbench fork | Voxel/low-poly first. Animation is bone-rig-centric. Retrofitting splats/AI/timeline is a rewrite. |
| Blender + AI plugins | Desktop-first. On-ramp is months. Procedural is opt-in. AI is a render filter. |
| Theatre.js + R3F from scratch | We need this stack — but starting blank costs ~3 months of plumbing. We borrow from Triplex + RubicsWorld instead. |
| Triplex fork as-is | Triplex assumes JSX = scene. Procedural-as-substrate breaks that invariant. We use Triplex for chrome, not for the model. |
| Reze Studio fork | GPLv3 (license-trap), MMD-specific, custom WebGPU engine incompatible with R3F ecosystem. Pattern source, not code source. |
| Houdini-class DAG (USD/Omniverse) | Right shape, wrong cost. v2+ territory. We ship Path A: tree-projected DAG with procedural generators. |

### 5. The pitch in one sentence

**Basher is a procedural director — every scene is a graph that evaluates to a film. AI agents and humans both edit the graph. The graph is the truth, the viewport is the result, and the chat is the language.**

---

## Part II — The Primitive

### 6. The single architectural commitment

Everything in Basher is a node in a DAG. There is no "raw scene state." There is no "authored content." There is only the graph, and what falls out when you evaluate it.

```
PROJECT
  = a DAG of typed nodes
  + named output sockets ('scene', 'timeline', 'render')
  + an asset bundle on disk
```

```
NODE
  inputs:     typed connections from other nodes' outputs
  parameters: serializable, schema-validated values
  outputs:    typed, lazy-computed, content-hashed, cached
  metadata:   id, type, name, position-in-graph-view
```

```
EVALUATION
  evaluate(nodeId, time?) →
    1. resolve input dependencies (recurse upstream)
    2. compute content hash of (params, inputHashes, time?)
    3. cache hit? return cached output
    4. else run evaluator(params, inputs, ctx) → output
    5. store in cache, return output
```

That is the entire spine. Eighty percent of Basher is node *definitions*. The remaining twenty percent is the evaluator, the storage layer, the UI surfaces, and the agent.

### 7. The seven properties of every node

These are non-negotiable. A node that violates any of them is broken.

1. **Typed sockets.** Every input/output has a `TypeDescriptor`. Connections are type-checked at edit time and runtime. You cannot wire `Mesh` into `Number`.
2. **Schema-validated parameters.** Every node ships a zod schema. Invalid params are caught before evaluation, not during.
3. **Deterministic given (params, inputs, seed).** A `pure: true` node returns the same output for the same inputs forever. Lint enforces no `Math.random` / `Date.now` / `performance.now` inside `pure: true` evaluators.
4. **Lazy + cacheable.** Outputs are not computed until requested. Once computed, they are cached by content hash until invalidated by a dependency change.
5. **Time-as-input, not-as-global.** If a node varies over time, time is a `Time` socket. Never read from a clock. Animation, scrubbing, and frame-by-frame render all rely on this.
6. **Versioned schema.** Every node type carries a schema version. Loading an older project upgrades nodes through registered migrations.
7. **Cost-tagged.** `'cheap' | 'medium' | 'expensive'`. The scheduler uses this to choose main thread vs worker, eager vs deferred re-eval.

### 8. The type system across sockets

Initial set, expanding through phases:

```
Primitives:  Number, Vector2, Vector3, Quaternion, Matrix4, Color, Boolean, String, Time
Geometry:    Mesh, BoundingBox, Skeleton, PosedSkeleton, Splat, SplatSequence
Material:    Material, Texture, Image
Animation:   AnimationClip, KeyframeChannel<T>, Curve<T>
Rendering:   Camera, Light, RenderPass, RenderTarget, ImageSequence, Video
Scene:       Scene, Group, Transform, Attachment
Workflow:    ComfyUIWorkflow, Prompt
References:  AssetRef, NodeRef
```

Sockets are nominally typed. Implicit conversions exist only between numeric types (Number ↔ Vector1, Vector2 ↔ Vector3 with zero-fill). Everything else is explicit through converter nodes.

### 9. The five core operations

The agent's tool surface, the undo system, and the user's authoring UI all reduce to five primitive operations on the DAG:

```
addNode(type, params)            → returns NodeId
removeNode(nodeId)               → returns inverse Op
connect(fromId, fromSocket, toId, toSocket)
disconnect(fromId, fromSocket, toId, toSocket)
setParam(nodeId, paramPath, value)
```

Each emits an inverse Op for undo. Each is serializable. Each can be batched into a `Diff` (transactional set of Ops) for atomic apply/reject.

Higher-level operations (`character.walkTo`, `procedural.scatter`, `camera.frameShot`) are **macros** — functions that emit sequences of these five primitives. Both humans and agents call macros. Both can drop down to primitives when needed.

### 10. The evaluator's three responsibilities

```
1. Resolve dependencies via topological sort. Cycle detection by visited-set + depth limit.
2. Cache by content hash. Invalidate downstream on param/input change.
3. Schedule by cost. Cheap on main thread; expensive in workers; medium negotiates.
```

The evaluator is the highest-leverage code in the project. Every contributor reads it. Test coverage is mandatory. Any change is reviewed by two people.

---

## Part III — The Surfaces

The DAG is the truth. The user does not see the DAG by default. They see one of three surfaces, each of which is a *projection* of the DAG.

### 11. The viewport (always visible)

R3F Canvas mounted at app root, never unmounted. It renders the result of `evaluate('scene', currentTime)`. Camera comes from the same evaluation. PostFx is applied per a `RenderOutput` node's parameters.

The viewport does not author. Click-and-drag manipulations emit Ops. The gizmo writes to the upstream `Transform` node's parameter. The viewport is a window into the evaluator's output.

**Live-drag mode:** during a drag, the gizmo writes directly to one parameter on one node. Full graph re-eval is debounced (16ms) or deferred to release. This preserves 60fps without sacrificing graph correctness.

### 12. The scene tree (Director + Pro modes)

A walkable hierarchical view derived from the DAG by walking backward from the `scene` output through `Group`/`Transform`/`Attachment` nodes. Looks identical to Blender's outliner. Drag-reorder emits `disconnect` + `connect` Ops.

The scene tree is not the truth. It is a humane projection. Two non-identical DAGs can produce the same scene tree if they evaluate to the same hierarchy.

### 13. The timeline (Director + Pro modes)

Bottom-rail panel. Two views vertically split:

- **Top: dopesheet.** Rows are bone/property channels. Diamonds are keyframes. Aggregates `KeyframeChannel<T>` nodes by their target.
- **Bottom: curve editor.** Selected channel's bezier curve. Editing handles emits `setParam` Ops on that channel node.

The timeline is a projection of the subset of the DAG that consumes `Time` and produces values for the scene. Reze Studio's split-view UX is the model.

### 14. The library (Director mode)

Left rail. Folder tree of assets on disk. Drag-drop to viewport emits an Op chain that adds an `AssetNode` + `Transform` + connection to a `Group`. Thumbnails generated by an offscreen R3F Canvas.

Hot-reload via Blender live-link. The Vite dev server holds an "active scene" pointer, beaconed every 2s. Blender's addon writes GLB to the scene's `assets/` and posts a refresh; the library invalidates the asset's cache; downstream nodes re-evaluate.

### 15. The chat drawer (Simple = primary, Director = co-equal, Pro = collapsed)

Right rail. Three tabs:

- **Chat** — conversational interface to the agent.
- **Activity** — append-only log of every Op applied, by user or agent, with timestamp and source.
- **Tools** — debug introspection of the registered tool schema (visible in Pro mode only).

In Simple mode, the chat is the editor. The user describes; the agent proposes; the user accepts; the viewport reflects.

### 16. The DAG view (Pro mode, read-only in v0.5)

Force-directed graph visualization of the project's nodes and edges. In v0.5 it is read-only — a debug surface that says *"this is what your project looks like under the hood."* In v0.6 it becomes editable: a true visual node editor for power users.

The discipline is that **everything is a DAG underneath; authoring surfaces are still familiar.** Showing the graph too early is the failure mode of Houdini-for-everyone. We must not.

### 17. Mode hierarchy

| Mode | Default surfaces | DAG visible? | Primary input |
|---|---|---|---|
| **Simple** | Viewport + Timeline + Chat | No | Natural language |
| **Director** | + Scene tree + Library + Inspector | No | Mixed (chat + direct) |
| **Pro** | + DAG view + Render-graph editor + Theatre Studio + Code | Yes (read-only v0.5) | Direct manipulation + code |

Mode persists per-project. Onboarding starts in Simple. Director is the default after first project. Pro is opt-in.

---

## Part IV — The Agent

### 18. The principle: the agent is a privileged user

The agent edits the DAG through the same five primitive Ops, the same tool surface, the same undo system, and the same Diff overlay as the user. There is no agent-private mutation path. There is no agent-only state.

This is load-bearing. If the agent could bypass the Op system, every cross-cutting feature (undo, save, multiplayer, replay) would have to handle two cases. Forcing the agent through the user's path collapses the design surface.

### 19. The Diff-first interaction model

The agent never silently mutates the live DAG. It always:

1. **Plans.** The LLM emits text + a structured tool-call sequence (`addNode`, `connect`, `setParam`, ...).
2. **Forks the DAG.** The Op sequence applies to a forked DAG, not the live one.
3. **Previews.** The viewport renders both: the live evaluation in normal style, the diff evaluation as a ghost overlay (semi-transparent for new geometry, dotted outlines for new keyframes, badges for moved objects).
4. **User accepts/rejects.** Per-Op checkboxes; "Apply selected", "Apply all", "Reject all". Apply pushes through the real Op system → one undo entry titled `"Agent: <description>"`.

This is the Op-as-transaction pattern. Reject discards the fork. Accept commits atomically.

### 20. The tool surface

**Primitives (always available):**

```
dag.addNode(type, params)
dag.connect(from, to)
dag.disconnect(from, to)
dag.setParam(nodeId, path, value)
dag.deleteNode(nodeId)
dag.query(predicate)              → returns matching nodeIds
dag.evaluate(nodeId, time?)       → returns current output (for context)
dag.summarize(scope?)             → compact projection (~500 tokens)
viewport.screenshot()             → base64 image (vision input)
```

**Macros (introduced phase-by-phase):**

```
P1:  library.search, library.import, procedural.scatter
P2:  character.add, character.walkTo
P3:  timeline.keyframe, timeline.addLayer, camera.frameShot, shot.create
P4:  render.shot
P5:  render.aiRestyle, render.estimateCost
P6:  splat.add
P7:  publish.toPlayCanvas
```

Each macro emits a sequence of primitives. Both human and agent can call any macro or drop to primitives.

### 21. Context strategy per turn

Token-efficient and explicit:

1. **System prompt + tool schemas** — large, cached aggressively.
2. **`dag.summarize()`** — node counts by type, named anchors, current selection. ~500 tokens.
3. **Recent activity** — last 10 Ops with diffs, source-tagged.
4. **User message.**
5. **Vision input** — viewport screenshot auto-attached on triggers ("this", "here", "looks like", "show me", "what do you see").
6. **Selection details** — full node JSON only for currently selected nodes.

The whole DAG is never sent. Summaries and queries are the agent's contract with the project.

### 22. The four agent modes

| Mode | Behavior |
|---|---|
| **Read-only** | Agent can describe, search, query, screenshot. Every mutation requires accept. (Default for new sessions.) |
| **Co-pilot** | Trivial mutations (transform <0.5u, single keyframe edits) auto-apply. Structural changes (delete, render trigger) prompt. |
| **Sandbox** | Agent edits a fork of the DAG. User merges back at session end via PR-style review. |
| **Autopilot** | Agent operates without prompts within an explicit token + cost budget. (v0.6.) |

### 23. Memory

- **Within-session:** conversation + Diff history in context window.
- **Cross-session:** `agent_sessions/<id>.json` — summarized turn-by-turn, persisted in the project folder.
- **Project-level:** `agent_notes.md` — human-readable, agent-writable, user-editable. Conventions, preferences, project lore. Read at session start.

### 24. Cost & safety guardrails

- Live token tracker in drawer per session.
- AI render cost preview *before* dispatch — agent must call `render.estimateCost` and present it.
- Hard token cap per session (configurable). Auto-pause at 80% with notification.
- Spending alerts at $1, $5, $10 per session.
- Destructive Ops (`deleteNode`, `removeMany`) always require accept, even in Co-pilot mode.

### 25. Concurrency: who writes when

Single-writer queue. The user's input always wins ties. If the agent emits an Op while the user is mid-drag, the agent's Op queues until release. No CRDT in v0.5. Multiplayer (CRDT on the node map via Yjs) is v1.

---

## Part V — The Pipeline

### 26. From scene to film

The render pipeline is a subset of the DAG, no special architecture. The relevant nodes:

```
RenderPass (variants: Beauty, Depth, Normal, Albedo, ID, Alpha, MotionVectors)
  inputs: Scene, Camera, Time
  output: Image (single frame at given time)
  params: format, output target, material override

RenderJob
  inputs: RenderPass[], Scene, Camera
  params: frameRange, fps, outputDir
  output: ImageSequence (per pass)
  evaluator: walks frames, dispatches passes, writes files

ComfyUIWorkflow
  inputs: ImageSequence (the passes), Prompt
  params: workflow JSON, preset
  output: ImageSequence (stylized)
  evaluator: HTTP-dispatches to ComfyUI, polls, downloads

VideoStitch
  input: ImageSequence
  params: fps, codec
  output: Video
  evaluator: ffmpeg-wasm
```

A "render" is the chain `Scene → RenderJob → ComfyUIWorkflow → VideoStitch → Video`. Authored visually in v0.6+; in v0.5 it is constructed by macros (`render.shot`, `render.aiRestyle`).

### 27. Multi-pass rendering

The render-graph contract from P4 onward: any node consuming `Scene` + `Camera` + `Time` and producing `Image` is a valid pass. Built-in passes are first-party node types. Plugin passes (v1) are third-party node types. Same primitive.

Passes share a clone-and-override mechanism: the evaluator clones the scene with material overrides, renders to an off-screen `RenderTarget`, reads back, and emits the `Image`. Beauty pass uses RubicsWorld's PostFx chain (ACES + SMAA + optional realism-effects SSGI/TRAA).

Splats render to beauty only in v0.5. Depth/normal use bounding-mesh proxies (documented limit, lifted in v0.7).

### 28. AI render: temporally consistent stylization

Three starter ComfyUI presets:

- **Stylized realism** — depth + normal + beauty → SDXL ControlNet
- **Anime** — LineArt + segmentation
- **Concept paint** — img2img low-denoise on beauty

Temporal coherence: prev-frame as ControlNet conditioning. Workflow-level setting; the agent can also author new presets via meta-prompt (v0.6).

Failure handling: ComfyUI not running → clear error + setup link. Partial frames → resume from last good frame. Cost preview required before submit.

### 29. Procedural generation as substrate

`ScatterNode`, `ArrayNode`, `CurveFollowNode`, `GridNode` — each is a node whose outputs are *generated* from inputs. Deterministic given a seed. The `ScatterNode` ships in P1 and proves the pattern.

Procedural is the default. Authored content is the degenerate case: a node with no inputs, only parameters. There is no philosophical distinction between *"the user placed three trees here"* and *"the user wrote a scatter rule that produced three trees here."* The first is just a `Group { children: [Tree, Tree, Tree] }` node; the second is `ScatterNode { area, density, seed }`. Both are part of the same DAG.

### 30. Generative as substrate

`ComfyUIWorkflow` is one node type. Future generative nodes — text-to-3D (HY-World), text-to-character, motion synthesis, lip-sync, speech — are each one more node type. The agent picks them up automatically through the registry. The user picks them up through the library or chat.

There is no "generative pipeline" separate from the rendering pipeline. Both are subgraphs of the same DAG.

### 31. PlayCanvas streaming export

Export traverses the evaluated DAG output and emits PlayCanvas scene JSON. Procedural nodes are *baked* at export — their evaluated output is shipped, not their definition. Animation: keyframe nodes are baked to PlayCanvas tracks (or to a replay script).

In v0.5 we ship static-bundle export only. WebRTC pixel-streaming is v0.6.

### 32. The Blender bridge

A live-link Vite middleware holds an "active scene" pointer. Blender's addon polls it and writes its export to that scene's `assets/`. The library panel watches the asset folder and invalidates dependent node caches on change. Blender becomes a high-fidelity asset authoring tool that round-trips into Basher in seconds. Lifted from RubicsWorld; repurposed from level export to asset export.

---

## Part VI — The Stack

### 33. Locked technical decisions

```
Runtime:          Vite + React 19 + TypeScript
3D:               @react-three/fiber + drei + @react-three/postprocessing
State:            zustand
UI chrome:        Tailwind + shadcn/ui
Inspector:        Leva (dev/inspector parameter editing only)
Timeline runtime: Theatre.js + @theatre/r3f
Behavior model:   @pmndrs/timeline (composable behaviors)
Editor base:      Triplex (forked, MIT) — repositioned to chrome + gizmos + inspector
DnD:              dnd-kit
Navmesh:          recast-navigation-js
3DGS:             @mkkellogg/gaussian-splats-3d
4DGS:             Visionary (WebGPU, Apache 2.0) — playback only in v0.5
Streaming:        PlayCanvas Engine (export target, not editor)
AI render:        ComfyUI HTTP client + ffmpeg-wasm
LLM SDK:          @anthropic-ai/sdk + openai + ollama-js
Validation:       zod (parameter schemas, save format, agent tool schemas)
Storage:          custom Storage interface, two impls (Electron fs + web OPFS)
Donor parts:      RubicsWorld (PostFx, RealismFX, WalkControls, walkMask,
                  colliderRefs, Blender beacon, audio bus)
Pattern sources (no code): Reze Studio (timeline UX, animation layers),
                  Blockbench (snapshot-diff undo, format/codec split),
                  OpenMontage / ViMax (agentic director architecture, v0.8+)
```

### 34. Why these and not others

- **R3F over raw Three.js:** declarative scene rendering matches DAG-output-to-React-tree mapping cleanly.
- **Zustand over Redux/Jotai:** simpler stores, selector hooks, no boilerplate. DAG state lives in zustand; selectors project surfaces.
- **Tailwind + shadcn over Material/AntD:** modern editor aesthetic, no design-system fight, matches Reze.
- **Theatre.js over rolling our own:** keyframe + scrub + curve handling is solved. We wrap it in DAG nodes.
- **Triplex over react-three-editor:** Triplex is more mature; we keep its chrome and lose its scene model.
- **Vite over Next.js:** SSR is irrelevant for a desktop-class editor. Vite is faster locally and produces smaller bundles.
- **zod over io-ts/yup:** ecosystem alignment with ai-sdk + tool schemas.
- **ComfyUI over A1111/Diffusers HTTP:** workflow JSON is graph-shaped; aligns with Basher's primitive.
- **PlayCanvas as export target:** native splat support; clean WebGL/WebGPU path; existing CDN.

### 35. License posture

Permissive only. MIT, Apache 2.0, BSD. GPL deps are blocked. CI license-audit on every `package.json` diff.

ComfyUI is GPL but used over HTTP, never linked or shipped. Same for Blender. Reze Studio is GPL — used as pattern source only, no code copied.

This preserves Basher's options: closed-source paid tier, white-label, embed in commercial tools. Locking ourselves into GPL is a one-way door we explicitly refuse.

### 36. The donor strategy

We do not write what others have written. We import patterns and cherry-pick code:

- **Triplex** — fork for chrome, gizmos, inspector. Reposition: scene model is ours.
- **RubicsWorld** — copy `PostFx.tsx`, `RealismFX.tsx`, `FpsMeter.tsx`, `WalkControls.tsx`, `walkMask.ts`, `colliderRefs.ts`, the Blender live-link beacon, the audio bus, the route-mode pattern.
- **pmndrs ecosystem** — drei, @theatre/r3f, @pmndrs/timeline. Use as libraries.
- **Blockbench** — pattern: format/codec split (one trait, many implementations); pattern: snapshot-diff undo as fallback when inverse-Ops are insufficient.
- **Reze Studio** — pattern: dopesheet/curve split timeline UX; pattern: layered animation with bone masks.
- **SuperSplat** — link out for splat editing in v0.5; consider iframe embed in v0.6.

---

## Part VII — The Plan

### 37. Phase map (11 weeks to v0.5)

```
P0   Foundation + DAG core             [Wk 1-2]
P1   First node types + Asset Library  [Wk 3]
P2   Character + Move (as nodes)       [Wk 4]
P2.5 AI Agent on the DAG               [Wk 5]
P3   Timeline = animation nodes        [Wk 6]
P4   Render graph = render nodes       [Wk 7]
P5   AI Render Bridge                  [Wk 8]
P6   Splats node                       [Wk 9]   ← cut candidate
P7   PlayCanvas export from DAG        [Wk 10]
P8   Progressive UX + Demo             [Wk 11]
```

Each phase is end-to-end demoable on its own. No phase exists only to enable the next. P6 splats and P7 streaming are explicit cut candidates if scope slips; v0.5 ships without them and still demos.

### 38. P0 — Foundation + DAG core (2 weeks)

**Week 1 — the spine.**

- `NodeDefinition` interface, `paramSchema`, `inputSchema`, `outputSchema`, `evaluate`, `pure`, `cost`, `version`.
- Node registry — typed, runtime-discoverable, agent-introspectable.
- DAG storage (`Map<NodeId, Node>`; edges as input refs).
- Evaluator: topological sort, lazy eval, content-hash caching, cycle detection (depth limit + visited set).
- Op system: five primitives, each with inverse.
- Project schema = `{ version, nodes, edges, outputs }`.
- Storage interface (Electron fs + web OPFS).
- Migration runner (no-op for v1; framework ready).

**Week 2 — minimum viable shell.**

- React/Vite/Tailwind/shadcn shell.
- R3F Canvas mounted at root, renders `evaluate('scene', time)`.
- Default project: `PerspectiveCamera` + `DirectionalLight` + `BoxMesh` + `Scene` aggregator nodes, four total.
- PostFx port from RubicsWorld (operates on evaluated scene; PostFx config is a parameter on a `RenderOutput` node).
- Mode store (`'simple' | 'director' | 'pro'`), `Layout` component, right-drawer placeholder.
- Blender live-link beacon (dev-only).
- FPS meter, reference screenshot, Playwright E2E.
- Lint rules: no `Date.now`/`Math.random`/`performance.now` inside `pure: true` evaluators; no time-as-closure.

**P0 acceptance (8 tests):**
1. Dev server up in <5s.
2. Default project: 4 nodes, evaluator produces correct scene.
3. Mode toggle reconfigures chrome.
4. Save produces project folder; reload restores.
5. Inspector edits a node param → viewport updates within 16ms.
6. Beacon fires in dev, absent in prod.
7. PostFx beauty matches reference within 2% pixel diff.
8. ≥60fps on M1 baseline.

### 39. P1 — First node types + Asset Library (1 week)

- Node types: `GltfAsset`, `Transform`, `Group`, `Light` (4 variants), `Camera` (2 variants), `MaterialOverride`, `ScatterNode`.
- Library panel (left rail): folder tree of `assets/`, thumbnails generated by offscreen R3F.
- Drag-drop emits Op chains: `addNode(GltfAsset) → addNode(Transform) → connect → addNode(Group) → connect`.
- Scene tree (right rail): projection of DAG, walks backward from `scene` output through `Group`/`Transform`.
- Inspector: edits node parameters via `setParam` Ops.
- Selection store.
- TransformControls gizmo: edits upstream `Transform` node param in live-drag mode.
- Undo via inverse-Ops (snapshot-diff as fallback for non-trivial cases, Blockbench-pattern).
- ScatterNode shipped: parameters (asset list, area mesh, density, seed, distribution mode); deterministic.

**P1 acceptance:** drag GLB → places via Op chain → undo reverts → reload preserves → ScatterNode produces deterministic placement, re-evaluates on param change.

### 40. P2 — Character + Move (1 week)

- Node types: `Character`, `AnimationClip`, `Skeleton`, `PosedSkeleton`, `Navmesh`, `WalkPath`, `LocomotionState`.
- `Time` input flows through animation evaluation.
- Click-to-move: Op chain creates `WalkPath` node, connects to character's `LocomotionState`.
- recast-navigation-js powers `Navmesh` evaluator.
- Multi-character supported.

### 41. P2.5 — AI Agent on the DAG (1 week)

- Right-drawer chat UI (message list, streaming text, input).
- Activity log tab (every Op + source).
- Tools tab (debug introspection, Pro mode only).
- LLM provider abstraction (Anthropic, OpenAI, Ollama).
- Streaming response with mid-stream tool-call execution into Diff buffer.
- Diff system: ghost overlay rendering; per-Op accept/reject; atomic apply via undo.
- Context: `dag.summarize`, recent activity, vision-on-trigger.
- Modes: Read-only (default), Co-pilot, Sandbox.
- Token budget tracker; cost preview on AI render trigger.
- Cross-session memory (`agent_sessions/<id>.json`); project-level (`agent_notes.md`).

**P2.5 acceptance:** "add 3 trees" → Diff appears → accept → 3 nodes in scene → undo reverts atomically. "Scatter rocks on the ground" → ScatterNode created → preview shows ghosts → accept. Vision question → response references actual scene contents. Reject → no change. Switch to Ollama → still works.

### 42. P3 — Timeline = animation nodes (1 week)

- Node types: `KeyframeChannel<T>`, `Curve<T>`, `AnimationLayer`, `Shot`, `Cut`.
- Animation layers with bone masks from day one (Reze pattern).
- Dopesheet UI: projection of all `KeyframeChannel` nodes for selected target.
- Curve editor: projection of one channel; bezier handle editing emits `setParam` Ops.
- Behaviors via `pmndrs/timeline` are macros emitting keyframe nodes.

### 43. P4 — Render graph = render nodes (1 week)

- Node types: `BeautyPass`, `DepthPass`, `NormalPass`, `AlbedoPass`, `IDPass`, `AlphaPass`, `MotionVectorPass`, `RenderJob`.
- Each pass takes `Scene` + `Camera` + `Time` → `Image`.
- `RenderJob` walks frames, dispatches passes, writes files.
- Pass results stored such that agent can describe them.

### 44. P5 — AI Render Bridge (1 week)

- Node types: `ComfyUIWorkflow`, `Prompt`, `VideoStitch`.
- Three starter presets (stylized realism, anime, concept paint).
- Temporal coherence via prev-frame ControlNet conditioning.
- Cost preview as a `dryRun()` evaluator method on `ComfyUIWorkflow`.
- Resume-from-last-good-frame on failure.

### 45. P6 — Splats node (1 week, cut candidate)

- Node types: `SplatAsset`, `SplatRender`, `SplatScatter` (= `ScatterNode` + `SplatAsset`), `SplatAsset4D`.
- 3DGS via `@mkkellogg/gaussian-splats-3d`.
- 4DGS via Visionary, behind WebGPU feature flag.
- Renders to beauty pass; depth/normal use bounding-mesh proxies (documented).

### 46. P7 — PlayCanvas export from DAG (1 week)

- Export = traverse evaluated DAG output → emit PlayCanvas scene JSON.
- Animation: keyframe nodes baked to PlayCanvas tracks or replay script.
- Procedural nodes baked at export (output shipped, not definition).
- Static bundle export only in v0.5; pixel-streaming is v0.6.

### 47. P8 — Progressive UX + Demo (1 week)

- Three modes (Simple, Director, Pro) per Section 17.
- Mode switcher in title bar; persists per-project.
- 60-second guided tour on first project.
- Demo project shipped: pre-built 30s clip walking through full pipeline.
- README + 5-minute screencast.

**Acceptance:** three first-time users, each ships a stylized clip in <15min from clone.

---

## Part VIII — The Disciplines

### 48. Determinism is enforced or it does not exist

- Every node declares `pure: true | false`. Default is `true`.
- `pure: true` evaluators are tested by running them twice on identical inputs; outputs must match bit-exact (or within float epsilon for known-noisy ops). CI gate.
- Lint rules ban `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID` inside `pure: true` evaluators.
- Random nodes accept a `seed` parameter; randomness is `mulberry32(seed)`.
- Time enters as a `Time` socket. Not a closure. Not a global. Not `useFrame`.

Without these, scrubbing breaks, frame-render diverges from viewport, agent reproducibility fails, and caching corrupts. Determinism is not a luxury.

### 49. Time is a first-class type

The `Time` socket carries a `{ frame, seconds, normalized }` triple. Animation nodes consume it. Render nodes consume it. The viewport injects "current scrub time" as the time input to the `scene` output.

A node that needs to behave non-deterministically over real wall-clock time (e.g. a network sync indicator) declares `pure: false` and reads `ctx.realTime` from the eval context. These nodes do not appear in render output paths.

### 50. The Op system is the only mutation path

UI clicks, agent tool calls, file imports, hot-reload — all emit Ops. Stores never mutate directly. Reviewers reject any code that calls `dagStore.setState` outside the Op dispatcher.

This enforces the property: **anything the user can do, the agent can do, anything the agent can do, the user can do.** The two paths through the system are isomorphic.

### 51. Caching correctness

- Cache key: `hash(nodeId, paramsHash, inputHashesSorted, timeIfImpure)`.
- Invalidation: when a node's params change or any upstream input's hash changes.
- Cache scope: per-node, per-project. Cleared on project close.
- LRU eviction at memory ceiling (default 512MB).
- Test harness: every `pure: true` node must pass `evaluate(p, i) === evaluate(p, i)` twice in CI.

### 52. Migration policy

- Every node type declares `version: number`.
- Schema bump from N to N+1 ships with `migrate(N → N+1)`.
- Project file declares `nodeVersions: { type: version }`. Loader migrates each node to the current version on load.
- First node-type schema bump triggers writing the first migration. Mandatory before second bump.
- Migrations are tested against a corpus of saved demo projects in CI.

This protects every saved project from every change. Without it, every node-type tweak in P3+ breaks every saved file.

### 53. Performance budgets

- 60fps in viewport at 1080p with default scene on M1.
- Single-frame evaluation budget: 8ms (cheap nodes) / 16ms (medium) / 100ms (expensive, off main thread).
- DAG re-eval on param change: <16ms for typical edits; debounced to 16ms for live-drag.
- Bundle <2MB gzipped at P0.
- Library asset thumbnail generation: <500ms per asset, off main thread.
- ScatterNode: capped at N=5000 in v0.5; lift cap when worker scatter ships in v0.6.

### 54. Testing strategy

- **Vitest unit:** every node type has determinism + schema-validation tests. Storage round-trip. Migration round-trip. Op inverse correctness.
- **Playwright E2E:** P0–P8 happy paths. Pixel-diff reference screenshot for PostFx.
- **CI license audit:** every dependency add reviewed.
- **CI cache-correctness harness:** runs every `pure: true` node twice, compares output.
- **CI migration corpus:** loads a folder of demo projects with each PR; any failure blocks merge.

### 55. Observability

Anonymous, opt-in only. Counts:

- `project_created`, `node_added` (by type), `op_applied` (by source: user/agent/macro), `render_finished` (by pass count), `ai_render_finished` (by preset), `publish_clicked`.

No content telemetry. No prompt telemetry. No DAG dumps. The user owns their work; the platform learns aggregate patterns only.

---

## Part IX — The Risks

### 56. The catalog

Each risk has a likelihood, a failure mode, and a mitigation. Mitigations are budgeted into specific phases.

| Risk | Likelihood | Failure mode | Mitigation |
|---|---|---|---|
| Eval performance kills 60fps | High | Drag stutters; user feels editor is broken | Sub-graph re-eval, live-drag mode, workers, cost hints. P0/P1. |
| Time-as-input not enforced | High | Scrubbing breaks; render diverges from viewport | Lint rule + test harness + reviewer enforcement, day one |
| Pure-flag lying | High | Cache corruption manifests as random bugs | Twice-eval test harness in CI. Mandatory. |
| Triplex repositioning blocks lift | Medium | More own-code than expected | Reduce Triplex use to chrome + gizmos + inspector; build authoring ourselves |
| Agent generates invalid Ops | Medium | Diff contains malformed nodes | Zod-validate every tool call before reaching store; agent self-corrects on validation error |
| Generator nodes recurse infinitely | Low | Eval hangs main thread | Depth limit (4) + cycle detection at evaluation |
| Procedural eval blocks main thread | Medium | Heavy scatter freezes UI | Yield via `requestIdleCallback`; progress UI; cap N=5000 in v0.5 |
| Agent hallucinates non-existent tools | Medium | Tool call rejected; user confused | Tool schema in system prompt; validate name; error message back to agent for self-correction |
| DAG visible too early scares users | High | "Why is this so complicated?" | Hidden in Simple + Director modes. Pro mode read-only in v0.5. |
| Diff preview ghost confuses user | Medium | User can't tell what's pending | Distinct visual treatment: semi-transparent + dotted + label badge; toggle to hide |
| Cost runs away (agent loops) | Medium | Bill spikes | Hard token cap per session; spending alerts; auto-pause at 80% |
| Migration policy slips | High | Old projects break on load | First node-type bump triggers first migration. Mandatory before second bump. CI corpus. |
| ComfyUI dependency blocks adoption | High | Users can't run AI render | Document setup in v0.5; bundle one-click installer in v0.6; demo cloud in v0.7 |
| 4DGS slow on average hardware | Medium | Playback stutters | WebGPU feature-flag; WebGL fallback message |
| Multi-pass + splats incoherent | Medium | Depth/normal of splats wrong | Splats render to beauty only; bounding-mesh proxies for depth/normal. Documented. |
| Scope blows 11-week timeline | High | Ship slips | P6 (splats) and P7 (streaming) are explicit cut candidates. Demo (P8) is non-negotiable. |
| GPL infection from careless dep add | Low | License contamination | License-audit CI; allowlist of permissive licenses; pattern-source-only rule for GPL projects |
| User edits during agent's mid-stream | Medium | Op conflict, lost user input | Single-writer queue; user always wins ties; agent Ops queue until release |

### 57. The pre-mortem

Imagine v0.5 ships and fails. The most likely autopsy:

1. **The DAG was right but the perf wasn't.** Drag-and-drop felt sluggish because we under-budgeted eval. Users tried it once and never came back. *Mitigation: P0/P1 perf budget is hard-gated; live-drag mode is shipped before any node-author UI.*
2. **The agent was impressive but unreliable.** Tool calls succeeded 80% of the time, but the 20% failure was so frustrating users disabled the chat. *Mitigation: zod-validate everything; agent self-corrects on validation error; Read-only mode is default; trivial-only auto-apply.*
3. **The simple mode was too simple.** New users hit the wall — couldn't do anything beyond the demo without enabling Director. *Mitigation: chat is the editor in Simple; the agent can do everything; the wall is "you have to type".*
4. **ComfyUI killed the demo.** Every new user got stuck on setup. *Mitigation: cloud demo endpoint for first AI render in v0.5; bundle installer in v0.6.*

We address each in the plan; we revisit each at v0.5 retrospective.

---

## Part X — The Roadmap Beyond v0.5

### 58. v0.6 — Visual node editor + cost-down

- Visual DAG editor in Pro mode (full editing, not read-only).
- Custom AI workflow node editor (compose ComfyUI workflows in-app).
- SuperSplat embedded panel for splat editing.
- One-click ComfyUI installer.
- WebRTC pixel-streaming export.
- Worker-based scatter (lift N=5000 cap).
- AI render preset authoring via meta-prompt.

### 59. v0.7 — Animation depth + materials

- Per-bone Blockbench-grade rigging UI.
- Material node graph (PBR + custom shaders).
- 4DGS editing (not just playback).
- VRM support.
- Splat lighting beyond basic shadows.

### 60. v0.8 — Agentic director

- ViMax/OpenMontage-style multi-agent layer: Scriptwriter → Storyboard → Director → Compositor.
- Long-form continuity across shots.
- Style transfer pinning across scenes.
- Voice cloning + lip-sync nodes.

### 61. v1.0 — Multiplayer + plugins

- Multiplayer editing (CRDT on the node map via Yjs).
- Public plugin API for new node types.
- Plugin marketplace.
- Cloud project sync.

### 62. v2.0 — Full DAG + USD interop

- Houdini-class DAG features (loops, switches, foreach, references).
- USD interchange (read + write).
- Material X.
- Native compute shader nodes.

---

## Part XI — The Director's Question

### 63. The point

Every architectural decision in this thesis exists to answer one question: **what does the director do, and what does the system do?**

In Sora-class tools, the system does everything; the director is a passenger.

In Blender-class tools, the director does everything; the system is a typewriter.

In Basher, the director composes a graph. The system evaluates the graph. The graph is editable, reproducible, machine-readable, and human-readable. The director is in control because the graph is. The director is amplified because the agent can edit the graph too.

This is the directorial unit, made concrete: a node, with inputs, parameters, and an output. The shot is a node. The character is a subgraph. The render is a chain. The film is the evaluation. The director is whoever chooses what to evaluate and how.

### 64. The discipline of the simple mode

In Simple mode, the user speaks. The agent edits. The viewport reflects. The DAG is invisible.

This is the test of the architecture. If the simplest interaction is *natural language → result*, and the deepest interaction is *direct DAG editing*, and they are the same system underneath, then Basher works.

If they diverge — if Simple mode requires a special "easy" pipeline and Pro mode requires a special "real" pipeline — the architecture has failed. Two systems. Two bugs. Two roadmaps.

One graph. Many surfaces. One discipline.

### 65. The closing claim

A film is a graph that evaluates to a sequence of frames. We commit to this primitive. We expose three surfaces over it (viewport, timeline, chat) and let the user choose. We let the agent share the same authoring path. We make procedural the substrate, generative one node category among many, and AI restyle a chain in the render graph.

This thesis is not a feature list. It is a commitment. Every line of code in Basher will be evaluable against it: *does this respect the single primitive? Does this preserve determinism? Does this go through the Op system? Does this hide the DAG by default? Does this make the director more in control, not less?*

If yes, the line stays. If no, it does not.

---

## Appendix A — Glossary

- **DAG** — Directed acyclic graph. Basher's project structure.
- **Node** — A unit in the DAG with typed inputs, parameters, and outputs.
- **Op** — A primitive mutation on the DAG (`addNode`, `connect`, `setParam`, ...).
- **Macro** — A function that emits a sequence of Ops. Both UI buttons and agent tools are macros (or primitives).
- **Diff** — A transactional set of Ops produced by the agent, previewable as a ghost overlay before accept.
- **Evaluator** — The function that walks the DAG and computes outputs lazily, with caching.
- **Pure node** — A node whose output is deterministic given (params, inputs). Cacheable.
- **Time socket** — A typed input carrying current scrub/render time. The only non-global way for nodes to vary over time.
- **Surface** — A user-facing projection of the DAG (viewport, scene tree, timeline, chat, DAG view).
- **Mode** — Simple / Director / Pro. Determines which surfaces are visible and which is primary.
- **Macro-tool** — An agent tool that wraps a macro (e.g. `character.walkTo`).
- **Primitive-tool** — An agent tool that calls a primitive Op directly (`dag.addNode`, ...).

## Appendix B — The Five Op Primitives (Reference)

```ts
type Op =
  | { type: 'addNode'; nodeId: NodeId; nodeType: string; params: unknown }
  | { type: 'removeNode'; nodeId: NodeId }
  | { type: 'connect'; from: NodeRef; to: NodeRef }
  | { type: 'disconnect'; from: NodeRef; to: NodeRef }
  | { type: 'setParam'; nodeId: NodeId; paramPath: string; value: unknown }

type NodeRef = { node: NodeId; socket: SocketId }

interface InverseOp {
  forward: Op
  inverse: Op
}

interface Diff {
  id: string
  description: string
  ops: InverseOp[]
  status: 'proposed' | 'previewing' | 'applied' | 'rejected'
  source: 'user' | 'agent' | 'macro'
  timestamp: number
}
```

## Appendix C — The Default Project (P0 deliverable)

```ts
// Four nodes. The minimum viable DAG.
{
  version: 1,
  outputs: { scene: 'n_scene', render: 'n_render' },
  nodes: {
    n_camera:  { type: 'PerspectiveCamera', params: { fov: 45, position: [3, 2, 3] } },
    n_light:   { type: 'DirectionalLight',  params: { intensity: 1.1, position: [5, 5, 3] } },
    n_box:     { type: 'BoxMesh',           params: { size: [1, 1, 1], material: 'default' } },
    n_scene:   { type: 'Scene',
                 inputs: { camera: { node: 'n_camera', socket: 'out' },
                           lights: [{ node: 'n_light', socket: 'out' }],
                           children: [{ node: 'n_box', socket: 'out' }] } },
    n_render:  { type: 'RenderOutput',
                 inputs: { scene: { node: 'n_scene', socket: 'out' } },
                 params: { postFx: { tonemap: 'ACES', smaa: true } } }
  }
}
```

Boot Basher with this DAG. See a cube. Edit `n_camera.params.position`. See the cube from a new angle. Save. Reload. Same DAG, same cube. The smallest viable Basher project. Everything else is more nodes.

---

**End of thesis.**

*This document is the source of truth for v0.5. Every PR references the section it implements or the section it amends. Amendments require a changelog entry at the top of this file. The thesis evolves; the commitments do not.*
