# Design — Keyframe-Driven ComfyUI (Timeline → Schedule Compiler)

> **Status:** DRAFT / design milestone. Not yet scheduled. Author: session 2026-06-24.
> **Branch base:** `ux-overhall` tip `75e04ee`.
> **Supersedes nothing** — extends the v0.5 ComfyUI bridge (P5) and the v0.7 keyframe
> unification ([[V57]]). Cross-refs: `BLENDER-DATA-MODEL-PARITY-231-DESIGN.md` (the
> sibling design-doc format), `UNIFICATION-DESIGN.md` (the direct-channel road).

---

## 0. TL;DR

Basher becomes the **timeline/NLA authoring layer on top of ComfyUI**. You import any
ComfyUI workflow, expose its parameters as keyframeable Basher params (reusing the
existing V57 channel system), and on render Basher **compiles** the keyframes into a
_native_ ComfyUI artifact:

- **Preview path** — per-frame value substitution, N independent `/prompt` runs. Fast,
  works with any param, but ComfyUI-invisible and **not temporally coherent**.
- **Compiled path** — the keyframes are baked into **one batched workflow** with
  in-graph schedule nodes (via a small custom **bridge node**), so ComfyUI executes the
  whole animated sequence as a single coherent batch, and the animation is a real,
  portable, openable ComfyUI workflow.

**Licensing:** no fork of ComfyUI core (which is GPL-3.0). The only GPL-world artifact
is one small **custom node** shipped as a ComfyUI extension; Basher talks to ComfyUI at
arm's length over the HTTP API and **stays proprietary**.

The novel, defensible IP is the **timeline → schedule compiler** — nobody has built a
timeline-first driver for ComfyUI.

---

## 1. Vision & the wedge

ComfyUI front-ends are **graph-first**: you wire nodes, you press Run, you get an image
or a batch. There is no good **timeline-first** experience — author motion on a
timeline, scrub, keyframe arbitrary params, see them as NLA strips, render a coherent
clip. That gap is the wedge.

Basher already _is_ a timeline-first 3D tool with a mature keyframe system ([[V57]]: free
floating channels, dopesheet + curve editor, NLA-style timeline). Pointing that system
at ComfyUI workflow params — and compiling the result down to native ComfyUI schedules —
turns Basher into "After Effects / Blender NLA for diffusion."

The 3D scene is the **control rig**; the timeline drives both the 3D control passes
(depth/normal/etc.) _and_ the diffusion params; ComfyUI is the stateless render engine.

---

## 2. The core problem and the resolution

### 2.1 The per-frame fiction (what we must NOT ship as the only path)

The naive approach — "evaluate every param at frame _t_, inject a fresh workflow JSON,
submit" — produces **N independent executions**. ComfyUI sees N unrelated graphs, not an
animation. Two hard consequences:

1. **No temporal coherence.** Independent runs share no latent/context state. A video
   model can't carry information frame→frame → flicker. (Prev-frame img2img feedback —
   the current `prev_frame_image` mechanism in `stylizedRealism.ts` — is a weak patch,
   not coherence.)
2. **The animation is not an artifact.** It lives only as a Basher-side stream of
   graphs; you can't open "the animated workflow" in ComfyUI, share it, or run it
   standalone.

Per-frame injection is therefore a **Basher-only fiction**. It is still valuable — as
the _authoring/preview_ path and for genuinely independent per-frame work (still-image
param sweeps, per-frame control-pass img2img) — but it is **not** how coherent video or a
native animated workflow is produced.

### 2.2 The resolution: compile keyframes INTO one workflow

Flip the target. Instead of substituting values per frame, **compile** the Basher
keyframe channels into a **single batched workflow** whose animation is expressed as
**in-graph schedule nodes**. ComfyUI runs the whole sequence as one batch → coherent, and
the output is a real ComfyUI workflow you can open / inspect / share.

```
Basher timeline (source of truth)
        │  keyframe channels bound to workflow params (V57)
        ▼
  ┌───────────── COMPILER ─────────────┐
  │  bake each channel → per-frame array │
  │  insert bridge/schedule nodes        │
  │  rewire target param ← schedule out  │
  └──────────────────────────────────────┘
        │
        ▼
  ONE batched ComfyUI workflow  ──/prompt──▶  ComfyUI (coherent batch)
        ▲
        └── (preview mode falls back to N per-frame graphs)
```

**Both paths share the same source of truth** (the Basher channels). The _compile
target_ differs: preview = N graphs; render = 1 batched scheduled graph.

---

## 3. Licensing posture (the boundary that keeps Basher proprietary)

ComfyUI core (`comfyanonymous/ComfyUI`) and the official frontend
(`Comfy-Org/ComfyUI_frontend`) are both **GPL-3.0** (verified 2026-06-24). Strong
copyleft: any _derivative/combined work_ must also be GPL-3.0.

```
┌────────────────────────────┐         HTTP /prompt, /upload, /history, /view
│  Basher  (proprietary)     │ ───────────────────────────────────────────────┐
│  - timeline / NLA          │   arm's-length API boundary (NOT derivative)     │
│  - keyframe→schedule        │                                                  ▼
│    compiler                 │                                   ┌──────────────────────────┐
│  - ComfyUICapability client │                                   │ ComfyUI server (GPL-3.0) │
└────────────────────────────┘                                   │  + custom_nodes/         │
                                                                  │     BasherSchedule/*     │  ← the ONLY
                                                                  │     (GPL/MIT extension)  │     GPL-world
                                                                  └──────────────────────────┘     artifact we ship
```

**Rules this design holds to:**

- Basher **never** vendors, embeds, forks, or links ComfyUI code. It is an HTTP client.
  → Basher is not a derivative work; its license stays ours. (FSF "separate programs /
  aggregate" interpretation.)
- The **bridge node** is a separate **custom node** (a ComfyUI _extension_ in
  `custom_nodes/`), distributed on its own, under its own license (GPL-compatible). The
  GPL boundary sits there, not in Basher.
- **SaaS note:** GPL-3.0 is _not_ AGPL — no network-use clause. Running ComfyUI
  server-side for web users does not "convey" it → no copyleft trigger on Basher. A
  _downloadable_ Basher that **bundles** ComfyUI would convey it → trigger. Keep ComfyUI
  out of any Basher distributable.
- **Model licenses are a separate, often stricter gate** (OpenRAIL-M, research/non-
  commercial video models). Out of scope for this doc, but tracked in §17.

---

## 4. Current state (ground truth)

What exists today is a **v0.5 skeleton** — real seams, stub pixels. Cited so increments
target reality.

| Area                | File                                                               | Reality                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capability iface    | `src/core/comfy/ComfyUICapability.ts`                              | `submit(workflowJson: unknown, inputs:{images,scalars}) → {jobId, frame: Uint8Array}` — **single-frame return** (the hard boundary for video).                                                                                             |
| HTTP client         | `src/core/comfy/HttpComfyUICapability.ts`                          | Real flow: `/upload/image` → `/prompt {prompt, client_id}` → poll `/history/{id}` @250ms → `/view`. 30s timeout. `cancel` = best-effort `/interrupt`.                                                                                      |
| Stub                | `src/core/comfy/StubComfyUICapability.ts`                          | Deterministic 1×1 PNG keyed by content hash. The test seam.                                                                                                                                                                                |
| URL config          | `src/core/comfy/index.ts` + `boot.ts:118`                          | `DEFAULT_COMFYUI_URL='http://127.0.0.1:8188'`. `pickComfyUI()` called **with no arg** — the documented `settings.get('comfyui.serverUrl')` is **not wired**. No auth.                                                                      |
| Preset              | `src/agent/strategy/presets/stylizedRealism.ts`                    | One hand-written 14-node SDXL+depth/normal-ControlNet **template, never validated against a server**. `prev_frame_image` VAEEncode → KSampler denoise 0.55 = per-frame img2img. **No AnimateDiff/video/temporal.**                         |
| Registry/dispatch   | same + `CostPreviewConnector.tsx:28`, `renderDryRunWorkflow.ts:75` | `PRESET_REGISTRY` has **one** entry; dispatch **hardcoded** to `stylizedRealism` (ignores `presetId`).                                                                                                                                     |
| Per-frame loop      | `src/render/runComfyUIWorkflow.ts`                                 | Loops `frameStart..frameEnd`, feeds prev stylized frame, `lastGoodFrame` resume, writes PNGs to OPFS. No AbortSignal.                                                                                                                      |
| Control passes      | `src/render/runRenderJob.ts` + `stubEncoder.ts`                    | **FAKE.** Only `stubEncoder` (1×1 hash PNG). `runRenderJob` **never called in production**. `renderToImage.ts` does beauty-only, **no depth/normal material override**.                                                                    |
| Node                | `src/nodes/ComfyUIWorkflow.ts`                                     | params `{presetId(enum), frameStart, frameEnd, lastGoodFrame, outputPath, width, height}`; inputs `{prompt, pass-input[], time}`; out `Image` passKind `'stylized'`. Skeleton — no I/O in evaluate.                                        |
| Video stitch        | `src/render/runVideoStitch.ts`                                     | Stub (`probeWebCodecsEncoder()` returns null). **Never called in production.**                                                                                                                                                             |
| Real muxer (non-AI) | `src/render/renderAnimation.ts`                                    | **Real** WebCodecs H.264 + `mp4-muxer` (`createMp4Sink`), but stitches the **live viewport**, not stylized frames. Reusable.                                                                                                               |
| Keyframe system     | `src/app/nodeChannels.ts`, `src/nodes/keyframeInterp.ts`           | [[V57]] free-floating `KeyframeChannelNumber`/`Color` nodes: `params.{target, paramPath, keyframes}`; `directChannelNodesForTarget(nodes, targetId)`; `sampleScalarKeyframes(keys,t)`. **This is the system we point at workflow params.** |

**The single biggest blocker: real control passes do not render.** Everything
downstream is meaningless until depth/normal/beauty are real pixels.

---

## 5. Architecture overview

Five layers, bottom-up. Each is an increment boundary (§14).

```
 L5  Timeline / NLA          author keyframes on workflow params; strips; round-trip import
 L4  Compiler                channels → {preview graphs | one batched scheduled graph}
 L3  ComfyGraph model        imported workflow JSON + param-binding table (Basher DAG node)
 L2  Connection / capability  URL config, auth, batched submit contract, validate
 L1  Control passes           real depth/normal/beauty from the 3D scene (the foundation)
```

Two **execution regimes** cross-cut L4:

|                  | Preview                               | Compiled (render)                           |
| ---------------- | ------------------------------------- | ------------------------------------------- |
| ComfyUI sees     | N independent graphs                  | ONE batched graph                           |
| Coherence        | none                                  | yes (single batch)                          |
| Param generality | any param                             | params with a schedule target / bridge node |
| Use              | scrub, fast iterate, per-frame passes | final coherent clip; portable artifact      |
| Output           | frame-at-a-time                       | the whole batch                             |

---

## 6. Data model

### 6.1 Workflow ingestion — `ComfyGraph`

ComfyUI's **API format** (the `/prompt` body) is a flat object keyed by node id:

```jsonc
{
  "3":  { "class_type": "KSampler",        "inputs": { "seed": 0, "cfg": 6.5, "denoise": 0.55,
                                                       "model": ["4",0], "positive": ["6",0], ... } },
  "6":  { "class_type": "CLIPTextEncode",  "inputs": { "text": "a cat", "clip": ["4",1] } },
  "10": { "class_type": "ControlNetApply", "inputs": { "strength": 0.7, ... } }
}
```

Inputs are **either a literal** (number/string/bool) **or a link** `[nodeId, outputIdx]`.

Basher imports this verbatim into a `ComfyGraph` value (opaque to the DAG —
`ComfyWorkflowJson` is already `unknown` in `ComfyUICapability.ts:25`), plus a derived
**param manifest** — every _literal_ input is a candidate animatable param:

```ts
interface ComfyParam {
  nodeId: string; // "3"
  inputName: string; // "cfg"
  classType: string; // "KSampler" (for UI grouping + compile dispatch)
  valueKind: 'float' | 'int' | 'string' | 'bool' | 'image' | 'enum';
  literal: number | string | boolean; // the authored value (the "rest" pose)
  // metadata for the compiler (see §7): can this param be scheduled in-graph?
  scheduleHint?: ScheduleHint;
}
interface ComfyGraph {
  apiJson: Record<string, ComfyNodeJson>; // verbatim, the compile substrate
  params: ComfyParam[]; // the animatable manifest
  meta: { name: string; importedAt: string; fps: number; frames: number };
}
```

`valueKind` is inferred from the literal's JS type, refined by `classType`+`inputName`
against a small **node-schema table** (e.g. `KSampler.seed` = int, `LoadImage.image` =
image, `CLIPTextEncode.text` = string/prompt). Unknown nodes still expose their literals
as best-effort floats/strings.

> **Param addressing:** the canonical key is **`<nodeId>.<inputName>`** (e.g. `"3.cfg"`).
> Stable across re-imports as long as node ids are stable (they are, in the API format).

### 6.2 The `ComfyWorkflow` DAG node (evolution of `ComfyUIWorkflow`)

Today's `ComfyUIWorkflow` is preset-bound (`presetId` enum). We generalize it to carry an
imported graph:

```ts
ComfyWorkflowParams = {
  graph: ComfyGraph;          // imported workflow + manifest (replaces presetId-only model)
  frameStart, frameEnd, fps;  // the batch range (fps no longer hardcoded — runComfyUIWorkflow.ts:194 TODO)
  outputPath: string;
  width, height;
  lastGoodFrame;              // resume (preview path only)
  // bound params are NOT stored here — they are V57 channels targeting this node (§6.4)
}
```

The node's `evaluate` stays pure (V8 / V2): it returns an `ImageValue` (or a new
`VideoValue`, §8) whose `sourceHash` mixes the graph hash + every bound channel's hash +
the time/range — so a changed keyframe invalidates the cached render. (Mirrors the
existing `ComfyUIWorkflow.evaluate` hash discipline, `ComfyUIWorkflow.ts:112`.)

Backward-compat: the existing presets become _imported graphs_ (`stylizedRealism` ships
as a built-in `ComfyGraph`), so the preset registry collapses into "starter graphs."

### 6.3 Binding a workflow param to a keyframe channel (reuse V57, zero new machinery)

A workflow param is animated by the **exact same** free-floating channel a 3D transform
uses ([[V57]]):

```ts
// A KeyframeChannelNumber node, free-floating, targeting the ComfyWorkflow node:
{
  type: 'KeyframeChannelNumber',
  params: {
    target: '<comfyWorkflowNodeId>',
    paramPath: 'comfy:3.cfg',      // ← the workflow-param address, namespaced
    keyframes: [ {frame:0, value:6.5, ...}, {frame:24, value:9.0, ...} ],
  }
}
```

`directChannelNodesForTarget(nodes, comfyWorkflowNodeId)` (`nodeChannels.ts:40`) already
enumerates these. The **only new thing** is teaching the inspector + dopesheet to:
(a) list a ComfyWorkflow node's `graph.params` as animatable rows (an `inspectorSection`),
and (b) route the diamond/autoKey for those rows — note [[H104]]: a custom inspector
control must explicitly wire the shared keyframe diamond, or its params are silently
non-animatable. The `useAnimatableField` spine ([[#213]]) is the reuse target.

`paramPath` namespacing: `comfy:<nodeId>.<inputName>` distinguishes workflow params from
the existing transform/material paramPaths so resolvers don't collide.

### 6.4 What gets keyframed — the value kinds

| valueKind     | Channel                                        | Example                                                                           |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| float/int     | `KeyframeChannelNumber`                        | `cfg`, `denoise`, ControlNet `strength`, IPAdapter `weight`, `seed` (step interp) |
| color         | `KeyframeChannelColor`                         | a color input on a node                                                           |
| string/prompt | **new** `KeyframeChannelText` (discrete/step)  | `CLIPTextEncode.text` — prompt travel                                             |
| image         | **new** `KeyframeChannelImage` (discrete/step) | `LoadImage.image` — **the reference-image case**                                  |
| bool/enum     | `KeyframeChannelNumber` quantized, or discrete | toggles, sampler choice                                                           |

Text/image channels are **step-interpolated** (discrete): "this prompt/image from frame X
until the next key." This is the natural model for the reference-image trigger.

---

## 7. The keyframe → schedule compiler (the core IP)

Input: a `ComfyGraph` + the set of bound channels + `{frameStart, frameEnd, fps}`.
Output: either N preview graphs or ONE batched scheduled graph.

### 7.1 Bake

For each bound channel, **bake** its curve to a per-frame array over the range, using the
SAME sampler the timeline/render uses (`sampleScalarKeyframes` / the channel's own
`evaluate().sample(seconds)`, `nodeChannels.ts:79`) so preview == compiled == dopesheet
(the H40 boundary-pair discipline):

```ts
interface BakedTrack {
  param: ComfyParam; // 3.cfg
  values: (number | string | ImageRef)[]; // length = frameEnd-frameStart+1, one per batch index
}
```

### 7.2 Preview path (per-frame)

For `frame f`: deep-clone `graph.apiJson`, set each `BakedTrack.values[f]` into
`apiJson[nodeId].inputs[inputName]` (uploading images first via `/upload/image`), submit.
This is the generalization of today's `stylizedRealism.compile()` substitution
(`stylizedRealism.ts:305`) from {prompt,passes} to **arbitrary params**. ComfyUI's node
cache means unchanged upstream nodes don't re-run across frames.

### 7.3 Compiled path (batched, coherent) — the bridge node

A batched video workflow (AnimateDiff / video model) processes a **latent batch** of N
frames in one execution. To vary a param across that batch, the value must be a **batch /
list** consumed by a batch-aware node. We supply that with **one custom bridge node**:

```
custom_nodes/BasherSchedule/   (ComfyUI extension, GPL/MIT, shipped separately)
  BasherValueSchedule   — INPUT: values_json (string: "[6.5, 6.7, ... ]")
                          OUTPUT: FLOAT batch (list length N)   → feeds batch-aware floats
  BasherPromptSchedule  — INPUT: schedule_json (per-frame text) + clip
                          OUTPUT: CONDITIONING batch (prompt-travel; encodes per segment)
  BasherImageSchedule   — INPUT: images (batch) + index_json (per-frame index)
                          OUTPUT: IMAGE batch / IPAdapter weights  → reference-image keys
```

The node reads the **baked array we computed in Basher** (`§7.1`) — Basher is the
keyframe engine; the node is a dumb player. This mirrors how FizzNodes' `BatchValueSchedule`
works, except the schedule is **baked by Basher's curve editor** instead of a text DSL.

**Compile step (per bound param):**

1. Find the link currently feeding `apiJson[nodeId].inputs[inputName]` (or the literal).
2. Insert a `BasherValueSchedule` (or Prompt/Image variant) node carrying the baked array.
3. Rewire `inputs[inputName] = [<scheduleNodeId>, 0]` so the param now reads the batch.
4. Ensure the batch size (latent count) matches N (set on the empty-latent / context node).

Result: one workflow, batch size N, every animated param driven by a schedule node →
**coherent + native + portable**.

### 7.4 Compile-target selection (the honest edge)

Not every param can be scheduled in-graph. The compiler classifies each bound param via
`ComfyParam.scheduleHint`:

- **SCHEDULABLE** — a batch-aware path exists (most floats into KSampler-adjacent nodes,
  ControlNet/IPAdapter strengths, prompt text, reference images). → compiled path.
- **STRUCTURAL** — changing it changes graph topology / can't be a batch (e.g. swapping a
  checkpoint, changing sampler _type_, image _resolution_). → **not** keyframeable in the
  compiled path; only the preview path (separate runs) supports it, with a UI warning.
- **UNKNOWN** — best-effort SCHEDULABLE float; flagged for the user to verify.

The classification table is seeded from the known node schemas and **grows by
observation** (the first time a param doesn't compile, add its hint). **Log every param
demoted to preview-only — silent truncation reads as "it all animates" when it doesn't.**

---

## 8. Execution contract changes (single-frame → batched)

The current `ComfySubmitResult = { jobId, frame: Uint8Array }` (`ComfyUICapability.ts:44`)
is **single-frame** — the hard architectural boundary for video. The compiled path
returns a _batch_. Add a batched method (don't break the per-frame one — preview still
uses it):

```ts
interface ComfyUICapability {
  // ... existing single-frame submit (preview path) ...
  submitBatch(workflowJson, inputs): Promise<ComfyBatchResult>;
}
interface ComfyBatchResult {
  jobId: string;
  frames: Uint8Array[]; // N decoded frames from the batch's SaveImage/VHS node
  // or a muxed video blob if the workflow ends in a video-combine node
  video?: Uint8Array;
}
```

`HttpComfyUICapability.submitBatch` extends the existing flow: the `/history/{id}`
outputs of a batched workflow contain **N images** (or a video file from a
VideoCombine-style node) — collect all, not just `first node → first image`
(`HttpComfyUICapability.ts:120`). Progress comes from ComfyUI's `/ws` (websocket)
`executing`/`progress` events — a new, optional capability method `onProgress(cb)`
(today there is only 250ms history polling).

`StubComfyUICapability.submitBatch` returns N deterministic frames keyed by
`(graphHash, batchIndex)` — the batched test seam.

---

## 9. Increment 1 — Real control passes (the foundation)

Nothing above matters until depth/normal/beauty are real. This is pure WebGL, locally
verifiable, no ComfyUI needed — and it's the increment that fits our tight observe-loop.

- Implement a real `PassEncoder` (the seam `runRenderJob.ts:40` already defines) that
  wraps the production renderer:
  - **beauty** → existing `renderSceneToImageCanvas` (`renderToImage.ts:201`).
  - **depth** → re-render with a `THREE.MeshDepthMaterial` scene override (or read the
    depth buffer) at the production camera; pack to grayscale/16-bit per ControlNet
    depth convention.
  - **normal** → `THREE.MeshNormalMaterial` override; pack `(n+1)/2` to RGB (the
    `NormalPass.ts:45` convention that's currently unimplemented).
- Wire `runRenderJob` into a production path (it's defined but never called) so a
  RenderJob actually writes `beauty_NNNN.png` / `depth_NNNN.png` / `normal_NNNN.png`.
- **Preview them in the Render Result view** (we just built it) — switch its source to a
  pass, scrub, eyeball that depth/normal look right. Observation, not inference.

Verification: render depth/normal of the default box → the PNG is a real depth ramp /
normal field, not a flat hash color. Falsifiable: revert to `stubEncoder` → the assertion
(non-uniform, depth gradient front-to-back) fails.

---

## 10. Increment 2 — Connection layer

- Wire `pickComfyUI(settingsUrl)` from a real setting/env (`boot.ts:118` currently passes
  nothing). Add `comfyui.serverUrl` + optional auth header to a settings store (none
  exists today — introduce a minimal one; this also retro-fixes the documented-but-unwired
  gap).
- `isAvailable()` already probes `/system_stats` (good).
- **Validate a real workflow**: import a known-good ComfyUI workflow JSON, submit against
  a _running_ ComfyUI, confirm a real image returns. This is where the hand-written
  `stylizedRealism` template gets replaced by validated graphs.

---

## 11. Increment 3 — Keyframe-any-param (preview path) — _the thing the user asked for_

- `ComfyGraph` ingestion + param manifest (§6.1) — import a workflow JSON, list params.
- `ComfyWorkflow` node carrying the graph (§6.2).
- Inspector section listing `graph.params` as animatable rows; diamond/autoKey wired via
  `useAnimatableField` ([[H104]] guard). New `KeyframeChannelText` / `KeyframeChannelImage`
  for prompt/reference params.
- Preview compiler (§7.2): bake channels → per-frame substitution → per-frame submit
  (extend `runComfyUIWorkflow.ts`).
- Dopesheet/NLA shows the bound channels (free — they're V57 channels on the node).

**Milestone:** keyframe `cfg` / a prompt / a reference image on any imported workflow,
scrub the timeline, watch the preview frames change. Prove the keyframe-first UX against
the **stub** capability first (deterministic), then a real server.

---

## 12. Increment 4 — Compiled path (coherent video)

- The `BasherSchedule` custom node pack (§7.3) — shipped as a ComfyUI extension repo.
- `submitBatch` contract (§8) + batched output collection + websocket progress.
- The schedule compiler (§7.3) + compile-target classification (§7.4).
- Render → MP4: reuse `renderAnimation.ts`'s `createMp4Sink` (`:203`) on the returned
  batch frames (replace the stub `runVideoStitch`).

**Milestone:** keyframe a reference image's IPAdapter weight, render → **one** batched
AnimateDiff workflow, get a coherent clip, and the compiled workflow opens in ComfyUI
with the schedule nodes visible.

---

## 13. The reference-image example, traced end-to-end

User intent: "inject reference image B at frame 24 in an img2img video workflow."

1. **Author (L5):** import an AnimateDiff+IPAdapter workflow. In the inspector, the
   IPAdapter `image`/`weight` params show as rows. Add a `KeyframeChannelImage` on
   `comfy:IPAdapterNode.image` with a step key {0: refA, 24: refB}; optionally a
   `KeyframeChannelNumber` on `...weight` ramping 0→1 around frame 24.
2. **Bake (L4/§7.1):** Basher samples → `images = [A,A,…(×24),B,B,…]`, `weights=[…]`.
3. **Compile (L4/§7.3):** insert `BasherImageSchedule` (carrying the per-frame index) +
   `BasherValueSchedule` (weights); rewire the IPAdapter inputs to read the batches;
   set latent batch size = N.
4. **Execute (L2/§8):** `submitBatch` → ONE `/prompt` → ComfyUI runs the batch
   coherently; the reference smoothly takes over around frame 24 — _with_ temporal
   continuity, because it's one batched diffusion, not 48 independent runs.
5. **Stitch (L4/§12):** batch frames → `createMp4Sink` → MP4 in the Render Result view.
6. **Artifact:** the compiled workflow is openable in ComfyUI — the schedule nodes are
   right there. "Visible on the ComfyUI side," exactly as required.

Contrast with preview: step 3–4 become "48 graphs, swap `LoadImage` per frame" — fine for
scrubbing, incoherent for the final.

---

## 14. Phasing summary

| Inc   | Scope                                                | Verifiable without ComfyUI?           | Gates                                                       |
| ----- | ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| **1** | Real control passes (depth/normal/beauty)            | ✅ pure WebGL + Render Result preview | observe real depth/normal PNGs                              |
| **2** | Connection layer (URL/auth/validate)                 | ❌ needs a running ComfyUI            | real image returns                                          |
| **3** | Keyframe-any-param **preview** path                  | ✅ vs stub, then real                 | scrub → frames change; channels in dopesheet                |
| **4** | Compiled batched path + bridge node + MP4            | ❌ needs ComfyUI + models + GPU       | coherent clip; workflow opens in ComfyUI                    |
| 5     | NLA strips + round-trip import of existing schedules | partial                               | strips reflect channels; import parses known schedule nodes |

Increments 1 and 3 keep our fast observe-loop. 2 and 4 are where verification changes
shape (§15).

---

## 15. Verification strategy (the observe-loop under heavy models)

- **Inc 1 & 3** stay in the tight loop: WebGL passes and stub-capability keyframing are
  deterministic and local. Falsifiable e2e as usual.
- **Inc 2 & 4** need a real ComfyUI + multi-GB models + a GPU, and runs are slow. So:
  - Keep the **stub capability** as the CI gate (deterministic batched frames); it proves
    the _compiler + contract_, not the model output.
  - Add a **manual/observed validation checklist** run against a real server (not CI):
    image returns, batch coherence eyeballed, compiled workflow opens in ComfyUI.
  - **Snapshot the compiled workflow JSON** in tests — assert the compiler inserts the
    right schedule nodes + rewires links (this is the IP, and it's deterministic even
    without a model). This is the highest-value test surface for Inc 4.

---

## 16. Risks & open questions

- **Q-A (coherence ceiling):** how coherent is "one batch" really, for the workflows we
  target? AnimateDiff context windows cap clip length; long clips need context
  stitching. → prototype against ONE real AnimateDiff+IPAdapter workflow in Inc 4 early.
- **Q-B (param schedulability):** the SCHEDULABLE/STRUCTURAL line (§7.4) is empirical.
  First compile of a real workflow will reveal params that don't fit. → grow the hint
  table by observation; never silently drop.
- **Q-C (node-id stability on re-import):** if a user edits the workflow in ComfyUI and
  re-imports, node ids may shift → bound channels orphan. → bind by a stable key
  (node id + class_type + input), warn + offer rebind on mismatch (the [[V44]]
  correspondence-by-stable-id discipline; [[H114]] orphan-rebind precedent).
- **Q-D (batch size vs memory):** N-frame batches blow VRAM for large N. → chunked
  batches with overlap; the compiler must support sub-batching transparently.
- **Q-E (custom-node distribution):** the bridge node must be installed in the user's
  ComfyUI. → ship via ComfyUI Registry / Manager; Basher detects its presence
  (`/object_info`) and falls back to preview if absent.
- **Q-F (progress/cancel):** batched runs are long; need websocket progress + real
  cancel (today `cancel` is a server-wide `/interrupt`, `HttpComfyUICapability.ts:132`).

---

## 17. Licensing checklist (do before commercial ship — get counsel)

- [ ] Basher ships **no** ComfyUI code (no vendor/fork/bundle in any distributable).
- [ ] Bridge node lives in a **separate repo**, GPL-compatible license, shipped as a
      ComfyUI extension.
- [ ] If desktop Basher ever bundles ComfyUI → that triggers GPL conveyance; prefer SaaS
      (server-side ComfyUI) for tight coupling.
- [ ] **Per-model license audit** — every checkpoint/ControlNet/motion-module/video model
      a shipped preset depends on (OpenRAIL-M restrictions; research/non-commercial video
      models). This is likely the real commercial gate, independent of ComfyUI.
- [ ] Per-custom-node license audit for any third-party node a shipped graph requires.

---

## 18. Anvi catalogue impact (to add as increments land)

- **vyapti:** new entry — "ComfyUI animation is authored as V57 channels on the
  ComfyWorkflow node and COMPILED to a target (preview N-graphs | one batched scheduled
  graph); the timeline is the single source of truth; preview==compiled==dopesheet via
  the ONE baker (`sampleScalarKeyframes`)." Sibling of [[V57]] (the channel road),
  [[V44]] (correspondence by stable id — Q-C), [[V80]] (the Render Result view that
  previews passes + frames).
- **dharana:** new boundary — **Basher ↔ ComfyUI (arm's-length API)**. Silent-failure
  modes: stub passes submitted as real control (Inc 1 blocker); per-frame fiction shipped
  as "video" (no coherence); bound channels orphaned on re-import (Q-C); a STRUCTURAL
  param silently dropped from the compiled path (§7.4). Observation targets: both sides of
  the boundary — what Basher _sent_ (the compiled JSON snapshot) vs what ComfyUI _ran_
  (the `/history` record). Ground Truth doc candidate: download ComfyUI source, trace
  `/prompt` execution + batch handling.
- **krama:** the compile lifecycle (ingest → bind → bake → classify → insert-schedule →
  rewire → submit → collect → stitch) — atomic ordering, the rewire-before-submit
  invariant.

---

## 19. Glossary

- **Preview path** — per-frame value substitution, N independent `/prompt` runs.
- **Compiled path** — keyframes baked into ONE batched workflow with schedule nodes.
- **Bridge node** — the `BasherSchedule` custom ComfyUI node that plays a baked array as a
  batch (the GPL-world artifact).
- **Schedulable / Structural** — whether a param can (compiled) or cannot (preview-only)
  be animated in a single batch.
- **Bake** — sample a Basher keyframe curve to a per-frame array via the shared sampler.
- **Control passes** — depth/normal/beauty rendered from the 3D scene as ControlNet/img2img
  conditioning.

```

```
