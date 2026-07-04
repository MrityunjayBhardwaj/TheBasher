# Basher — Performance Boost Plan (three.js render path)

> **Status:** assessment + backlog. Grounded in the current `ux-overhall` render path
> (three.js `^0.169`, R3F `^8`, drei `^9`, `@react-three/postprocessing`).
> **Premise:** the DAG / Op / IR / evaluator / agent / timeline layers are renderer-free
> (`src/nodes`, `src/agent`, `src/core` proper = **0** three imports). All perf work below
> lives in the render seam (`src/viewport`, `src/render`, `src/app/*Gizmo/helpers`) — the
> substrate (V34) is untouched.
>
> **Method (deductive, not empirical):** the lever order below is a _hypothesis_. The gate
> is the existing scene-scale harness (`tests/e2e/perf-scene-scale.spec.ts`, #114) which
> splits the per-frame budget into **CPU-eval vs React-reconciliation vs GPU/draw-call**.
> Measure first → pull the lever the budget points at → re-measure. One observation per change.

---

## 0. What is ALREADY fast — do NOT redo these

These are the expensive, non-obvious optimisations already shipped. Re-doing them is wasted
effort; building on top of them is the play.

| Optimisation                          | Where                                                                                     | Why it matters                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Animation hot path bypasses React** | `src/viewport/SceneFromDAG.tsx:~1301` (`useFrame`)                                        | Time sampling + TRS writes mutate the `Object3D` **in place, outside React's commit** (K13 / B13 "Pass 2→3", PR #115). Playback pays **zero** reconciliation cost per frame. Hardest perf thing to get right — done. |
| **Evaluator cache**                   | `src/core/dag/evaluator.ts` (`createEvaluatorCache`), instantiated `SceneFromDAG.tsx:115` | Re-evaluation of unchanged sub-DAGs is memoised.                                                                                                                                                                     |
| **Geometry registry dedup**           | `src/app/geometryRegistry.ts`                                                             | Deterministic `GeometryRef.key` → one built `BufferGeometry`, shared across every node that resolves the same key. Identical geometry is built once.                                                                 |
| **DPR cap + cheap AA**                | `src/viewport/Viewport.tsx:151-159`                                                       | `dpr={[1,2]}` caps retina cost; `antialias:false` + SMAA in post is cheaper than MSAA for this pipeline.                                                                                                             |
| **Imperative timeline canvas**        | `src/timeline/TimelineCanvas.tsx` (K13)                                                   | Static-layer offscreen cache + React-bypass rAF strip-redraw; playhead scrub never re-renders React.                                                                                                                 |
| **Existing budget instrument**        | `tests/e2e/perf-scene-scale.spec.ts` (#114)                                               | Already separates CPU-eval / React / GPU at 50→2000 meshes. Use it as the gate.                                                                                                                                      |

**Implication:** heavy _animation playback_ is already near-optimal. The remaining wins are in
**idle cost**, **object count**, and **picking** — not in the animation loop.

---

## 1. The levers — ranked by ROI

Each lever: the gap (with evidence), the fix, effort, risk, and the file surface.

### Lever 1 — On-demand frameloop ⭐ biggest "free" win (idle editor)

- **Gap (observed):** `src/viewport/Viewport.tsx:149` mounts `<Canvas>` with **no `frameloop`
  prop** → R3F defaults to `"always"` → the viewport renders **60fps continuously even when the
  scene is idle** (static cube on screen = fan spins, battery drains, laptop heats).
- **Fix:** drive the frameloop by activity. `frameloop="demand"` when paused/idle; switch to
  `"always"` only during **playback / orbit / gizmo-drag / agent-apply**, and call
  `invalidate()` on every discrete edit (Op dispatch, selection, camera move).
- **Catch (why it's not a one-liner):** the animation model is `useFrame`-driven, and `useFrame`
  only fires under `"always"`. A naive flip to `"demand"` **freezes playback**. The wiring must
  gate the mode on `playing || orbiting || dragging`, and `invalidate()` must be wired into the
  Op dispatcher + selection store + camera `onChange`. `SceneBgTestSeam.tsx:45-49` already calls
  `invalidate()` — partial precedent exists.
- **Effort:** Medium. **Risk:** Medium (a missed `invalidate()` site = "viewport doesn't update
  after edit X" — needs a falsifiable e2e per trigger: edit→exactly-one-frame-rendered).
- **Win:** large perceived win (idle CPU/GPU → ~0; battery + thermals on laptops).

### Lever 2 — Instancing ⭐ biggest win for many objects

- **Gap (observed):** `grep InstancedMesh src` → **zero hits.** 2000 repeated cubes today = 2000
  draw calls + 2000 `Object3D`s.
- **Fix:** collapse nodes sharing the same resolved `GeometryRef.key` **and** material into a
  single `InstancedMesh` with a per-instance matrix buffer. The geometry registry already groups
  by key — instancing is the renderer-side consumer of that grouping. Per-instance TRS writes go
  through `setMatrixAt` in the existing `useFrame` (stays React-bypassed).
- **Effort:** High (selection/picking per-instance via `instanceId`; the AnimationLayer wrapper +
  override model must map onto instance ids; gizmo addresses an instance, not an `Object3D`).
- **Risk:** Medium-High (interacts with B1.1/B1.2 selection-unwrap; per-instance override is new).
- **Win:** order-of-magnitude draw-call reduction for scatter / arch-viz / repeated-asset scenes.

### Lever 3 — BVH-accelerated raycasting (`three-mesh-bvh`) — picking at scale

- **Gap (observed):** `grep computeBoundsTree|three-mesh-bvh src` → **zero.** Click-to-select is
  default three.js raycast = **O(triangles)** per ray. On a heavy mesh / dense scene, every click
  stalls.
- **Fix:** add `three-mesh-bvh`, `computeBoundsTree()` on registry geometry at build time, swap
  `Mesh.prototype.raycast` for the accelerated raycast. One-time per geometry; picking → O(log n).
- **Effort:** Low-Medium (drop-in lib; build-time hook in `geometryRegistry.ts`).
- **Risk:** Low. **Win:** responsive selection on heavy scenes; also speeds any future
  snap/ground-projection raycasts.

### Lever 4 — LOD + frustum-cull tuning

- **Gap (observed):** `grep "new LOD"` → **zero.** Default per-object frustum culling is on, but
  distant / dense meshes render full-resolution; no distance LOD; no manual bounding-sphere hints.
- **Fix:** `THREE.LOD` for heavy assets (auto-decimated tiers); verify `frustumCulled` stays true
  on instanced/large meshes; set explicit `boundingSphere` where the registry knows bounds.
- **Effort:** Medium (needs decimation tiers — could reuse the bake pipeline). **Risk:** Low.
- **Win:** scales with scene depth/complexity; complements Lever 2.

### Lever 5 — Draw-call / material batching

- **Gap:** distinct materials = distinct draw calls even on shared geometry. The OpenPBR IR →
  `openpbrToThree.ts` adapter builds one `MeshPhysicalMaterial` per material; identical materials
  may not be deduped at the renderer.
- **Fix:** content-hash materials (mirror the geometry registry pattern) → share
  `THREE.Material` instances across nodes with identical resolved IR; merge static
  same-material geometry via `BufferGeometryUtils.mergeGeometries` where instancing doesn't fit.
- **Effort:** Medium. **Risk:** Low-Medium (material is per-node-cloned today for override
  fidelity — H76; dedup must preserve the clone-on-override invariant).
- **Win:** fewer state changes + draw calls on material-heavy scenes.

### Lever 6 — WebGPU **without leaving three** (the non-Babylon backend swap)

- **Context:** three.js ships `WebGPURenderer` + TSL node materials. This is the WebGPU answer
  to "should we switch renderers" _inside_ the current stack — no Babylon/Orillusion rewrite.
- **Gap:** the pipeline is `WebGLRenderer` end-to-end (`src/render/renderToImage.ts` uses
  `WebGLRenderTarget`; PostFx is `@react-three/postprocessing` = WebGL).
- **Fix (research bet, not a port):** evaluate R3F's WebGPU path; the material IR (V32, "renderer
  is a compile target") would gain an `openpbrToTSL` adapter alongside `openpbrToThree`.
- **Effort:** High / exploratory. **Risk:** High (postprocessing stack + browser support).
- **Win:** compute-shader-class workloads (particles, large instancing) + future-proofing.

---

## 2. Cross-cutting hygiene (cheap, do alongside)

- **`material.dispose()` / `geometry.dispose()` audit** — `SceneFromDAG.tsx` already disposes
  built materials on unmount (`:976`). Verify every imperative `useMemo`-built resource has a
  matching dispose; a leak shows as climbing GPU memory over a long edit session.
- **`dpr` runtime governor** — drop `dpr` to `1` during orbit/drag, restore on settle (cheap
  motion blur of detail the user won't notice mid-gesture).
- **Suspense / lazy asset decode** — confirm glTF decode (`gltfLoaderConfig.ts`) is off the main
  thread (Draco/Meshopt workers) so import never janks the frameloop.
- **PostFx toggle at scale** — SMAA + tonemapping has a fixed per-frame cost; expose a "performance
  mode" that drops post when frame budget is exceeded.

---

## 3. Sequencing — measure-gated

```
STEP 0  Run the harness (real GPU):  PWHEADED=1 npx playwright test perf-scene-scale --headed
        → read staticFrameP95 / churnReactP95 / churnEvalP95 / GPU knee at 1000–2000 meshes.
        → this tells us which regime we're in. DO NOT skip — the lever order is a hypothesis.

IF idle/battery is the complaint     → Lever 1 (frameloop)         [Medium, large UX win]
IF GPU/draw-call bound at scale      → Lever 2 (instancing) → 3 (BVH) → 4 (LOD) → 5 (batch)
IF React-reconciliation bound        → revisit DAG→scene memoisation in SceneFromDAG
IF CPU-eval bound                    → evaluator cache coverage / Op granularity
IF "as fast as physically possible"  → Lever 6 (WebGPU) as a milestone, after 1–5 land
```

**Recommended first cut (highest ROI, lowest risk):**
**Lever 1 (frameloop) + Lever 3 (BVH raycast)** — both contained, both measurable, both improve
the _felt_ responsiveness immediately. Then gate Lever 2 (instancing) on the harness showing a
real draw-call knee.

---

## 4. Per-lever acceptance gates (falsifiable — AnviDev)

Every lever ships with an observation that **bites red** if the optimisation regresses:

| Lever        | Falsifiable gate                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Frameloop  | Idle scene → assert **0 frames** rendered over 1s (probe `gl.info.render.frame`); edit → assert **exactly 1** frame. Falsify by reverting to `"always"` → idle frame-count climbs. |
| 2 Instancing | 1000 same-geo nodes → assert **draw calls ≈ 1** (not 1000) via `gl.info.render.calls`. Falsify by disabling the instanced path → calls = 1000.                                     |
| 3 BVH        | Heavy mesh → click-pick p95 latency under budget; falsify by removing `computeBoundsTree` → latency spikes.                                                                        |
| 4 LOD        | Camera far → assert reduced-tier geometry active.                                                                                                                                  |
| 5 Batch      | N identical materials → assert one shared `Material` instance + reduced `calls`.                                                                                                   |
| 6 WebGPU     | Pixel-parity render vs WebGL path on a reference scene.                                                                                                                            |

All numbers come from `tests/e2e/perf-scene-scale.spec.ts` + `window.__basher_perf` +
`gl.info.render` — never "it feels faster." Observation over inference.

---

## 5. Boundaries this touches (dharana)

- **B1 (Editor ↔ Evaluator):** all levers stay renderer-side; no Op-bypass, substrate (V34) clean.
- **B1.1 / B1.2 (evaluation-wrapper ↔ selection):** Lever 2 (instancing) must preserve the
  layer-unwrap selection contract — picking an instance must resolve to the **object** id, not the
  AnimationLayer or the InstancedMesh.
- **B16 (editor view ↔ DAG cameras):** Lever 1 must `invalidate()` on camera `onChange` or
  look-through / orbit won't repaint under `"demand"`.
- **B17 (live ↔ offscreen render):** Lever 6 (WebGPU) changes `renderToImage.ts`'s render target;
  the `editorChrome` exclusion (V37) must survive the backend swap.

> New catalogue entries (hetvabhasa / vyapti) to be added as each lever ships and reveals its
> trap. This doc is the backlog; the catalogues are the accumulated proof.
