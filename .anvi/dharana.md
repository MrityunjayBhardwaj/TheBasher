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

| Lens | When active | Project-specific instantiation |
|---|---|---|
| **Design** | Phase planning, schema design | Anchor on the single-primitive commitment (THESIS.md §6). Every design question → "is this a node? what are its inputs/outputs/params? is it pure?" |
| **Diagnose** | Bug investigation | Start with B1-B5 boundaries above. Most bugs will land at one of them. Check hetvabhasa first; pattern likely cataloged. |
| **Review** | PR review | Five required checks: (a) thesis section referenced? (b) Op-system used? (c) determinism preserved? (d) capability interface respected? (e) license-audit clean? |
| **Recover** | Major architectural drift | Reread THESIS.md Part XI (The Director's Question). If a change makes the director less in control, revert. |

### Project-specific axes (created through blind spot detection)

> None yet. Will accumulate as catalogues grow.

---

## 4. ORGANIZATIONAL HEALTH

> No code yet. First fatality test runs after P0 ships.

**Future fatality tests to run after each phase:**
1. **Hetvabhasa clustering:** do 3+ error patterns cluster at the same boundary? If yes, restructure that boundary.
2. **Vyapti span:** does any invariant span 3+ modules? If yes, modules are entangled — consolidate.
3. **Krama crossing:** does any lifecycle cross module boundaries 3+ times? If yes, the sequence is broken into too many handoffs.

**Predicted high-risk boundaries (THESIS.md §57 pre-mortem):**
- B1 (editor ↔ evaluator): perf — drag stutters because eval too slow.
- B3 (agent ↔ DAG): reliability — tool calls succeed only 80% of the time.
- B5 (web ↔ Blender): UX — companion-script setup blocks adoption.

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
**Next update trigger:** end of P0 — re-derive based on first real boundaries observed during implementation.
