# Vyāpti — Invariants

> Structural rules that must hold across the codebase. Pulled from THESIS.md commitments. Marked NOT YET IMPLEMENTED until P0 enforces them.

## Format

```
### V<N>: <invariant statement>

**Span:** which modules / files this invariant reaches
**Enforcement:** how it's mechanically enforced (lint, test, CI, review)
**Status:** ALIGNED / MISALIGNED / NOT YET IMPLEMENTED
**REF:** THESIS.md section + file:line if implemented
**Why it matters:** what breaks if violated
```

---

### V1: Every store mutation goes through the Op dispatcher

**Span:** DAG store (`src/core/dag/store.ts`). UI projections (mode store, selection store) have their own state and never touch the DAG.
**Enforcement:** `useDagStore.dispatch(op, source, description)` is the SOLE mutation entry; `hydrate()` is the project-load seam (clearly named, bypasses op log). Inspector + future agent surfaces emit Ops, never `setState`.
**Status:** ALIGNED (P0)
**REF:** THESIS.md §50; `src/core/dag/store.ts:46`

### V2: Pure node evaluators are bit-exact reproducible given (params, inputs)

**Span:** All five P0 node types (`src/nodes/*.ts`). Future nodes inherit the constraint.
**Enforcement:** ESLint `no-restricted-syntax` on `src/nodes/**` bans `Math.random`/`Date.now`/`performance.now`/`crypto.randomUUID` (`eslint.config.js`). Vitest twice-eval test asserts deep-equal value + identical content hash on the default DAG (`src/nodes/nodes.test.ts`). Hash is FNV-1a over a stable JSON of (nodeId, params, inputHashes-sorted, time iff impure).
**Status:** ALIGNED (P0)
**REF:** THESIS.md §48, §51; `src/core/dag/evaluator.ts:79`

### V3: Time enters as a `Time` socket, never as a closure or global

**Span:** All animation and render node evaluators in `src/nodes/**`. The `TimeSource` node (`src/nodes/TimeSource.ts`) is the SOLE legal time producer; pure consumers wire their `time` input to it.
**Enforcement:**

- ESLint `no-restricted-syntax` on `src/nodes/**` bans `Math.random` / `Date.now` / `performance.now` / `crypto.randomUUID` / `useFrame` / `useThree` (`eslint.config.js:6-32`).
- Vitest twice-eval at multiple t values for every Time-aware pure node — PosedSkeleton, AnimationClip, LocomotionState, Character (`src/nodes/nodes.test.ts` Wave A block).
- The evaluator's cache key includes time only for `pure: false` nodes (`src/core/dag/evaluator.ts:119`); pure consumers re-evaluate via the upstream TimeSource hash flip propagated through `inputHashes`.
  **Status:** ALIGNED (P2). The first user — `AnimationClip` consuming `Time` via socket — flipped this from NOT YET IMPLEMENTED. P2 acceptance #1 (E2E) verifies bit-exact replay at t=2.5s.
  **REF:** THESIS.md §49; `src/nodes/TimeSource.ts:1`; `src/nodes/AnimationClip.ts:1`; `src/nodes/PosedSkeleton.ts:1`; `src/nodes/LocomotionState.ts:1`.
  **Why it matters:** scrubbing, frame-stepping, agent's "what does scene look like at t=2.5?" all depend on this.

### V4: Every node type carries a `version: number`; project loaders migrate

**Span:** Every node-type definition (`NodeDefinition.version`) + project loader (`src/core/project/io.ts`) + migration runner (`src/core/project/migrations.ts`).
**Enforcement:** Type system requires `version` field. Two ladders run on load: format migrations (registered by version) and per-node migrations (`def.migrations[v]`). v0.5 ships zero registered migrations — first node-type bump adds the first.
**Status:** ALIGNED — runner + format-migration + per-node migration paths tested (`src/core/project/project.test.ts`). P0 ships at format=1, node version=1 across the board, no migrations registered.
**REF:** THESIS.md §52; `src/core/project/migrations.ts:1`

### V5: Permissive licenses only in dependency tree

**Span:** Every production dependency (`scripts/license-audit.mjs` walks `npm ls --omit=dev --all`).
**Enforcement:** `npm run license-audit` job in `.github/workflows/ci.yml`. Allowlist: MIT/ISC/BSD-2/BSD-3/0BSD/Apache-2.0/CC0/Unlicense/Python-2.0/WTFPL/Zlib/BlueOak-1.0; forbidden tokens: GPL/AGPL/LGPL/CC-BY-NC/SSPL/BUSL/CDDL. Falls back to LICENSE-file scan when `package.json.license` is absent.
**Status:** ALIGNED — 74 production deps, all permissive. GPL `blockbench/` reference checkout is gitignored AND vite-fs-denied.
**REF:** THESIS.md §35; `scripts/license-audit.mjs:1`

### V6: Capability interfaces decouple browser/native impls

**Span:** `src/core/storage/` (`StorageCapability` → `OpfsStorage`/`IndexedDbStorage`/`TauriStorage`/`MemoryStorage`); `src/integrations/blender/` (`BlenderBridgeCapability` → `BrowserBlenderBridge`). v0.6 will add `core/file-picker/` and `core/render-encoder/`.
**Enforcement:** No code outside `src/core/storage/` or `src/integrations/blender/` imports a Tauri, `idb`, OPFS, or `node:fs` symbol. `pickStorage()` chains OPFS → IndexedDB → Memory at runtime via `isAvailable()`.
**Status:** ALIGNED for storage + Blender bridge. P2 viewport-polish added IndexedDB without a single caller change — capability discipline held. v0.6 Tauri swap point remains a one-line provider change in `src/app/boot.ts`.
**REF:** THESIS.md §33; `src/core/storage/StorageCapability.ts:1`; `src/core/storage/IndexedDbStorage.ts:1`

### V7: Agent tool handlers return `Op[]`; do not mutate state directly

**Span:** Every agent tool definition (`src/agent/tools/*.ts`).
**Enforcement:** Tool handler signature is `(args, ctx: ToolContext) => Op[] | Promise<Op[]>`. No exceptions.
**Status:** ALIGNED (P2.5). Four tools shipped with Vitest twice-call tests proving pure output. Diff system enforces the Op-only return path — accept feeds through dispatchAtomic; reject discards fork.
**REF:** THESIS.md §18, §20; `src/agent/tools/types.ts:10`; `src/agent/tools/registry.ts:15`; `src/agent/diff/forkedDag.ts:1`; `src/agent/diff/store.ts:113`
**Why it matters:** agent edits via the same path as the user; one undo system; one diff system; one audit log.

### V8: Viewport + render execution never mutate DAG; both read evaluated DAG output

**Span:** R3F `Canvas` (`src/viewport/Viewport.tsx`) + `SceneFromDAG` (`src/viewport/SceneFromDAG.tsx`); P4 extension: `runRenderJob` + encoders (`src/render/**`).
**Enforcement:** `SceneFromDAG` calls `evaluate(state, target.node, { cache })` and walks the result. `runRenderJob` walks frames, evaluates the pass subgraph, and writes via `StorageCapability` (V6). The rule is **file-rooted, not call-stack-rooted**: no source file under `src/viewport/` OR `src/render/` contains a `dispatch(...)` call, `useDagStore.setState`, or `applyOp(...)`. Components imported from `src/app/` that dispatch (e.g. `src/app/Gizmo.tsx` — the TransformControls authoring surface) are allowed even when they render inside the Canvas — the dispatch is defined in their own file's source. The `src/render/` extension is mechanically guarded by a textual import-only regex test in `src/render/runRenderJob.test.ts` ("V8 — file-rooted dispatch rule"). Mode switches do not unmount the Canvas — Layout flips slot visibility via `display:none` (K1 step 6).
**Status:** ALIGNED. Click-to-select handlers in NodeList live in `src/app/`, not `src/viewport/`, and update `selectionStore` (a UI projection, not the DAG). The P1 Gizmo (`src/app/Gizmo.tsx`) follows the same pattern — file location, not Canvas containment, defines the boundary. P4's `src/render/` extension verified clean — runRenderJob reads DagState + writes to storage; no Op emission from this directory.
**REF:** THESIS.md §11; `src/viewport/SceneFromDAG.tsx:30`; `src/app/Gizmo.tsx:1`; `src/render/runRenderJob.ts:1`; `src/render/runRenderJob.test.ts` (V8 import guard).

### V10: Persisted-schema fields require defensive defaults at every consumer until the hydrate seam re-validates

**Span:** Every node evaluator (`src/nodes/**`) AND every render-side consumer of an evaluator's output (`src/viewport/**`, `src/app/**` reading `value.X`) when a schema field is added after the project format has been released.
**Enforcement:** Code review: any new field on a node's `paramSchema` MUST also be guarded with `?? defaultValue` at the evaluator (so legacy `node.params` lacking the field don't emit `undefined` into the value), AND at every consumer that destructures the field on a value object (so a future evaluator slip still doesn't crash). The two-layer guard is intentional belt-and-suspenders. The hydrate seam (`useDagStore.hydrate()` in `src/core/dag/store.ts`) bypasses `paramSchema.parse()` because saved projects are assumed validated — but ".default()" only fills on parse, not on hydrate. Until v0.6's re-validation pass, this invariant lives in eval+consumer code.
**Status:** ALIGNED for v0.5 — every persisted-schema field added post-release follows this rule. Two occurrences cataloged: `rotation: vec3` on positional lights (P2.6.3) and `scale: vec3` on positional lights (P2.6.4). Both pair an evaluator-level `?? default` with consumer-side `?? default` in helpers + renderer.
**REF:** hetvabhasa H14; `src/nodes/{DirectionalLight,PointLight,SpotLight,AreaLight}.ts` (evaluator default); `src/viewport/{LightHelpers,SceneFromDAG}.tsx` (consumer default); `src/nodes/lightRotation.test.ts` + `src/nodes/lightScale.test.ts` (regression coverage). v0.6 plan: add `paramSchema.parse()` re-validation inside `hydrate()` at the project-load seam — eliminates the need for evaluator-level guards going forward (they remain harmless redundancy).
**Why it matters:** the bug class this prevents is silent on dev fixtures and only fires for real users with persisted projects from before the field landed — the worst possible failure mode (canary tests pass; users crash on app open). The two-layer guard converts a load-time crash into a benign default + UI behavior the user can correct via the gizmo. The rule's _generality_ matters more than the specific rotation/scale cases — every future schema addition triggers the same trap unless the convention is actively maintained.

### V11: Agent tool context must carry selection state

**Span:** `ToolContext` interface (`src/agent/tools/types.ts`), orchestrator tool call dispatch (`src/agent/orchestrator.ts:180`), system prompt builder (`src/agent/orchestrator.ts:247-256`), AgentChat message sender (`src/app/AgentChat.tsx:34`).
**Enforcement:** `ToolContext` has `selectedNodeIds: ReadonlySet<string>`. Orchestrator passes it to every handler. System prompt includes a `Selected nodes:` block with id, type, and current params. AgentChat reads from `useSelectionStore.getState().selectedNodeIds` at send time.
**Status:** ALIGNED (P2.5 v2).
**REF:** `src/agent/tools/types.ts:21`; `src/agent/orchestrator.ts:245-256`; `src/app/AgentChat.tsx:34`.
**Why it matters:** Without selection context, "rotate selected to 45°" acts on all matching nodes or all nodes in the scene. The LLM has no way to know which node the user is pointing at.

### V13: Agent mutations preserve the declared closure

**Span:** `src/agent/closure/` (expand + types) + `src/agent/diff/store.ts`
(propose-time gate) + `src/agent/orchestrator.ts` (closure inference and
F6 retry threading) + every `src/agent/mutators/builders/*.ts`
(buildClosureSpec) + `src/agent/mutators/validate.ts` (gate 3).

**Enforcement:** `useDiffStore.propose` accepts an optional
`closureSpec`. When provided, `expandClosure(spec, state)` resolves the
roots into a node set and the gate rejects any op whose target lies
outside (V13 acceptance #2: "rotate selected can NEVER produce ops
that mutate any other node"). Fresh addNode introducing a new id is
allowed; ids introduced earlier in the same diff propagate. Mutator
plans declare their own closure via `MutatorDefinition.buildClosureSpec`
— the orchestrator passes that to propose, overriding the
selection-inferred fallback.

Each declared edge kind runs its own per-root BFS. Mixing 'parent' and
'children' produces a UNION ("ancestors and descendants of root"), not
a free-mixing walk that would leak siblings under a shared parent.

**Status:** ALIGNED (P2.5.2 Wave A + Wave C, 2026-05-08).
**REF:** P2.5.2 PLAN §5; `src/agent/closure/expand.ts:1`;
`src/agent/diff/store.ts:95` (gate); `src/agent/mutators/validate.ts:1`
(gate 3); `src/agent/orchestrator.ts` (`inferClosureSpec`,
`mutatorClosureSpec` precedence). Twice-call determinism + cycle-safety
+ maxDepth tested in `src/agent/closure/expand.test.ts`. Integration
proven by `src/agent/diff/diff.test.ts` ("propose with closure rejects
out-of-closure ops").

**Why it matters:** without this gate, ops from fuzzy LLM output land
on the wrong node and the user only catches it visually after accept.
With the gate, the orchestrator threads the structured rejection back
to the LLM as a follow-up message and the LLM either retries within
scope, dag.inspects for context, or surfaces to the user. The bug
class — agent mutating outside intent — becomes mechanically impossible
when a closure is declared.

### V14: Mutator non-redundancy

**Span:** `src/agent/mutators/builders/*.ts` (every Mutator
definition).

**Enforcement (mechanical):** an automated test asserts no two
registered Mutators share the same
`(requiredEdges, requiredNodeTypes, preserves, lossy[].kind)` contract
signature. A signature collision fails CI with the two colliding names
— no review pass needed to catch the easy case.
Test: `src/agent/mutators/mutators.test.ts` — "V14: no two Mutators
share the same contract signature."

**Signature widening (issue #60 / hetvabhasa H36, 2026-05-18):** the
signature now includes the sorted set of `lossy[].kind` strings. The
pre-widening signature read `preserves` only; for two Mutators that
differ ONLY in what they DESTROY (e.g. append vs delete a sample), an
honest declaration left them colliding because `lossy` was invisible
to the gate. The mechanically-rewarded escape was a false `preserves`
token — the gate stayed green by certifying a lie. The first observed
escape was P7's `deleteKeyframe` (a `'keyframe-identity'` PreservedAspect
in `preserves` to avoid a `simplifyChannel` collision). H36 catalogues
the pattern; the resolution widened V14 to read `lossy[].kind`, then
the now-honest `deleteKeyframe` collided with the now-honest
`clearChannel` (both destroy `animation-shape` + `keyframe-density` at
different scales), which V14 correctly flagged as a parameterization
candidate. They were merged into `removeKeyframes` with
`scope: 'all' | { time }`. The `'keyframe-identity'` PreservedAspect was
retired as dead. **Lesson encoded in V14:** if you want to game the
mechanical gate, the gate's input set is too narrow — widen the gate,
don't lie in the contract.

**Enforcement (review-layer, semantic):** the mechanical test catches
contract clones but not deeper semantic redundancy (two Mutators emit
the same Op-shape on a probe scene). Code review still applies:
- Could `setBoxColor` be folded into the existing
  `mutator.setMaterialColor` by widening its precondition? Yes →
  reject the new entry.
- Could `rotateAroundPivot` be a parameter on `mutator.rotate` (e.g.
  optional `pivot: vec3`)? Yes → extend, don't fork.

The catalog lives in one barrel file (`src/agent/mutators/index.ts`)
so adding one is visible in any diff. Monthly catalogue audit if the
catalog passes 20 entries in v0.5. A follow-up issue tracks the
Op-shape probe test.

**Status:** ALIGNED (P2.5.2 Wave C, 2026-05-08; mechanical guard added
2026-05-08 post-PR-#9 review). Six starter Mutators ship with unique
contract signatures: rotate (preserves position+scale+material+children),
translate (preserves rotation+scale+material+children), scale (preserves
position+rotation+material), setMaterialColor (preserves
position+rotation+scale+children), duplicate (preserves
rotation+scale+material), deleteNode (preserves nothing). Each covers
a distinct Op-shape pattern.

**REF:** P2.5.2 PLAN §2 P-4; `src/agent/mutators/index.ts:1` (the
single visible catalog); `src/agent/mutators/mutators.test.ts` (the
mechanical guard).

**Why it matters:** Mutator-thinking is contagious — every new noun
the LLM emits ("setLightColor", "setBoxColor") is a candidate Mutator
unless the catalog actively resists. Without V14, the catalog grows
into a per-node-type per-property surface (50+ entries) instead of
staying at the semantic-operation layer (~10 entries). The five-gate
validator works equally well at either size — but the LLM's decision
quality drops sharply once "which Mutator?" becomes a search problem.

### V15: Workflow strategy is fetched lazily, not inlined in the system prompt

**Span:** `src/agent/orchestrator.ts` (`buildStaticSystemPrompt` —
keeps only rules + tool catalogue + Op shape examples + a one-line
quick-conventions summary) + `src/agent/strategy/` (the catalog +
`agent.getStrategy({ topic })` tool).

**Enforcement:** code review. Any new "tip / preference / workflow
hint / how-to" content goes to a strategy resource via
`registerStrategy(...)`, not into the inline system prompt. The
prompt's role is rules + Op shape — non-negotiable on every round.
The strategy catalog's role is contextual guidance — fetched only
when the topic is relevant.

**Status:** ALIGNED (P2.5.2 Wave D, 2026-05-08). Five starter
resources land: units, materials, lighting, cameras, assetChoice.
The orchestrator's old `paramTips` block (Common node params + Units
convention) was lifted into the units + materials + lighting
resources; the prompt keeps only a one-line pointer.

**REF:** `src/agent/strategy/catalog.ts:1` (the registry +
starter resources); `src/agent/strategy/tool.ts:1` (the LLM-facing
tool); `src/agent/orchestrator.ts` (`paramTips` slimmed to one line +
strategy pointer).

**Why it matters:** the system prompt is the most expensive context
window — re-sent every round of every turn. Moving 500-1000 tokens
of contextual workflow guidance to lazy resources cuts each round's
prompt cost without losing accessibility (the LLM can still pull the
exact body when relevant). Privacy posture (V15-adjacent): the
strategy catalog is local + deterministic — no external service
holds the workflow library.

### V12: Every convention boundary is declared in `.anvi/dcc-reference.md`

**Span:** every value-typed field on a node param schema, every agent tool
arg, every persisted-format field. Whenever the field's interpretation
depends on a convention (units, axis order, time representation, color
space, etc.), that convention MUST be declared explicitly — the canonical
declaration lives in `.anvi/dcc-reference.md`.

**Enforcement:** code review. New `paramSchema` field with a value type
that has a convention question (rotation, FOV, intensity, color, time,
etc.) requires either (a) a Cross-refs line pointing at the relevant
dcc-reference.md section, or (b) a new section added to that doc with
the industry-standard table BEFORE the field lands. The agent's system
prompt declares the conventions verbatim so the LLM emits matching
values.

**Status:** ALIGNED for the conventions captured today (rotation,
position, color space, color storage, coord system, time, Euler order,
material model, tonemap). TBD for conventions that will land with P3+
(quaternion serialization, animation interpolation, IK solver,
skinning weights, render output color space, frame rate default).

**REF:** `.anvi/dcc-reference.md` (the lookup table); H20 (first bug
that motivated the invariant); dharana §3 axis "Convention boundary
(units / coordinate / format)" (the lens this invariant is enforced
through).

**Why it matters:** without this invariant, every new field is a
candidate silent-unit-boundary bug. H20 was invisible for the entire
P0-P2.6 lifespan because no test exercised non-zero degree input;
similarly subtle bugs are queued for FOV (vertical/horizontal),
intensity (lumens/unitless), color (linear/sRGB), Euler order. Making
the convention explicit at design time converts an empirical-discovery
class into a deductive-lookup class — Lokayata-on-design instead of
Lokayata-on-bug.

### V9: Materials are data, not code (in v0.5)

**Span:** `src/nodes/MaterialOverride.ts` + any node exposing material parameters.
**Enforcement:** Material nodes expose preset choice + scalar/texture params only. No string-typed shader source, no JS callback that returns a `Material`, no TSL/OSL/GLSL/WGSL authoring surface in v0.5. Reviewer rejects any `new ShaderMaterial({ vertexShader, fragmentShader })` outside `core/render/` (none expected in v0.5).
**Status:** ALIGNED (P1). `src/nodes/MaterialOverride.ts` exposes preset PBR scalars (`color`, `roughness`, `metalness`, `opacity`, `emissive`, `emissiveIntensity`) only. The viewport applies via `MeshStandardMaterial`; no shader-source pathway exists anywhere in `src/`.
**REF:** THESIS.md §39 (`MaterialOverride`); deferred-decision rationale in `dharana.md` §3 ("Shader-as-node-graph"); `src/nodes/MaterialOverride.ts:10`.
**Why it matters:** PBR via GLB + parameter overrides keeps the asset library decoupled from the renderer. Allowing shader-as-code in P1 leaks renderer concerns into content authoring, breaks determinism/caching guarantees (V2), and pulls TSL's WebGPU surface area into a phase whose job is content placement. Re-evaluate when the render graph lands (P4).

### V16: Every chrome-hiding mode has a keyboard escape

**Span:** `src/app/stores/modeStore.ts`, `src/app/KeyboardShortcuts.tsx`, every operational mode that hides chrome regions.
**Enforcement:** if a mode sets `display: none` on regions containing the mode-switching UI (R3 TopToolbar, R5 LeftSidebar's chrome dropdown, R-anywhere with `useModeStore.setMode`), there must be a keyboard handler that returns to a mode where chrome is visible. The canonical handler is Esc → `useModeStore.setMode('edit')`. ESLint guard: any new operational mode added to `Mode` type triggers a manual check on `KeyboardShortcuts.tsx`.
**Status:** ALIGNED (P6 W1). `mode === 'director'` hides R1/R2/R3/R4/R5/R7; Esc handler at `src/app/KeyboardShortcuts.tsx:139–146` resets mode to `'edit'`. Any future mode that hides chrome inherits this discipline.
**REF:** docs/UI-SPEC.md §6.2 (keyboard model), §11 #4 (acceptance); `src/app/KeyboardShortcuts.tsx:139`; `src/app/Layout.tsx:43–62` (Director chrome-hide); P6 W1 commit `aa89e35`; hetvabhasa H25 (the misframing this invariant prevented from worsening — without Esc, Director-mode dropdown unreachability would have surfaced as user-facing wedge, not just a test failure).
**Why it matters:** chrome that hides itself without a non-chrome exit is a one-way door. The user enters a mode and can't leave without F5 / closing the tab / clearing localStorage. Test #9's Canvas-mounts-once spec hit this in W1 — `selectOption('edit')` failed because the dropdown was display:none — and only because the test used the same affordance the user would. Without the test, the wedge would have shipped silent.

### V17: Mode is operational state; density is not a Basher concept

**Span:** `src/app/stores/modeStore.ts`, `src/app/stores/chromeStore.ts`, every component that reads `useModeStore`.
**Enforcement:** the `Mode` type is an operational state (`'edit' | 'run' | 'animate' | 'director'`). It must NEVER carry density / panel-visibility-preset values (`'simple' | 'studio' | 'pro'` or any successor framing). Per-panel collapse lives in the orthogonal `chromeStore` (`toolRailCollapsed`, `leftSidebarCollapsed`, `inspectorCollapsed`). Reviewer rejects any PR that conflates the two.
**Status:** ALIGNED (P6 W1, D-UX-5). The legacy density `Mode` (simple/director/pro) was repurposed to operational mode; legacy values coerce to `'edit'` on first read. `chromeStore` exists at `src/app/stores/chromeStore.ts` with three independent boolean flags.
**REF:** docs/UI-SPEC.md §3.3 (operational mode), §3.2 (per-panel collapse — D-UX-5 rationale); `src/app/stores/modeStore.ts:23` (Mode type), `src/app/stores/chromeStore.ts:18` (ChromeState); P6 W1 commit `a3a283e`; hetvabhasa H25 (related — naming similarity caused a sister misframing this invariant guards against repeating).
**Why it matters:** density and operational mode are different axes. Density = "which panels does the user want visible." Operational mode = "what state is the editor in" (am I editing? rendering? animating? presenting?). Conflating them creates a 3×4 = 12-cell matrix where most cells are nonsense (e.g. "simple-density × director-mode" — what does that mean?). The Spline pattern (D-UX-7) is one canonical layout + per-panel collapse + operational mode. Future "Wide/Compact" or "Tablet/Desktop" affordances must not collapse back into Mode.

### V18: Every persisted UI store guards localStorage with safeGet/safeSet wrappers

**Span:** every zustand store under `src/app/stores/` that reads or writes `localStorage` at module-load OR via store actions — currently `chromeStore`, `modeStore`. Future stores (`leftSidebarStore`, etc.) inherit.
**Enforcement:** each persisted store defines local `safeGetItem(key)` / `safeSetItem(key, val)` helpers that check for *callable* method bindings (`typeof localStorage?.getItem !== 'function'`) wrapped in try/catch. Direct `localStorage.getItem(...)` / `setItem(...)` calls in `src/app/stores/*.ts` are rejected at code review. The wrapper is intra-store (not extracted to a shared util) because each store's failure semantics are subtly different — corrupted JSON falls back to defaults, quota errors silently swallow on write, etc.
**Status:** ALIGNED (P6 W2 — both stores carry the wrappers). `chromeStore.ts:42–59` was authored with the wrappers; `modeStore.ts:25–43` was retrofitted in W2 commit `8b70ac8` after `ComfyStatusIndicator`'s test pulled modeStore in earlier than W1's tests had and tripped the H26 path.
**REF:** `src/app/stores/chromeStore.ts:42` (safeGetItem / safeSetItem); `src/app/stores/modeStore.ts:25` (W2 retrofit); hetvabhasa H26 (the trap this invariant prevents); krama K11 (persisted-store boot lifecycle — V18 is K11's invariant counterpart).
**Why it matters:** vitest's happy-dom exposes `localStorage` as a globalThis stub whose method bindings aren't attached at module-load. A store that calls `localStorage.getItem` directly bombs at import time, causing the test file's *suite collection* to fail before any test body runs — which looks identical to a test config bug rather than a happy-dom bug. The wrapper makes the failure mode uniform (silent fallback to defaults at boot, silent ignore on write) and means new persisted stores don't have to rediscover H26 by hitting it.

### V19: Keyboard and UI dispatches for the same conceptual action must go through a shared pure helper

**Status:** ALIGNED (P6 W6 — 2026-05-13)

**Span:** `src/app/KeyboardShortcuts.tsx` + any chrome surface that exposes a UI button (toolbar, menu, popover) for an action already bound to a keyboard shortcut. P6 W6 instantiation: K keyboard + Key toolbar button (insert keyframe); Delete keyboard override + Delete toolbar button (delete keyframe). P6 W7 instantiation: keyboard Q/W/E/R + R4 ToolRail click + R8 FloatingViewportToolbar click all converge on `editorStore.setActiveTool` — single dispatcher; translate/rotate/scale propagate to `gizmoStore.mode` automatically. The asymmetric direct writer at the old `TransformToolbar.ModeGroup` (wrote `gizmoStore.mode` without touching `editorStore.activeTool`) was eliminated in W7 C2. **V19 grep gate:** `grep -rnE 'useGizmoStore\([^)]*setMode\)|gizmoStore\.setMode' src/` should match only `editorStore.ts:56` (the propagation site) — runs on every future chrome PR per dharana B11 W7 re-validation triggers.

**Reason:** The same input intent ("insert a keyframe at the current frame on the active channel") must produce a bit-identical Op shape regardless of entry point. Divergence creates the worst kind of UX bug — "the button does *almost* the same thing as the shortcut, except…" — and the gap is often subtle (different default easing, different rounding, different time semantics). Catching it requires testing both routes, which means writing N×2 specs forever.

**Mechanism:** extract the Op-building logic to a pure named export in the keyboard handler (e.g., `buildKeyframeInsertOp`, `buildKeyframeDeleteOp` in P6 W6 commit `d31c1e1`). Both the keyboard branch and the toolbar button call the same helper; both go through `useDagStore.dispatchAtomic([op], 'user', label)` with the same label so undo entries are uniform.

**Test guard:** for every (keyboard, UI) pair on the same action, the e2e spec for the UI button must run the same observable as the keyboard spec (e.g., W6 #2 and W6 #3 are paired — K-press vs Key-click — both assert the same `keyframes.length === 4` outcome). If only one is tested, divergence creeps in undetected.

**Violation surface:** any UI handler that re-implements logic the keyboard handler already covers. Smell: a toolbar button's onClick lambda that contains its own filter+sort+dispatch instead of calling the keyboard helper. Smell: a keyboard branch that has special-cases the UI never gets.

**REF:** P6 W6 commit `d31c1e1` (pure helpers exported from KeyboardShortcuts.tsx); commit `6939a05` (toolbar buttons reuse the helpers); `tests/e2e/p6-w6-animate-ops.spec.ts` #2 (K keyboard) + #3 (Key button mirrors K). UI-SPEC.md §6.2 (keyboard model) + §5.9 (bottom toolbar).

**Sister case (P6 W7 — 2026-05-14):** gizmo tool dispatch. `src/app/stores/editorStore.ts:53-58` (`setActiveTool` is the single dispatcher; translate/rotate/scale propagate to gizmoStore.mode); `src/app/ToolRail.tsx:160` (R4 click → setActiveTool); `src/app/FloatingViewportToolbar.tsx` (R8 click → setActiveTool); `src/app/KeyboardShortcuts.tsx` Q/W/E/R branch (keyboard → setActiveTool). All three surfaces tested in `tests/e2e/p6-w7-floating-toolbar.spec.ts` #2/#3/#4 — V19 3-way sync. The W7 commit `959ae96` deleted `src/app/TransformToolbar.tsx` which carried the only direct `gizmoStore.setMode` writer outside the editorStore propagation — closing the asymmetry V19 was created to prevent.

### V20: A React-bypass mirror value must have exactly one writer, co-located with the source's single mutation chokepoint

**Status:** ALIGNED (P6 W9 — 2026-05-15)

**Span:** any value duplicated outside the React subscription path so a hot loop (rAF / animation / WebGL frame) can read it without forcing re-renders — an "escape hatch". P6 W9 instantiation: `viewportStore.currentFrameRef` ({ current: number }), read by the imperative `TimelineCanvas` rAF playhead loop, written by `timeStore`'s frame chokepoint. Predicted next span: any P7 imperative-canvas overlay (splats) that needs a React-bypass per-frame value.

**Reason:** A mirror copy diverges from its source the instant any mutation path to the source skips the mirror write. The only structure under which divergence is impossible-by-construction (not impossible-if-you-remember) is: one writer, placed at the single point through which every mutation of the source already flows. Place the write at a *consumer* (the rAF owner, an effect, a handler) and it covers only the mutation paths that flow through that consumer — every other path is a silent divergence site with no error (see [[H33]] for the trap, the negative of this rule).

**Mechanism:** identify the source value's chokepoint — the one place where it is actually computed/assigned. For `timeStore.frame` that is `deriveFrame()` → `set({...frame...})`, invoked from exactly three setters (`setTime`, `setDuration`, `tick`). Add one private `mirrorFrame(frame)` helper called immediately after each `set`. The rAF owner (Clock.tsx) is a consumer and gets zero writes. Consumers only ever *read* the mirror via `getState().<ref>.current`.

**Invariant to assert:** `mirror.current === source` after every state transition that can change the source. W9 evidence: `src/app/stores/viewportStore.test.ts` (15/15) asserts equality after `setTime`, `tick` (while playing), and `setDuration`, plus a negative case (a non-frame mutation leaves the mirror unchanged) and ref-object-identity stability (the `{current}` object is never reassigned — consumers hold the reference).

**Violation surface:** a `useRef`/`{current}` mirror written inside a component effect or an animation loop body; a denormalised store field written at each call site that produces it instead of at the one place it's derived; any "I'll also set X here" scattered across handlers. Smell: the same mirror assignment appears in 2+ files, or appears in a loop/effect while the source has setters elsewhere.

**REF:** P6 W9 C1 commit `a01ce47`; `src/app/stores/viewportStore.ts` (`currentFrameRef` field, init-once, never reassigned); `src/app/stores/timeStore.ts:87-150` (`mirrorFrame` + the 3-setter chokepoint); `src/app/Clock.tsx:29` (the consumer that does NOT write — the grounding correction); `tests/e2e/p6-w9-timeline-canvas.spec.ts` #3 (frame == readout cross-check). Negative pattern: [[H33]]. Sister: V19 (one *dispatcher* for an action across input surfaces — V20 is the read-side analogue: one *writer* for a mirror across mutation paths). Provenance: ORIGIN = W9 plan grounding correction (context memo D-W9-9 named Clock as the dual-writer; source showed Clock calls `tick()` not `setTime()` and scrub/setDuration bypass Clock). WHY without it: escape-hatch playhead silently freezes on the non-playback paths the rAF owner never sees. HOW: chokepoint-single-writer makes the sync invariant hold by construction, testable in isolation.
