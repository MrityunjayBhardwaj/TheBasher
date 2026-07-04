# Design — The Compositor (After Effects-style Composition / Layer timeline)

> Status: DESIGN (not yet built). North-star chrome for Basher's video layer.
> Sibling of `docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md` — the ComfyUI keyframe
> compiler becomes a _layer source_ inside this model.

---

## 0. TL;DR

Basher's video editing surface is **one After Effects-style timeline**: layers
stacked vertically (composite + sequence), each layer a time-bar (the NLE: trim /
in-out / position), each layer twirling open to its keyframeable properties (the
dopesheet) and a **non-destructive effect stack** (color, inpaint, AI-extend,
first/last-frame gen, …). The viewer shows the composite at the playhead.

This is **not three surfaces bolted together** (NLE + dopesheet + compositor). It
is one surface, because everything in it already maps onto Basher's substrate:

- Composition / Layer / nesting → DAG nodes in the ONE substrate ([[V34]])
- per-layer keyframes (the dopesheet) → free-floating keyframe channels ([[V57]])
- per-layer effect stack → the typed operator chain ([[V58]]) lifted to the Image socket
- a layer source → anything that evaluates to a time-varying Image: a 3D scene
  (today's `Shot`), an imported media clip, a **ComfyUI generator** ([[V81]]), or a
  **nested Composition**
- "visible in both Basher and ComfyUI" → an AI effect/layer _compiles_ to a ComfyUI
  graph (the keyframe→schedule compiler, [[V81]])
- the viewer → the unified 2D View / Render Result ([[V80]])

**Director-simple chrome over a node substrate.** The DAG _is_ the node graph; a
node-graph view is a future projection of the same data, free whenever wanted —
we just don't force directors to see it (exactly the ComfyUI move: node graph
underneath, a keyframe timeline on top).

---

## 1. The wedge & why AE, not Resolve-pages or a node UI

Target user = **the director**. Visual simplicity wins. The AE model — one timeline,
layers + keyframes together, sequencing via nested comps — is simpler than
DaVinci-style separate pages (Edit / Fusion / Color) and far simpler than a raw
node editor. We get Resolve-grade _capability_ (edit, compositing, color, effects,
AI) on **one** surface because the power lives in the substrate, not the chrome.

We lose nothing by hiding the graph: Basher is already a DAG end-to-end ([[V34]]),
so the node projection can be generated later from the same nodes. Decision locked
(2026-06-24, with the user): **AE one-timeline model; node view deferred.**

---

## 2. The core insight — one timeline subsumes four tools

```
┌─ Viewer (2D View / Render Result, V80) — composite at the playhead ─────────┐
└──────────────────────────────────────────────────────────────────────────────┘
┌─ Timeline: "Comp 1"   (fps · duration · WxH)                  [Graph editor ◢]┐
│ Layers                  │ 0      1s      2s      3s      4s                   │
│ ▾ ◧ Hero  (3D scene)    │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                            │ ← layer bar  (NLE: trim/move)
│    ▾ Transform          │    ◆────────◆────────◆                              │ ← keyframes  (dopesheet)
│       Opacity           │    ◆────────────────◆                               │
│    ▾ Effects            │                                                     │
│       ▸ Relight  (AI)   │                                                     │ ← effect stack (V58 operators)
│       ▸ Color Correct   │    ◆────────────◆                                   │
│ ▾ ◧ Plate (Comfy gen)   │       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                          │
│       ref image         │    ▣              ▣ (frame 24)                      │ ← KeyframeChannelImage (step)
│       cfg               │    ◆──────────────◆                                 │ ← comfy param channel (V81)
│       ▸ Inpaint (AI, masked)                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Layer bar** = the clip/NLE aspect (trim, in/out, position, ripple).
- **Twirl-down properties** = the dopesheet (transform, opacity, _and_ comfy params,
  _and_ a reference-image channel). Graph-editor toggle reuses the existing
  `CurveEditor`.
- **Effects group** = a per-layer non-destructive operator stack ([[V58]]).
- **Source** of a layer is polymorphic (3D scene / media / ComfyUI / nested comp).

Your two requirements collapse into this one surface: _"dopesheet + clip editing in
one interface"_ = the layer twirls down into its keyframes; _"inject a reference at a
keyframe, see it in Basher and ComfyUI"_ = a `KeyframeChannelImage` on a Comfy layer
whose source compiles to a ComfyUI graph.

---

## 3. Relationship to what already exists (Existence check)

| Existing piece                                                                    | Role in the compositor                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Shot` (camera + scene + time range) / `Cut`                                      | A `Shot` becomes a **3D-scene layer source**; the earlier "Shot vs MediaClip" fork dissolves — both are layer sources. `Cut` stays available for the procedural camera-cut EDL within a scene-render. |
| Dopesheet (`src/timeline/TimelineCanvas.tsx`), `CurveEditor`, `timelineDockStore` | Becomes the **twirl-down property view** of a layer (not a separate tab). The ruler/playhead/zoom-pan ([[V50]]) is shared.                                                                            |
| `operatorStack.ts` ([[V58]], Mesh→Mesh)                                           | Generalized to **Image→Image** for the effect stack — same add/remove/reorder/mute = re-wire helpers.                                                                                                 |
| V57 keyframe channels (`nodeChannels.ts`)                                         | Layer property keyframes, comfy param channels, the new Text/Image channels. **Zero new keyframe machinery.**                                                                                         |
| 2D View / Render Result ([[V80]])                                                 | The compositor **viewer**.                                                                                                                                                                            |
| ComfyUI keyframe compiler ([[V81]], Inc 3/4)                                      | A **ComfyUI generator layer source**. Inc 3's keyframe-any-param work now has a home: it is what a Comfy layer's properties do.                                                                       |
| `renderToImage` passes ([[V82]]), `createMp4Sink`                                 | A scene layer renders via the existing pass core; the comp exports via the existing MP4 sink.                                                                                                         |

Nothing here is a second pipeline ([[V34]]) — the compositor is new _nodes + chrome_
over the existing substrate and the existing operator/channel/render machinery.

---

## 4. Data model

Three new node kinds + one new socket type. All pure-metadata evaluators (the
renderer/viewer does the pixel work, mirroring Scene→renderer).

### 4.1 `Composition` (the comp / sequence)

```ts
CompositionParams = { name, width, height, fps, durationFrames, background }
inputs:  { layers: { type: 'Layer', cardinality: 'list' } }   // order = composite z-order (top = front)
outputs: { out: { type: 'Composition' } }                      // a layer can consume a comp → nesting
evaluate → CompositionValue { layers: LayerValue[], width, height, fps, durationFrames }
```

Nesting = a `Layer` whose source is another `Composition`. That is the sequencing
mechanism — no separate NLE container.

### 4.2 `Layer`

```ts
LayerParams = {
  name, enabled, solo, locked,
  startFrame,            // position of the layer's in-point on the comp timeline
  inPoint, outPoint,     // trim of the source (source-local frames)
  blendMode,             // 'normal' | 'add' | 'multiply' | 'screen' | …
  opacity,               // keyframeable (V57 channel: paramPath 'opacity')
  transform,             // 2D anchor/position/scale/rotation — keyframeable
}
inputs:  { source: { type: 'Image', cardinality: 'single' } }  // time-varying Image (see §4.3)
outputs: { out: { type: 'Layer' } }
```

`opacity` / `transform` are driven by V57 channels targeting the Layer node — the
twirl-down dopesheet rows. The **effect stack** is spliced on the `source` Image
edge (§5), not stored on the Layer.

### 4.3 Layer sources — a uniform "Image at time t" contract

A layer's `source` input is the **Image** socket. Anything that produces a
time-varying `ImageValue` (its evaluate reads `ctx.time`) can be a source:

| Source kind       | Node                                                 | Produces                                                           |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| 3D scene          | a scene-render node wrapping `Shot` (camera + Scene) | the rendered beauty Image at frame t (existing pass core, [[V82]]) |
| Media clip        | `MediaClip` (NEW) — OPFS path + decode               | the decoded video/image frame at `(t − startFrame + inPoint)`      |
| ComfyUI generator | `ComfyWorkflow` ([[V81]])                            | the generated frame at t from keyframed params                     |
| Nested comp       | `Composition`                                        | its composite at t                                                 |

This is the [[V78]] discipline one level up: one socket type (`Image`), consumers
read a value that knows how it was produced; the type system does not grow a
per-source socket.

### 4.4 `MediaClip` (NEW) — the only genuinely new _source_

```ts
MediaClipParams = { name, src: <opfs-path>, mediaKind: 'video'|'image', srcFps, srcFrames, width, height }
inputs:  {}
outputs: { out: { type: 'Image' } }   // time-varying: evaluate reads ctx.time
evaluate → ImageValue { passKind:'beauty', descriptor, sourceHash: hash(src, frameAt(ctx.time)) }
```

Decode happens at the viewer/runtime seam (a `MediaDecodeCapability`), not in the
pure evaluator — same impurity discipline as render passes.

---

## 5. Effects = V58 operators on the Image socket (the big reuse)

A **video effect is a typed operator in a non-destructive stack** — exactly the
pattern shipped for geometry modifiers and constraints ([[V58]], epic #201/#209).
`operatorStack.ts` already implements add / remove / reorder / mute as pure
re-wiring of a linear `target→out` sub-chain. We generalize it from `Mesh→Mesh` to
**`Image→Image`**:

```
rawSource.out ─▶ ColorCorrect.target … ColorCorrect.out ─▶ Inpaint.target … Inpaint.out ─▶ Layer.source
```

- The helpers parameterize on socket type (`Mesh` → `Image`); the `MODIFIER_NODE_TYPES`
  registry gets an `EFFECT_NODE_TYPES` sibling. **No new stack engine.**
- Each effect is a plain `NodeDefinition` with `target: Image` / `out: Image` and
  keyframeable params (V57 channels → the effect's dopesheet rows).
- `muted` bypasses (passes the source through) — same as a muted modifier.

### 5.1 Two effect families

- **Local effects** (color correct, exposure, curves, blur, transform, crop): pure
  GPU/shader on the Image. Run live in the viewer, no ComfyUI.
- **AI effects** (inpaint, AI-extend, first/last-frame gen, AI edit, upscale, relight):
  their evaluate produces an Image whose `sourceHash` describes the op; the pixels
  are produced by **compiling the effect to a ComfyUI graph** ([[V81]]) and submitting.
  This is where "visible in both Basher and ComfyUI" is delivered — the effect is a
  node on the Basher side and compiles to nodes on the ComfyUI side.

### 5.2 Mapping the requested feature list

| Ask                                    | Where it lands                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| AI video extender                      | AI effect that lengthens the layer's out-point by generating frames conditioned on the tail |
| First-frame / last-frame video gen     | a ComfyUI generator source whose first/last frames are two `KeyframeChannelImage` keys      |
| AI video edit                          | AI effect (prompt-conditioned edit) on the layer                                            |
| Video inpainting                       | AI effect + a **mask** (a keyframeable layer property / a mask layer)                       |
| Color correction                       | local effect (LUT / curves shader)                                                          |
| Video effects (blur, glow, transform…) | local effects in the same stack                                                             |

Masks are a keyframeable layer property (AE-style) — a follow-on, not in the spine.

---

## 6. Compositing & playback (the viewer)

At playhead frame `t`, the viewer composites the Composition bottom→top:

1. For each enabled layer, evaluate its `source` Image at t (effect chain included),
   trimmed by `inPoint/outPoint`, positioned by `startFrame`.
2. Apply the layer's 2D transform + opacity + blend mode.
3. Composite onto the accumulator (a WebGL/2D canvas pass).

Render == viewport parity ([[V37]]): the offscreen comp render (export) walks the
same composite as the live viewer. Export → `createMp4Sink` over the composited
frames (reuse `renderAnimation`'s sink).

Open question (§10): the compositing engine — start with an ordered 2D-canvas /
drawImage composite (simple, director-grade) and escalate to a WebGL blend pass
only when blend modes / performance demand it.

---

## 7. Chrome — concrete surface

Evolve the existing `src/timeline/` drawer into the **Composition timeline**:

- **Layer outline column** (left): rows for each layer, twirl triangle → properties
  - effects; enable/solo/lock toggles; reorder by drag (= `buildMoveModifierOps`
    analogue on the `layers` list).
- **Track area** (right): each layer's bar (trim/move handles); twirled-open property
  rows show V57 keyframes on the SAME ruler/playhead/zoom as today ([[V50]]); the
  graph-editor toggle swaps to `CurveEditor`.
- **Controls panel** (right rail, in the VIDEO space — see §7.1): selected layer's
  full producer-pipeline input surface (the AE "Effect Controls" analogue, generalized).
- **Viewer**: the 2D View shows the comp composite ([[V80]]).

The current dopesheet/curve tabs become _views of a selected layer_, not top-level
peers — one timeline, not three.

### 7.1 The Controls panel — "all the inputs of the producer pipeline" (LOCKED)

A layer is produced by a **pipeline**: a `source` (polymorphic on the Image socket —
MediaClip / ComfyUIWorkflow / scene-render / nested comp) feeding through an `effect`
chain ([[V58]] Image→Image operators). The **Controls panel** exposes the _complete
input surface of that pipeline_ for the selected layer. It is the After Effects
**Effect Controls** panel, generalized one step: because a Basher `source` can itself
be a parameterized **generative process** (ComfyUI, a 3D render) — not the dumb footage
AE assumes — the source's inputs belong in the same panel as the effects' inputs.

**This is the domain-aligned home (not the NPanel inspector).** Decisive constraint:
in the VIDEO space the NPanel inspector is **covered** by the compositor (`z-index 45`,
`Layout.tsx`) and compositor layer selection is **local** (`LayerTimeline` `useState`),
not the global `selectionStore` NPanel reads. A dedicated VIDEO-space rail sidesteps
both — and gives "expose all params" real vertical room a 220px twirl-down can't.

Shape (mirrors AE; the reference system → pre-validated boundary):

- **Header** — the selected layer name.
- **One collapsible section per producer**, in pipeline order: the `SOURCE` section
  first, then each `EFFECT` section. The **section body is rendered by producer kind**
  (a registry of section renderers), so the panel is generic and producer-agnostic:
  - `source = ComfyUIWorkflow` → the graph manifest (`importComfyGraph`): **Schedulable**
    params as animatable rows; **Structural** params read-only with a "preview-only"
    note (design §7.4 — never silently dropped). ← the first source renderer (inc 3 D).
  - `source = MediaClip` → its clip props.
  - `source = scene-render` → render settings (later).
  - each effect (ColorCorrect today) → its param rows.
- **Every animatable row wires the ONE shared seam** — `useAnimatableField` +
  `ParamDiamond` ([[H104]] guard) — regardless of producer, so the keying affordance is
  written once. The channel TYPE is dispatched EXPLICITLY by the param's `valueKind`
  (float/int → `KeyframeChannelNumber`, string → `KeyframeChannelText`, image →
  `KeyframeChannelImage`); do NOT rely on `inferValueType` (it was deliberately not
  taught `text`). `paramPath` for a comfy param = `comfy:<nodeId>.<inputName>`.

**Two surfaces, one source of truth (the AE contract):** the Controls panel is the
_full_ input surface; the timeline twirl-down shows the _animated subset_ as rows with
keyframes for timing. Both read the SAME [[V57]] channels, so they cannot drift. An
animated comfy/effect param appears in BOTH (panel = author values/keys; timeline =
retime), exactly as AE shows an effect in Effect Controls AND the timeline.

**Why this is the right module boundary (diminishing-returns test):** the panel's span =
the layer's whole production pipeline; the next producer kind is "add one section
renderer," not "add a panel." Control-pass bindings (depth/normal → ControlNet) later
land as inputs in the SOURCE section — same boundary, no new surface.

---

## 8. Increment plan (spine-first, then one operator at a time)

Each increment: a fresh gate (tsc / eslint / vitest) + live observation + one atomic
commit. Do **not** boil the ocean — prove the unification on a thin vertical slice,
then every later feature is "add one typed operator / one source kind."

1. **Spine** — `Composition` + `Layer` + `MediaClip` nodes; import a video/image →
   OPFS → a MediaClip layer; a second layer whose source is a `Shot` (3D scene);
   the layer timeline chrome (bars + twirl-down) over the existing ruler; opacity +
   2D transform keyframeable (V57); viewer composites the two layers at the playhead;
   export → MP4. **Proves dopesheet + NLE + compositing are one surface.**
2. **First local effect** — generalize `operatorStack.ts` to the Image socket; ship
   **Color Correct** (curves/LUT shader) as the first `EFFECT_NODE_TYPES` member,
   with a keyframeable param. Proves the V58 lift.
3. **ComfyUI layer** — a `ComfyWorkflow` source as a layer; this is where the ComfyUI
   keyframe compiler **Inc 3** (keyframe-any-param: cfg / prompt / reference image)
   lands — now inside a layer with a home. `KeyframeChannelText` / `KeyframeChannelImage`.
4. **First AI effect** — one AI effect (e.g. inpaint or AI-extend) compiling to ComfyUI
   ([[V81]] compiled path, Inc 4), proving "visible on both sides" + the batched render.
   5+. Each further effect (color tools, blur, first/last-frame gen, edit, masks, blend
   modes, nesting/pre-comps) = add one operator / one source kind against the proven spine.

---

## 9. Anvi catalogue impact (to add as increments land)

- **New vyapti** (proposed): _"The video editing surface is ONE layer timeline; a
  Composition is a DAG node holding Layer nodes; a layer's source is any time-varying
  Image producer (scene-render / media / ComfyUI / nested comp); a video effect is a
  typed Image→Image operator in the V58 stack; the node-graph view is a deferred
  projection of the same DAG."_ — derives from [[V34]] + [[V57]] + [[V58]] + [[V78]] + [[V80]] + [[V81]].
- **dharana**: a new boundary _Composition ↔ compositing engine_ (silent-failure modes:
  layer order vs z-order drift; trim/startFrame off-by-one at frame mapping; blend-mode
  parity viewer-vs-export; effect-chain mute not bypassing).
- **krama**: the composite lifecycle (evaluate source → effect chain → trim/position →
  transform/opacity/blend → accumulate, bottom→top).

---

## 10. Risks & open questions

- **Compositing engine choice** — 2D-canvas composite first vs WebGL blend pass.
  Start simple; escalate on observed need (blend modes / perf).
- **Frame-rate mapping** — comp fps vs source fps vs ComfyUI batch fps; one baker /
  one frame-map function, snapshot-tested (mirror the V81 "one baker" discipline).
- **Media decode** — `WebCodecs VideoDecoder` for video sources; a decode capability
  with a stub for tests/headless.
- **Effect-stack on Image socket** — confirm `operatorStack.ts` generalizes cleanly
  (the helpers are socket-name parameterized already: `TARGET`/`OUT` constants).
- **Render-output persistence** — render/ComfyUI output must persist to OPFS as a
  referenceable artifact to become a MediaClip (today render-animation only downloads).
- **Performance** — many layers × per-frame source eval; rely on sourceHash caching
  ([[V43]]) and the v0.7 renderer plan ([[v07_renderer_cpu-wall_webgpu]]).
- **Scope discipline** — the feature list is large; the spine + one-operator-at-a-time
  cadence is the guard against boiling the ocean.

---

## 11. Glossary

- **Composition (comp)** — a DAG node holding ordered Layers; the sequence/canvas.
- **Layer** — one element in a comp: a source + trim/position + transform/opacity/blend
  - an effect stack.
- **Layer source** — anything producing a time-varying Image: a 3D scene (`Shot`), a
  `MediaClip`, a `ComfyWorkflow`, or a nested `Composition`.
- **Effect** — a typed Image→Image operator in the layer's non-destructive V58 stack;
  local (shader) or AI (compiles to ComfyUI).
