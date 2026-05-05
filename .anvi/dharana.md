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
**Next update trigger:** end of P2.5 (AI Agent on the DAG) — re-validate after agent emits Ops via tool calls; V7 (agent → Op[]) flips ALIGNED there.
