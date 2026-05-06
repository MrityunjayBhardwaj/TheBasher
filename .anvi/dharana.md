# Dharana — Basher Project-Specific Instantiation

> Forward-looking entries: Basher has no code yet. These boundaries, invariants, and lens configurations are derived from the THESIS.md commitments and will be validated/updated as P0 ships.

**Source of truth:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/THESIS.md`
**REF (project-level):** THESIS.md (entire document — every dharana entry below cites a thesis section)

---

## 1. PROJECT BOUNDARIES

### Boundary B1: Editor (R3F) ↔ Evaluator (DAG core)

**ORIGIN:** THESIS.md §11 — viewport renders the result of `evaluate('scene', currentTime)`. The editor never authors raw scene state; it emits Ops.
**WHY:** If R3F components mutate scene state directly (bypassing Ops), undo breaks, agent control breaks, multiplayer breaks, save/load diverges. Single most likely place to leak.
**HOW:** Reviewers reject any `dagStore.setState(...)` outside the Op dispatcher. Every UI mutation goes through `dispatch(op)`.
**REF:** THESIS.md §50 (The Op system is the only mutation path)
**Silent-failure modes:** scene state diverges from DAG; viewport "correct" but save loses changes; undo no-ops.
**Observation targets:** every gizmo drag → confirm an Op landed in activity log; every store change → confirm it came from `dispatch`.

### Boundary B2: Evaluator ↔ Storage (OPFS / future Tauri fs)

**ORIGIN:** THESIS.md §33 (capability interfaces) + §38 (P0 storage requirements).
**WHY:** Basher v0.5 is browser-only OPFS; v0.6 adds Tauri fs. Two impls must be behind one interface. Diverge here and migration is a rewrite.
**HOW:** `core/storage/StorageCapability.ts` interface; `OpfsStorage.ts` impl in v0.5; `TauriStorage.ts` stub for v0.6. No code outside `core/storage/` touches the storage backend directly.
**REF:** THESIS.md §33, §52 (migration policy)
**Silent-failure modes:** save succeeds but truncates large projects; OPFS quota exceeded silently; reload loses last N changes.
**Observation targets:** write-then-read-back verification on every save in dev; quota percentage shown in dev FPS overlay.

### Boundary B3: Agent (LLM) ↔ DAG (via tool calls)

**ORIGIN:** THESIS.md §18 (agent is a privileged user), §19 (Diff-first), §20 (tool surface).
**WHY:** Agent must edit through the same Op system as the user. Bypass = two mutation paths = every cross-cutting feature has two cases.
**HOW:** Tool handlers return `Op[]`; never call `dagStore.setState`. Diff system applies to forked DAG; user accepts → ops flow through real Op dispatcher.
**REF:** THESIS.md §18-20
**Silent-failure modes:** agent applies tool that bypasses Diff; agent applies invalid op (zod validation skipped); user rejects but state already mutated.
**Observation targets:** every agent turn → activity log shows source='agent'; reject path → confirm zero state changes.

### Boundary B4: Node evaluator ↔ time/randomness (purity)

**ORIGIN:** THESIS.md §48 (Determinism enforced), §49 (Time is a first-class type).
**WHY:** Pure-flag lying corrupts cache; time-as-closure breaks scrubbing and frame-render parity.
**HOW:** Lint rule bans `Math.random`/`Date.now`/`performance.now`/`crypto.randomUUID` in `pure: true` evaluators. Time enters via `Time` socket only. CI test harness runs every `pure: true` node twice on identical inputs and compares output bit-exact.
**REF:** THESIS.md §48-49, §51 (Caching correctness)
**Silent-failure modes:** drag a slider → cache returns stale; render frame ≠ viewport frame at same time; agent reproduces a scene differently.
**Observation targets:** twice-eval test in CI; visual diff between render-frame-N and viewport-at-time-T.

### Boundary B5: Web build ↔ Blender live-link

**ORIGIN:** Browser-first decision (this session, 2026-05-05). Browsers cannot host HTTP servers.
**WHY:** RubicsWorld's beacon-from-page pattern needs reversal: Blender addon hosts a small HTTP server; browser polls. Otherwise hot-reload silently breaks.
**HOW:** Blender addon ships a Python `http.server` companion; Basher polls `/active` and the addon writes assets to a watched directory the user picks via File System Access API. Polling cadence 2s in dev.
**REF:** THESIS.md §32, §33 (capability interfaces — `BlenderBridgeCapability`)
**Silent-failure modes:** addon server not running but page assumes it is; CORS misconfig; user picks wrong asset folder.
**Observation targets:** beacon poll responses logged in dev console; "Blender connected" indicator in chrome.

---

## 2. ACTIVE INVARIANT SPANS

> No invariants discovered yet — derived from THESIS.md as commitments to enforce in code.

### V1: Every store mutation is an Op

**Status:** NOT YET IMPLEMENTED (P0 enforces)
**Span:** All zustand stores (DAG store, selection store, mode store, agent store).
**REF:** THESIS.md §50

### V2: Every node declares `pure: true | false`; pure nodes are bit-exact reproducible

**Status:** NOT YET IMPLEMENTED (P0 enforces via lint + test harness)
**Span:** Every node type definition.
**REF:** THESIS.md §48

### V3: Time enters as a socket, never as a closure or global

**Status:** NOT YET IMPLEMENTED (P0 enforces via lint)
**Span:** All animation and render node evaluators.
**REF:** THESIS.md §49

### V4: Every node type carries `version: number`; loading older projects migrates them

**Status:** NOT YET IMPLEMENTED (P0 ships migration runner; v1 schema = no-op)
**Span:** Every node type + project loader.
**REF:** THESIS.md §52

### V5: Permissive licenses only

**Status:** NOT YET IMPLEMENTED (P0 ships license-audit CI)
**Span:** Every `package.json` dependency.
**REF:** THESIS.md §35; memory/feedback_license.md

---

## 3. LENS CONFIGURATION

### Active lenses for Basher (v0.5 phases)

| Lens         | When active                   | Project-specific instantiation                                                                                                                                   |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design**   | Phase planning, schema design | Anchor on the single-primitive commitment (THESIS.md §6). Every design question → "is this a node? what are its inputs/outputs/params? is it pure?"              |
| **Diagnose** | Bug investigation             | Start with B1-B5 boundaries above. Most bugs will land at one of them. Check hetvabhasa first; pattern likely cataloged.                                         |
| **Review**   | PR review                     | Five required checks: (a) thesis section referenced? (b) Op-system used? (c) determinism preserved? (d) capability interface respected? (e) license-audit clean? |
| **Recover**  | Major architectural drift     | Reread THESIS.md Part XI (The Director's Question). If a change makes the director less in control, revert.                                                      |

### Project-specific axes (created through blind spot detection)

> None yet. Will accumulate as catalogues grow.

### Deferred decisions (seeds — re-evaluate at named trigger)

#### Shader-as-node-graph (TSL) — defer to P4

**ORIGIN:** P1 scoping discussion (2026-05-05). Question raised: should `MaterialOverride` accept TSL or OSL alongside PBR?
**WHY:** TSL is the right _long-term_ fit for Basher (shaders-as-DAG-nodes). But authoring it in P1 destabilizes the asset library:

- TSL lives in `three/webgpu`; API is still moving. Pinning P1 to it imports churn.
- WebGPU path forces dual-rendering (WebGL fallback), which is real complexity, not a P1 line item.
- P1's job is _content placement_ (drag GLB → see asset). Shader authoring is a _renderer_ concern; the natural home is P4 (render graph), where pass nodes land.
- OSL is unviable in v0.5 entirely — no browser runtime, compiling OSL → WGSL is research not a phase.
  **HOW (when triggered at P4):**
- Add a `Shader` node type (TSL-typed inputs/outputs).
- `MaterialOverride` gains an optional `shader: ShaderRef` input alongside the existing PBR params.
- Determinism: TSL graphs are pure-by-construction; verify with the same twice-eval harness as other pure nodes.
- Renderer support: gate on `webgpu` capability; WebGL fallback uses preset PBR only.
- OSL: still deferred to v0.6+ research; if revisited, importing OSL semantics into a TSL graph is the path, not running OSL itself.
  **P1 guard:** V9 (materials = data, not code) blocks accidental shader-source leakage during P1.
  **Status:** SEED. No implementation in P1–P3. Re-evaluate during P4 planning.

---

## 4. ORGANIZATIONAL HEALTH

**Post-P0 fatality test (2026-05-05):**

1. **Hetvabhasa clustering:** 6 patterns cataloged (H1-H6). H1/H2/H3 cluster at _tooling/dev-loop_, NOT at any of B1-B5. H4 sits at B2 (storage TS typing). H5 sits at B1 (DAG types). H6 is at the test/observation boundary (UI overlay vs pixel diff). **No 3+ clustering at a single B-boundary** — boundaries B1-B5 are correctly placed for now.
2. **Vyapti span:** V1 (op dispatcher) spans `core/dag/store.ts` only — single module, no entanglement. V2 spans `src/nodes/**` (declared) + `eslint.config.js` (enforced) + `src/nodes/nodes.test.ts` (verified) — three sites, but they're complementary not overlapping. V6 (capability) spans `core/storage/` and `integrations/blender/` — distinct interfaces, distinct directories. **No invariant spans 3+ modules with overlapping concerns.**
3. **Krama crossing:** K1 boot sequence runs through `src/app/boot.ts` end-to-end, single entry. K2 op dispatch lives entirely in `src/core/dag/store.ts` + `ops.ts`. K5 save/load lives in `core/project/io.ts`. **No lifecycle crosses 3+ module boundaries.**

**Verdict: organization is sound after P0.** Continue with current structure into P1.

**Post-P1 fatality test (2026-05-05):**

1. **Hetvabhasa clustering:** 10 patterns cataloged (H1-H10). H9/H10 are tooling/test patterns (GLTFExporter polyfill, zustand snapshot stale across async hops) — not boundary issues. H1-H8 distribution is unchanged from P0. **No new 3+ clustering at any B-boundary.**
2. **Vyapti span:** V9 lands ALIGNED with `MaterialOverride` (single module, no entanglement). V1/V2/V4/V5/V6/V8 still single-module-spanning. **No invariant gained a multi-module span during P1.**
3. **Krama crossing:** K6 (asset-drop chain) lives entirely in `src/app/asset/dropChain.ts` + `src/app/AssetDropZone.tsx` + `src/core/dag/store.ts` (the dispatchAtomic seam). **No new lifecycle crosses 3+ module boundaries.**

**Verdict: organization is still sound after P1.** New "boundary" B6 emerges (Library ↔ OPFS asset store) but it is a clean specialization of B2 (Evaluator ↔ Storage) — same StorageCapability seam, same V6 enforcement.

**Post-P2 fatality test (2026-05-06):**

1. **Hetvabhasa clustering:** 11 patterns cataloged (H1-H11). H11 (data-testid on R3F primitives) is a UI-test pattern, not a boundary issue. No B-boundary newly clusters 3+ patterns.
2. **Vyapti span:**
   - V3 (Time-as-socket) flips from NOT YET IMPLEMENTED → ALIGNED with the TimeSource singleton + 4 pure consumers (PosedSkeleton, AnimationClip, LocomotionState, Character). Span: `src/nodes/TimeSource.ts` + 4 evaluators + `eslint.config.js` (lint enforcement) + the evaluator's cache-key path. All within `src/nodes/**` and `src/core/dag/evaluator.ts:119`. Single concern, complementary sites — no entanglement.
   - V1/V2/V4/V5/V6/V8/V9 still single-module-spanning.
   - **No invariant gained a multi-module span during P2.**
3. **Krama crossing:** K7 (walkTo chain) lives in `src/app/character/walkTo.ts` (pure macro) + `src/app/character/GroundClick.tsx` (pointer capture + dispatch) + `src/core/dag/store.ts` (dispatchAtomic). Three sites, all atomic, mirrors K6's shape. **No lifecycle crosses 3+ module boundaries beyond the already-allowed app-store seam.**

**Verdict: organization is sound after P2.** A nascent "B7: Viewport-pointer ↔ DAG-mutation" boundary appears (GroundClick translates pointer hits into Op chains) but it shares the V8 file-rooted enforcement with B1 — the dispatch lives in `src/app/`, not `src/viewport/`, so the boundary is structurally identical to the asset-drop one. No new dharana B-entry needed.

**Predicted high-risk boundaries (THESIS.md §57 pre-mortem) — P0 status:**

- B1 (editor ↔ evaluator): perf was the worry. P0 shows `dispatch → evaluate → render` synchronous chain runs in <16ms (acceptance #5 ✓). 91 fps observed on M1 with default DAG (acceptance #8 ✓). No stutter. Watch on bigger graphs in P1.
- B3 (agent ↔ DAG): not exercised in P0; ships with P2.5.
- B5 (web ↔ Blender): polled endpoint works in dev, inert in prod. Companion-setup-blocks-adoption is the real risk; deferred to P1+ (not on the P0 path).

**Self-review pass (post-merge, same day):**
Goal-backward review caught two real bugs that all 8 acceptance tests missed:

1. Uncontrolled inputs in Inspector (H7) — visible only when external state mutates the DAG (undo, agent ops). Fixed inline; regression test #10 added.
2. ambientLight DAG leak in SceneFromDAG — V8 violation. Removed; threshold absorbed the visual delta in #7.
   Plus three structural improvements: `dispatchAtomic` for P1's drag-reorder, `bootPromise` guard for StrictMode, Canvas-preservation E2E #9.

**Lesson:** acceptance tests prove the goal is met under the canonical input path. They DO NOT prove the system holds under non-canonical mutations (external state changes, repeated mounts, mode toggles). After every phase ship, run a goal-backward review for these classes specifically:

- "What if state mutates from a path I didn't test?"
- "What if a component re-mounts when I assumed it wouldn't?"
- "What invariant did I declare but not enforce?"

---

## 5. GROUND TRUTH INVENTORY

> No external systems traced yet. Basher v0.5 has no Ground Truth dependencies because it builds on permissive web libraries we use as black boxes (THREE.js, R3F, Theatre).

**Candidates for future Ground Truth docs:**

- THREE.js render loop + frustum culling (if perf debugging hits opaque boundary)
- ComfyUI workflow execution (if AI render bridge debugging hits opaque boundary)
- PlayCanvas scene serialization (if export debugging hits opaque boundary)
- gaussian-splats-3d material/light interaction (P6+, if depth/normal pass integration breaks)

---

## Provenance

**Created:** 2026-05-05 — before P0 begins.
**Updated:** 2026-05-05 — initial seed from THESIS.md commitments.
**Updated:** 2026-05-05 — post-P0 re-derivation: V1/V2/V4/V5/V6/V8 flipped from NOT YET IMPLEMENTED to ALIGNED. Hetvabhasa H1-H6 added. Organizational fatality test passed — no boundary needs restructuring.
**Updated:** 2026-05-05 — post-P1: V9 flipped to ALIGNED. K6 (asset-drop chain) added. H9/H10 cataloged. Connect-with-index extension is backward-compatible with V1; existing tests unchanged.
**Updated:** 2026-05-06 — post-P2: V3 (Time-as-socket) flipped to ALIGNED. K7 (character.walkTo chain) added. H11 (data-testid on R3F primitives crashes Canvas) cataloged. ESLint extended to ban `useFrame`/`useThree` in `src/nodes/**`. The TimeSource impure singleton + cache-key path through the evaluator preserves twice-eval determinism for pure consumers; verified by 5 t-sample harness in `src/nodes/nodes.test.ts`. Multi-character cache isolation verified at both unit + E2E layers.
**Updated:** 2026-05-06 — post-P2 viewport-polish round (orbit + axis widget + char-gizmo + multi-project + IDB):

- V6 span widened: `IndexedDbStorage` adopted as the OPFS fallback; `pickStorage()` now chains OPFS → IDB → Memory. Added without a single caller change — capability discipline held.
- K8 added: boot-with-last-project lifecycle. Multi-project switch auto-saves the outgoing project before hydrating the incoming one (no "did you save?" modal — saves are cheap, atomic per K5).
- H12 added: declarative R3F `<PerspectiveCamera position={...}>` fights OrbitControls (and any externally-mutating control system). Fix: ref + useEffect keyed on primitive scalars, not array identity.
- New small UI store: `gizmoStore` (TransformControls dragging flag) — separates gizmo + orbit responsibilities cleanly. Editor-camera + DAG-camera are now distinct concerns: DAG-camera authors initial pose + render output (P4); editor-camera is OrbitControls' free orbit.
- Character gizmo binding: TransformControls bound to selected Character emits walkTo on drag-end (mirrors click-to-move) — same Op-shape, different trigger.
- No new B-boundary needed. The "Viewport-pointer ↔ DAG-mutation" surface (GroundClick + Gizmo) is a clean V8 file-rooted echo of B1 — dispatch lives in `src/app/`, not `src/viewport/`.
  **Next update trigger:** end of P2.1 (viewport polish + menu bar + click-to-select) — re-validate selection-store cardinality (single → array) and any new keyboard-driven Op surfaces.

**Updated:** 2026-05-06 — post-P2.1 (Waves A+B already shipped; this entry covers Waves C+D+E):

- **Selection model now multi.** `selectionStore.selectedNodeIds: ReadonlySet<NodeId>` + `primaryNodeId` is the canonical pair; `selectedNodeId` is a deprecated single-id mirror kept so P0/P1/P2 surfaces (Inspector header, Gizmo binding, Cmd+S save indicator) continue without rewrites. Wave A's choice held under Wave C/D/E exercise — no churn at the call sites.
- **viewportStore added** as the sister UI projection alongside selectionStore + gizmoStore + threeRef. Lives in `src/app/stores/viewportStore.ts`. Owns: pivot (median-only in v0.5), snapStep + snapEnabled, gridVisible, axisWidgetVisible. `maybeSnapVec3()` is the read-once helper Gizmo translate + GroundClick worldPoint call to honor snap.
- **New Op-surfaces wired in P2.1 — all preserve V1 + V8 file-rooted enforcement:**
  - `src/app/character/cameraFromView.ts` (K9) — Cmd+Shift+C / View menu → atomic `[disconnect → addNode PerspectiveCamera → connect]` chain.
  - `src/app/dragScrub.ts` + `src/app/Inspector.tsx` — Inspector label drag-scrub. Live preview is local React state; one drag commits ONE setParam Op on pointer-up. No per-pixel dispatches → undo stack stays clean (one drag = one Cmd+Z entry).
  - `src/app/MenuBar.tsx` — File / Edit / Select / View. Every action funnels through existing helpers (boot.ts for project ops, useDagStore.dispatch for ops, hydrate for Edit→Reset). The reset path is the only V1-exception escape and matches the documented project-load seam.
- **No new B-boundary needed.** The P2.1 surfaces (NPanel + MenuBar + framing.ts) all live in `src/app/` and dispatch from there. The viewport (`src/viewport/`) read viewportStore but never writes the DAG — V8 file-rooted holds.
- **Hetvabhasa update:** H13 (Playwright pixel-diff baseline must be regenerated after layout shifts). Cataloged because the menu bar legitimately shrunk the viewport DIV by ~35px → acceptance #7 fails on the old darwin baseline despite no scene-content change. Linux baseline regen deferred to first CI run (H8 pattern).
- **Fatality test (post-P2.1, 2026-05-06):**
  1. Hetvabhasa clustering: H13 sits at the test/observation boundary (same family as H6/H8/H11). Total now 13 cataloged. No B1-B5 boundary newly clusters 3+ patterns.
  2. Vyapti span: V1/V2/V3/V4/V5/V6/V8/V9 still single-module-spanning. The MenuBar/NPanel/dragScrub additions did NOT widen any invariant.
  3. Krama crossing: K9 lives in `cameraFromView.ts` + `threeRef.ts` + `ThreeBridge.tsx` + `useDagStore.dispatchAtomic` — three sites, all atomic, mirrors K7's shape. No new lifecycle crosses 3+ module boundaries.

  **Verdict: organization remains sound after P2.1.**

  **Next update trigger:** start of P2.5 (AI Agent on the DAG). Expect new clustering at B3 (Agent ↔ DAG) — currently empty. V7 will flip to ALIGNED.

**Updated:** 2026-05-06 — post-P2.6 (Editor polish: TransformToolbar + viewport shading + UV editor scaffold):

- **New boundary B6: Editor shading ↔ DAG render.** Conceptual: editor-only lights (`src/viewport/EditorLights.tsx`) MUST NOT leak into render output. Mechanism: EditorLights returns `null` when `viewportStore.shading === 'rendered'`. Acceptance #7 (PostFx pixel-diff) sets `rendered` before screenshot — proves the seal. **Silent-failure mode:** designer composes scene under studio fill, hits render, sees a much darker output because their DAG had no lights and they were unknowingly relying on editor lighting. Mitigation: `rendered` mode in the toolbar is one click away — designers can preview the DAG-only result anytime.
- **New UI projection store: `editorStore`** — a sister to selectionStore / gizmoStore / threeRef / viewportStore. Owns the active editor space (`view3d` / `uv`). Tab key toggles. Layout flips slot visibility via display:none — Canvas survives the space switch (K1 step 6 discipline preserved).
- **New surfaces in P2.6 — all preserve V1 + V8 file-rooted enforcement:**
  - `src/app/TransformToolbar.tsx` — top-bar gizmo mode + snap + shading + space groups. Mutates only UI projections.
  - `src/app/UVEditor.tsx` + `src/app/uvLayout.ts` — read-only UV editor that paints canonical box UVs in HTML 2D canvas; reads selection + DAG, never writes.
  - `src/viewport/EditorLights.tsx` — first src/viewport/ component that mutates nothing, just renders R3F primitives gated on a viewport projection. Confirms the V8 file-rooted rule's spirit (no dispatch from src/viewport/) is the right cut: pure-rendering helpers belong here, dispatching helpers belong in src/app/.
- **Hetvabhasa note (NOT a new entry):** layout-shifting features re-tripped H13 (toolbar's row added another ~32px shrink to viewport DIV → acceptance #7 baseline regen needed again). Pattern is the same as last round; no new entry, just confirmation H13 is the right framing.
- **Fatality test (post-P2.6, 2026-05-06):**
  1. Hetvabhasa clustering: 13 entries (no new). H13 reaffirmed at the test/observation boundary.
  2. Vyapti span: V1/V2/V3/V4/V5/V6/V8/V9 still single-module-spanning. New stores (`editorStore`) and components (TransformToolbar / UVEditor / EditorLights) didn't widen any invariant.
  3. Krama crossing: no new lifecycle exceeded 2 module boundaries. The space toggle is a single store-set; the shading toggle is a single store-set with one downstream component re-render.

  **Verdict: organization remains sound after P2.6.** B6 (editor-shading ↔ DAG-render) is conceptual not file-structural — no new directory, no new module, just a contract that EditorLights honors.

  **Next update trigger:** unchanged — P2.5 (AI Agent on DAG).

**Updated:** 2026-05-06 — post-P2.6.1 / P2.6.2 / P2.6.3 (Editor polish hotfix train):

- **Add menu shipped** (P2.6.1) — Blender-style right-click + Shift+A: meshes (Cube, UV Sphere via new SphereMesh node type — **24 → 25 node types**), lights (Sun / Point / Spot / Area / Ambient), cameras (Perspective / Orthographic), empties (Group / Transform). Single dispatchAtomic per pick. New nodes auto-select for instant gizmo binding.
- **Sphere UV unwrap** (P2.6.2) — equirectangular grid mirrors THREE.SphereGeometry's actual UV layout. Honest about pole stretch.
- **Wireframe shading mode** (P2.6.2) — viewportStore.shading: 'studio' | 'wireframe' | 'rendered'. Toolbar third button; menu mirrored. Gates pass through every meshStandardMaterial + traverses cloned glTF scenes.
- **Light helpers + selection + rotation** (P2.6.2 + P2.6.3) — wireframe gizmo per light kind; helpers gain onClick → selectionStore.select(pickId); every positional light schema gains `rotation: vec3` default [0,0,0]; DirectionalLight ring + actual shaded direction both compute from `rotation × (0,-1,0)` (legacy fallback to `-position` when rotation is zero — preserves seed scene + acceptance #7 baseline).
- **Two new hetvabhasa entries:**
  - **H15** (gizmo re-select bug) — conditional R3F render gated on a useRef breaks on remount because ref writes don't trigger re-render. Fix: lift to useState + callback ref. P2.6.1 hotfix.
  - **H14** (hydrate seam bypasses zod default-fill) — schema additions land as `undefined` for projects saved before the field existed; the load path skips `paramSchema.parse()`. Fix: defensive defaults at the evaluator (cheap, no migration). P2.6.3 hotfix.
- **Fatality test (post-P2.6.3, 2026-05-06):**
  1. Hetvabhasa: 15 entries (added H14 + H15). H14 sits at the hydrate boundary — the test/observation cluster grew to 4 (H6/H8/H11/H13/H14/H15 — though H14 is closer to a load-path issue and H15 is a render-path issue). No B-boundary cluster reaches 3+ same-cause patterns.
  2. Vyapti span: V1/V2/V3/V4/V5/V6/V8/V9 still single-module-spanning. The new `addMenuStore` + `editorStore` are sister UI projections; viewportStore widened with `shading` (no span change). SphereMesh adds one more registered node type.
  3. Krama crossing: no new lifecycle exceeded 2 module boundaries. Add menu spawn = single dispatchAtomic call. Light helpers click pickup = single selectionStore.select call. Both mirror existing K6 / K7 shapes without creating new crossings.

  **Verdict: organization still sound after the P2.6.x hotfix train.** A potential future invariant: V10 — "node value shape MUST be defensive against missing schema fields after additions" — could land at the evaluator boundary if H14 recurs. Hold off until the second occurrence per dharana promotion criteria.

  **Next update trigger:** unchanged — P2.5 (AI Agent on DAG).

**Updated:** 2026-05-07 — post-P2.6.4 (light scale gizmo + size-driven power):

- **Promotion triggered.** P2.6.4 added `scale: vec3` to the four positional lights — second occurrence of the H14 pattern (rotation in P2.6.3 was the first). Both followed identical mechanics: schema field with `.default()`, defensive `?? default` at evaluator, defensive `?? default` at every consumer (helper + renderer). Per dharana promotion criteria (single → memory; recurrence → vyapti), V10 has been added to vyapti.md as ALIGNED for v0.5 with a v0.6 plan to fold the guard into a hydrate-seam re-validation pass.
  - **ORIGIN:** P2.6.3 hotfix (H14, rotation field) — first observation. P2.6.4 (scale field) — second observation, confirming the pattern.
  - **WHY:** the bug class this prevents fires only for users with persisted projects from before the field landed — silent on dev/CI fixtures, visible only in production. The two-layer guard converts a load-time crash into a benign default the user can correct via the gizmo.
  - **HOW:** vyapti V10 codifies the rule. Code reviewers reject any new `paramSchema` field that lacks the eval-side guard. Until v0.6's hydrate re-validation lands, every consumer that destructures the new field must also `?? default`.

- **Scale-drives-power** is a design choice on top of the schema rollout (volume product on Sun/Point/Spot, area-natural for AreaLight). Render-side projection only — DAG round-trip stays exact. Not a bug pattern; not catalogued in hetvabhasa.

- **Fatality test (post-P2.6.4, 2026-05-07):**
  1. Hetvabhasa clustering: 15 entries (no new). H14's REF list extended to include the scale rollout as a sister case. No B-boundary newly clusters 3+ patterns.
  2. Vyapti span: **V10 added (ALIGNED for v0.5).** Span: every node evaluator + every viewport/app consumer of evaluator output. Single concern (defensive defaults across the hydrate seam), complementary sites — no module entanglement. V1/V2/V3/V4/V5/V6/V8/V9 unchanged.
  3. Krama crossing: no new lifecycle. Light scale write = standard gizmo `setParam` Op (K2 lifecycle); render side multiplies at projection time, no new crossing.

  **Verdict: organization still sound after P2.6.4.**

- **Known catalogue staleness (NOT introduced by P2.6.4 — flagged for future housekeeping):** dharana §2 "ACTIVE INVARIANT SPANS" only mirrors V1-V5 and still says "NOT YET IMPLEMENTED." Vyapti has V1-V10 with current statuses. Section 2 needs a regen pass against vyapti.md before P2.5 work begins, so dhyana's session-start "scope to current work" can correctly load V6-V10 boundaries.

  **Next update trigger:** unchanged — P2.5 (AI Agent on DAG).
