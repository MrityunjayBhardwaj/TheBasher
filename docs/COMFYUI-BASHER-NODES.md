# ComfyUI ↔ Basher — the two-node contract

**Status:** AUTHORITATIVE (2026-06-28). **Supersedes** `COMFYUI-KEYFRAME-COMPILER-DESIGN.md`
(the keyframe-any-param *compiler*), which reached across the boundary into ComfyUI's
concern. That approach is **deprecated, staged for removal** once this path is observed
working — build the new path, prove it, then cut the old (never delete shipped+tested
code before its replacement is proven).

---

## The boundary, in one sentence

Basher hands media + values **in**, takes media **out**, and shows **one progress bar**.
Everything between is ComfyUI's concern. Basher **never parses the foreign graph** — it
only enumerates its own `basher_*` nodes and reads metadata from *those* nodes alone.

## Why the compiler was the wrong boundary

The retired design had Basher walk every input of an imported workflow, infer each
param's `valueKind`, classify it SCHEDULABLE vs STRUCTURAL, inject `BasherValueSchedule`
nodes, and rewire links. That is Basher modelling ComfyUI's *internals* — the wrong side
of the boundary. The control surface should be **declared by the workflow author** (by
wiring a node), not **inferred by Basher** (by guessing at foreign params).

## The contract — TWO nodes + a progress bar

| Node | Direction | `kind` spans | Basher gives it |
|---|---|---|---|
| `basher_controller` | input (`*` output, wired anywhere) | float, int, string, bool, **image, video** (png-seq or mp4) | a row: scalar → keyframe channel; media → project-asset bind |
| `basher_export` | output (sink) | image, video | collect the result → a project MediaClip |

The author opts a setting in by dropping a `basher_controller` and wiring its `*` output
into the target input. One controller ↔ one Basher channel; fan-out (one controller into
several inputs) is allowed. Media inputs are the **same node** with `kind=image|video` —
the input concept is unified (see "Why one input node").

**Inputs and outputs stay separate nodes.** Folding all *inputs* into one node is right —
they share the span "a Basher-driven input, declared by wiring." An export is the opposite
flow (a sink Basher reads *from*); collapsing in+out into one node would conflate two
directions, which is a real domain boundary, not incidental. Two nodes, one per direction,
is the floor.

## Why one input node (and not image/video/scalar separately)

The invariant *"a Basher-driven input, declared by wiring, enumerated and bound from
Basher"* spans **every** kind. That shared span IS the abstraction boundary. The per-kind
widget differs (a float shows a diamond + timeline channel; an image shows an asset picker;
a video binds a clip whose frames map to the batch) — but that divergence is inherent to
`kind` and exists whether or not the node is split. So folding costs nothing on Basher's
side and saves the author node types; the cost curve stays flat (a new kind = one `case`).

## The one transport seam (invisible to the author)

`kind` drives two different transports under the hood:

- **scalar kinds** travel **inline** — Basher writes the baked `values_json` array onto
  the node before submit; the node replays it across the batch (`OUTPUT_IS_LIST`, the
  FizzNodes mechanism — same as the old `BasherValueSchedule`).
- **media kinds** travel **out-of-band** — Basher uploads the bytes via `/upload/image`
  (which accepts any file, keyed on filename extension — grounded in
  `comfyui/server.py` `image_upload`) and the node reads a filename, like `LoadImage` does.

The author just sets `kind` and wires the `*` output. The node's `run()` and Basher's
submit both branch on `kind` internally — contained, small.

## Lifecycle (the only thing Basher does)

1. **Author** builds a workflow in ComfyUI: settings to expose → `basher_controller`
   nodes; media in → `basher_controller` (kind=image/video); results → `basher_export`.
   Export **API format** (`Save (API Format)`, Dev Mode).
2. **Basher imports** and scans ONLY for `basher_*` node `class_type`s:
   - controllers → keyframeable rows (scalar) / asset-bind rows (media) in the Controls panel
   - exports → output sinks
   No foreign node is read.
3. **User** keyframes the scalar controllers on the timeline and binds media controllers
   to project assets.
4. **Render:** Basher bakes each scalar channel → a length-N array, writes
   `values_json`+`frame_count` onto the node; uploads bound media; submits **one** batch;
   streams the whole-workflow progress (`/ws`); collects the `basher_export` nodes →
   project MediaClips.

Batch length **N** comes from the input media (a `basher_controller` kind=video = N frames)
or the author's batch setup. Basher only supplies length-N arrays; making the *graph*
coherent across that batch (AnimateDiff context, conditioning batching, native video
models) is the author's job in ComfyUI.

## What this reuses / retires

| | |
|---|---|
| **Reused** | the keyframe channels + `ParamDiamond` Controls rows (now sourced from declared controllers, not inference); the bake (`resolveEvaluatedParam`); the per-frame-array node mechanism (`OUTPUT_IS_LIST`); the image upload path (`resolveComfyImageBindings`); the `/ws` progress stream + bar; `createMp4Sink` + the MediaClip on-ramp |
| **New** | the `basher_controller` + `basher_export` nodes (in the arm's-length MIT extension); a scan that enumerates them; Basher writing `values_json` onto a controller |
| **Retired** (staged) | `importComfyGraph` param manifest, `valueKind` inference, schedulable/structural classification, `compileBatchedWorkflow` input-rewire + demotions, the `KeyframeChannel*`-on-foreign-param bindings |

## Migration (build → prove → cut)

1. **Slice 1** — `basher_controller` (scalar kinds) node + Basher scan + one **float**
   channel driving one input, baked → batched → frames back. Live-observe.
2. **Slice 2** — media kinds on `basher_controller` (image, then video png-seq/mp4),
   reusing the upload path.
3. **Slice 3** — `basher_export` collection (image, then video) → project MediaClips.
4. **Slice 4** — deprecate then delete the compiler once 1–3 are observed working.

## Open grounding items (verify live, do not infer)

- **`*` (AnyType) output** connecting to a real FLOAT input *and* a real IMAGE input and
  passing ComfyUI's validation (well-trodden in the custom-node ecosystem; confirm on
  `/object_info` + an actual submit).
- **`OUTPUT_IS_LIST` batch alignment** — a list output runs the downstream per item; a
  true batch-aligned latent may need a different shape. The old `BasherValueSchedule` was
  validated for scalar schedules; re-confirm for the controller.
- **video frame mechanism** — `kind=video` decoding (native `LoadVideo` for mp4; a
  png-seq path) and how its frame count sets N.

## The nodes live arm's-length

`basher_controller` + `basher_export` ship in the SEPARATE MIT extension
(`comfyui/custom_nodes/BasherSchedule/` → rename to a `Basher` bridge). Basher emits their
JSON shape over the HTTP API and **never vendors this code** (ComfyUI core is GPL-3.0;
Basher stays a separate program — design §3 of the superseded doc, still binding).

REF: conversation 2026-06-27/28 (the I/O-boundary + controller reframe); vyapti V81
(epic — status pivots here); `src/app/video/comfyImageBinding.ts` (the upload path the
media kinds reuse); `src/core/comfy/comfyProgress.ts` (the progress stream).
