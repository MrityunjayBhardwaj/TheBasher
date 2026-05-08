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
**Status:** EXERCISED (P2.5 v2, 2026-05-07). 6 tools registered: 2 universals (`dag.inspect`, `dag.exec`) + 4 macros (`character.walkTo`, `camera.snapshot`, `library.import`, `mesh.add`). Multi-turn loop (max 3 rounds): inspect → results fed back → exec. `ToolResult { ops, text }` replaces raw `Op[]` (read-only→text, mutation→ops). Selection context: `selectedNodeIds` flows from SelectionStore → ToolContext → system prompt (V11 ALIGNED). Tool registry + fork engine + diff store + ghost overlay + accept/reject bar all shipped. V7 ALIGNED. K3 cataloged with file:line REFs.
**Observation targets:**
- every agent turn → diff store shows pending → accept lands single dispatchAtomic entry; reject clears with zero state changes.
- **Selection context check (P2.5 v2):** before any agent turn that targets "selected" / "this" / pronouns, verify the API request body's system prompt contains a `Selected nodes:` block listing the current `selectionStore.selectedNodeIds`. If the block is absent or stale, the LLM will fall through to all-nodes or wrong-node behavior — symptom looks like "agent rotates everything" or "agent ignores selection." See H19 for the stale-snapshot mechanism that produced this class of bug.
- **Multi-turn drift check:** in the follow-up message after `dag.inspect`, verify the original user request appears verbatim (not the literal string `"the user's request"`). If verbatim text is missing, H19's stale-snapshot pattern is active in `runAgentTurn`.

### Boundary B4: Node evaluator ↔ time/randomness (purity)

**ORIGIN:** THESIS.md §48 (Determinism enforced), §49 (Time is a first-class type).
**WHY:** Pure-flag lying corrupts cache; time-as-closure breaks scrubbing and frame-render parity.
**HOW:** Lint rule bans `Math.random`/`Date.now`/`performance.now`/`crypto.randomUUID` in `pure: true` evaluators. Time enters via `Time` socket only. CI test harness runs every `pure: true` node twice on identical inputs and compares output bit-exact.
**REF:** THESIS.md §48-49, §51 (Caching correctness)
**Silent-failure modes:** drag a slider → cache returns stale; render frame ≠ viewport frame at same time; agent reproduces a scene differently.
**Observation targets:** twice-eval test in CI; visual diff between render-frame-N and viewport-at-time-T.

### Boundary B7: Agent identifier ↔ DAG node-set

**ORIGIN:** H21 (2026-05-08, agent invented "scene" as a literal node
id) + P2.5.2 PLAN §5 Wave B. The class bug is "agent picks the wrong
target" or "agent invents an id from a prompt placeholder" — both sit
at the seam where natural-language references meet concrete node ids.

**WHY:** Without a first-class identifier stage, every prompt-vs-real-id
mismatch is a variant of H21. Selection context helps when one node is
selected, but "the cube" with three cubes has no commit point where
ambiguity surfaces. The model picks silently; the closure gate (B3, V13)
catches the symptom but not the class.

**HOW:** `agent.identify` runs on round 1 when the heuristic
`shouldRunIdentifyRound(message, selection)` fires (selective
references, explicit identifier markers, or selection present).
Three branches: 'match' commits selectors as turn-local identifiedSelectors
(threaded into closure-spec inference); 'ambiguous' surfaces candidates
to the user and ends the turn; 'no-match' surfaces rationale and ends.
Confidence is derived from candidate count (P-6 mitigation), NOT
model-reported.

**REF:** P2.5.2 PLAN §5 Wave B; `src/agent/identify/identify.ts:1`;
`src/agent/identify/confidence.ts:1`;
`src/agent/orchestrator.ts` (`shouldRunIdentifyRound`,
`parseIdentifyResult`, three-branch dispatch); H21 in
`.anvi/hetvabhasa.md`.

**Silent-failure modes:**
- Heuristic false-negative: a prompt that references existing nodes
  slips past the heuristic; closure gate (B3) catches the resulting
  out-of-scope op. Telemetry tracks per-turn round counts to spot
  drift.
- LLM emits its own confidence in a freeform format (the P-6 risk).
  Mitigated by deriving confidence from candidate count locally; the
  model's self-reported number is ignored.

**Observation targets:**
- For prompts that reference existing nodes: verify round 1 emitted
  a `tool_choice: { name: 'agent.identify' }` request body and that
  the result was 'match' (or 'ambiguous'/'no-match' surfaced cleanly).
- For purely additive prompts: verify Identify did NOT run (P-3
  latency mitigation).
- For multi-target prompts ("each cube", "all spheres", "the
  objects"): verify Identify resolves to ALL matching ids with
  confidence 1.0 (hint auto-promoted to 'multiple-allowed') — added
  P2.5.3 Wave A.
- For verb-noun co-reference prompts ("rotate the cube", "color the
  sphere"): verify Identify runs (the verb-noun heuristic supersedes
  the dropped bare `\bthe\b` trigger) — P2.5.3 Wave A3.
- For color-qualified references ("the red cube"): verify family-
  match accepts off-hex picker colors; pink does NOT match red
  (P2.5.3 Wave C2/C3).

**Span scope (post-P2.5.3):** Identifier resolution covers (a)
exact-id, (b) selection, (c) type-aliased nouns (singular + plural),
(d) generic-primitive aliases (object/thing/everything/nodes),
(e) quantifier-promoted multi-target intent, (f) color-family fuzzy
match. Out of scope (defer): semantic-property references ("the tall
one", "the rotated cube"), spatial references ("the cube on the
left"), temporal references ("the cube I just added"). These are P5+
candidates; live-smoke pressure determines order.

### Boundary B8: Mutator catalog ↔ Op constructor

**ORIGIN:** P2.5.2 PLAN §5 Wave C. B3's hetvabhasa cluster (H19/H20/H21)
shared the same structural gap: every common operation was hand-built
by the LLM each time, with no contract for closure / preconditions /
preserved aspects. The Mutator catalog is the bridge between LLM intent
and the Op vocabulary — Mutators are the consumers of closure +
identifier.

**WHY:** Without a Mutator catalog, dag.exec is the only mutation
surface for the LLM. That conflates "compose any Op chain" with
"perform a known semantic operation". The gap is where bugs at H19's
caliber live: the LLM emits valid ops that target the wrong node,
miss a unit conversion, or violate the schema; Wave A's closure gate
catches the symptom but not the class.

**HOW:** Each `MutatorDefinition` declares spec (zod-validated arg
shape), contract (requiredEdges, requiredNodeTypes, preserves, lossy),
buildClosureSpec, preconditions (shape-only — P-5), and build (Spec +
ClosureSet + DagState → Op[]). The five-gate validator runs on every
plan: existence, schema, closure, preconditions, adapter (P7 stub).
agent.proposePlan is the LLM-facing surface; `dag.exec` stays as raw
escape (mode-gated to copilot/sandbox).

**REF:** P2.5.2 PLAN §5 Wave C; `src/agent/mutators/types.ts:1`;
`src/agent/mutators/validate.ts:1`; `src/agent/mutators/tool.ts:1`;
six starter Mutators in `src/agent/mutators/builders/`.

**Silent-failure modes:**
- Mutator preconditions misalign with reality (P-5 risk).
  Shape-only checks; semantic state ("Navmesh has obstacles configured")
  belongs in build — not in preconditions.
- Catalog drift (P-4). Vyapti V14 is the structural answer: every new
  Mutator must justify non-redundancy at code review.
- Gate 5 (adapter fidelity) stays a stub forever (PLAN R11). Tracked;
  activates at P7 PlayCanvas export.

**Observation targets:**
- For every agent.proposePlan call: verify the JSON return either has
  `ok: true` with closureRoots + warnings, or `ok: false, gate, reason`.
- For "make character walk to (5,0,3)" without a Navmesh: verify gate 4
  fires before any LLM round 2 — the precondition rejects, the
  structured failure threads back via F6, the LLM either retries or
  surfaces to the user.

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

### V13: Closure preservation

**Status:** ALIGNED (P2.5.2 Wave A + Wave C, 2026-05-08)
**Span:** `src/agent/closure/`, `src/agent/diff/store.ts`,
`src/agent/orchestrator.ts`, every Mutator's buildClosureSpec,
`src/agent/mutators/validate.ts` (gate 3).
**REF:** vyapti.md V13.

### V14: Mutator non-redundancy

**Status:** ALIGNED (P2.5.2 Wave C, 2026-05-08) — code-review enforced
**Span:** `src/agent/mutators/builders/*.ts`.
**REF:** vyapti.md V14.

### V15: Workflow strategy fetched lazily, not inlined in system prompt

**Status:** ALIGNED (P2.5.2 Wave D, 2026-05-08)
**Span:** `src/agent/orchestrator.ts` (`buildStaticSystemPrompt`),
`src/agent/strategy/` (catalog + tool).
**REF:** vyapti.md V15.

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

#### Axis: DCC-LLM bridge reference

**ORIGIN:** 2026-05-08, blender-mcp adoption analysis. The question
"should we adopt X from [DCC-LLM bridge]?" recurs as the ecosystem
matures (blender-mcp at 21K stars; Houdini-MCP, C4D-MCP, Maya-LLM
likely to land soon). Each bridge is a reference implementation
mining ground for ideas, not an architectural template.

**WHY this axis exists:** these bridges optimize for *Blender's API
surface* (vast, unbounded — they need `execute_blender_code`).
Basher's DAG vocabulary is *bounded* — we have V1 (op-as-only-mutation
path) + V7 (handlers return Op[]) + diff-first preview. Adopting
their patterns naively imports their compromises. We need a deliberate
filter: take ideas that align with V1/V7; reject ones that violate
them.

**HOW to apply:** when surveying a DCC-LLM bridge (or any LLM-tool
integration), separate ideas into three buckets:
1. **Adopt** — vision/screenshot tools, asset-catalog integrations,
   AI-3D-generation, telemetry, strategy-as-resource patterns.
2. **Defer** — MCP-server-as-additional-surface (v0.6 scope when
   external IDE drive becomes a real ask).
3. **Reject** — arbitrary code execution, direct setState bypasses,
   any pattern that puts the agent on a parallel mutation path.

**Detection signal:** any time research surfaces a popular LLM-tool
bridge. Default action: 30-minute survey, ranked recommendation,
reject-list with reasoning. blender-mcp is the canonical first
worked example.

**Cross-refs:** P2.5.2 PLAN.md (the survey + adoption decisions);
post-blender-mcp commits `a710a9f` (strategy + telemetry) and the
rejected list in PLAN.md §10 (external assets → P3, AI gen → P5,
vision tool → optional pull-forward, MCP server → v0.6+).

#### Axis: Convention boundary (units / coordinate / format)

**ORIGIN:** H20 (rotation units mismatch, 2026-05-07) — silent unit
boundary between user-facing storage (degrees) and engine-layer
consumption (THREE radians). The bug was invisible until the agent's
first non-zero degree input. No existing catalogue axis surfaced it
because the mismatch wasn't a flow bug or a state bug — it was a
*convention* bug.

**WHY this axis exists:** Basher straddles three convention zones:
1. **THREE.js / glTF runtime** — engine-mandated (radians, +Z forward,
   xyzw quaternions, vertical FOV).
2. **DCC user mental models** — Blender / Maya / Houdini / C4D / 3ds Max
   conventions, which the agent's prompts and the human's typing both
   inherit.
3. **Game-engine conventions** — Unity / Unreal / Godot, where Basher's
   eventual export targets live (P7 PlayCanvas, plus Unity/Unreal
   future).

These three diverge on roughly 20 named decisions (rotation units,
position units, axis up, color space, time representation, FOV
direction, Euler order, quaternion order, etc.). Each silent boundary
is a candidate H-class bug.

**HOW to apply:** before introducing ANY new value-typed field on a
node, agent tool, or persisted format, check `.anvi/dcc-reference.md`.
The doc lists every convention question with the canonical answer
across the five DCCs + three engines + glTF + THREE. The check
prevents recurring H20-class bugs by making the convention boundary
explicit at design time, not at first-bug time.

**Detection signal that this axis is active:** any time the question
"which units?" / "which order?" / "which format?" comes up. Default
answer: consult dcc-reference.md FIRST, then decide. If the doc doesn't
cover the question, add a section to it before picking a side.

**Cross-refs:** `.anvi/dcc-reference.md` (the lookup), H20 (first
catalogued instance).

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

**Updated:** 2026-05-07 — post-CI-fix train (PR #6: prettier + Linux baseline + P1#4 race guard):

- **H16 added** to hetvabhasa: "Test dispatches asset-dependent op before OPFS seed lands → empty blob → `<GltfAssetR>` throws → ErrorBoundary unmounts the entire React tree → black page → every subsequent assertion times out with the wrong-looking 'element(s) not found' surface error." Promoted on first observation because the diagnostic cost was high enough to warrant immediate cataloguing — without the trace screenshot the surface error misleads the investigator into debugging mode-switch / SceneTree mounting / store reactivity, none of which is the cause.
  - **ORIGIN:** PR #6 CI failure on `tests/e2e/p1-acceptance.spec.ts:258` (P1#4). Symptom-vs-cause gap was extreme (5+ inferences off the trail before the screenshot was checked).
  - **WHY:** R3F's ErrorBoundary unmount-on-throw is invisible at the assertion layer. Future asset-dependent CI tests will hit this same race if added without the library-availability gate. Without the entry, every recurrence costs another full investigation cycle.
  - **HOW:** the entry's "real fix" block names the gate pattern explicitly; "detection signal" pairs the surface error with the trace's `pageError` events so the next investigator skips the inference detour.

- **Meta-pattern flagged inside H16 (not yet a separate entry):** speeding up CI exposes pre-existing races that slow upstream tests were silently masking. Holding off on a separate entry until the second occurrence per dharana promotion criteria. Recurrence trigger: any future "fix one CI test → unrelated CI test newly fails" sequence.

- **Fatality test (post-CI-fix, 2026-05-07):**
  1. Hetvabhasa clustering: 16 entries (added H16). Test/observation cluster grows to H6/H8/H11/H13/H16 — five entries, but each at a structurally different mechanism (overlay text, platform suffix, R3F primitive prop crash, layout-shift baseline, async-seed race). No 3+ clustering at a single mechanism. Cluster is a _category_ (test/observation boundary), not a _single fault line_.
  2. Vyapti span: V1-V10 unchanged. The fix is in test code only; no production invariant moved.
  3. Krama crossing: no new lifecycle. The test itself uses K6's library-seed pattern (already cataloged) — the fix just makes P1#4 honor an existing krama, doesn't introduce a new one.

  **Verdict: organization still sound after the CI-fix train.** The repeat-rate at the test/observation boundary (5 of 16 entries) is the highest-density cluster — but the underlying mechanisms are distinct. If a third async-seed-race entry lands, that's the trigger to consolidate into a vyapti ("every test that depends on async-seeded state must wait on a seed-availability signal").

  **Next update trigger:** unchanged — P2.5 (AI Agent on DAG).

**Updated:** 2026-05-08 — post-P2.5.1 correctness train + P2.5.2 plan committed (NOT executed):

- **P2.5.1 shipped (commits 1ae2c92 → de84341 → a266e03):** orchestrator
  rewrite + 8 correctness fixes (F1-F8 from AGENT.md analysis), Tailwind
  AgentChat refactor, AGENT.md doc, H20 (rotation units → degrees in DAG,
  radians at THREE seam), dcc-reference.md (20-section convention lookup
  + V12 invariant), H21 (anchor placeholder bug + Anchors block in
  per-turn context). Wire format now OpenAI-spec-correct (assistant
  {tool_calls} → role:'tool' with tool_call_id) — testable on Claude /
  GPT-4o via OpenRouter.
- **B3 (Agent ↔ DAG)** observation targets extended for selection
  context check + multi-turn drift check.
- **B4 (Node evaluator ↔ time/randomness)** unchanged — V2 + V3 still
  ALIGNED post-rewrite (rotation conversion lives in viewport, not in
  evaluator; purity preserved).
- **New axes activated:** convention boundary (post-H20 + dcc-reference);
  DCC-LLM bridge reference (post-blender-mcp survey, 2026-05-08).
- **P2.5.2 plan committed (62d58f1 + a710a9f):** four-wave pipeline
  hardening (closure preservation + Identify stage + Mutator catalog +
  catalogue/strategy/telemetry). 36-46h scope. NOT executed yet — picks
  up in next session via `.planning/p2.5.2-agent-pipeline/PLAN.md`.

- **Fatality test (post-P2.5.1, 2026-05-08):**
  1. Hetvabhasa clustering: 19 entries (added H19, H20, H21 since P2.5).
     Three new entries cluster at the agent boundary (B3) — three
     occurrences within one milestone is the consolidation trigger.
     **Verdict:** consolidate B3's hetvabhasa cluster into a vyapti
     once Wave C lands ("every agent edit goes through a Mutator with
     declared closure + preconditions"). Already specified in PLAN.md
     as V13 + V14.
  2. Vyapti span: V11 (selection wiring), V12 (convention declared) ALIGNED.
     V13/V14/V15 planned, NOT YET IMPLEMENTED — Wave A-D will land them.
  3. Krama crossing: K3 (agent tool dispatch) extended with multi-turn
     loop in P2.5 v2; will extend further with Identify stage in Wave B.
     No new lifecycle crossings 3+ module boundaries.

  **Verdict: organization remains sound after P2.5.1.** B3's
  three-pattern cluster is a *cluster of similar mechanisms*, not a
  structural fatality — closure preservation + Mutator preconditions
  (P2.5.2 plan) is the right structural answer. No restructuring;
  invariant tightening.

  **Next update trigger:** Wave A completion (closure expansion +
  preservation gate ships) → V13 flips to ALIGNED.

**Updated:** 2026-05-07 — post-P2.5 v2 (multi-turn agent loop + selection context):

- **B3 (Agent ↔ DAG) now exercised end-to-end with multi-turn.** Surface widened from 4 macros → 6 tools (added universals `dag.inspect` + `dag.exec`). Orchestrator runs up to 3 rounds: inspect → results fed back → exec. `ToolResult { ops, text }` separates read-only return (text) from mutation return (ops). `selectedNodeIds` now flows ToolContext-deep into the system prompt (id, type, current params for every selected node).

- **V11 added (ALIGNED):** Agent tool context must carry selection state. Span: `src/agent/tools/types.ts` (ToolContext shape) + `src/agent/orchestrator.ts:180` (dispatch) + `:247-256` (system prompt builder) + `src/app/AgentChat.tsx:34` (read at send time). No multi-module entanglement — single concern (selection wiring through one path), four sites that mirror the Op-emit chain.

- **H19 added** to hetvabhasa: Zustand `getState()` snapshot stale after `set()` — user message lost. Sister to H10 (same mechanism in test code). The orchestrator captured `sessionStore = useAgentSessionStore.getState()` at function start, then called `addMessage(...)` which `set()`s a NEW state object; subsequent reads of the captured `sessionStore.session.messages` saw the pre-`addMessage` snapshot, so the user's current message was never in the API request body. Real fix: read fresh at every access (`useAgentSessionStore.getState().session.messages`) and use the `message` param directly in follow-up prompt construction. **The single observation that diagnosed this:** logging the API request body and seeing the `messages: []` array missing the user turn. Without that observation, the symptom ("agent rotates everything") points at prompt tuning or LLM behavior — both wrong frames.

- **B3 observation targets extended** with two project-specific checks (above):
  1. Selection context check — verify `Selected nodes:` block in system prompt before pronoun/selection turns.
  2. Multi-turn drift check — verify original user request appears verbatim in the follow-up after `dag.inspect`.

- **Known gaps (NOT bugs, deferred to P3):**
  - Multi-turn reliability: follow-up message doesn't restate selection IDs (system prompt has it, but worth verifying under model variance).
  - `dag.inspect` output appended as plain text, not structured `tool_result` — works for Gemma 4, suboptimal for stricter models.
  - No session persistence (localStorage chat history).
  - No settings UI (API key / model / base URL).
  - Server EPERM after bad `pkill -f node` — operational, not architectural.

- **Fatality test (post-P2.5 v2, 2026-05-07):**
  1. Hetvabhasa clustering: 17 entries (added H19). H10 + H19 share the Zustand stale-snapshot mechanism but at different surfaces (test code vs. orchestrator) — two cataloged occurrences. Third occurrence triggers consolidation into a vyapti ("any closure capturing `getState()` across `set()` boundaries must re-read"). Watch for it.
  2. Vyapti span: V11 added (ALIGNED). 4-site span all within the agent surface (types + orchestrator + AgentChat) + ReadOnly contract from selectionStore — single concern, complementary sites, no module entanglement. V1-V10 unchanged.
  3. Krama crossing: K3 (agent tool dispatch) extended with the multi-turn loop — same atomic shape, just iterated up to 3× per turn. No new lifecycle crosses 3+ module boundaries.

  **Verdict: organization still sound after P2.5 v2.** B3's silent-failure mode list now has empirical content (was speculative pre-P2.5). Selection-context wiring through ToolContext is the right cut — placing it on the dispatcher closure instead of forcing each tool to import the selection store would have created a per-tool span that V11 explicitly avoids.

  **Next update trigger:** P3 — agent reliability tuning + persistence + settings UI + new macro tools (node.delete, material.setColor, animation.play).

**Updated:** 2026-05-08 — post-P2.5.2 (Waves A+B+C+D shipped):

- **Wave A** — closure expansion + preservation gate. `src/agent/closure/`
  + `src/agent/diff/store.ts` propose-time gate. V13 flips to ALIGNED.
  Per-edge-kind BFS with shared visited-set + maxDepth 256 (P-1 cycle
  mitigation). Each declared kind runs its own per-root BFS — no
  free-mixing of 'parent' and 'children' (the early bug that would have
  leaked siblings into the closure was caught in unit tests before
  shipping). Orchestrator infers closure from selection or
  identifiedSelectors; falls vacuous when no roots → additive prompts
  unchanged.
- **Wave B** — two-stage Identify → Plan. `src/agent/identify/`. New
  boundary B7 (Agent identifier ↔ DAG node-set). Pure local resolver
  (no LLM round needed — model just constructs the query). Confidence
  derived from candidate count (P-6). Heuristic
  shouldRunIdentifyRound skips Identify on additive prompts (P-3).
  Three branches: match → identifiedSelectors threaded into closure
  inference; ambiguous → candidate list to user; no-match → rationale.
- **Wave C** — Mutator catalog with five-gate validator. Six starter
  Mutators (rotate, translate, scale, setMaterialColor, duplicate,
  deleteNode). New boundary B8 (Mutator catalog ↔ Op constructor). V14
  flips to ALIGNED (code-review). Mutator-declared closure overrides
  Wave A's selection-inferred fallback; gate 3 reuses Wave A's gate.
  agent.proposePlan returns ops or {ok:false, gate, reason} the LLM
  reacts to.
- **Wave D** — strategy resources + telemetry. `src/agent/strategy/`
  + `src/agent/telemetry/`. V15 flips to ALIGNED. System prompt's
  inline paramTips (units + materials) lifted into the strategy
  catalog; prompt keeps a one-line pointer. Telemetry recorder is
  opt-in localStorage by default; killswitch via env or localStorage;
  no PII (tool name + outcome + duration only); allowlist of known
  tool names blocks accidental leak through.

- **Hetvabhasa update:** no new H entries surfaced during execution —
  the planning was thorough enough that the only genuine bug
  discovered (the 'parent'/'children' free-mixing in BFS) was caught
  by the test suite before commit. Catalogued as a comment in
  `src/agent/closure/expand.ts:41` rather than as a hetvabhasa entry
  — single-occurrence near-misses caught in test go to memory not
  catalogue (per dharana promotion criteria).

- **Fatality test (post-P2.5.2, 2026-05-08):**
  1. Hetvabhasa clustering: 19 entries (no new). H19/H20/H21 cluster
     at B3 — Wave A/B/C consolidate the cluster into V13 (gate) +
     V14 (catalog) + B7 (identifier seam) + B8 (mutator seam). The
     cluster's *mechanism* is now structurally addressed; future
     B3-class bugs land at gate-rejection time with structured
     failures, not as silent symptoms.
  2. Vyapti span: V13 + V14 + V15 added. V13 spans
     `src/agent/closure/` + `src/agent/diff/store.ts` +
     `src/agent/orchestrator.ts` + every Mutator's buildClosureSpec.
     V14 spans `src/agent/mutators/builders/` (code-review-only —
     no module entanglement). V15 spans
     `src/agent/orchestrator.ts:buildStaticSystemPrompt` +
     `src/agent/strategy/`. Each invariant has a single-concern
     enforcement site; no cross-module entanglement.
  3. Krama crossing: K3 (agent tool dispatch) extended with the
     conditional Identify pre-stage. Same atomic shape, just one
     more round when the heuristic fires. No new lifecycle crosses
     3+ module boundaries.

  **Verdict: organization remains sound after P2.5.2.** B3's
  three-pattern hetvabhasa cluster (H19/H20/H21) is now closed by
  three structural invariants (V13 + V14 + V11) — the *cluster
  mechanism* is mechanically rejected at the gate. The DCC-LLM
  bridge axis (added pre-P2.5.2) has its first worked example: the
  blender-mcp survey's strategy-resource pattern + opt-in telemetry
  pattern were adopted; arbitrary code execution + direct setState
  bypasses were rejected.

  **Next update trigger:** P3 (timeline / animation nodes) —
  KeyframeChannel<T> Mutators land. Closure follows new edge kind
  'animation'. New strategy resource: animation. Telemetry tracks
  animation-Mutator usage.

**Provenance:** Updated 2026-05-08 — post-P2.5.2: V13 + V14 + V15
added; B7 + B8 boundaries added; DCC-LLM bridge axis activated with
the blender-mcp survey as the first worked example; strategy-resource
+ opt-in telemetry patterns adopted; six starter Mutators registered;
agent.identify + agent.proposePlan + agent.listStrategies +
agent.getStrategy tools added (registry now 11). H19/H20/H21
mechanism class structurally closed by V13 + Wave B Identify stage +
Wave C Mutator catalog.

**Updated:** 2026-05-09 — post-P3 (Timeline = animation nodes):

- **B7 (Agent identifier ↔ DAG node-set) span scope extended** to
  include animation references: channel ids by paramPath (e.g.
  `<targetId>_position_channel` is the deterministic id addChannel
  emits), AnimationLayer ids by wrapped target, and
  natural-language keyframe references ("the bouncing keyframe", "every
  channel on the cube") which the agent.identify resolver already
  passes through via the type-alias / generic-noun branches added in
  P2.5.3. The animation surface adds no new identifier-resolution
  failure mode; H21 / H24's mitigations cover it directly.

- **B8 (Mutator catalog ↔ Op constructor) extended.** Catalog grows
  6 → 10. Four new Mutators land: `mutator.timeline.addLayer`,
  `mutator.timeline.addChannel`, `mutator.timeline.keyframe`,
  `mutator.shot.create`. V14 (non-redundancy) holds — each new
  signature is unique vs the existing six, mechanically asserted
  in `mutators.test.ts` "V14 contract signature" test. Closure
  spec for addChannel walks `'animation'` so layer's existing
  channels sit alongside the layer root in scope (gate 1
  contract_edges); keeps future "diff against existing channels"
  preconditions cheap.

- **H22 (per-edge-kind BFS isolation) holds under live socket.**
  P3 Wave A is the first time the `'animation'` edge kind has a
  real socket on a registered node type (`AnimationLayer.inputs.animation`,
  cardinality:list). Closure tests in `expand.test.ts` confirm:
  rooted at layerA with `followedEdges:['animation']`, walker
  reaches chA only — sibling layerB's chB does NOT leak; walker
  doesn't free-mix into 'children' (boxA stays out of scope).
  Per-kind BFS rooted-at-rootSelectors discipline preserved.

- **New strategy resource `animation` (V15 lazy)** lays out the
  three-Mutator sequence (addLayer → addChannel → keyframe ×N)
  for the LLM. STRATEGY_TOPICS exhaustive check enforces drift —
  adding a topic without updating the zod enum fails tsc.

- **AnimationLayer evaluator patches channel values into a deep-
  cloned target at paramPath.** Number/Vec3 weight-blend toward
  the static value; Quat/Color snap at the half-weight mark
  (slerp/HSL-lerp partial blending deferred until weight<1 is
  authored). `target` output retypes 'AnimationLayer' → 'Mesh'
  so the layer inserts transparently in scene chains, mirroring
  Transform's wrap.

- **DiffBar gains a time-range indicator.** Walks pending op chain
  for explicit time values (KeyframeChannel keyframes, Shot
  bounds, setParam keyframes/time). Hidden when no temporal data
  present — non-animation diffs unaffected.

- **Fatality test (post-P3, 2026-05-09):**
  1. Hetvabhasa clustering: 24 entries, no new H from P3 work.
     The animation surface didn't surface a new failure class —
     P2.5.2's structural answers (V13/V14, gate-validator) caught
     every wiring mismatch in dev (e.g. addChannel's
     contract_edges declaration vs followedEdges; resolved at
     test time, not in production). No B-boundary newly clusters
     3+ patterns.
  2. Vyapti span: V13 + V14 + V15 ALIGNED status verified —
     animation Mutators all declare buildClosureSpec, gate 3
     accepts on closure-rooted ops, V14 non-redundancy mechanical
     guard passes. No invariant span widened.
  3. Krama crossing: animation playback adds no new lifecycle
     beyond K3's atomic Mutator dispatch (single round → ops →
     V13 gate → propose → accept → dispatchAtomic). The
     channel-application step lives entirely inside
     AnimationLayer.evaluate — single-module concern, no crossing.

  **Verdict: organization remains sound after P3.** The
  animation surface integrates cleanly through the existing
  Mutator + closure machinery. The dopesheet/curve editor are
  pure projections of the DAG — V8 file-rooted holds (dispatch
  stays in `src/app/timeline/`, never `src/timeline/`).

  **Next update trigger:** P3.1 (BVH + FBX + Mixamo retargeting).
  Expect a new bone-name-resolution boundary class — sister to
  H21 at the rig boundary. Promote to a new dharana boundary B9
  if a second name-mismatch bug surfaces.
