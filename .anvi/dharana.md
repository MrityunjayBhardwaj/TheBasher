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

### Boundary B1.1: Gizmo proxy ↔ evaluated-scene (the #68 boundary-pair)

**ORIGIN:** issue #68 / Phase 7.3 — the transform gizmo seeded from `node.params.position` (static authored source) while the rendered cube is the AnimationLayer's evaluated patched clone; once a param was animated they diverged and the gizmo froze at the authored point for the whole animation. P7's E2 motion gate asserted the EVALUATOR output and NEVER the gizmo proxy — a boundary-pair gap (only the producer side was observed).
**WHY:** This is the silent-failure that SHIPPED precisely because only one side of the boundary was observed. Without this entry tracked, the next wrapper-stale-surface bug (the open NPanel-live-values sibling, a future viewport HUD/handle) gets diagnosed from scratch and the named "evaluate the node" trap (returns the RAW value, not the patched clone) is re-attempted. Removing this entry reopens the H40 class as an empirical rediscovery instead of a deductive lookup.
**HOW:** one pure resolver (`resolveEvaluatedTransform`) mirrors the renderer's scene-child index-correspondence + unwraps the AnimationLayer patched clone (Chesterton — the SceneFromDAG mechanism already exists; do not invent a parallel walk). Every surface needing "where it actually renders" consumes that one helper. Consumers (2 as of 2026-05-19): (1) **Gizmo** (`src/app/Gizmo.tsx`) — direct consumer; the manip proxy seeds from the resolver, D-01 layer-select synthesize. (2) **NPanel Inspector** (`src/app/NPanel.tsx`) — via the transform-param adapter `src/app/resolveTransformParam.ts` (per-param view over the resolver; the read-only-while-playing gate is `playing && resolved !== null`). The reusable diagnostic question: "which side of the producer/consumer boundary did I observe — the evaluator, or the surface?"
**REF:** issue #68, #69 (NPanel sibling, CLOSED 2026-05-19), #77 (open H36-on-second-surface follow-up), hetvabhasa [[H40]] (the pattern, cross-ref H22/H34/H36), CONTEXT D-01/D-05/D-06 (7.3) + D-01/D-04/D-06 (7.4), `src/app/resolveEvaluatedTransform.ts`, `src/app/resolveTransformParam.ts`, `src/app/Gizmo.tsx`, `src/app/NPanel.tsx`, `tests/e2e/p7.3-gizmo-evaluated-transform.spec.ts`, `tests/e2e/p7.4-npanel-evaluated-display.spec.ts`.
**Provenance:** 2026-05-19 (Phase 7.4): NPanel landed as the second consumer via `resolveTransformParam` (commit `b0ac811`, helper `1510f1b`); D-06 boundary-pair gate `tests/e2e/p7.4-npanel-evaluated-display.spec.ts` green (3 tests, commit `1a8eb48`); #69 closed; K13 non-regression re-proven (W9 perf p95 9.10ms, IMPROVED vs 7.3 baseline 9.70ms). No new dharana entry — same boundary class, second consumer at it.
2026-05-19 (P7.4 ext): inspector commit unified onto the shared `routeAnimatedGrab` chokepoint (D-05); #77 + #78 closed; H36 now holds on both gizmo + inspector surfaces.
**Silent-failure modes:** a UI surface (gizmo, inspector field, HUD, handle, label) freezes at the authored `params` value while the rendered object animates/overrides away from it; "evaluate the node" re-introduces the stale value one indirection deeper; a unit test that asserts only "it changed" passes against the wrong source.
**Observation targets:** **boundary-pair (now per-consumer) — for EACH UI surface bound to source-params on a wrappable node, the surface value == the evaluated render-walk value at ≥2 distinct playhead times, for box-select AND layer-select.** Gizmo: `p7.3-gizmo-evaluated-transform.spec.ts` assertion 1. Inspector: `p7.4-npanel-evaluated-display.spec.ts` test 1. The next consumer (future HUD / snap guide / overlay label) MUST land a sibling spec — the per-consumer pattern is the structural defense. Plus: the resolver runs at playhead-change cadence in the React seeding effect, NOT the W9 rAF loop — re-run the W9 240-frame 60fps gate as the K13 non-regression acceptance (observed p95 9.10ms ≤ 16.6ms ≤ 10.67ms 10%-drift soft gate; vs 7.3 baseline 9.70ms — no regression introduced by adding a second consumer).

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

### Boundary B11: Design spec ↔ source code (UI-SPEC authoring + re-validation boundary)

**ORIGIN:** P6 W1 (2026-05-10). D-UX-8 was authored from memory of file _names_ (Inspector.tsx + NPanel.tsx — sounded like duplicate inspectors) without reading either file. Observation at W1 start revealed they have orthogonal roles. Decision was retracted; spec was patched mid-wave; one round-trip lost. **Update P6 W2.6 (2026-05-11):** the W1 correction was _itself_ reversed two waves later, when W2's TopToolbar absorbed NPanel's mode + snap groups and W7 was already slated to take grid/axis toggles. NPanel ended up with nothing unique left; the merge unblocked itself. User pushed merge forward to W2.6; spec restored to original direction. Two reversals on the same decision in 5 commits.

**WHY:** the W1 lesson was "don't lock from memory before reading code." The W2.6 lesson is the deeper one: **spec entries asserting surface distinctness decay across waves**. A claim like "X and Y are not duplicates because each has unique sections {Y₁, Y₂, Y₃}" is a _conjunction_; any wave that absorbs Y_i into a third surface erodes the conjunction silently. Without a re-validation cycle, the spec's earlier "they're distinct" verdict reads as authoritative even when the underlying premises have evaporated. Both kinds of drift (initial-authoring memory error, mid-roadmap conjunction decay) silently mislead downstream waves. The boundary's WHY now covers both phases, not just the first.

**HOW (authoring-time):** before any "merge / delete / replace" decision lands in a spec's locked-decisions table, open every file the decision names. Write a one-sentence functional description per file. Only if the descriptions semantically overlap does the merge framing apply.

**HOW (re-validation, NEW W2.6):** every wave plan that touches multi-surface chrome (TopToolbar, ToolRail, FloatingViewportToolbar, NPanel, LeftSidebar tabs, AddMenu/AssetsPopover) runs a _section inventory pass_ over any spec entry of the form "X and Y serve different roles":

1. List each surface's _current_ unique sections (from code, not from memory).
2. Cross-check against the spec's distinctness claim.
3. If any surface's unique-section count drops to ≤ 1, flag the merge as unblocked and update the spec entry's status, even if the merge isn't yet executed.
4. Surface candidates to re-validate at every wave: AddMenu / AssetsPopover (creation vs asset import); LeftSidebar Scene tab / Agent tab (DAG view vs LLM chat); future Inspector Render section / external CostPreview mount.

**REF:** docs/UI-SPEC.md §1 D-UX-8 (the swing → restore ledger captures provenance for both reversals); §5.8 NPanel canonical Inspector (W2.6); hetvabhasa H25 (initial-authoring trap); hetvabhasa H27 (re-validation-cycle trap — the W2.6-revealed iteration); P6 W1 commit `5a71e67` + P6 W2.6 commit `c19b43a`.

**Silent-failure modes:** (a) decision locked from memory at authoring → downstream wave acts on it → code break surfaces only when test exercises the deleted/merged surface OR user encounters broken affordance; (b) decision _was_ correct at authoring but adjacent chrome evolved → distinctness claim now false → merge stays scheduled for a far-future wave (or never) while the redundant surface confuses users every session; (c) re-validation pass skipped → next chrome wave inherits the stale claim → cycle repeats.

**Observation targets:** every D-UX entry in a spec carries either a `**REF:**` to file:line that's been opened during authoring, OR a `**TODO: observe**` flag. Spec-checker (anvi-ui-checker) treats unobserved files in a locked decision as a BLOCK verdict. **Additional W2.6 target:** every wave plan touching multi-surface chrome adds a "section inventory" step that re-runs §B11 HOW (re-validation) over distinctness claims, with output recorded in the wave's plan as either "no shifts" or "{D-UX-N} restored / overridden / advanced".

**W3 section-inventory pass (2026-05-12):** ran B11 HOW (re-validation) over the surfaces W3 touches:

| Surface pair                                                                                                                                                                                   | Inventory result                                                                                                                                                                                                                                                                     | Verdict   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| AddMenu (4 groups: Mesh/Light/Camera/Empty, 11 procedural items) vs AssetsPopover (3 bundled glTF tiles via DRAG_MIME drop chain)                                                              | Disjoint: AddMenu spawns procedural primitives via `buildAddPrimitiveOps` + dispatchAtomic; AssetsPopover triggers HTML5 drag onto AssetDropZone. Zero section overlap.                                                                                                              | no shifts |
| LeftSidebar Scene tab (DAG tree, drag-reorder, K6 asset-drop integration) vs Agent tab (LLM transcript, mode selector, tool-call rows)                                                         | Orthogonal domains (scene hierarchy vs LLM chat). Zero section overlap.                                                                                                                                                                                                              | no shifts |
| ProjectTabs (R1: always-visible strip with select/close/new/dirty-dot/tooltip + ComfyStatusIndicator host on right edge) vs ProjectsMenu (popover with full CRUD: new/duplicate/rename/delete) | Share one read seam (`listAllProjectMetadata`) but UI affordances disjoint. ProjectTabs = always-visible switch + status; ProjectsMenu = on-demand CRUD. Both surfaces emit `createNewProject`/`deleteProject`/`switchProject` through the same boot helpers — single mutation path. | no shifts |

**Future re-validation triggers:** (a) ProjectsMenu absorbs ComfyStatusIndicator or unsaved-indicator → ProjectTabs may become redundant; (b) Agent tab keyframe badges migrate to timeline dock → Scene tab loses Animate-mode unique section, may merge with Agent; (c) AddMenu absorbs glTF import via virtual entries → AssetsPopover may collapse to the drag surface only. Each future chrome-touching wave runs this inventory afresh.

**W4 section-inventory pass (2026-05-12):** ran B11 HOW over the surfaces W4 touches:

| Surface pair                                                                                                                                                                        | Inventory result                                                                                                                                                                                                                                                                                                                         | Verdict                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------- |
| NPanel section cards (Transform/Mesh/Material/Render/Animate/Channel/Layout — 7 declared sections) vs NPanel raw-fallback (flat param renderer for nodes without inspectorSections) | Disjoint by design: sectioned path renders cards per declared section; raw-fallback renders single flat list under `inspector-raw-fallback` testid. The two paths are mutually exclusive per node — selection check is `declared.length === 0`. Raw-fallback is the _escape_ path for legacy/glue nodes; never co-renders with sections. | no shifts (intentional | /either) |
| inspectorSections (per-node-type registry declaration) vs paramToSection (predicate-based param router)                                                                             | Complementary, not redundant. Registry declares _which sections apply_ to a node type; predicate routes _which params land in each section_. Adding a new node type requires registry declaration; adding a new param to an existing section just extends the predicate. No duplication.                                                 | no shifts              |
| Section catalog (§5.8: 7 entries) vs §7.2 multi-select sections (`['Transform', 'Metadata']`)                                                                                       | Spec internal: §7.2 references 'Metadata' which is NOT in §5.8's catalog. Locked D-10 A: multi-select uses `['transform', 'layout']` (Layout substitutes for Metadata since Layout is the catalog's "always last; positioning hints" entry). Documented in `MULTI_SELECT_SECTIONS`.                                                      | resolved via D-10      |

**W4 re-validation triggers:** (a) new node types added that should fit existing sections but lack inspectorSections — registry-snapshot test would catch silent omission only for the buckets we explicitly probe; (b) new section ids added to the catalog → must update SECTION_IDS + paramToSection predicate + node declarations; (c) §7.2 'Metadata' gets a real home in the catalog → MULTI_SELECT_SECTIONS narrows back to its original spec wording. Each future Inspector-touching wave re-runs the §5.8 catalog vs registry-declared coverage check.

**W5 section-inventory pass (2026-05-13):** ran B11 HOW over the surfaces W5 touches:

| Surface pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Inventory result                                                                                                                                                                                                                                                                                                                                                                                       | Verdict                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `src/timeline/Dopesheet.tsx` (collectLayers + LayerRowControls mute/solo + ChannelRowView with per-channel diamond markers across ALL channels + orphan-channels section + DopesheetHeader tick marks every 0.5s + EmptyHint + absolute-`<div>` playhead, ~275 LOC) vs `src/timeline/CurveEditor.tsx` (reads single `activeChannelId` from `timelineSelection` + `expandToTracks` Vec3→3 RGB polylines + `sampleTrack` interpolation @ 30 samples/s with `smoothstep` Bézier easing + `computeRange` Y-padding + circle keyframes + Quat/Color placeholder + SVG `<line>` playhead, ~210 LOC) | Disjoint domains: keyframe geometry across ALL channels grouped by layer vs interpolated continuous curve of ONE channel. Different store subscriptions (`useSelectionStore.primaryNodeId` + `useDagStore.state.nodes` vs `useTimelineSelection.activeChannelId` + same DAG slice). Different render primitives (HTML/CSS layout vs SVG). Different playhead implementations. Zero functional overlap. | no shifts — D-UX-2 split justified at code level |
| Tab strip header (TabButton + Frame/FPS readout) vs existing Timebar (always-visible scrub bar below the drawer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Disjoint: tab strip is gated on `timelineDrawerOpen === true` and lives INSIDE the drawer body header. Timebar lives outside the drawer body, always visible, and owns playhead scrub. Both read from `timeStore` but neither dispatches; no shared visual region.                                                                                                                                     | no shifts                                        |
| `timelineDockStore.activeTab` vs `viewportStore.timelineDrawerOpen`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Complementary, not redundant. `timelineDrawerOpen` answers "is the drawer expanded at all?" (default false, preserves pixel baselines); `activeTab` answers "which pane shows when expanded?". Both persist independently. Closing the drawer does NOT clear the tab choice — when the user re-opens, they return to the tab they left.                                                                | no shifts                                        |

**W5 re-validation triggers:** (a) future Timebar absorbs Frame/FPS readout → DockHeader's right-side readout becomes redundant (would collapse to tab strip only); (b) keyboard shortcut for tab switching (Tab? Shift+Tab?) lands in W6 → tab-strip click handler becomes one of several entry points to `setActiveTab`; (c) ~~imperative TimelineCanvas (W9) replaces SVG Curve Editor rendering~~ **CORRECTED 2026-05-15 (W9 discuss, D-W9-2):** W9 replaces the **Dopesheet** (HTML/CSS DOM diamonds), NOT the SVG CurveEditor. CurveEditor stays SVG + declarative playhead. Tab boundary unaffected; the _Dopesheet pane content_ swaps to a canvas-2D surface; (d) track-ops bottom toolbar lands in W6 → new "actions row" inventory pair vs existing tab strip + Timebar.

**W6 section-inventory pass (2026-05-13):** ran B11 HOW over the surfaces W6 touches:

| Surface pair                                                                                                                | Inventory                                                                                                                                                                                                                                                                                                                                                           | Verdict                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| W5 tab strip (28px top of body) vs W6 bottom toolbar (28px at body bottom: `[Key][Delete][Simplify…][Clear]`)               | Disjoint visual + functional regions. Top = read-only status (Frame/FPS) + tab navigation. Bottom = Mutator-dispatching action buttons gated on (channelId, keyframeId) selection state. No shared testids; no shared dispatch path.                                                                                                                                | no shifts                              |
| Global `KeyboardShortcuts.tsx` handler vs proposed Animate-only branches (Space/K/`[`/`]`/Delete-override)                  | Complementary, extends same file with mode-gated `if (editorMode === 'animate')` branches. Keys Space, K, `[`, `]` were previously unused; Delete branch _overrides_ existing node-delete only when `activeKeyframeId` is set (early return), preserving edit-mode semantics.                                                                                       | no shifts                              |
| Toolbar dispatch path vs Keyboard dispatch path                                                                             | Single source of truth: both routes funnel through the same pure helpers (`buildKeyframeInsertOp`, `buildKeyframeDeleteOp`) exported from KeyboardShortcuts.tsx. Toolbar Clear and Simplify go through validatePlan + dispatchAtomic (Mutator path) — same five-gate validation as agent calls. V1 (Op-system) preserved.                                           | no shifts                              |
| `mutator.timeline.keyframe` (existing) vs `mutator.timeline.simplifyChannel` (new) vs `mutator.timeline.clearChannel` (new) | All three target KeyframeChannel nodes. V14 (Mutator non-redundancy) initially collided — fix: extend `PreservedAspect` with `'animation-shape'` + `'keyframe-density'`. Three distinct contract signatures: keyframe preserves both, simplify preserves shape only (lossy density), clear preserves neither (lossy both). Genuinely distinct semantics, not gamed. | resolved via PreservedAspect extension |
| SimplifyPopover (new chrome) vs existing popover precedents (AddMenu, AssetsPopover, ProjectsMenu)                          | Pattern reuse — `bottom-full right-0 absolute` card + click-outside + Esc dismissal. No global modal infra introduced. testids: `simplify-popover`, `…-input`, `…-apply`, `…-cancel`, `…-error`.                                                                                                                                                                    | no shifts (pattern reuse)              |
| Existing `Tab` keybinding (3D ↔ UV) vs W5-deferred "dock tab-switch keyboard"                                               | Resolved by D-W6-5 = drop entirely. No replacement key worth the discoverability cost. Mouse-only tab switching for v0.5.                                                                                                                                                                                                                                           | resolved: dropped                      |

**W6 re-validation triggers:** (a) W7 FloatingViewportToolbar adds new buttons in a 4th visual region → re-inventory toolbar regions; (b) Insert blank frame / Cut/Copy/Paste land later → bottom toolbar grows, need to verify §5.9 button order; (c) keyframe drag (W9 imperative) adds a 2nd `activeKeyframeId` setter path → re-validate single source of truth; (d) Quat/Color simplify becomes supported → simplifyChannel's no-op branch shrinks, may invalidate W6#7 spec's implicit Number-only assumption.

**W7 section-inventory pass (2026-05-14):** ran B11 HOW over the surfaces W7 touches:

| Surface pair                                                                                                | Inventory                                                                                                                                                                                                                                                                                                                                                                                         | Verdict                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R3 TopToolbar.TransformToolbar.ModeGroup (gizmo Sel/Mv/Rot/Scl) vs R8 FloatingViewportToolbar gizmo buttons | Pre-declared at W2 authoring (`TopToolbar.tsx:8-11` + `TransformToolbar.tsx:155-159`: "W7 absorbs gizmo + grid + persp/ortho; TransformToolbar split apart"). C1 added R8; C2 deleted TransformToolbar.tsx entirely; SpaceGroup inlined into TopToolbar. Asymmetric writer (TransformToolbar.ModeGroup wrote `gizmoStore.mode` direct, not `editorStore.activeTool`) eliminated.                  | **advanced** — W7 executed the pre-scheduled split                                |
| R4 ToolRail Sel/Mv/Rot/Scl vs R8 Sel/Mv/Rot/Scl                                                             | Distinctness via location (R4 = persistent left edge, R8 = contextual bottom-near-viewport); both dispatch through `editorStore.setActiveTool` per D-W7-2 (V19). Spline pattern preserves both surfaces. e2e P6.W7#2 + #3 + #4 verify 3-way sync (R4 ↔ R8 ↔ keyboard W/E/R) end-to-end.                                                                                                           | no shifts (distinctness preserved by location + dispatch unified)                 |
| R3 TopToolbar Shading/Snap/Space groups vs R8                                                               | Spec §5.7 originally silent on these. **D-W7-3 amendment:** Shading + Snap migrate R3 → R8 (viewport-state knobs near viewport, Spline pattern); Space stays in TopToolbar (workspace switch at a different conceptual level). e2e p26-acceptance migrated 3 specs (P2.6#1/#2/#10) to the new R8 testids; P2.6#3/#4/#11 untouched (toolbar-space-\* testids preserved through SpaceGroup inline). | resolved via D-W7-3 amendment                                                     |
| R7 NPanel Transform section (per-node x/y/z `setParam` rows) vs R8 gizmo tool buttons                       | Different concept entirely: NPanel rows MUTATE the DAG via setParam Ops; R8 sets a UI projection (`editorStore.activeTool`). W2.6 already moved viewport-toggle sections out of NPanel. No collision surface.                                                                                                                                                                                     | no shifts                                                                         |
| viewportStore key surface vs R8 spec'd buttons                                                              | `gridVisible` + `toggleGridVisible` exist (P2.6); `frameSelected` + `frameAll` exist in `character/framing.ts:74,84`; `shading`/`setShading` + `snapEnabled`/`toggleSnapEnabled`/`snapStep`/`setSnapStep` exist (P2.6). **Persp/Ortho had zero scaffolding** — no `projection` key, no THREE camera-swap plumbing.                                                                                | resolved via D-W7-1 drop (amend §5.7 anatomy; defer until real director use case) |
| §11 #9 "R3 collapsed" vs implementation `display:none`                                                      | Spec language said R3 collapses to a thin strip with mode pill (recovery affordance). Implementation hides R3 entirely; Esc + universal mode pill recovery during edit suffice. Risk of locking director users out exists only if Esc handler breaks — V16 catalogue entry covers that.                                                                                                           | resolved via §11 #9 amendment (R3 "hidden", not "collapsed")                      |
| ModeBadge top-right of R6 vs DiffBar top-left of R6 vs FpsMeter (R6 overlays)                               | Disjoint corners + disjoint content (DiffBar = Mutator metadata; FpsMeter = fps readout; ModeBadge = operational mode). `pointer-events-none` on ModeBadge so click-through to viewport works. No shared testids.                                                                                                                                                                                 | no shifts                                                                         |

**W7 re-validation triggers:** (a) W8 contrast audit must verify `bg-bg-2/90` on R8 + ModeBadge over rendered viewport (R8 lives over the live render, dark + light cube scenes both need to pass §4.1 + §8.4); (b) W9 imperative TimelineCanvas drag-redraw — if R9 chrome grows in animate mode, re-inventory R8 ↔ R9 bottom-edge collision (R8 floats inside R6 at bottom-4; R9 is a separate grid row below — currently disjoint, but a future R9 popover that extends UP into R6 would collide); (c) future ortho/top/front/side view requirement reopens D-W7-1 — when it does, add `viewportStore.projection` + camera-swap pipeline first (capability gap remains the constraint); (d) any future direct writer to `gizmoStore.mode` outside `editorStore.ts:56` re-violates V19 — grep gate must run on every chrome PR.

**W9 section-inventory pre-pass (2026-05-15, discuss-phase):** ran B11 HOW over the surfaces W9 will touch. Pre-pass (decisions locked, code not yet written); the executing wave re-runs this and records the post-pass.

| Surface pair                                                                                                                                                                           | Inventory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/timeline/Dopesheet.tsx` (deleted W9) vs new `src/timeline/TimelineCanvas.tsx` (canvas-2D diamonds + cached static layer + imperative rAF playhead, dpr-scaled, mirror data-attrs) | Same domain (keyframe geometry across ALL channels grouped by layer), same store subscriptions. TimelineCanvas is a render-primitive swap (HTML/CSS `<div>` diamonds → canvas-2D), NOT a new distinct surface. The W5 Dopesheet↔CurveEditor distinctness pair (line 213) **survives**: TimelineCanvas (canvas diamonds, all channels) vs CurveEditor (SVG curve, one channel) remain disjoint domains + different primitives + different playhead impls.                                                                                                                                                                                                                                                                                                      | **advanced** — Dopesheet→TimelineCanvas render-primitive swap; D-UX-2/D-UX-3 split preserved                                                                                   |
| R3F `Canvas` (`src/viewport/Viewport.tsx`, mounts ONCE per V8 rider + K1 step 6 + THESIS §11) vs new 2D `<canvas>` (TimelineCanvas, in the timeline-drawer subtree)                    | **NEW design-entailed boundary.** Two persistent canvas elements now coexist. They are structurally disjoint (viewport slot vs drawer subtree) so a remount of one should not touch the other — but the architecture GUARANTEES this risk exists the moment a 2nd canvas lands, so it is captured at design time (dharana-spec design-entailed exception, not observation-loop-deferred). Silent-failure mode: adding TimelineCanvas perturbs the React tree such that the R3F Canvas remounts (WebGL context lost, scene rebuilt, V8 mount-once violated).                                                                                                                                                                                                   | **flagged** — W9 must assert R3F Canvas DOM identity stable across TimelineCanvas mount/unmount + drawer open/close (reuse acceptance #5 / Canvas-preservation E2E #9 harness) |
| `viewportStore.currentFrameRef` (new escape-hatch field, D-W9-1) vs `timeStore.frame` (existing derived)                                                                               | Complementary, not redundant. Both carry the same integer frame; ~~Clock.tsx dual-writes both every rAF tick from one source (D-W9-9)~~ **CORRECTED 2026-05-15 (W9 C1 grounding): `timeStore`'s three frame setters (`setTime`/`setDuration`/`tick`) dual-write both — the single frame chokepoint — NOT Clock.tsx (Clock calls `tick()`, never `setTime`, and scrub/setDuration bypass Clock; see [[H33]]/[[V20]]).** `timeStore.frame` is the React-path (NPanel params, CurveEditor SVG playhead, any `seconds` subscriber re-renders); `currentFrameRef.current` is the escape-path (TimelineCanvas rAF loop only, zero React). Never diverge — invariant asserted in tests: after any setTime, `currentFrameRef.current === timeStore.getState().frame`. | no shifts (deliberate dual-channel; single source)                                                                                                                             |

**Provenance for the new R3F↔2nd-canvas boundary entry:**
ORIGIN: W9 discuss-phase pre-mortem (2026-05-15) — design lens identified that introducing TimelineCanvas creates a second persistent canvas adjacent to the mounts-once R3F Canvas. Not a failed fix; a design-time structural fact.
WHY: Without this flagged, a W9 (or any future multi-surface-rendering wave) React-tree change that remounts the R3F Canvas would surface only as a runtime WebGL-context-lost / scene-rebuild — the hardest-to-diagnose silent failure class, because nothing in the timeline code looks like it touches the viewport. Removing this entry reopens that blind spot for every future canvas-adjacent wave.
HOW: Separates "the R3F Canvas mount lifecycle" from "any sibling canvas surface's mount lifecycle." Observation target: R3F Canvas DOM node identity (and WebGL context address) must be byte-stable across TimelineCanvas mount/unmount, timeline-drawer open/close, and mode switches. Enforced by an e2e reusing the acceptance #5 harness.
REF: THESIS.md §11; vyapti V8 (mount-once rider clause, `vyapti.md:77`); krama K1 step 6 (`krama.md:29`); `src/viewport/Viewport.tsx:1-3` (mounts-once header); acceptance #5 / Canvas-preservation E2E #9; memory `project_p6_w9_context.md` §3 pre-mortem.

**W9 section-inventory POST-pass (2026-05-15, execute-phase — commits C1 `a01ce47` → C5 `f2298a0`):** the executing wave re-ran B11 HOW; outcomes vs the pre-pass:

| Pre-pass pair                        | Post-pass result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dopesheet → TimelineCanvas           | **CONFIRMED advanced.** Dopesheet.tsx deleted (311 LOC), TimelineCanvas mounted at `TimelineDrawer.tsx:87`, CurveEditor git-proven untouched. The W5 Dopesheet↔CurveEditor distinctness pair survives (canvas-diamonds-all-channels vs SVG-curve-one-channel — disjoint, intact). D-UX-2/D-UX-3 split preserved. H29 grep gate enumerated + hand-resolved every legacy testid consumer (5 e2e specs + contrastMatrix R9 rows) in the same commit as the delete; the `'dopesheet'` _tab id/label_ intentionally retained (D-UX-2 — only the render primitive advanced, not the tab). |
| R3F Canvas ↔ 2nd 2D canvas (flagged) | **RESOLVED — no shift. The flagged risk did NOT materialize.** `tests/e2e/p6-w9-timeline-canvas.spec.ts` #4 reuses the acceptance #9 Canvas-preservation harness: R3F Canvas DOM identity stable across drawer toggle ×3 + Dopesheet↔Curve tab churn forcing TimelineCanvas remount. Structural disjointness (viewport slot vs drawer subtree) confirmed by observation, not inference. The boundary entry STAYS in dharana (Chesterton — the risk class is permanent for any future canvas-adjacent wave; trigger (b) still live).                                                 |
| currentFrameRef ↔ timeStore.frame    | **CONFIRMED no shifts, mechanism corrected.** Single source, dual channel — but the writer is `timeStore`'s 3-setter chokepoint, not Clock (the C1 grounding correction; [[H33]]/[[V20]] catalogued). Sync invariant asserted: `viewportStore.test.ts` 15/15 (after setTime/tick/setDuration) + e2e #3 (data-playhead-px-derived frame == `timeline-dock-frame-readout` every scrub sample).                                                                                                                                                                                        |

**Goal-backward outcome:** the 240-frame@60fps Lokayata gate (`tests/e2e/p6-w9-perf.spec.ts`) **PASSED**, independently re-run by the verifier (p95≈9.0–9.6ms, max≤15.3ms; budget p95≤16.6/max≤33). Trigger (d)'s dirty-rect/offscreen-tiling escalation path was **not** invoked — no perf workaround, no threshold weakening. Known automated-observation gap (FLAG-2): strip-restore-doesn't-erase-diamonds has no automated pixel proof (D-W9-4 forbids canvas pixel-diff); the e2e does the count-constant + monotonic best-effort and labels it; manual scrub recorded as user UAT in `project_p6_w9_shipped.md`. Lifecycle catalogued as [[K13]] (imperative-canvas hot-path) for the predicted P7-splats recurrence.

**W9 re-validation triggers:** (a) ~~the executing W9 wave re-runs this inventory and records the post-pass~~ **DONE (above)**; (b) if a future wave adds a THIRD canvas/WebGL surface (e.g. node-graph minimap, P7 export preview) → the R3F↔2nd-canvas boundary generalizes to an N-canvas mount-isolation invariant, promote from dharana flag to a numbered vyapti entry; (c) if W9's keyframe-drag Op path (D-W9-7, currently deferred) lands → re-inventory the `activeKeyframeId` single-source-of-truth pair (already flagged W6 trigger (c)); (d) if the 240-frame@60fps benchmark fails and dirty-rect/offscreen-tiling is introduced → re-inventory the static-layer cache vs playhead-strip-redraw boundary for correctness (strip restore must not desync from the cached static layer).

**W10 — P6-wide B11 consolidation + protocol transition (2026-05-16, the final P6 wave / first retroactive audit wave):**

W10 = `/anvi:ui-review` retroactive 6-pillar audit. Its `docs/UI-REVIEW.md` is the **consolidated §B11 re-validation for all of P6** — the W3..W9 per-wave pre/post inventory passes converge into one verdict, re-derived from the _assembled_ UI (not copied from per-wave memory — the H25/H27 lock-from-memory trap was explicitly avoided; the audit re-observed).

**Consolidated distinctness verdict (all 6 pairs hold; NO organizational fatality at the UI-SPEC↔source boundary):** 2 ADVANCED (Dopesheet→TimelineCanvas, TransformToolbar→R4/R8 split), 1 RESTORED (Inspector→NPanel merge), 3 NO-SHIFT. No stale distinctness claim survives into P6 close.

**Protocol transition (provenance: W10 close):** the per-wave "section-inventory pre/post-pass" protocol (instituted W2.6, run W3..W9) **retires for P6**. `docs/UI-REVIEW.md` is now the P6 distinctness baseline; **future audits are delta-from-UI-REVIEW.md, not per-wave pre/post**. The W2.6 additional-target ("every wave plan touching multi-surface chrome runs §B11 HOW") still applies to _new_ milestones (v0.6+), but within a milestone that has a UI-REVIEW.md, the consolidated doc supersedes per-wave passes. ORIGIN: W10 produced the first consolidated audit; WHY: per-wave passes were necessary while the chrome was being built incrementally (each wave could shift a prior claim) — once assembled and audited as a whole, the consolidated doc is the stronger, single source (per-wave passes would now duplicate it and risk drift). HOW: a v0.6 chrome wave re-opens only the specific UI-REVIEW.md surface rows it touches, not a fresh full pre/post.

**W10 scope-safeguard observation (memory, not yet a numbered catalogue entry — first occurrence; promote on recurrence at the v0.6 audit per the dharana decision model):** the D-W10-1 "fix everything inline" policy collided with reality for exactly 2 of 10 findings (c-1 zoom-%, c-2 non-destructive-close) — both were _new capability disguised as an audit finding_, not corrections to existing chrome. The plan's audit→triage(A4)→fix→**mini-checkpoint** krama caught both before they ballooned the audit wave: each STOPPED at investigation, surfaced to the user (not silently built, not silently deferred), and the user dispositioned per-item (c-1 build-in-W10, c-2 DEFER→v0.6). The reusable pattern: **a retroactive-audit finding whose fix requires new capability is a roadmap item, not an audit-wave fix; forcing it inline balloons scope — the per-finding mini-checkpoint is the cap.** Recorded in `project_p6_w10_shipped.md`; promote to a numbered hetvabhasa/krama entry if it recurs at the v0.6 ui-review (single occurrence → memory, recurrence → catalogue).

**W10 re-validation triggers:** (a) any post-W10 P6 chrome change re-opens only the affected UI-REVIEW.md surface row (delta-from-baseline, not full pass); (b) c-2's deferred non-destructive-close → when the v0.6 open-tabs-vs-storage session abstraction lands, re-inventory the ProjectTabs ↔ storage-set distinctness (a NEW pair that does not exist in v0.5); (c) c-1's new `viewportStore.cameraZoom` field + Viewport.tsx `onChange` writer — re-verify the V8 file-rooted boundary on any future viewport-store write (the precedent set: UI-projection-store writes from `src/viewport/` are V8-clean; DAG dispatch from there is not — the distinction must hold); (d) the next milestone's first ui-review consumes UI-REVIEW.md as its baseline — if it's stale/missing, that audit blocks.

**P6 MILESTONE CLOSED — MERGED to `main` 2026-05-18 (PR #59, merge commit `ca97bd1`).** The B11 P6-wide consolidation + `docs/UI-REVIEW.md` baseline + the per-wave-protocol-retirement are now on `main` (authoritative, not branch-only). Adversarial milestone audit: CLOSEABLE, 17/17 §11 MET (3 run-verified), zero silently-dropped decisions. The per-wave section-inventory protocol is **dormant for the remainder of v0.5**; it **re-activates at the next milestone's first chrome wave** (the W2.6 additional-target applies per-milestone, not globally — a fresh milestone with no UI-REVIEW.md baseline reinstates per-wave pre/post passes until its own consolidation). Trigger (d) is the wake condition. P7 carries (recorded for boundary awareness, not B11 concerns): the animation-AUTHORING path (H34 4-edge splice → director affordance) + Splats node + D-W9-7; v0.6 carries c-2/H35/F-2/F-6. See [[basher-p6-milestone-complete]].

**P7 W-D section-inventory pass (2026-05-18) — PROTOCOL RE-ACTIVATED.** P7 is the next milestone's first chrome wave (W2.6 additional-target + W10 wake-condition (d)); P6's `docs/UI-REVIEW.md` baseline does NOT cover the v0.7 affordances (Auto-Key indicator, 3-state inspector diamond), so per-wave pre/post section-inventory passes apply until P7's own consolidation. **FLAG-2:** P7 has no UI-REVIEW.md baseline (dharana.md:284). Ran B11 HOW (re-validation) over every surface Wave D touches — **files OPENED, not recalled from memory** (H25/H27):

| Surface                                            | File:line opened                                                                        | Current unique sections                                                                         | Auto-Key / diamond collision?                                                                                                                                                                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timebar (always-visible transport)                 | `src/app/Timebar.tsx:23-89` (rendered at `src/timeline/TimelineDrawer.tsx:113`)         | play/pause btn · **REC toggle+dot (NEW D2)** · scrub range · seconds readout                    | NO — REC sits between play/pause and scrub; does not overlap the seconds readout or scrub region.                                                                                                                                                             |
| DockHeader / timeline-tab-strip (drawer-open only) | `src/timeline/TimelineDrawer.tsx:120-154`                                               | Dopesheet tab · Curve Editor tab · spacer · frame/total readout (`timeline-dock-frame-readout`) | NO — physically a SEPARATE element from Timebar (DockHeader is inside the open drawer body at TimelineDrawer.tsx:74; Timebar is the row at :101-115 BELOW it). The §5.10 frame/fps readout lives in DockHeader, NOT Timebar — no overlap with the REC toggle. |
| NPanel ParamRow (NumericField + VectorField)       | `src/app/NPanel.tsx:103-190` (ParamDiamond), `:209-211`/`:308-310` (leading-span mount) | leading `<span>`: diamond + drag-scrub label · value input(s)                                   | NO — the C2 diamond is a leading adornment inside the label `<span className="flex items-center gap-1">`, left of the drag-scrub label; the value `<input>` is the right-hand sibling. The diamond does not overlap any existing param-row adornment.         |

**Cross-check vs UI-SPEC §5.8 / §5.9 / §5.10 distinctness claims (file:line opened — `docs/UI-SPEC.md:458-552`):** §5.8 Section catalog ALREADY lists the Animate section owner as `animation — Record/AddKey/Simplify/Clear` (UI-SPEC.md:496) — the spec _anticipated_ a Record affordance under the Animate domain BEFORE P7; D2/C2 _realize_ an already-declared concern, they do not introduce a new contested surface. §5.9/§5.10 already split Timebar (transport+scrub) from DockHeader (tabs + Range + frame/fps) by content; the REC toggle lands in transport (Timebar), semantically correct, no merge pressure. No "X and Y are distinct" conjunction decayed.

**VERDICT: NO SHIFTS.** No D-UX entry restored / overridden / advanced. No distinctness claim decayed. Wave D adds two new chrome elements (Auto-Key REC indicator in Timebar; 3-state diamond in NPanel ParamRow) that _realize_ the already-specced §5.8 "Animate — Record/AddKey" concern — purely **additive**, pinned by a new **D-UX-14** in UI-SPEC §1 with `**REF:**` to opened file:lines. ORIGIN: P7 Wave D first chrome wave of the v0.7 milestone; WHY: without this pass the §5.8 Record affordance ships with no pinned visual contract and the anvi-ui-checker would BLOCK D-UX-14 on unobserved files; HOW: per-surface table above + the file:line REFs on D-UX-14.

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

**WHY this axis exists:** these bridges optimize for _Blender's API
surface_ (vast, unbounded — they need `execute_blender_code`).
Basher's DAG vocabulary is _bounded_ — we have V1 (op-as-only-mutation
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
_convention_ bug.

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

| System                                                                                                                      | Ground Truth Doc                                                                                      | Source Location                                                                                                                        | Last Verified | Opaque Regions                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| three.js glTF pipeline (GLTFLoader + Material/Mesh/SkinnedMesh/Skeleton clone + SkeletonUtils + drei useGLTF), **v0.169.0** | `~/.anvideck/projects/basher/ref/GROUND_TRUTH_GLTF.md` (429 lines, 307 file:line citations, 7 stages) | `~/.anvideck/projects/basher/ref/sources/three-gltf/` (verbatim copy of Basher's pinned `node_modules/three@0.169.0` + drei `Gltf.js`) | 2026-05-31    | drei `useLoader` cache/Suspense internals (live in `@react-three/fiber`, not in the copied tree); Draco/KTX2/Meshopt WASM decoders; `PropertyBinding.sanitizeNodeName` reserved-char set (the B8 name⇄DAG-key reconciliation depends on it matching Basher's `sanitizeBoneName` — flagged UNGROUNDED) |

**What it grounds (the 10 glTF catalogue entries, previously interim):** materials/fidelity §STAGE 3 ([[H59]]) · skin/skeleton §STAGE 5 ([[H46]] [[H50]] [[H51]] [[V25]]) · clone/share boundary §STAGE 6 ([[H45]] [[V20]] [[H36]] [[H59]]) · clips/child-addressing §STAGE 7 + §STAGE 6 ([[H53]] [[H54]] [[V26]]) · the B12 boundary extensions. Highest-value verified facts: `Mesh.js:60` (material shared by REFERENCE across clones + the useGLTF cache — the #99/V20/H36 landmine); `SkeletonUtils.js:379-388` (clone REBINDS `skeleton.bones` to cloned bones — the H45 fix; plain `Object3D.clone` does not); `GLTFLoader.js:3542-3543` (`metalness`/`roughness` default to **1.0** when the factor is omitted, so a map drives the channel — independently confirms the H59 map-aware-tint rule); `GLTFLoader.js:661-665` (`KHR_materials_unlit` → MeshBasicMaterial, no `.emissive`/`.roughness` — confirms the #99 unlit guard).

**Re-trace trigger:** any bump of `three` or `@react-three/drei` in `package.json` — re-verify the cited file:lines (GLTFLoader internals shift between minor versions).

**Candidates for future Ground Truth docs (not yet traced):**

- ComfyUI workflow execution (if AI render bridge debugging hits opaque boundary)
- gaussian-splats-3d material/light interaction (P8 splats, if depth/normal pass integration breaks)

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
  - V12 invariant), H21 (anchor placeholder bug + Anchors block in
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
  three-pattern cluster is a _cluster of similar mechanisms_, not a
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
  - `src/agent/diff/store.ts` propose-time gate. V13 flips to ALIGNED.
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
  - `src/agent/telemetry/`. V15 flips to ALIGNED. System prompt's
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
     cluster's _mechanism_ is now structurally addressed; future
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
  three structural invariants (V13 + V14 + V11) — the _cluster
  mechanism_ is mechanically rejected at the gate. The DCC-LLM
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

- opt-in telemetry patterns adopted; six starter Mutators registered;
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

**Updated:** 2026-05-09 — post-P3.1 (Animation import + Mixamo retargeting):

- **B7 span scope unchanged.** The agent identifier resolves DAG node
  ids (project-level); rig bone-name resolution is a separate boundary
  class — sister class to B7 but distinct (exact-match, not fuzzy;
  mechanical, not natural-language).

- **B8 (Mutator catalog ↔ Op constructor) extended.** 10 → 11
  Mutators. New: `mutator.animation.retarget` — first Mutator that
  reads multi-input state (source clip + source skeleton + target
  skeleton) and runs an externally-provided algorithm
  (SkeletonUtils.retargetClip) to produce its Op chain. Closure spec
  uses 3 root selectors (sourceClip, sourceSkeleton, targetSkeleton);
  followedEdges = [] since the new clip id is fresh and connect-to-
  time targets the project TimeSource (always in scope post-#40).

- **New node type `BoneNameMap`** (32 → 33). Pure data node;
  evaluator returns its params verbatim. Multiple retargets share one
  map; edits trigger downstream re-evaluation via the cache-key path.

- **Bone-name maps catalog + bone-group preset catalog** added under
  `src/core/import/`. Pre-built maps for Mixamo ↔ glTF / Reze /
  Rigify; pre-built bone-mask presets for upperBody / lowerBody /
  arms / headAndNeck. Both are static lookups — no DAG state.

- **Live-smoke wrinkles caught at test time, not at production:**
  - THREE.PropertyBinding's track-name regex reserves `[].:/` as
    delimiters. Mixamo's `mixamorig:Hips` namespace breaks
    AnimationMixer binding silently — the retargeted clip comes back
    empty, no error thrown. Fix at the THREE → POJO seam in
    `threeAdapter.sanitizeBoneName` (`:` → `_`). Bone-name presets
    use sanitized form. Sister class to H21 (placeholder/anchor
    confusion at the prompt boundary) — both are
    "surface advertises something the receiver silently misinterprets."
    Single occurrence → memory; promote to a hetvabhasa entry on
    second occurrence (next likely candidate: glTF asset names with
    spaces).
  - SkeletonUtils.retargetClip's `options.names` direction is
    target → source. Public retargetClip() takes the natural
    source → target; we invert internally. Documented in the API
    comment so future readers don't relitigate.

- **No new dharana boundary needed for bone-name resolution.** The
  boundary IS structurally distinct from B7 (rig-side, exact-match)
  but: zero hetvabhasa cluster yet, sanitization is a one-line
  defensive fix, the boundary's enforcement is mechanical (the
  sanitize function runs every import). Promote to B9 when (a) a
  second name-resolution surface fails, OR (b) glTF asset names hit
  the same reserved-char issue.

- **Fatality test (post-P3.1, 2026-05-09):**
  1. Hetvabhasa: 24 entries unchanged. The PropertyBinding /
     map-direction wrinkles surfaced and were fixed at test time —
     same pattern as P3 (gate-validator + dev tests catch wiring
     issues before commit). No B-boundary newly clusters 3+.
  2. Vyapti span: V13 / V14 / V15 ALIGNED status verified for the
     new Mutator. retarget's signature is unique vs the existing 10
     (V14 mechanical guard passes).
  3. Krama crossing: import surface adds no new lifecycle. Drop /
     console-import → parse → buildOps → dispatchAtomic — same K3
     atomic-shape Mutators use.

  **Verdict: organization remains sound after P3.1.** Bone-name
  resolution is a candidate axis (sister to B7) but doesn't cross
  the dharana-promotion threshold yet — single observation, single
  fix, no recurrence.

  **Next update trigger:** P4 (Render graph) or first second
  occurrence of name-resolution-at-asset-boundary failure.

**Updated:** 2026-05-09 — post-P4 (Render graph = render nodes, narrowed scope):

- **B7 (Agent identifier ↔ DAG node-set) span unchanged.** addPass's
  closure spec (rootSelectors=[jobId], followedEdges=['pass-input'])
  resolves a project-level node id, same exact-match shape as the
  existing 11 Mutators. No new identifier surface.

- **B8 (Mutator catalog ↔ Op constructor) extended.** 11 → 12 Mutators.
  New: `mutator.render.addPass` — single Mutator parameterized by
  passKind ('beauty' | 'id'), discriminated build step picks BeautyPass
  vs IDPass node type. Closure spec uses 1 root selector (jobId);
  followedEdges = ['pass-input'] so existing passes on the job sit in
  scope alongside the root. V14 mechanical signature-uniqueness guard
  passes (12-of-12 unique signatures).

- **New node types BeautyPass + IDPass + RenderJob** (33 → 36; THESIS
  §43 narrowed to 3 of 7 listed for v0.5; AO + Depth + Normal + Albedo
  - Alpha + MotionVector deferred to P5+ on demand). BeautyPass + IDPass
    are pure: true (Scene + Camera + Time → Image metadata only); RenderJob
    is pure: false — the only impure node added in P4.

- **New socket types Image + JobResult.** Image is a lazy value
  (descriptor + sourceHash, no pixels until execution). JobResult is
  RenderJob's metadata output. Neither is ungrounded — both have
  ImageValue / JobResultValue POJO definitions with REF to THESIS
  §43 + §51.

- **B9 candidate: render execution layer ↔ DAG.** runRenderJob lives
  in src/render/ (V8 file-rooted: no dispatch from this directory).
  Reads DagState + writes via StorageCapability. The encoder is
  injectable (PassEncoder) — production wires a real GL renderer;
  tests + Wave B inject the deterministic `stubEncoder` (1x1 PNG keyed
  off pass.sourceHash). Boundary not yet promoted: single observation,
  single fix, no recurrence. Promote on second issue.

- **H22 (per-edge-kind BFS isolation) holds under live 'pass-input'
  socket.** RenderJob is the first node carrying a `pass-input` input
  socket (string-keyed because the EdgeKind literal contains a hyphen).
  Closure tests verify: closure rooted at jobA via 'pass-input' reaches
  passA only; ['parent','pass-input'] from passA reaches jobA but does
  NOT free-mix to siblings; 'pass-input' walk does NOT carry over to
  other input-socket walks. Same isolation rule the 'animation' edge
  kind locked in at P3.

- **V8 file-rooted dispatch mechanically guarded.** runRenderJob.test.ts
  contains a textual import-only regex that fails CI if src/render/\*
  ever imports a dispatcher (dagStore / useDagStore / dispatchAtomic /
  core/dag/ops). Same enforcement style as STRATEGY_TOPICS.

- **Locked decisions (project_p4_prompt):**
  - PostFx config home: deferred to Wave B revisit (real-time vs
    render-time coupling will reveal the seam). RenderOutput.params
    untouched.
  - Mutator granularity: single addPass with passKind discriminator,
    not per-kind Mutators. V14 satisfied with one signature.
  - DEFAULT_OPS unchanged: fresh project does NOT seed a RenderJob.
    Opt-in via dag.exec or addPass. Lock-in test (PR #40) untouched.
  - Execution architecture: main-thread synchronous walk in Wave B;
    Web Worker / OffscreenCanvas is a strategy swap (Wave B.1 / P5)
    if profiling demands it.
  - Pass scope: BeautyPass + IDPass only; THESIS §43 strict subset
    (no amendment). The 5 deferred kinds slot in via the same
    PassKind enum + node-type registration when P5's AI restyle
    pipeline demands them.

- **Fatality test (post-P4, 2026-05-09):**
  1. Hetvabhasa: 24 entries unchanged. The Wave A → Wave B → Wave C
     train surfaced one wrinkle (RenderJob socket name string-keyed
     'pass-input' to match EdgeKind literal) — caught at test time,
     fixed before commit. No new B-boundary clusters 3+.
  2. Vyapti span: V13 ALIGNED (closure preservation gate enforces);
     V14 ALIGNED (12-of-12 mechanical signature uniqueness); V15
     ALIGNED (rendering strategy resource separated, not in system
     prompt). All re-verified.
  3. Krama crossing: addPass → runRenderJob is a NEW two-step
     lifecycle (compose Diff in DAG, then trigger execution that
     writes via StorageCapability). The split is intentional — the
     Diff system is for DAG mutation; render execution is a side
     channel. Boundary count = 2 (DAG → Storage), under the H22
     fatality threshold.

  **Verdict: organization remains sound after P4.** RenderJob's
  pure: false marking + the impure execution layer in src/render/
  match the locked decision; H22 isolation extends cleanly to the
  new edge kind; no new B-boundary triggers promotion. The
  not-yet-wired runJob tool (agent → live PNG output) is a
  Wave B.1 / P5 task — the Mutator + summarizePass surface lets
  the agent COMPOSE + DESCRIBE renders today; LIVE EXECUTE is a
  UI/follow-up concern that needs a real GL encoder + ToolContext
  storage extension.

  **Next update trigger:** P5 (AI Render Bridge) — ComfyUI wiring
  will exercise the pass-output describable contract. Expect
  pressure to add Depth + Normal passes for ControlNet inputs.

**Updated:** 2026-05-09 — post-P5 (AI Render Bridge — stylizedRealism
preset, ComfyUI capability, video stitch — all four waves shipped):

- **B9 promoted (render execution layer ↔ DAG).** P4 was the first
  observation; P5 added two more execution-layer files
  (`runComfyUIWorkflow.ts` + `runVideoStitch.ts`). Per dharana
  promotion criteria (single → memory; recurrence → dharana entry),
  three observations is well past threshold. Promoted with explicit
  ORIGIN/WHY/HOW/REF.

  **ORIGIN:** P4 introduced `runRenderJob` as the first impure
  execution-layer file under `src/render/`. P5 added
  `runComfyUIWorkflow` (stylization frame walk + capability submit +
  storage write) and `runVideoStitch` (frame read + encode + storage
  write). All three share: V8 file-rooted (no Op emission), V6
  capability discipline (storage / comfy / video-encoder), reads of
  evaluated DagState, side-effecting writes. The boundary class is
  not "rendering" specifically — it's "impure execution layer that
  consumes DAG metadata + side-effects through capabilities".

  **WHY:** Without B9 catalogued, future execution-layer additions
  (PlayCanvas exporter at P7, splat encoder at P6 if it lands) will
  be added one-off without checking the established discipline:
  - Read DagState; never write Ops from this directory.
  - All side effects route through a registered capability (V6).
  - Writebacks (e.g. lastGoodFrame on ComfyUIWorkflow) are
    callbacks the caller dispatches — never inline dispatch from
    the execution file.
    Each violation reopens H19 (stale snapshot) / V8 (file-rooted)
    / V1 (op-as-only-mutation) holes that were already closed.

  **HOW:** Mechanical guard — every file under `src/render/**` has
  a textual import-only regex test in `runRenderJob.test.ts` that
  fails CI on imports of dispatcher / store mutators / op
  machinery. Currently guards `runRenderJob.ts`, `stubEncoder.ts`,
  `dryRun.ts`, `runComfyUIWorkflow.ts`, `runVideoStitch.ts` —
  five files, one regex. Future src/render/ additions add to this
  list before ship.

  **REF:** `src/render/runRenderJob.ts:1`,
  `src/render/runComfyUIWorkflow.ts:1`, `src/render/runVideoStitch.ts:1`,
  `src/render/runRenderJob.test.ts` ('V8 — file-rooted dispatch rule'
  describe block). project_p5_plan B1/D2.

  **Silent-failure modes (B9):**
  - Adding a new src/render/ file without extending the import-only
    guard → V8 violation lands silently.
  - Calling `useDagStore.getState()` inside an async loop in
    src/render/\* → H19 stale-snapshot pattern; capture-once at
    function start instead.
  - Writing to fs/opfs directly (bypassing StorageCapability) →
    Tauri swap at v0.6 becomes a rewrite. Reviewer rejects.

  **Observation targets:**
  - For every new file under `src/render/**`: confirm the V8
    import-only test names it. Missing entry → fail CI before merge.
  - For every async loop in src/render/\*: confirm state.nodes is
    read once at function entry, not per-iteration.
  - For every storage path constructed in src/render/\*: confirm it
    flows through `StorageCapability.write`, never `node:fs` /
    `OpfsStorage` directly.

- **B10 candidate (ComfyUI ↔ external server boundary)** — single
  observation, kept in memory not dharana per promotion criteria.
  Promotion trigger: a second class of LLM/tool-bridge integration
  appears (e.g. blender-mcp wired through a similar capability) —
  at that point the WHY of B10 generalizes from "ComfyUI specifically"
  to "any LLM-tool external server", and the catalogue entry earns
  its place. Tracked in memory as `project_p5_shipped.md`.

- **V13 (closure preservation) ALIGNED re-verified.** addAIPass +
  addStitch each declare buildClosureSpec. Gate 3 (closure\_
  preservation) accepts both Mutators' op chains under the rooted
  closures. V13 status unchanged — the new Mutators integrate
  cleanly through existing machinery.

- **V14 (Mutator non-redundancy) ALIGNED re-verified.** Mechanical
  guard now passes 14-of-14 unique signatures (was 12 after P4).
  addAIPass distinguishes from addPass via `preserves` (drops
  'material'). addStitch distinguishes via
  `requiredNodeTypes: ['RenderJob','ComfyUIWorkflow']` (no other
  Mutator pairs both).

- **V15 (lazy strategy) ALIGNED re-verified.** Strategy resource
  count 8 → 9 with 'aiRender' added. System prompt's one-line
  pointer remains the only inline content; preset bodies +
  workflow guidance live in the registry, fetched via
  `agent.getStrategy({ topic: 'aiRender' })` only when relevant.

- **V12 (convention boundary) extended.** dcc-reference §21
  "Stylized render conventions" added with four locked decisions
  (sRGB PNG output, 4-digit zero-pad frames, 'avc1.42E01F' codec
  id, 'prev_frame_image' placeholder name). Cross-refs from
  runComfyUIWorkflow + runVideoStitch + the stylizedRealism
  preset.

- **D-01 'pass-input' edge kind held under expanded usage.** P5
  loaded three new node types onto this kind: ComfyUIWorkflow's
  pass-input (raw passes in), ComfyUIWorkflow's `out` socket
  (stylized output flowing as Image, consumed by VideoStitch's
  pass-input), VideoStitch's pass-input. H22 isolation tested
  under all three — closure rooted at jobId never leaks to
  sibling jobs / orphan workflow nodes / external stitches.

- **§43 amendment landed (D-02).** DepthPass + NormalPass
  registered (40 → 42 nodes pre-P5; +5 P5 nodes = 45 wait...
  let's recount. P4 ended at 36. P5 adds: Prompt (37),
  ComfyUIWorkflow (38), DepthPass (39), NormalPass (40),
  VideoStitch (41). **41 node types total post-P5.** §43 deferred
  set unchanged: LineArt, Segmentation, AO, Albedo, Alpha, Motion
  remain v0.6+ — only land when a registered preset demands them.

- **Fatality test (post-P5, 2026-05-09):**
  1. Hetvabhasa clustering: 24 entries (no new H from P5 work —
     planning was thorough enough that wiring mismatches were
     caught at test time, not in production). No B-boundary
     newly clusters 3+ patterns.
  2. Vyapti span: V13/V14/V15 ALIGNED status verified; new V12
     section in dcc-reference cross-refs. No invariant span
     widened.
  3. Krama crossing: K10 added (AI render workflow lifecycle —
     extends K4's compose/execute/describe shape with prev-frame
     coherence + resume + capability submit). Each phase of K10
     stays atomic-shape; no lifecycle crosses 3+ module
     boundaries.

  **Verdict: organization remains sound after P5.** B9's
  promotion is the only structural addition — and it formalizes
  what was already true rather than introducing a new boundary.
  The execution layer continues to be a clean V8 file-rooted
  surface; capabilities (V6) absorb the new external-server
  concern (Comfy) the same way they absorbed Storage at P0.

  **Next update trigger:** P6 (Splats node) or v0.6 (meta-prompt
  preset authoring + remaining §43 passes — LineArt, Segmentation,
  AO, Albedo, Alpha, Motion).

### Boundary B12: glTF/glb loader registration (consumer ↔ three-stdlib decoders)

**ORIGIN:** issue #80 / 2026-05-20. drei's `useGLTF` (default args) wires `DRACOLoader` pointing at `https://www.gstatic.com/draco/versioned/decoders/1.5.5/` (verified at `node_modules/@react-three/drei/core/Gltf.js:8`). That CDN fetch is non-deterministic per THESIS §48 (network call into the render path) and fails silently offline / behind a CSP. `KTX2Loader` (Basis Universal — `KHR_texture_basisu`, common in size-optimised exports) was not wired at all by drei. Real-world `.glb` exports almost always use Draco mesh compression (Blender's default exporter, Sketchfab downloads, glTF-Transform pipelines) → the pre-#80 failure mode was "imports a hand-made cube but anything real silently does not load." Surfaced by an honest audit of glTF import quality (not a user bug report — the limitation was structural and invisible to anyone testing only the bundled cube/sphere/cone fixtures).

**WHY:** Removing this entry reopens the silent-failure-on-real-assets class. The boundary is between drei (the consumer) and three-stdlib (the actual GLTFLoader + Draco/KTX2/Meshopt extensions); the consumer has implicit network-dependent defaults that the SceneFromDAG renderer relies on. Without explicit configuration this boundary has invisible failure modes that surface only when a user imports a real asset — and even then the failure is a blank viewport, not a user-visible reason. The same loader-registration pattern will apply to P8 Splats (`.ply` / `.splat` ingestion via `@mkkellogg/gaussian-splats-3d` or its successor — same `useResolvedAssetUrl` infra, same OPFS blob wrapping, same decoder-registration discipline needed). The boundary class is "external loader with implicit network dependencies on third-party defaults."

**HOW:** explicit registration + self-hosting:

1. `src/viewport/gltfLoaderConfig.ts` exports `useGltfLoaderExtend()`, a hook memoised on the R3F renderer that builds an `extendLoader` registering `KTX2Loader` with `setTranscoderPath('/basis/')` + `detectSupport(gl)`.
2. Draco self-hosting is done via drei's `useDraco='/draco/'` string arg — drei wires the `DRACOLoader` for us, just pointed at our path instead of the gstatic CDN.
3. Decoder assets vendored under `public/draco/` + `public/basis/` (copied from `node_modules/three/examples/jsm/libs/`; added to `.prettierignore` — third-party JS+WASM wrappers, not ours to reformat).
4. Consumer `src/viewport/SceneFromDAG.tsx` GltfAssetR calls `useGLTF(url, '/draco/', true, extendLoader)`.
5. Future consumers (P8 splats, any future loader with CDN-default behaviour) follow the same shape: vendor the decoder under `public/<name>/`, expose a `use*LoaderExtend()` hook keyed on the renderer if KTX2-style support detection is needed, pass through to the consumer's loader-config arg.

**REF:** issue #80 (CLOSED 2026-05-20), PR #84 (MERGED `e3a3645`), commit `31ed8c2`, THESIS §39 (P1 node types), THESIS §48 (determinism — no CDN), `src/viewport/gltfLoaderConfig.ts` (the config module), `src/viewport/gltfLoaderConfig.test.ts` (5 unit tests asserting self-hosted paths + decoder WASM committed + regression-guard grep against a future bare-arg revert), `src/viewport/SceneFromDAG.tsx` GltfAssetR (the consumer with comments naming the THESIS §48 rationale), `tests/e2e/p0-gltf-draco.spec.ts` (runtime proof: loads a Draco-compressed `.glb`, asserts scene-walk finds the asset AND zero Draco/GLTFLoader `console.error` fires — converts "wires-up" to "decoder actually decoded"), `public/assets/cube-draco.glb` (fixture, generated via `gltf-pipeline -i cube.gltf -d -o cube-draco.glb`), `public/draco/draco_decoder.{js,wasm}` + `public/basis/basis_transcoder.{js,wasm}` (vendored decoders). Open follow-ups in the same boundary class: [#81] glTF embedded animation clips silently dropped; [#82] multi-file `.gltf` (separate `.bin`/textures) broken by opfsLoader single-blob wrap; [#83] fidelity follow-ups (lossy material override, no load-error surfacing, no glTF skeleton → rig).

**Provenance:** 2026-05-20 (issue #80 / PR #84 / commit `31ed8c2`): self-hosted Draco + KTX2 wiring landed; real `.glb` imports now load; `.planning/` added to `.gitignore` in the SAME COMMIT as the loader-config fix (the root-cause hardening for vyapti [[V21]] was bundled with the symptom resolution it served).

**Silent-failure modes:** (1) a user drops a `.glb` exported by Blender/Sketchfab → drei-default DRACOLoader fetches `gstatic.com/draco/...` → blocked by CSP/offline/network → suspense throws → blank asset, no user-visible reason; (2) a `.glb` with `KHR_texture_basisu` textures → unregistered extension → loader throws → same blank-asset failure mode; (3) a future P8 splat ingestion path with CDN-default decoder behaviour would repeat the same class (the structural defense is the discipline above, not just the #80 fix).

**Observation targets:** **per-decoder-class — for EACH loader that handles a compressed/encoded asset, prove the decoder is registered AND a fixture using the encoding loads end-to-end with zero console.error.** glTF: `tests/e2e/p0-gltf-draco.spec.ts` (Draco proof). KTX2: when a `.glb` with `KHR_texture_basisu` ships, add a parallel KTX2 fixture test (currently observation target is unproven by fixture; gated only by the unit test asserting `extendLoader` registers KTX2 + by the runtime config). Future splats: a sibling spec following the same shape. The reusable diagnostic question: "is this loader's default behaviour network-dependent? If yes, what fails when the network isn't there?"

**2026-05-21 extension (P7.5 / #81 sub-class — animation extraction at the same boundary):** B12 now spans drop-time animation extraction in addition to render-time decoding. The eager-parse path lives at `src/core/import/{glb.ts, gltfImportChain.ts}` and is the third importer after BVH/FBX (the deferred-glTF-clips note at `fbxImportChain.ts:7` earns its keep). New DAG-resident state for any animated glTF drop: `TransformClip` node(s) + a `ClipSelect` node + `GltfAsset.params.nodeNameMap`. New consumer side at `GltfAssetR` (`src/viewport/SceneFromDAG.tsx`): walks `gltf.scene` by name, applies per-child TRS from the evaluated `TransformClipValue`. **Rotation discipline at the seam:** glTF tracks are quaternions; Basher stores rotation as degrees-Euler throughout the DAG (matches `Transform.rotation` end-to-end, `SceneFromDAG.tsx:266,426,449,525`); AnimationClip's `BonePose.rotation` is the radians-typed sibling for skeletal paths. TransformClip stores degrees → renderer converts to radians at the THREE seam via the existing `degVec3ToRad` helper. Conversion at import: `quaternionToEulerVec3` (radians) → `radVec3ToDeg` → keyframe.rotation. Anyone touching a new clip format at this boundary must read CONTEXT 7.5 D-01 + `.planning/phases/7.5-gltf-transform-clip/SECTION-INVENTORY.md` (B3 CHECKPOINT) before adding a fork-prone schema.

**Follow-ups at this boundary (status as of 2026-05-24):** **#89 CLOSED** (quantised animation accessors / KHR_mesh_quantization — PR #102); **#90 CLOSED** (data-URI buffers / JSON-only `.gltf` external buffer resolution; #82's load-layer cousin — PR #104); **#88 CLOSED** (skinned glTF deformation — PR #107; NOT the bone-indexed Skeleton+AnimationClip extraction originally assumed — see the render-consumer note below). **STILL OPEN:** #91 (glTF child gizmo/NPanel addressing — `resolveEvaluatedTransform` consumer evolution for glTF scene children; H40-family at this boundary); #99 (lossy material override drops textures/PBR); #100 (glTF skeleton → DAG rig nodes — the addressing half #88 deliberately deferred); #105 (agent `library.import` clip-extraction parity with the UI drop path). The TransformClip / ClipSelect node pair (PR #92) is the canonical shape — any future clip importer (FBX node-indexed clips, Alembic, USD) should mirror its (importer-chain → ClipSelect → consumer) topology, not invent a parallel one.

**B12 render-consumer extension 2026-05-24 (#88 / PR #107):** the boundary now spans a third surface — the RENDER consumer's clone of the GLTFLoader-built scene. A skinned glTF carries its own `SkinnedMesh` + `THREE.Skeleton` (GLTFLoader builds them); #81's TransformClip already animates the joint scene-nodes by name. So skinned-deform support was NOT a BVH/FBX-style Skeleton+AnimationClip extraction — it was a one-line renderer fix: `GltfAssetR` must clone with `SkeletonUtils.clone`, not `Object3D.clone`, or the cloned SkinnedMesh stays bound to the SOURCE bones and the mesh never deforms (the footgun [[H45]]). **New observation target at this boundary:** for any skinned-asset render path, prove DEFORMATION via a skin-bound vertex world-position delta (`SkinnedMesh.getVertexPosition` under real render time driven by `__basher_time.setTime`), NOT joint TRS and NOT the pure evaluator (`__basher_evaluate` has no mounted SkinnedMesh / no render frame). Detection fixture: `tests/e2e/p7.6-gltf-skinned.spec.ts` (B2 bound-SkinnedMesh validity gate + B3 vertex-delta + falsification). The reusable question stays the same H40 one — "which side did I observe, the evaluator or the rendered surface?" — here the evaluator showed joints moving while the surface stayed frozen. The DAG-resident skeleton addressing (#100) and bone gizmo/NPanel (#91) are the still-open halves; #88 closed only the deformation half. **REF:** `src/viewport/SceneFromDAG.tsx` GltfAssetR (`cloneSkinned` + `window.__basher_gltf_skin` seam), [[H45]], CONTEXT/PLAN 7.6.

**B12 child-addressing extension 2026-05-26 (#91 / phase 7.7):** the boundary now spans a fourth surface — a glTF scene child as a first-class **addressable DAG node**. Pre-7.7 the children were name-addressed proxies inside the single `GltfAsset` node (`nodeNameMap`); the gizmo/NPanel/keyframe path could not reach them (THESIS 157/502: to be gizmoable a thing must be a DAG node with a Transform param). 7.7 emits one **inputless, non-producing `GltfChild` node** per scene child at drop (eager, deterministic `hashId('gltfChild', assetRef, key)` ids, one atomic K6 chain), addressable via the outliner child-tree (`sceneTreeWalk.ts` projects `childHierarchy`, collapsed-by-default, D-UX-17). **The architectural lock that preserves #88: the GltfChild node REFERENCES the three.js object by name and owns only the local TRS override — three.js keeps geometry+skeleton+deform (D-03/H45). NEVER make the addressing node a render producer or a transform OWNER** (reusing `Transform`/`Group` — both scene producers — would double-render; the node is deliberately NOT in the renderable `SceneChild` union). One pure layering primitive `resolveGltfChildTrs` (precedence `manual-if-overridden[field] → clipTrack → base`, branch on the `overridden` flag NOT value-equality — the bone-dragged-back-to-base trap) feeds BOTH the renderer (all children, the single writer at the `:551-564` seam) and `resolveEvaluatedTransform` (selected child, trailing glTF-child branch) — V20 one-rule. **New silent-failure mode (6) + observation target:** a render-consumer that reads sibling DAG state via `useDagStore.getState()` (a SNAPSHOT) instead of a SUBSCRIBED selector is NOT a React dependency → a gizmo `setParam` updates the store but the renderer effect never re-fires → the override silently never applies / snaps back (the H40 freeze in a new guise, this time on the CONSUMER's own read rather than the producer). The fix and the observation target: read child nodes via a **subscribed selector** so the effect re-layers on every param write, and PROVE it by observing the override **persists with no snap-back on the rendered surface** (not the Op log) — `tests/e2e/p7.7-gltf-child-addressing.spec.ts` E1c. DAG-explosion is real but bounded: a 64-bone rig = 65 GltfChild nodes, +26KB save (~403 B/child), 186ms one-time outliner expand (collapsed-by-default keeps steady-state cheap); virtualization is a follow-on only if a rig exceeds ~150 bones. **REF:** `src/nodes/GltfChild.ts`, `src/app/resolveGltfChildTransform.ts` (the one layering primitive), `src/viewport/SceneFromDAG.tsx` GltfAssetR (subscribed selector, single writer), `src/app/sceneTreeWalk.ts` (child projection), `docs/UI-SPEC.md` D-UX-17, `tests/e2e/p7.7-gltf-child-addressing.spec.ts` (E1a-d + E2 determinism) + `p7.7-dag-explosion.spec.ts`, [[H45]] [[H40]], CONTEXT/PLAN 7.7. Still open at this boundary: #100 (typed-joint/bone rig semantics on these child nodes — 7.8), retargeting (D-04), viewport bone-pick (D-06 follow-on).

**B12 rig-projection extension 2026-05-29 (#100 / phase 7.11):** the boundary now spans a fifth surface — the glTF **rig as a pure read-only `Skeleton` projection** that participates in the existing `Skeleton`/`PosedSkeleton` family and is a retarget target/source. **#100's rig-projection + retarget half is now CLOSED** (the addressing half #88 deferred); the remaining open follow-on at this boundary is **D-06 viewport bone-pick** (click-a-joint), plus #99 (lossy material override) and #105 (agent clip-extraction parity). The mechanism (see [[V25]]): a NEW pure node `GltfSkeleton` takes a `GltfAsset` as its ONE input and joins the asset's import-captured `skins` metadata into a `BoneSpec[]` via `projectGltfSkeleton` — it does NOT read GltfChild's live pose (a `Skeleton` is import-time-STATIC bind pose; GltfChild has no output socket, and stays the SOLE pose owner — [[V20]]/[[H36]]). **The architectural lock that resolves the V2-vs-edge-less-GltfChild fork: the bind pose the projection needs is captured ON `GltfAsset` at import (the same `defaultTRS` that already seeds GltfChild), so the projection is pure-on-its-input with NO live edge and NO write path back to GltfChild.** Wave A also closes two latent capture gaps that were silent on the TRS-only committed fixtures: matrix-form joint transforms ([[H51]]) and the joint-list-vs-node-index spine ([[H50]]). Retarget (D-01) and IBM capture (D-04) are SEPARABLE — `SkeletonUtils.retargetClip` reconstructs inverses from the bind pose and needs only name+parent+position+rotation(+scale); the captured IBMs ride for deform-fidelity + future DAG-side skinning (proven == GLTFLoader's `boneInverses` in Wave E1).

**New silent-failure modes (7) + (8) + observation targets at this boundary:**

- **(7) A "convenience" write-back from a rig-reading surface reopens [[H36]].** Any future surface that reads the rig (DAG-side skinning, bone-pick #100/D-06) could "helpfully" write a pose change back to GltfChild from the projection path, re-introducing dual-write. **Observation target / gate:** `GltfSkeleton.ts` + `projectGltfSkeleton.ts` carry NO write/store tokens — the `GltfSkeleton.test.ts` F3 grep guard (comments stripped) fails the build if they do. This converts [[V20]]/[[H36]] from prose into an enforced invariant at the new surface.
- **(8) A rig datum indexed by node-index instead of joint-list position scrambles the rig silently on permuted-joint rigs.** False-passes on identity-ordered fixtures ([[H50]]). **Observation target:** every per-joint array shares the `skin.joints[]` spine; assert ordering + parent on BOTH `[1,0]` AND `[63..0]` fixtures (`gltfSkinCapture.test.ts` / `projectGltfSkeleton.test.ts`). The render-side correspondence is the [[H40]] both-sides check: projected `bones[i].name` == rendered `SkinnedMesh.skeleton.bones[i].name` (sanitized), index-by-index — observed in-app via the `__basher_gltf_skin` seam's `boneName(i)` accessor (added Wave F), NOT inferred from the evaluator alone (the prior P7 trap). The deform-faithfulness proof stays the [[H45]]/[[H46]] one: a bone ROTATION delta + a skin VERTEX delta under real render time (`tests/e2e/p7.11-gltf-rig-nodes.spec.ts` F6a-3).

The cross-vocabulary retarget (a foreign-named clip bridged by a NON-IDENTITY nameMap, with a falsification that an empty map leaves every target bone unbound) is the load-bearing D-01 proof — without it the bridge could be a no-op and a name-identity test would still pass (`retarget.test.ts` F6b).

**Ground Truth note:** GROUND_TRUTH_GLTF.md was DEFERRED at Wave E2 (E1's round-trip test + RESEARCH.md §B1 citations are sufficient empirical ground for 7.11). All 7.11 catalogue entries ([[V25]], [[H50]], [[H51]], the K6 extension) are therefore INTERIM-GROUNDED via RESEARCH.md §B1 three.js citations (`GLTFLoader.js:3930-3993` loadSkin / IBM `:3975` / `new Skeleton` `:3989`; `Skeleton.js:64-78` calculateInverses) until GROUND_TRUTH_GLTF.md is created (a high-payoff de-risk for the next skinning phase / D-06). **REF:** `src/nodes/GltfSkeleton.ts`, `src/core/import/projectGltfSkeleton.ts`, `src/core/import/gltfImportChain.ts` `buildSkinMetadata`, `src/nodes/GltfSkeleton.test.ts` (purity + F3 no-write-back grep gate), `src/core/import/gltfSkinCapture.test.ts`, `src/core/import/projectGltfSkeleton.test.ts`, `src/core/import/retarget.test.ts` (cross-vocabulary bridge), `tests/e2e/p7.11-gltf-rig-nodes.spec.ts` (projection + H40 boundary-pair, observed), [[V25]] [[H50]] [[H51]] [[H40]] [[H45]] [[H46]] [[V20]] [[H36]], RESEARCH.md §B1, CONTEXT/PLAN 7.11. Issue #100.

**B12 silent-failure modes added 2026-05-21:** (4) a glTF with `animations[]` drops silently as a static mesh — pre-P7.5 behavior; CLOSED by PR #92's degenerate→full single-path importer; the regression class is "a future refactor restores the static-only drop path for glTF (e.g. someone extends a different MIME handler), bypassing buildGltfImportOps." Detection: `tests/e2e/p7.5-gltf-animation.spec.ts` Test 1 (single-clip drop → evaluator samples bobbing Y at t=0.5). (5) a glTF rotation track is interpolated as radians when the rest of the system treats Transform.rotation as degrees — the "57.3× too fast" failure mode the B3 CHECKPOINT pre-empted. Detection: `gltfImportChain.test.ts` "B3 CHECKPOINT" + `TransformClip.test.ts` "rotation is stored + interpolated in DEGREES."

**B12 editable-imported-clips extension 2026-05-30 (#108 / phase 7.12):** the child-addressing boundary now carries a fourth precedence LAYER — a per-bone **baked KeyframeChannel** copy-on-write layer between manual override and clip. The one layering primitive `resolveGltfChildTrs` becomes a 4-band presence-based pick (`manual-if-overridden[field] → baked-channel-if-present[field] → clipTrack → base`), branching on PRESENCE not value-equality at the baked band too (a bone keyed back to its base pose KEEPS the override; only absence resurfaces the clip — [[H54]]/R-4). The first timeline edit of a read-only imported clip row transparently bakes that bone's clip track into edge-less per-component `KeyframeChannelVec3` nodes ([[H54]] — NO AnimationLayer edge; the resolver enumerates them by `childName`), keyed by BOTH the GltfChild dagId AND childName ([[V26]]), the keys surviving the zod param-store only because they are schema-declared ([[H56]]). **The lock that preserves single-write + perf: the baked band is sampled (function-of-time, [[V24]]) inside the EXISTING `GltfAssetR` useFrame at the same `seconds` snapshot as the clip — NO new time subscription ([[H48]]), the useFrame stays the SOLE TRS writer ([[V20]]/[[H36]]).** **New silent-failure modes + observation targets at this boundary:** (a) [[H55]] — the band must be threaded into BOTH callers of `resolveGltfChildTrs` (renderer `SceneFromDAG` C2 AND read-side `resolveEvaluatedTransform` C3), via the SHARED enumerator `bakedGltfChannels.ts`, or the gizmo/NPanel diverge from render (the [[H40]] #68/#77 second-surface class); observation target = e2e read-side==render parity at t=0.5 AND t=1.5 (`p7.12-editable-imported-clips.spec.ts` b2 — observed 85.0°==1.4835rad). (b) the FLAG-3 single-row-set: a bone shows clip rows XOR baked rows, never both, never a baked-channel-as-orphan duplicate; observation target = post-bake row inventory (clipRowCount=0, bakedRowCount=3). (c) [[H53]] — clip tracks keyed by childName not dagId (empty-dopesheet trap). (d) the no-subscription perf guard: `commits === 0` across 5s playback on `skinned-bar.glb` (the CI-achievable proof; the node-count knee is a DESIGN argument + the /tmp Fox harness, NOT a small-fixture measurement). Revert is structural: delete the baked node(s) → presence fallback to the clip on BOTH surfaces, through the dispatch seam (which required tightening the V13 closure gate — [[H57]]). **REF:** `src/app/resolveGltfChildTransform.ts` (4-band primitive), `src/app/bakedGltfChannels.ts` (shared enumerator, BLOCK-1/BLOCK-2), `src/agent/mutators/builders/bakeGltfChannel.ts` (the bake), `src/app/animate/bakeOnEdit.ts` + `dispatchMutator.ts` (`dispatchBakeThenRetime`/`dispatchRevertGltfChannel`), `src/viewport/SceneFromDAG.tsx` GltfAssetR (C2), `src/app/resolveEvaluatedTransform.ts` (C3), `tests/e2e/p7.12-editable-imported-clips.spec.ts`, [[V24]] [[V26]] [[H40]] [[H48]] [[H53]] [[H54]] [[H55]] [[H56]] [[H57]] [[V20]] [[H36]], CONTEXT/PLAN 7.12. Issue #108. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

**B12 material-override fidelity extension 2026-05-31 (#99 / phase 7.13):** the render-consumer surface now spans a sixth concern — **applying a `MaterialOverride` to a loaded glTF without destroying its imported material.** The pre-#99 `GltfAssetR` override effect replaced every mesh material with a fresh `new MeshStandardMaterial(7 scalars)`, dropping all maps + downgrading `MeshPhysicalMaterial` (KHR extensions) to plain Standard ([[H59]]). **The fix locks three things at this boundary:** (1) clone the IMPORTED material (`source.clone()` preserves the subclass + every map ref; three.js 0.169 `Material.js:424` / `MeshStandardMaterial.copy` L76-104) and overlay only **map-aware-tint** fields — color/emissive/opacity always, roughness/metalness ONLY where the source has no corresponding map (those scalars multiply their maps; D-01, mirrors Blender's connected-socket-ignores-value-widget semantics), via the pure `resolveMaterialOverrideFields`. (2) Assign a FRESH clone per mesh, NEVER mutate the source material's properties — `Mesh.copy` (`Mesh.js:60`) copies `.material` BY REFERENCE, so clones across instances + the `useGLTF` cache share one object; in-place mutation is the [[V20]]/[[H36]]/[[H45]] single-writer landmine. The override effect stays the sole `m.material` writer, lazily capturing the original per clone (uuid-keyed ref, reset on clone swap) so override changes re-derive from the original and removal RESTORES (fixed a latent `if(!override) return` no-restore bug). (3) This is a SIBLING of [[H45]] at the SAME clone boundary — both are "clone semantics on a loaded glTF" footguns (H45 = skeleton rebind; H59 = material drop); a third clone-semantics pattern here would signal clustering. **New silent-failure mode + observation target:** a recolor/override path that rebuilds (rather than clones) the material drops textures silently — the override node's params still say the right color, only the rendered mesh's live `.map` says "textures gone." Observation target = `__basher_gltf_meshes()` reports `hasMap && mapImageOk` STILL true AFTER the override AND `.color` == the override (both halves), driven through the real op-path wiring not a prop injection ([[H58]]); restore returns `.color` to the imported value (source-integrity proof — the shared `useGLTF` material was never mutated). **OPEN SUCCESSOR: D-06 (#124)** — an explicit per-field "overridden" set on `MaterialOverride` (mirroring `GltfChild`'s TRS pattern) + an opt-in "flatten / ignore source material" toggle (the honest version of Blender's view-layer Material Override clay-flatten); needed for a director who wants to FORCE a mapped channel (e.g. flatten a textured metal to plastic), which the map-presence heuristic deliberately cannot. **REF:** `src/viewport/materialOverrideMerge.ts` (`resolveMaterialOverrideFields` + `.test.ts`), `src/viewport/SceneFromDAG.tsx` GltfAssetR (override effect: lazy original capture + `src.clone()` + restore-on-removal; `__basher_gltf_meshes` color field), `tests/e2e/p7.13-gltf-material-override.spec.ts` (real-affordance wiring + textures-survive + tint-lands + restore guard + falsification), [[H59]] [[H45]] [[H58]] [[H40]] [[V20]] [[H36]], CONTEXT/PLAN 7.13. Issue #99 (#83 fidelity follow-up — material-override slice DONE; #83's remaining slices = load-error surfacing + glTF skeleton→rig, the latter closed by #100/7.11). (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

**B12 multi-format ingestion + asset-management extension 2026-06-01 (#111+#112 / phase 7.14):** the import boundary now spans a SEVENTH concern — the **ingestion SURFACE for BVH/FBX** plus the **My-Imports asset-management** lifecycle (rename / delete / show-files). Two grounded facts shape it: (1) the BVH/FBX importers (`buildBvhImportOps`/`buildFbxImportOps`) ALREADY existed and emit ONLY `Skeleton`+`AnimationClip` (FBX in Basher is MOTION, not a model — P3.1 Mixamo heritage); #111 was purely the missing surface (read OPFS bytes a drop/picker wrote → decode per-format → dispatch). (2) `StorageCapability` has NO move/copy/recursive-delete primitive, so rename/delete are built from read/write/list/delete + a fail-safe ORDER ([[K14]]) and an explicit empty-dir prune ([[H60]]). **The domain-aligned-abstraction move (D-07):** the B12 invariant now spans 3 formats + rename/delete, so the format-agnostic helpers were lifted from `importGltf.ts` to a shared `importCommon.ts` (`IngestFile`, `USER_IMPORTS_ROOT`, naming, `ingestSingleFile`, `listFilesDeep`, `deleteOpfsTree`, `renameImportedAsset`, `deleteImportedAsset`); per-format build-ops stay format-specific (`importBvhFbx.ts` `importBvh/FbxFromOpfs` + `routeImportByExtension`); the chokepoint is still single (B12 invariant: nothing bypasses it). **The architectural asymmetry that drives the rename/delete logic (CONTEXT D-03): glTF persists a `GltfAsset.params.assetRef` → rename must rewrite it + delete-when-referenced is BLOCKED; BVH/FBX leave NO persistent ref → `nodesReferencingImport` returns [] → rename is folder-move-only and delete is always immediate.** A pure `nodesReferencingImport(name,state)` scanner (prefix-boundary safe — `user-imports/foo/` ≠ `user-imports/foobar/`) feeds BOTH the rename ref-rewrite and the delete-block. **New silent-failure modes + observation targets at this boundary:** (a) the no-move-substrate trap ([[H60]]) — delete-old before the new copy is verified orphans a live assetRef; file-only delete leaves an empty OPFS dir; the fail-safe order is copy→verify→rewrite-refs(1 dispatchAtomic, [[K6]])→deleteOpfsTree→bump ([[K14]]); observe the REAL OPFS directory handle (not just MemoryStorage's file map — the backend-asymmetry blind spot). (b) the My-Imports enumeration + drop/menu routing must recognise ALL FOUR formats (`.gltf`/`.glb`/`.bvh`/`.fbx`), not glTF-only, or a BVH/FBX silently never lists / never routes (D-04/D-05; the glTF-only-assumption trap, a sibling of the surface-coverage gaps). (c) break-refs delete = disconnect-consumers-then-removeNode in one dispatchAtomic ([[H57]]/[[V13]] — the op layer rejects removing a still-consumed node). **KNOWN LIMITATION (scoped):** break-refs removes the referencing `GltfAsset` node(s) + disconnects consumers, but leaves the import-created wrapper Transform/Group + the inputless `GltfChild` satellites as inert nodes (full import-footprint GC needs import-provenance that does not yet exist) — a follow-on, not a correctness bug. **REF:** `src/app/asset/importCommon.ts` (the lifted chokepoint + rename/delete/listFilesDeep/deleteOpfsTree), `src/app/asset/importBvhFbx.ts` (per-format OPFS chokepoints + `routeImportByExtension`), `src/app/asset/importRefs.ts` (`nodesReferencingImport`), `src/app/AssetDropZone.tsx` + `src/app/MenuBar.tsx` (`Import…` accepts all 4 exts) + `src/app/boot.ts` (`__basher_ingestBvh/FbxFile` seams), `src/app/AssetsPopover.tsx` (`findEntryFile` multi-format listing + the ︙ menu/rename/delete-banner — D-UX-18), `tests/e2e/p7.14-bvh-fbx-import.spec.ts` (ingest → Skeleton+AnimationClip, not a mesh) + `tests/e2e/p7.14-my-imports-mgmt.spec.ts` (rename→assetRef-follows / delete→OPFS-clear / referenced→banner→break-refs), [[H60]] [[K14]] [[H57]] [[V13]] [[K6]] [[H40]], CONTEXT/PLAN 7.14. Issues #111, #112. (BVH/FBX importers interim-grounded; glTF refs grounded in GROUND_TRUTH_GLTF.md.)

### Boundary B13: SceneFromDAG render-reconciliation (DAG/time stores ↔ React/R3F tree)

**ORIGIN:** perf investigation 2026-05-28 (issue #114, branch `perf/scene-scale-profiling`). `SceneFromDAG` subscribes to `useDagStore(s=>s.state)` (`SceneFromDAG.tsx:73`) AND `useTimeStore(s=>s.seconds)` (`:78`), so it re-renders + re-walks the WHOLE scene subtree on every edit AND every playback frame — independent of how many nodes actually changed. A three-budget profiler (eval / React / GPU) measured the cost: `eval p95 = 0.00ms` (94–100% cache hits — the evaluator is NOT the bottleneck), GPU holds 60fps to ~4000 draw calls / 4.4M tris, but React reconciliation is linear in node count (~0.011ms/node, M-series) and breaks the 16.6ms budget at ~1000 nodes. This boundary is DISTINCT from B1 (B1 = Op-mutation purity; B13 = render/reconciliation COST at the same surface).

**WHY:** Without this boundary tracked, the next "engine is slow" report gets misdiagnosed as an evaluator/determinism problem (→ Rust/WebGPU rewrite talk — the [[H48]] false-cause trap) instead of a React-reconciliation problem. It is also the design-entailed bottleneck for any scene with ≥~1000 nodes OR any animated scene during playback (the per-frame re-walk hits playback even when one object moves). Removing this entry reopens H48 as an empirical rediscovery and risks a wrong-layer rewrite.

**HOW:** the fix (not yet built) clusters here — (1) memoize per-node React subtrees so reconciliation touches only changed children (React.memo keyed on each child's evaluated-value hash); (2) decouple time-driven playback from React re-renders by mutating three.js objects imperatively per frame (the W9 timeline-playhead lesson, owed to the 3D viewport). **Observation target at this boundary:** before/after any change here, run the three-budget profiler (`window.__basher_perf` + `__basher_perf_stress`, or the Fox-duplication skinned benchmark) and read the React budget — NOT eval, NOT total fps. **Measurement trap:** GPU triangle load must come from a scene-graph walk (`scene.traverse`), NOT `gl.info.render` — PostFx's EffectComposer leaves `gl.info` reflecting only its final fullscreen pass. **REF:** `src/perf/frameProfiler.ts`, `src/perf/PerfProbe.tsx` (the `<PerfBoundary>` Profiler + `<GpuProbe>` scene-walk), `tests/e2e/perf-scene-scale.spec.ts`, `tests/e2e/perf-fox-benchmark.spec.ts` (skinned+animated benchmark), `src/viewport/SceneFromDAG.tsx:73,78` (the two per-frame subscriptions), [[H48]]. Issue #114.

**B13 — 2nd occurrence confirms (2026-05-28, headed M-series real GPU).** The Fox-duplication skinned+animated playback benchmark (Khronos `Fox.glb` × N, `useTimeStore.play()`, 5s) measured React reconciliation **~2.9ms per fox subtree, linear**, with eval ramped 0.3→0.8ms (TimeSource hash flips every frame → TransformClip cache-misses every frame, evalCalls/commit 20→62) — still **30× smaller than React**. 60fps knee landed between 4 and 6 foxes (`react.p95 = 12.5ms → 18.4ms`). GPU drew 6→12 calls / 1.3K→4.7K tris — trivial. **Promotion criteria met:** observed twice (synthetic SphereMesh CHURN + Fox skinned PLAYBACK), at the same boundary, with the same diagnosis (React-reconciliation linear in node count, dominates eval + GPU). Skinned+animated is the design-entailed case for an animation tool, so the fix moves from "future lever" to "v0.7 next-build candidate". The two memoize+imperative-playback levers (H48's "real fix") are now load-bearing for typical scenes, not edge cases.

**B13 — SHIPPED in P7.10 (2026-05-29).** The Pass 3 architectural fix landed: `TransformClipValue.sample(seconds)` (Houdini-precedent function-of-time at the value-shape level, see [[V24]]); `TransformClip` drops its `time` input socket so its cache key stops flipping per frame; `SceneFromDAG.tsx` drops the three `useTimeStore.seconds/frame/normalized` subscriptions and evaluates with frozen `ctx.time={0,0,0}`. Result: react.p95 collapsed from 24ms (Pass 2) to **0.00ms at every Fox-count level**; `commits = 0` across 5s of playback (vs ~600 commits pre-Pass-3); `frame.p95` flat at ~9.5ms (60fps with headroom). The Wave G acceptance held. **HOW (updated):** before / after any change at this boundary, run `PWHEADED=1 npx playwright test tests/e2e/perf-fox-benchmark.spec.ts --headed` and read both `react.p95` AND `commits` during playback. Either climbing back above zero is a regression against [[V24]] — likely a re-subscribed time-store dependency at the SceneFromDAG level OR a new impure node returning a pre-baked value instead of a `(t) => T` closure ([[H49]]). The single-writer V20/H36/H33 invariant on TRS write is preserved: `GltfAssetR`'s `useFrame` remains the sole bone-TRS writer onto the cloned scene; it reads live time imperatively (`useTimeStore.getState().seconds`) and samples the closure (`value.transformClip?.sample(seconds)`) at consumer cadence. **REF (added):** `src/nodes/TransformClip.ts` (the closure builder; `inputs: {}`), `src/nodes/types.ts` `TransformClipValue.sample`, `src/viewport/SceneFromDAG.tsx:73` (the no-time-subscription site + frozen ctx + the consumer useFrame), `src/app/resolveGltfChildTransform.ts` (signature: `tracks: Record<...>`, no longer `clip: TransformClipValue`), [[V24]], [[H49]]. Issue #114.

## Override-tracking consolidation boundary (cross-cutting — GltfChild ⊕ MaterialOverride)

**ORIGIN:** #124 design pass (2026-06-02). Filing #124 (a per-field `overridden` set on MaterialOverride) surfaced that `GltfChild` ALREADY hand-rolls `overridden:{position,rotation,scale}` and `resolveGltfChildTransform` hand-rolls the "manual-if-overridden else source" merge. #124 was about to mint the 2nd bespoke override-tracker + merge — a RECURRENCE (1st GltfChild, 2nd MaterialOverride), which is the promotion trigger.

**WHY:** without recognising this as one boundary, every future override domain (a 3rd, 4th…) re-implements the authored-set + the precedence merge + the NPanel reset affordance from scratch, and the map-presence-style workarounds (#99) proliferate. The class of problems made invisible: "two surfaces that both layer an override on a source drift apart in their dirty-tracking + revert semantics" (the same second-surface drift class as [[H40]], here in the override-tracking dimension). Removing this entry reopens "diagnose the next override-tracker from scratch instead of matching the known consolidation."

**HOW (the focus + the grounded decision):**

- The boundary is **override-tracking**: a per-field authored set + the merge rule `set[field] ? override[field] : source[field]` + the edit-to-override/per-field-revert UI. Consolidate into ONE primitive `src/core/override/overrideSet.ts`; consumers = `GltfChild` (retrofit) + `MaterialOverride` (#124) + NPanel `ParamRow` decorator.
- **Decided shape (grounded Houdini USD-opinion + Blender Library-Override, CONTEXT.md):** generic SUBSTRATE + TYPED wrappers — NOT a generic `Override(path→value)` mega-node. Basher already owns the generic operator substrate (`setParam` by `paramPath`); the gap is only the shared authored-set + revert UI. Both DCCs keep typed override nodes (Set-Material, Assign-Material LOP are nodes) over the generic substrate.
- **The structural reason the bit is EXPLICIT, not derived ([[V28]]):** Basher params are single-tier (seeded with the source value, R-4); USD/Blender derive overridden-ness from a two-tier authored-vs-fallback model Basher lacks. So the authored bit is carried, not inferred.
- **Flatten is a SEPARATE boundary** (coarse `ignoreSourceMaterial` toggle — Blender View-Layer Material Override / Houdini wholesale-assign), not folded into the per-field set.

**Observation targets:** after #124, fixing the Nth override domain should touch ONLY that node's params + one resolver call-site (consume `overrideSet`) — NOT a new tracker module + a new merge + a new revert UI. If the (N+1)th override domain still grows its own `overridden` shape, this consolidation didn't take — re-derive.

**OBSERVED RESULT — consolidation TOOK (#124 SHIPPED, PR #132 MERGED to `main` `088b21c`, 2026-06-02):** the primitive `src/core/override/overrideSet.ts` landed with TWO consumers as designed (D-06). The cost-curve flattened exactly as predicted: (1) GltfChild's bespoke merge was REPLACED by a single `mergeOverridden(...)` call (its hand-rolled `pick` band deleted) — a pure refactor, proven zero-shift by p7.7/p7.11/p7.12 e2e + 22 unit green UNCHANGED; (2) MaterialOverride's per-field force was added by consuming `isOverridden` in `resolveMaterialOverrideFields` + carrying the set on `MaterialValue` — NO new tracker module, NO new merge. The #99 map-presence workaround is now the explicit-set's FALLBACK (`isOverridden(set,f) || !map`), not a standalone heuristic. GOAL observed live (Lokayata, H40/H59 boundary-pair): `tests/e2e/p124-material-force-channel.spec.ts` forces `metalness=0` over a real three.js `.metalnessMap` (flatten not drop) and reverts. **Vyapti span: [[V28]] lands ALIGNED — the authored-set concern is enforced in ONE module spanned by two thin consumers; no invariant gained a multi-module span.** DEFERRED (independently shippable, the per-field-UI + flatten halves of the original design): **#130** NPanel `ParamRow` per-field decorator + ✕-revert (D-04 — until then both `MaterialOverride.overridden` AND `GltfChild.overridden` render as the same `(complex — Pro mode)` ParamRow fallback; consistent prior art since 7.7, the decorator fixes BOTH) · **#131** `ignoreSourceMaterial` flatten toggle (D-05, the separate coarse boundary noted above). The (N+1)th-domain re-derive test is now armed: a 3rd override domain that grows its own `overridden` shape instead of consuming `overrideSet` is the signal this consolidation regressed.

**OBSERVED RESULT — the decorator fixes BOTH consumers as predicted (#130 Wave D SHIPPED, 2026-06-02):** the consolidation dividend held. ONE node-type descriptor (`src/app/overrideDescriptor.ts`) + ONE shared `OverrideDecorator` on the existing `ParamRow` now drive the per-field state-dot + ✕-revert for BOTH `MaterialOverride.overridden` AND `GltfChild.overridden` — the two surfaces that previously both rendered as the identical `(complex — Pro mode)` fallback. No per-consumer UI was written; the descriptor gates the decorator to the covered fields and returns null for the ~38 other node types (the over-reach risk did NOT materialise). **The schema-shape split surfaced a real seam:** revert can't be one primitive — `clearOverride` (drop the key) is correct for MaterialOverride's `.partial()` set but would FAIL GltfChild's fixed-key `z.object({position,rotation,scale})` validation, so `buildRevertedSet` branches `clearOverride` (sparse) vs `withOverride(false)` (record). Both still read not-overridden via `isOverridden`, and the renderer restores source because both consumers branch on the explicit bit (the same R-4/[[V28]] property the revert relies on). **Latent gap closed:** NPanel TRS edits on a GltfChild previously did NOT set the `overridden` bit (only the gizmo's `writeGltfChildOverride` did — the [[H40]]/C2 second-surface trap); the shared `dispatchOverrideValueEdit` now marks value + bit in one atomic on BOTH the gizmo and the Inspector. GOAL observed live (H40/H59, not node params): `tests/e2e/p130-npanel-override-decorator.spec.ts` edits metalness in the REAL NPanel → forced over the map (`.metalness===0`, dot fills), ✕-revert → map defends (`.metalness===1`, dot hollow). **#124's deferred halves are now BOTH shipped (#130 + #131); the override-consolidation boundary is complete** — the next override domain inherits the primitive + the descriptor + the decorator for free.

**Operators-vs-graph note (the framing that opened the design pass):** Basher's Op layer (`addNode/removeNode/connect/disconnect/setParam`) ALREADY is the generic "operate on any node/property" layer the user asked about — `setParam` takes any node + paramPath + value. The standing material TRANSFORM must remain a NODE (a function in the dataflow), confirmed by both DCCs (Material SOP / Set-Material / Assign-Material LOP are all nodes) — because an imported material has no addressable static param to `setParam`. So the operator/node split is ALREADY correct; the only gap was the shared override-set primitive the typed nodes sit on.

**REF:** `.planning/phases/124-material-override-primitive/CONTEXT.md` + PLAN.md (decisions, 6-wave plan, Houdini+Blender grounding), [[V28]] (the invariant), [[H59]] (map-aware tint — the per-field default), [[V20]]/[[H36]] (single-writer material), the GltfChild R-4 trap, the existing B12 material-override extension (#99 successor note). Issue #124.
