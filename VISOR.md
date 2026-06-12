# Visor — A Thesis

**Subtitle:** A fully procedural, agent-native, director-first motion graphics editor — built on the same DAG primitive as Basher.

**Version:** Thesis v1.0 — written before any Visor-specific code exists. This document is the why, the what, and the how. It is the source of truth for every architectural decision in Visor v0.5 through v1.0.

**Status:** Draft. The Basher engine is the substrate; Visor is what the substrate looks like when you point it at 2D motion design instead of cinematic 3D.

> **⚠️ SUBSTRATE RECONCILIATION OPEN (2026-06-12).** A MoGraph-DSL/compose brainstorm reached a different substrate conclusion: build Visor's 2D procedural tier **on compose's IR directly** (because that IR already exists AND the compose B.8.6→B.8.8 text work — template+field, scalar-field, channel handlers, dominance recognizer — is a *working, render-verified vertical slice* of the C4D-MoGraph/Cavalry procedural trio, i.e. Visor's proto-core). That SHIFTS this thesis's "Visor on the Basher engine" + the locked "Move A" (compose = emit seam only). The shift is **not yet resolved** — three candidate reconciliations (R1 compose-IR-is-the-2D-substrate / R2 Basher-engine-targets-a-compose-2D-profile / R3 hybrid shared-primitive-library) are spelled out in `~/Documents/projects/MoGraph-DSL/.artifacts/visor-procedural-editor.md` §6. That artifact also locks **D-VIS-01 bake-on-edit** (defer the live procedural engine), D-VIS-02 (procedural IR is a superset above Lottie-parity), D-VIS-03 (LLM authors the procedural tier only, through the typed/refusing Mutator surface), and argues **procedural is the substrate that makes full LLM-authorship work** (LLMs author compact procedural specs, never keyframe soup). Read it alongside this thesis; the substrate question is the gating decision before any Visor code.

---

## Part I — The Argument

### 1. The problem is the wrong tool for the wrong artist

Motion graphics today splits across three failure modes:

**Failure mode A — After Effects, the timeline-of-layers monolith.** The user composes a stack of layers, animates each one with keyframes, and spends years learning expressions to make anything procedural. Procedural is a power-user feature, not the substrate. Tools fight the user when the project crosses ~50 layers. Real-time playback dies.

**Failure mode B — Houdini for mograph.** Procedural-first, but the on-ramp is a year. Geometry-engine concepts leak into UI for a designer who wants a hex grid that pulses to a beat. Render-to-disk is the only path to deliverable.

**Failure mode C — Cavalry-the-original (and Notch, TouchDesigner).** Procedural-first AND mograph-shaped. Closer to right. But still: human-only authoring surface; AI is bolted on; no agent path; no native 2D-3D unification; license posture is closed-source-commercial and lock-in is the business model.

All three fail at the same root: **the abstraction is shaped for an interaction model the next generation of designers does not have.** Designers used to draw frame-by-frame. Then they keyframed layers. Then they wrote expressions. The next surface is conversation, with procedural underneath.

The right primitive is — again — neither timeline-of-layers nor box-of-keyframes. It is **the directorial unit for motion design**: the move, the loop, the burst, the system. Composed in a way that is editable, reproducible, machine-readable, and that humans and AI agents can both author into.

### 2. The thesis

> **A motion graphic is a graph that evaluates to a sequence of frames. The director — human, agent, or both — edits the graph. The graph evaluates the motion.**

If this sentence is familiar, it's because it is the same sentence as Basher. **That is the point.** The directorial unit doesn't care whether the medium is cinematic 3D or stylized 2D. The graph evaluates either way. Visor is the same engine, the same Op system, the same agent surface, the same procedural-as-substrate commitment — pointed at a 2D-first surface area where speed of iteration matters more than fidelity.

### 3. Why now

Three forces converge:

1. **Browser 2D matured.** Canvas, OffscreenCanvas, WebGPU compute, Pixi/Konva/Skia-WebAssembly. A real-time 2D motion engine in the browser is competitive with desktop apps for everything short of feature-film-length output.
2. **Tool-calling LLMs matured.** "Make a hex grid that pulses to this beat" is now a tractable sentence. The agent emits Op chains; the user accepts; the graph updates; the viewport reflects.
3. **The procedural-mograph audience is starved for tooling that respects them.** Cavalry-the-original proved the demand. Notch costs $1k/year and ships zero AI. TouchDesigner is for installation art. After Effects is what the designer left because it broke at scale. There is room for a permissive, agent-native, procedural-first product.

### 4. Why not just X?

| Alternative | Why it loses |
|---|---|
| After Effects | Timeline-of-layers as the substrate is the problem, not the solution. Expressions are an escape hatch, not the model. |
| Cavalry (the existing product) | Closed-source commercial; no agent surface; no 3D unification; license-trap for derivative work. The product is a starting point, not a target — we admire the shape, not the constraints. |
| Notch | Commercial; broadcast-first; no procedural-as-substrate philosophy at the editor level. |
| TouchDesigner | Real-time installation art shape. Mograph workflow is awkward. |
| Houdini's COPs | Right depth, wrong audience. Mograph designers are not VFX TDs. |
| Geometry Nodes (Blender) | 3D-shaped; 2D is an afterthought; agent integration is years away. |
| Roll our own from scratch | We have Basher's engine. The thesis says the engine is dimension-agnostic. Reuse it. |

### 5. The pitch in one sentence

**Visor is a procedural motion designer — every piece is a graph that evaluates to a sequence of frames. AI agents and humans both edit the graph. The graph is the truth, the canvas is the result, and the chat is the language.**

The same primitive as Basher. The same disciplines. A different surface.

---

## Part II — The Reuse

### 6. The shared substrate

Visor inherits, unmodified:

```
DAG primitive (THESIS.md §6)        — typed nodes, lazy eval, content hashing
Five Op primitives (THESIS.md §9)   — addNode, removeNode, connect, disconnect, setParam
Type system across sockets (§8)     — Number/Vector/Time/etc. carry over
Evaluator (§10)                     — same topo-sort, same cache, same cycle detection
Op system as only mutation path (§50) — same V1 enforcement
Agent-as-privileged-user (§18-25)   — same Diff overlay, same Read-only/Co-pilot/Sandbox/Autopilot modes
Storage capability (§33)            — same OPFS + Tauri fs interface
Migration policy (§52)              — same versioned schemas
Determinism (§48)                   — same pure-flag, same lint, same twice-eval CI
License posture (§35)               — same permissive-only allowlist
```

**This is non-negotiable.** Forking the engine for Visor-specific reasons is the failure mode. If a 2D requirement breaks the engine, the engine is the wrong shape for both products and we fix it in the engine. The Basher repo and the Visor repo are siblings consuming the same `@basher-engine/*` packages.

### 7. What Visor adds (and only Visor)

```
2D-first node types          (§9-12 of this doc)
2D viewport                  (§13)
Layer + composition model    (§14)
Mograph-specific procedurals (§15)
2D-3D bridge nodes           (§16)
Beat-driven time             (§17)
Sequence/pattern primitives  (§18)
Web-export pipeline          (§19)
```

Each of these is a node-type or a surface. None of them changes the engine's shape.

### 8. The reuse contract

To make this real, Basher's `src/core/` and `src/integrations/` get extracted into a package: `@basher-engine`. Visor depends on it. So does Basher itself. Both consume:

```
@basher-engine/dag          — types, ops, evaluator, registry, store
@basher-engine/storage      — StorageCapability + impls
@basher-engine/project      — schema, migrations, save/load
@basher-engine/agent        — tool surface (P2.5+)
@basher-engine/render-graph — render passes (P4+)
```

Basher and Visor each ship their own `nodes/`, `viewport/`, `app/`. The engine is the trunk; the products are branches.

**Lifecycle promise:** any change to `@basher-engine` ships behind a semver bump. Both products' CI runs against the new version before merge. If a Visor-driven change breaks Basher (or vice versa), the engine change is wrong.

---

## Part III — The Visor-Specific Primitive

### 9. The 2D type system extension

Visor adds these socket types to the existing set:

```
Geometry2D:   Path2D, Shape2D, Stroke, Fill, BoundingBox2D
Composition:  Layer, Composition, BlendMode, Mask
Sprite:       SpriteSheet, SpriteFrame, Atlas
Text:         TextRun, FontRef, GlyphPath
Mograph:      Replicator, Cloner, Effector, Deformer
Audio:        AudioBuffer, BeatGrid, FrequencyBand
Pattern:      Sequence, Loop, Phase
```

Existing types carry over: `Number`, `Vector2`, `Vector3`, `Color`, `Time`, `Image`, `Material`. The 3D-only types (`Mesh`, `Skeleton`, `Splat`, `RenderPass`) exist but are unreachable from a Visor project unless a 2D-3D bridge node materializes them.

Same nominal-typing rule as Basher: implicit coercion only between numeric types. Everything else is explicit through converter nodes.

### 10. The seven properties of every node — preserved

The seven properties from THESIS.md §7 hold without modification:

1. Typed sockets.
2. Schema-validated parameters.
3. Deterministic given (params, inputs, seed).
4. Lazy + cacheable.
5. Time-as-input, not-as-global.
6. Versioned schema.
7. Cost-tagged.

A Visor `Replicator` node that creates 1000 instances of a path is `pure: true, cost: 'medium'` — same as Basher's `Scatter`. Same evaluator runs both. Same cache invalidates both.

### 11. The five core operations — preserved

`addNode`, `removeNode`, `connect`, `disconnect`, `setParam`. No change. A "duplicate this layer 16 times along a circle" macro emits exactly these primitives, just like Basher's `procedural.scatter`.

### 12. Visor's first-party node types (v0.5)

The minimum viable Visor. Each is a node. Each has a zod param schema. Each has a `pure` flag. Each is twice-eval-tested.

```
Geometry primitives:
  Rect, Ellipse, Polygon, Star, Path, Line, Arrow

Path operations (procedural):
  PathBoolean (union/intersect/subtract), PathOffset, PathSimplify,
  PathSubdivide, PathReverse, PathSampleAlong, PathTrim

Mograph generators:
  Replicator        — N copies of input along a transform field
  Cloner            — grid/circle/path/random distribution of clones
  Effector          — modifies cloner's per-instance transforms (random, plain, formula, audio)
  ScatterPath       — Visor version of Basher's ScatterNode for 2D

Deformers:
  Twist, Wave, Bend, Noise (procedural deformation of paths)

Composition:
  Layer             — z-ordered carrier of a Geometry2D
  Composition       — group of layers, blendmode-aware
  Mask              — alpha mask binding

Materials:
  SolidFill, GradientFill, PatternFill, Stroke, OutlineStyle

Animation drivers:
  KeyframeChannel<T>  — same primitive as Basher P3
  Curve<T>            — same
  AudioReactive       — bind a frequency band to any Number socket

Bridge:
  Geom3DToShape2D   — projects a 3D mesh through a 2D camera, emits Shape2D
  Shape2DToMesh     — extrudes a 2D shape into a 3D mesh

Output:
  RenderOutput2D    — composition → ImageSequence with codec params
  Export            — ImageSequence → MP4/WebM/Lottie/SVG-animation
```

That's the v0.5 surface. ~30 node types. Smaller than feels right for a mograph editor — but the procedurals (Replicator + Cloner + Effector) make ~30 nodes do the work of ~300 in After Effects.

---

## Part IV — The Surfaces

The DAG is the truth. The user does not see the DAG by default. They see one of three surfaces, each a projection.

### 13. The canvas (always visible)

A 2D renderer mounted at app root, never unmounted. Renders the result of `evaluate('composition', currentTime)`.

**Implementation choice for v0.5: WebGPU compute + custom 2D rasterizer, with Skia-WebAssembly as a fallback for browsers without WebGPU.** Pixi.js was considered and rejected — its retained-mode scene graph fights the DAG-as-truth model (we'd have two scene graphs to keep in sync, exactly the failure mode V8 prevents in Basher). Konva same problem. Skia is immediate-mode (paint-on-context) which fits: the evaluator emits paint ops, the renderer executes them, no parallel scene graph.

The canvas has:
- Pan/zoom (not orbit). Mouse wheel zooms; middle-drag pans.
- Pixel grid overlay (toggle).
- Safe-area + composition-bounds overlay (Director mode).
- Per-frame timing readout (FpsMeter, identical to Basher's).

### 14. The layer panel (Director + Pro modes)

A walkable z-ordered list derived from the DAG by walking the `composition` output. Looks like After Effects' layer stack — because that mental model is correct for 2D mograph, even if the underlying data is a DAG.

Drag-reorder a layer → emits `disconnect` + `connect(index)` ops, identical to Basher's scene-tree pattern. Two non-identical DAGs that evaluate to the same composition show the same layer stack.

### 15. The timeline (Director + Pro modes)

Bottom-rail panel. Three rows vertically split:

- **Top: dopesheet.** Identical to Basher P3. Aggregates `KeyframeChannel<T>` nodes.
- **Middle: curve editor.** Identical to Basher P3.
- **Bottom: audio waveform + beat grid.** New for Visor. The `AudioBuffer` node provides waveform; `BeatGrid` (a derived node, `pure: true`) provides snap targets. Audio-reactive parameters show their driver curve overlaid on the waveform.

The timeline is a projection of the subset of the DAG that consumes `Time` and produces values for the composition. Mograph's hard-cut, beat-aligned editing pattern works because the time is the truth and the keyframes are projections of nodes.

### 16. The library (Director mode)

Left rail. Folder tree of project assets — sprites, fonts, audio clips, imported SVGs, imported Lottie files. Identical to Basher's Library, with these additions:

- **SVG import** materializes as a `Shape2D` node + parameter schema for fills/strokes (so the imported SVG becomes editable through the same Op system).
- **Lottie import** materializes as a graph of `KeyframeChannel<T>` nodes plus a `Composition` — making the imported Lottie *first-class editable*, not opaque.
- **Font import** registers a `FontRef` accessible to `TextRun` nodes.
- **Audio import** registers an `AudioBuffer` and runs an offline FFT to populate `BeatGrid` + frequency-band metadata.

### 17. The chat drawer

Right rail. Identical to Basher's. Three tabs (Chat / Activity / Tools). Same modes (Read-only / Co-pilot / Sandbox / Autopilot). Same Diff-first interaction.

The agent's prompts differ — its tools are Visor's tools — but the contract with the user is the same. "Make me a starfield that drifts past the camera and pulses to the kick drum" is one chat turn that emits an Op chain creating `Cloner(star) → Effector(drift) → AudioReactive(kick → scale)`.

### 18. The DAG view (Pro mode, read-only in v0.5)

Identical to Basher's. Force-directed graph, debug surface in v0.5, editable in v0.6. Same discipline: hide the DAG by default, expose it under the hood for power users.

### 19. Mode hierarchy

| Mode | Default surfaces | DAG visible? | Primary input |
|---|---|---|---|
| **Simple** | Canvas + Timeline + Chat | No | Natural language |
| **Director** | + Layer panel + Library + Inspector | No | Mixed (chat + direct) |
| **Pro** | + DAG view + Render-graph + Code | Yes (read-only v0.5) | Direct + code |

Onboarding starts in Simple. Director is the default after first project. Pro is opt-in.

---

## Part V — The Mograph-Specific Primitives

### 20. The Replicator/Cloner/Effector trio (THE hero feature)

Visor's identity is procedural mograph. The Replicator/Cloner/Effector trio is to Visor what Houdini's `copy-to-points` is to Houdini: the thing that makes the product worth using.

```
Cloner
  inputs: target (any Geometry2D), distribution (grid/circle/path/random/audio)
  params: count, spacing, seed, distribution-specific (radius, path ref, etc.)
  output: Composition (one layer per clone, transformed per-instance)

Effector
  inputs: target Cloner, time
  params: parameter to modify, falloff curve, range, formula, audio-band ref
  output: Composition (target with modulated per-instance transforms)

  Variants:
    PlainEffector, RandomEffector, FormulaEffector, AudioEffector,
    PathEffector (transforms follow a path), ProximityEffector
```

Stack effectors deeply: a single Cloner can have 5 effectors layered, each a node, each pure given inputs, each cached. Re-evaluating after a parameter change re-runs only the affected effector and downstream — same incremental cost as After Effects' "modify keyframe" but with infinite procedural depth.

### 21. Audio-reactive as a first-class primitive

`AudioReactive` binds a frequency band to any `Number` socket. The driver is procedural — `BeatGrid` extracts onsets, FFT extracts bands, all `pure: true` given the input audio. Re-evaluation when scrubbing is byte-exact: the same time on the same audio always produces the same value.

This collapses the typical mograph pipeline:
- After Effects: import audio → keyframe assist → manually clean up → animate to the keyframes.
- Visor: import audio → drag `AudioReactive` onto a parameter → done. Re-render anytime; if you change the audio, the animation re-derives.

### 22. The pattern primitives

`Sequence`, `Loop`, `Phase` are nodes that operate on Time:

```
Sequence (input: time) → time-with-discrete-stops at keyed-in moments
Loop (input: time, period) → time mod period
Phase (input: time, offset) → time + offset
```

Combine them: a `Cloner` of 100 dots, each driven by a `LoopEffector` whose phase is offset per-clone, produces a wave pattern. One DAG. Three nodes. Driven by audio. Re-renders deterministically.

### 23. Text as a first-class procedural

Most mograph tools treat text as a sprite or as a styled string. Visor treats text as a **graph of glyph paths**. A `TextRun` node outputs a list of `Path2D` (one per glyph). That list flows through the same Cloner/Effector trio — meaning kerning, character animation, per-glyph modulation are all procedural without per-letter manual keyframing.

This is the difference between "a typewriter effect" (one keyframe per letter) and "a typewriter effect" (one Effector with a `RandomEffector` on opacity falloff).

### 24. The 2D-3D bridge

Visor doesn't pretend 3D doesn't exist. Two bridge nodes:

```
Geom3DToShape2D
  inputs: Mesh, Camera, Time
  params: projection mode (silhouette / outline / wireframe)
  output: Shape2D

Shape2DToMesh
  inputs: Shape2D, depth
  params: bevel, extrude method
  output: Mesh
```

A Visor project that imports a Basher scene gets it as 3D; a Basher project that imports a Visor composition gets it as a textured plane. The DAG primitive is the same; the type-system bridge nodes are the seam.

This makes hybrid shots tractable: a 3D character (Basher P2's `Character` node) walks across a 2D motion-graphics background (Visor composition projected onto a plane). One DAG. One render. One agent.

---

## Part VI — The Pipeline

### 25. From composition to deliverable

The render pipeline mirrors Basher's render-graph (THESIS.md §26-32) with 2D-flavored passes:

```
RenderPass2D variants:
  BeautyPass2D      — final composited frame
  AlphaPass2D       — alpha matte
  MotionVectorPass  — per-pixel motion (for AI restyle temporal coherence)
  IDPass2D          — per-layer ID for compositing

RenderJob2D
  inputs: RenderPass2D[], Composition, Time
  params: frameRange, fps, outputSize, codec
  output: ImageSequence

Export
  input: ImageSequence
  variants: MP4 (ffmpeg-wasm), WebM (ffmpeg-wasm), Lottie (synthesizer),
            SVG-animation (synthesizer), GIF, frame-stack-zip
```

A "render" is the chain `Composition → RenderJob2D → Export`. Authored via macros in v0.5 (`render.shot2D`, `export.lottie`). Visually authored in v0.6+ via the render-graph editor.

### 26. Lottie as a synthesis target (and not an import)

Lottie is the JSON format for After Effects animations. Most mograph tools either don't export it or export-with-restrictions.

Visor's promise: any DAG that consists of supported node types exports cleanly to Lottie. The synthesizer walks the evaluated output (not the source DAG) and emits Lottie JSON. Procedurals are baked at export — the Cloner's 1000 instances become 1000 Lottie layers. Big files, but they play in any Lottie player.

For DAGs that exceed Lottie's expressive power (audio-reactive, formula effectors, dynamic keyframe counts), the synthesizer either bakes per-frame or emits an error pointing at the offending node. Honest contract: we don't lie about what Lottie can hold.

### 27. SVG-animation as an alternative

SVG-SMIL is dead but `<svg>` + `requestAnimationFrame` JS is a fine target for web-native motion. Same synthesizer pattern: evaluated output → SVG + a tiny replay script. Smaller than Lottie for path-heavy designs.

### 28. AI restyle (shared with Basher)

Visor inherits the ComfyUI pipeline from Basher P5 with no modification. The 2D output is a perfectly good input to an SDXL workflow. Three additional starter presets specific to mograph:

- **Anime mograph** — line + flat-color stylization, optimized for high-frequency content
- **Print poster** — heavy halftone + grain, baked-in motion blur
- **Glitch** — datamosh + chromatic aberration + scanline ControlNet

Temporal coherence comes from the motion vector pass — same mechanism as Basher.

### 29. Procedural + generative + AI together

Visor's strongest combinatorial bet:

- **Procedural** — Cloner with 1000 instances driven by audio
- **Generative** — each instance's color sampled from a `TextToImage` node (a single AI image, sampled per instance)
- **AI restyle** — the whole thing rendered, then SDXL-pass for cohesion

Three paradigms, one DAG. None of them is bolted on; each is a node.

---

## Part VII — The Stack

### 30. Locked technical decisions

Inherited unchanged from Basher (THESIS.md §33):

```
Runtime / 3D / state / chrome / DnD / Theatre / zod / storage / LLM SDK
```

Visor-specific additions:

```
2D renderer:        WebGPU compute + custom rasterizer (primary)
                    Skia-WebAssembly (fallback, also used for path ops)
SVG parser:         svgson (MIT) or roll-own DOMParser-based
Lottie synth:       custom (no runtime dep on lottie-web; we're a producer)
SVG synth:          custom
Path ops:           paper.js (MIT) for boolean / offset / simplify
Font handling:      opentype.js (MIT) for glyph-to-path
Audio:              Web Audio API + meyda (MIT) for FFT/onset detection
Pattern source:     Cavalry-the-original (no code), Notch (no code),
                    AE expressions reference (concept only)
```

### 31. Why these and not others

- **Skia-WASM over Pixi/Konva:** immediate-mode rendering matches DAG-output-paint-ops cleanly. Retained-mode 2D scene graphs duplicate the source-of-truth. (Same V8-style argument as Basher's R3F-over-raw-three choice.)
- **paper.js over a custom path engine:** boolean ops and offsetting are 6-month projects to do correctly. Paper has solved them. MIT-licensed. We use it as a library, not a framework.
- **opentype.js over canvas text:** glyph-to-path is the difference between "type that animates" and "type that morphs." Browser canvas can't give us the path; opentype can.
- **meyda over WebAudio's AnalyserNode alone:** AnalyserNode is real-time only. We need offline analysis (scrub backward). Meyda runs offline against an `AudioBuffer`.
- **Custom Lottie/SVG synthesizers:** Visor is a *producer* of these formats, not a consumer. Library code for parsing them exists; library code for emitting clean, optimized output of them is rare and we benefit from owning the synthesis.

### 32. License posture (unchanged)

Permissive only. MIT, Apache 2.0, BSD. Same allowlist as Basher. Same CI gate.

This excludes:
- Houdini's HDA SDK (closed)
- Cavalry-the-original's plugin SDK (closed)
- Notch's plugin format (closed)
- Adobe's Lottie reference implementation (mixed; we don't depend on it)

We import patterns from these, not code.

### 33. The donor strategy

```
Basher engine        — direct dep (@basher-engine/*)
paper.js             — library (path ops)
opentype.js          — library (font → glyph paths)
meyda                — library (audio analysis)
ffmpeg-wasm          — library (video encode, also used by Basher P5)
react-three-fiber    — only for Pro-mode 3D-debug viewport (Visor is 2D-first)
```

We do not fork. We do not vendor. We depend.

---

## Part VIII — The Plan

### 34. Phase map (10 weeks to v0.5, after Basher v0.5 ships)

```
C0   Engine extraction + 2D foundation       [Wk 1-2]
C1   First node types + Library              [Wk 3]
C2   Mograph trio (Cloner / Replicator /
     Effector)                               [Wk 4-5]
C3   Timeline + audio + animation drivers    [Wk 6]
C4   Render graph 2D + Lottie / SVG export   [Wk 7]
C5   AI restyle (reuse Basher P5)            [Wk 8]
C6   2D-3D bridge nodes                      [Wk 9]    ← cut candidate
C7   Progressive UX + Demo                   [Wk 10]
```

Visor runs in parallel with or after Basher v0.5. The dependency is clear: Visor C0 cannot start until Basher's `core/`, `storage/`, `project/`, and `agent/` (P2.5) are extractable.

### 35. C0 — Engine extraction + 2D foundation

**Week 1 — engine extraction.**

- Extract `src/core/dag/`, `src/core/storage/`, `src/core/project/` into `@basher-engine/{dag,storage,project}` packages.
- Move agent surface (Basher's P2.5 deliverable) into `@basher-engine/agent`.
- Both Basher and Visor repos depend on these as workspace packages (npm/pnpm workspaces).
- CI in both repos runs against the engine packages on every PR.
- Basher's existing tests must all still pass after extraction. Non-negotiable gate.

**Week 2 — Visor shell + canvas.**

- Visor repo skeleton (Vite + React + Tailwind + shadcn, like Basher).
- Skia-WASM loaded; `Canvas2D` component renders evaluated DAG output.
- Mode store (`'simple' | 'director' | 'pro'`).
- Default project: a Rect + a SolidFill = a colored rectangle. The minimum viable Visor, mirroring Basher's "see a cube" P0.
- Lint rules: same V2 purity rules from Basher inherited.

**C0 acceptance (8 tests):**

1. Engine extraction: Basher's full test suite passes against `@basher-engine/*` instead of `src/core/*`.
2. Visor dev server up in <5s.
3. Default project: Rect + SolidFill renders to canvas.
4. Mode toggle reconfigures chrome.
5. Save → reload bit-exact.
6. Inspector edits a Rect param → canvas updates within 16ms.
7. Pan/zoom works without re-evaluating the DAG (camera is a viewport-only concern, V8).
8. ≥60fps on M1 with default project.

### 36. C1 — First node types + Library (1 week)

- Geometry primitives: `Rect`, `Ellipse`, `Polygon`, `Star`, `Path`, `Line`, `Arrow`.
- Layer + Composition aggregator nodes.
- Inline material specs (SolidFill, Stroke).
- SVG import → `Shape2D` node materialization.
- Library panel (left rail) — Visor version of Basher's Library.
- Drag-drop SVG / image into canvas → emits Op chain via `dispatchAtomic`.

**C1 acceptance:** drag an SVG → editable Shape2D appears in canvas → undo reverts → reload preserves.

### 37. C2 — Mograph trio (2 weeks — the spine of the product)

The make-or-break phase.

- `Cloner` with grid / circle / path / random / audio distribution modes.
- `Effector` base + variants (Plain / Random / Formula / Audio / Path / Proximity).
- `Replicator` (Cloner's simpler sibling — N copies along a transform).
- Dopesheet integration: cloners and effectors show as single timeline rows, expandable into per-effector keyframes.
- Twice-eval determinism for every cloner + effector combination (the cache hit rate is the perf story).

**C2 acceptance (5 tests):**

1. Grid Cloner of 10×10 dots renders within 16ms.
2. Adding a RandomEffector to a 100-dot Cloner re-evaluates within 16ms.
3. Audio-reactive scale on a 200-instance Cloner stays at 60fps during playback.
4. Same seed + same audio = byte-identical output across runs.
5. Cloner of cloners (nested) renders correctly.

### 38. C3 — Timeline + audio (1 week)

- `KeyframeChannel<T>`, `Curve<T>` (reused from Basher P3 — `@basher-engine/animation`).
- Dopesheet UI (Visor-styled but same data model as Basher).
- Curve editor.
- `AudioBuffer` node + offline FFT.
- `BeatGrid` derived node (`pure: true` given audio).
- `AudioReactive` driver (binds a band to any Number socket).

**C3 acceptance:** import an audio clip → drop AudioReactive on a Cloner's count → playback shows count modulating to the beat → scrub backward shows identical state.

### 39. C4 — Render graph 2D + export (1 week)

- `RenderPass2D` variants (Beauty, Alpha, MotionVector, ID).
- `RenderJob2D` walks frames.
- `Export` macros: MP4, WebM, Lottie, SVG-animation.
- Lottie synthesizer with honest-error path for unsupported nodes.

**C4 acceptance:** a 5-second composition renders to MP4 in <10s on M1; the same composition renders to Lottie and plays back identically in lottie-web.

### 40. C5 — AI restyle (1 week)

- Reuse Basher's `ComfyUIWorkflow` + `Prompt` + `VideoStitch` nodes.
- Three Visor-specific presets (anime mograph, print poster, glitch).
- Cost preview before submit.

**C5 acceptance:** "stylize this 3-second clip as anime mograph" → Diff appears → accept → stylized output renders → playback matches preset visual signature.

### 41. C6 — 2D-3D bridge (1 week, cut candidate)

- `Geom3DToShape2D`, `Shape2DToMesh` nodes.
- A Visor project can import a Basher scene and animate it as 2D mograph.
- A Basher project can import a Visor composition as a textured plane.

**C6 acceptance:** a Basher cube imported into Visor shows as outline; that outline drives a Cloner; the Cloner's 50 outlines render at 60fps.

### 42. C7 — Progressive UX + Demo (1 week)

- Three modes (Simple, Director, Pro) per Section 19.
- Onboarding tour.
- Demo project: 30-second audio-reactive title card with logo reveal — every node procedural, no keyframes hand-set.
- README + 5-minute screencast.

**Acceptance:** three first-time users, each ships a 15-second mograph clip in <20min from clone.

---

## Part IX — The Disciplines (inherited)

Visor inherits all of Basher's THESIS.md §48-55 disciplines unchanged:

- **Determinism is enforced or it does not exist.** Same lint rules. Same twice-eval CI.
- **Time is a first-class type.** Same `Time` socket. No `useFrame`. (Especially load-bearing for audio-reactive: a beat at frame 60 must always be the same beat at frame 60.)
- **The Op system is the only mutation path.** Same V1.
- **Caching correctness.** Same hash function. Same invalidation rule. Same LRU ceiling. Visor tunes the ceiling higher (1GB) because 2D bitmap caches are bigger than 3D scene caches.
- **Migration policy.** Same. Visor's own node-types carry their own version ladders.
- **Performance budgets.** Same 60fps / 16ms / 8ms tiers. Visor adds: Cloner of N=1000 instances re-evaluates in <16ms with no effector changes; <50ms with one effector change.
- **Testing strategy.** Same Vitest + Playwright + license-audit.
- **Observability.** Same anonymous opt-in counters. Visor adds `cloner_added_by_size`, `effector_added_by_type`, `audio_reactive_clip_imported`.

### 43. Visor-specific disciplines

- **2D-3D bridge nodes are explicit.** No implicit projection. A 3D scene rendered into 2D is `Geom3DToShape2D`, visible in the DAG, agent-introspectable, version-able.
- **Lottie export is honest.** Either a DAG renders cleanly to Lottie or it doesn't. The synthesizer never silently bakes per-frame to "make it work" — it errors and points at the unsupported node.
- **Audio is not a sidecar.** Audio is an evaluator-input. Scrubbing audio = scrubbing time = re-evaluating the DAG. There is no separate "audio playback engine" running parallel to the rendering pipeline.
- **The Cloner is not a Component.** A Cloner that creates 1000 things creates 1000 nodes' worth of evaluation, not 1000 React components. The renderer paints; React only manages the editor chrome.

---

## Part X — The Risks

| Risk | Likelihood | Failure mode | Mitigation |
|---|---|---|---|
| Skia-WASM perf insufficient for 1000+ instance clones | Medium | Drag stutters during playback | WebGPU compute path for hot loops; documented N-cap (5000) in v0.5 like Basher's ScatterNode |
| Engine extraction breaks Basher's tests | High | Visor blocks Basher's velocity | C0 acceptance gate: Basher tests must pass against extracted engine before Visor repo touches anything |
| Lottie's expressiveness is too narrow | Medium | Many DAGs fail to export | Honest-error contract; the synthesizer points at the offending node; users can bake-per-frame as escape hatch |
| Audio-reactive determinism fails (different FFT on different machines) | Medium | Same seed + same audio = different output | Pin meyda version; checksum FFT outputs in CI; ship a reference-audio test that runs on every PR |
| Mograph users want After-Effects-flavored expressions | Medium | "I want JS!" pressure to expose code | Pro mode includes a `FormulaEffector` whose param is a JS expression sandbox-evaluated; keep it scoped, lint for non-determinism |
| 2D-3D bridge encourages Frankenstein scenes | Low | Bad demos hurt the brand | The bridge ships with three exemplary demos showing taste, not power |
| Visor's brand collides with another mograph tool we haven't surveyed | Low | Trademark / SEO / market confusion | Renamed off "Cavalry" pre-v0.5 to avoid the obvious collision; run a full trademark + SEO sweep before v1.0 |
| Engine version drift between Basher and Visor | High | Subtle bugs from desync | Single-version policy: both products always depend on the same `@basher-engine` version; merge train enforces |
| Web-export Lottie file sizes too large (1000-instance Cloner = huge JSON) | Medium | Designers drop the format | Synthesizer warning at >5MB; offer SVG-animation fallback; offer pre-baked MP4 fallback |
| Real-time audio playback while editing competes with eval CPU | Medium | Drops frames during playback | Audio decode + FFT in worker; eval on main thread reads pre-computed frequency bands |
| Permissive font licensing | Low | Designer imports a paid font, ships a project containing it | Library import warns on font license metadata; doesn't block (designer's call) |
| The agent generates malformed Cloner configs | Medium | Diff contains 10000-instance Cloner that hangs eval | Same zod-validate-on-tool-call rule as Basher; cap instance counts at the schema level |

### 44. The pre-mortem

Imagine Visor v0.5 ships and fails. The most likely autopsy:

1. **The procedural pitch was right but the mograph designers wanted After Effects.** The Replicator/Cloner/Effector trio is correct in the abstract, but designers spent a year learning AE keyframes and want that workflow with AI on top. *Mitigation: Simple mode IS the keyframe workflow with AI; Director mode introduces procedurals; the on-ramp must not skip steps.*
2. **Skia-WASM was fast enough for demos but not for production.** A 60-second commercial at 4K with 5000 cloned instances dropped to 3fps in the editor. *Mitigation: WebGPU compute path lands in C2; cap instance counts honestly; document the path to v0.6 worker offload.*
3. **Lottie export disappointed.** Designers wanted to ship to an existing Lottie pipeline; many of their DAGs failed honest-export. *Mitigation: cap Visor's expressive power in Simple mode to Lottie-compatible nodes only, with a "go pro" upsell when the user reaches for a node that won't export.*
4. **Engine extraction took longer than planned.** Basher and Visor needed three rounds of API stabilization before the engine was actually shareable. *Mitigation: budget the extraction at 2 weeks not 1; gate Visor C1 on engine semver-stable.*

We address each in the plan; we revisit each at v0.5 retrospective.

---

## Part XI — The Roadmap Beyond v0.5

### 45. v0.6 — Visual node editor + Pro power

- Visual DAG editor (full editing, not read-only).
- Custom Effector authoring (compose effectors visually).
- WebGPU compute path everywhere (lift the 5000-instance cap).
- Real-time audio playback during edit (worker-based).
- Plugin SDK for community node types (sandboxed).

### 46. v0.7 — Type, layout, and interaction

- Per-glyph TextRun manipulation (kerning effectors, character animation).
- Auto-layout primitives (the React community has spoiled designers; Visor should match).
- Interactive prototypes: a Visor composition can include "wait for click here" hold-points and ship as a clickable prototype.

### 47. v0.8 — Multi-shot continuity

- ViMax-style "scene → shot → cut" hierarchy applied to mograph.
- Cross-shot continuity (a brand color set in shot 1 propagates).
- Long-form sequence editing (intro + 30 reusable beats + outro composes a 5-minute video).

### 48. v1.0 — Multiplayer + cloud

- Multiplayer (CRDT on the node map via Yjs).
- Cloud render farm (preview locally, render in the cloud).
- Asset marketplace (procedural patterns, fonts, audio loops).

### 49. v2.0 — Format + interop

- Native After Effects import (read .aep files; lossy but useful).
- Native Cavalry-the-original import (.cv files; honor the homage).
- Direct timeline integration with Basher (a Basher P3 timeline can include Visor compositions as shots).

---

## Part XII — The Director's Question (revisited)

### 50. The point — for motion design

In After-Effects-class tools, the system does keyframes; the designer manages 800 layers.

In Houdini-class tools, the designer is a TD; the system is a math engine.

In Visor, the designer composes a graph. The system evaluates the graph. The graph is editable, reproducible, machine-readable, human-readable. The designer is in control because the graph is. The designer is amplified because the agent can edit the graph too. The audio drives the graph because audio is just another node.

This is the directorial unit, made concrete for motion: a procedural pattern, with parameters, a time input, and an audio driver. The hex-grid-pulse is a node. The starfield is a subgraph. The titlecard reveal is a chain. The 60-second commercial is the evaluation. The director is whoever chooses what to evaluate and how.

### 51. The discipline of the simple mode (for mograph)

In Simple mode, the designer speaks. The agent edits. The canvas reflects. The DAG is invisible.

"Make a logo reveal where the letters fall in to the beat of this audio" becomes: import audio → `TextRun(logo) + AudioReactive(kick → opacity falloff per glyph) + KeyframeChannel(y-position fall-in)`. The user did not name a single node. The agent did. The canvas reflects.

If the simplest interaction is *natural language → mograph* and the deepest is *direct DAG editing*, and they are the same system underneath, Visor works.

### 52. The closing claim

A motion graphic is a graph that evaluates to a sequence of frames. We commit to this primitive — the same one Basher commits to, evaluated through the same engine. We expose three surfaces over it (canvas, timeline, chat) and let the designer choose. We let the agent share the same authoring path. We make procedural the substrate, generative one node category among many, AI restyle a chain in the render graph, and audio a first-class evaluator input.

This thesis is not a feature list. It is a claim that *the same primitive* serves cinematic 3D and procedural 2D — that the directorial unit is medium-agnostic, that a graph is a graph is a graph, that the engine doesn't know the difference and that's exactly why both products work. Every line of code in Visor will be evaluable against this: *does this respect the single primitive? Does this preserve determinism? Does this go through the Op system? Does this hide the DAG by default? Does this make the designer more in control, not less? Does this break or strengthen Basher?*

If yes (to all six), the line stays. If no, it does not.

---

## Appendix A — Glossary (Visor-specific additions)

- **Cloner** — A node that produces N copies of an input geometry, distributed by a chosen mode (grid/circle/path/random/audio). The mograph-equivalent of Basher's `ScatterNode`.
- **Effector** — A node that modulates a Cloner's per-instance transforms. Stackable. Always pure given inputs.
- **AudioReactive** — A driver node that binds a frequency band of an `AudioBuffer` to any `Number` socket.
- **Composition** — A z-ordered group of layers, blendmode-aware. The 2D analogue of Basher's `Scene`.
- **Layer** — A single z-positioned carrier of a `Geometry2D` value with optional mask. The 2D analogue of one of Basher's `SceneChild` variants.
- **BeatGrid** — A `pure: true` derived node that extracts onset times from an `AudioBuffer`. Used as snap target in the timeline.
- **Lottie synthesizer** — The traversal that walks an evaluated Visor composition and emits Lottie JSON. Producer-side; we don't import Lottie via this path.
- **Bridge node** — `Geom3DToShape2D` or `Shape2DToMesh`. The explicit seam between Basher 3D types and Visor 2D types.

## Appendix B — The Default Project (C0 deliverable)

```ts
// Three nodes. The minimum viable Visor.
{
  formatVersion: 1,
  outputs: { composition: 'n_comp', render: 'n_render' },
  nodes: {
    n_rect:    { type: 'Rect',
                 params: { size: [400, 200], position: [0, 0],
                           cornerRadius: 8, fill: { kind: 'solid', color: '#5af07a' } } },
    n_layer:   { type: 'Layer',
                 inputs: { content: { node: 'n_rect', socket: 'out' } },
                 params: { name: 'rect', blendMode: 'normal', opacity: 1 } },
    n_comp:    { type: 'Composition',
                 inputs: { layers: [{ node: 'n_layer', socket: 'out' }] },
                 params: { width: 1920, height: 1080, fps: 60, duration: 5 } },
    n_render:  { type: 'RenderOutput2D',
                 inputs: { composition: { node: 'n_comp', socket: 'out' } },
                 params: { format: 'mp4', codec: 'h264' } }
  }
}
```

Boot Visor with this DAG. See a green rounded rectangle on a 1920×1080 canvas. Edit `n_rect.params.cornerRadius`. See it round more. Save. Reload. Same DAG, same rectangle. The smallest viable Visor project. Everything else is more nodes.

## Appendix C — The Engine Contract

The `@basher-engine` packages expose this surface. Both Basher and Visor consume it. Neither product can extend it without a semver-major bump and the other product's CI passing on the new version.

```ts
// @basher-engine/dag
export type { NodeDefinition, Op, NodeRef, InputBinding, EvalCtx, ResolvedInputs };
export { applyOp, validateOp, evaluate, topoSort, registerNodeType, getNodeType, listNodeTypes };
export { useDagStore }; // factory; each product creates its own instance

// @basher-engine/storage
export type { StorageCapability, StorageQuota };
export { OpfsStorage, TauriStorage, MemoryStorage, pickStorage };

// @basher-engine/project
export { composeProject, saveProject, loadProject };
export { ProjectSchema, PROJECT_FORMAT_VERSION };
export { migrateProjectFormat, migrateNodes, registerFormatMigration };

// @basher-engine/agent (lands with Basher P2.5)
export type { Diff, ToolHandler };
export { applyDiff, rejectDiff, summarizeDag };
```

That is the entire contract. ~30 exported names. Both products live or die by it.

---

**End of thesis.**

_This document is the source of truth for Visor v0.5. Every PR references the section it implements or the section it amends. Amendments require a changelog entry at the top of this file. The thesis evolves; the commitments do not. The engine is shared with Basher; Visor's evolution must not break Basher's, and vice versa. One graph, one engine, two products._
