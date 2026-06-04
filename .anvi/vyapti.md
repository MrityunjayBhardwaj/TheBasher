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

### V3: Time enters as a typed `Time` socket OR a typed function parameter — never as a closure or global

**Span:** All animation and render node evaluators in `src/nodes/**`. The `TimeSource` node (`src/nodes/TimeSource.ts`) is one legal time producer (socket form); value-shape time methods like `TransformClipValue.sample(seconds)` are the other (function-parameter form, P7.10 #114). In both forms time is STRUCTURED and TYPED at the boundary; closure-over-global remains forbidden.

**P7.10 amend (#114):** Pre-P7.10 V3 required socket-only. Reading the actual codebase: every legitimate impure use threaded ctx.time through a typed Time socket from TimeSource. The synthesis P7.10 adds — `(seconds: number) => TRS-map` — is ITSELF a typed structured boundary (the function signature IS the contract), with the additional property that the consumer (not the evaluator) picks the cadence. Both forms satisfy V3's spirit (Time is explicit, typed, no globals). The amendment widens the LETTER to accept either; closure-form is opt-in and currently used only by `TransformClipValue.sample`.

**Enforcement:**

- ESLint `no-restricted-syntax` on `src/nodes/**` bans `Math.random` / `Date.now` / `performance.now` / `crypto.randomUUID` / `useFrame` / `useThree` (`eslint.config.js:6-32`).
- Vitest twice-eval at multiple t values for every Time-aware pure node — PosedSkeleton, AnimationClip, LocomotionState, Character (`src/nodes/nodes.test.ts` Wave A block).
- The evaluator's cache key includes time only for `pure: false` nodes (`src/core/dag/evaluator.ts:119`); pure consumers re-evaluate via the upstream TimeSource hash flip propagated through `inputHashes`.
- For function-parameter form (P7.10): the closure-bearing value's TYPE encodes the contract (`sample: (seconds: number) => Record<...>`). TS catches any consumer that reads `.tracks` (the pre-P7.10 shape) instead of invoking `.sample(t)`. `src/nodes/TransformClip.test.ts` asserts `inputs === {}` as a regression guard against a future revert re-adding the Time input socket (which would re-introduce the B13 per-frame cache-miss).

**Status:** ALIGNED (P2 + P7.10 amend). The socket form ships in `AnimationClip` / `PosedSkeleton` / `LocomotionState` / `Character` (unchanged). The function-parameter form ships in `TransformClipValue.sample` (P7.10). Both forms can coexist in the same DAG without conflict.

**REF:** THESIS.md §49; `src/nodes/TimeSource.ts:1`; `src/nodes/AnimationClip.ts:1`; `src/nodes/PosedSkeleton.ts:1`; `src/nodes/LocomotionState.ts:1`; `src/nodes/TransformClip.ts:1` (P7.10 function-parameter form); `src/nodes/types.ts` `TransformClipValue` (the type-level contract); `src/nodes/TransformClip.test.ts` "declares no inputs — time enters via .sample(seconds) (V3 amend)" (regression guard).
**Why it matters:** scrubbing, frame-stepping, agent's "what does scene look like at t=2.5?" all depend on this. The P7.10 amend additionally unlocks the consumer-cadence pattern: a renderer can sample at R3F's frameloop rate while the DAG re-evaluates only on dispatch — closing B13 (the SceneFromDAG re-walks-per-frame bottleneck).

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

- maxDepth tested in `src/agent/closure/expand.test.ts`. Integration
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

**Deeper guard — Op-shape probe (issue #22, 2026-05-18):** a second
mechanical test builds a probe scene per Mutator, runs `validatePlan`,
reduces `plan.ops` to a structural Op-shape signature, and asserts no
two collide. It caught `keyframe` vs `simplifyChannel` both emitting
`[{setParam, paramPath:'keyframes'}]`. **Key learning encoded:
Op-shape equivalence is NECESSARY but NOT SUFFICIENT for redundancy
when the Op vocabulary is coarser than the semantic distinction.** A
channel's entire `keyframes` array is one value-typed param, so every
channel edit is mechanically one `setParam('keyframes',…)` — the Op
stream physically cannot carry the append-vs-refit distinction; the
honest discriminator lives only in the contract (`keyframe` has no
`lossy`; `simplifyChannel` declares `lossy:['keyframe-density']`).
Resolution: the probe signature is `op-shape + contract discriminator`
(append the honest `preserves`/`lossy` already used by the signature
guard) so it fires ONLY on a genuine #60-class case (op-shape AND
contract both identical). This is the **inverse of the H36 trap**:
H36 = removing a real discriminator to go green; this = adding the
already-established honest one so the deeper probe stops
false-positiving. Test-only (a probe table reusing existing scene
builders + a completeness guard: every registered Mutator must have a
probe entry or CI fails — the H36 non-blindness lesson applied).

**REF:** P2.5.2 PLAN §2 P-4; `src/agent/mutators/index.ts:1` (the
single visible catalog); `src/agent/mutators/mutators.test.ts` (the
mechanical signature guard + the #22 Op-shape probe); issue #22 / #60;
[[H36]] (the sister trap — gate input set too narrow vs probe too
sensitive).

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
**Enforcement:** each persisted store defines local `safeGetItem(key)` / `safeSetItem(key, val)` helpers that check for _callable_ method bindings (`typeof localStorage?.getItem !== 'function'`) wrapped in try/catch. Direct `localStorage.getItem(...)` / `setItem(...)` calls in `src/app/stores/*.ts` are rejected at code review. The wrapper is intra-store (not extracted to a shared util) because each store's failure semantics are subtly different — corrupted JSON falls back to defaults, quota errors silently swallow on write, etc.
**Status:** ALIGNED (P6 W2 — both stores carry the wrappers). `chromeStore.ts:42–59` was authored with the wrappers; `modeStore.ts:25–43` was retrofitted in W2 commit `8b70ac8` after `ComfyStatusIndicator`'s test pulled modeStore in earlier than W1's tests had and tripped the H26 path.
**REF:** `src/app/stores/chromeStore.ts:42` (safeGetItem / safeSetItem); `src/app/stores/modeStore.ts:25` (W2 retrofit); hetvabhasa H26 (the trap this invariant prevents); krama K11 (persisted-store boot lifecycle — V18 is K11's invariant counterpart).
**Why it matters:** vitest's happy-dom exposes `localStorage` as a globalThis stub whose method bindings aren't attached at module-load. A store that calls `localStorage.getItem` directly bombs at import time, causing the test file's _suite collection_ to fail before any test body runs — which looks identical to a test config bug rather than a happy-dom bug. The wrapper makes the failure mode uniform (silent fallback to defaults at boot, silent ignore on write) and means new persisted stores don't have to rediscover H26 by hitting it.

### V19: Keyboard and UI dispatches for the same conceptual action must go through a shared pure helper

**Status:** ALIGNED (P6 W6 — 2026-05-13)

**Span:** `src/app/KeyboardShortcuts.tsx` + any chrome surface that exposes a UI button (toolbar, menu, popover) for an action already bound to a keyboard shortcut. P6 W6 instantiation: K keyboard + Key toolbar button (insert keyframe); Delete keyboard override + Delete toolbar button (delete keyframe). P6 W7 instantiation: keyboard Q/W/E/R + R4 ToolRail click + R8 FloatingViewportToolbar click all converge on `editorStore.setActiveTool` — single dispatcher; translate/rotate/scale propagate to `gizmoStore.mode` automatically. The asymmetric direct writer at the old `TransformToolbar.ModeGroup` (wrote `gizmoStore.mode` without touching `editorStore.activeTool`) was eliminated in W7 C2. **V19 grep gate:** `grep -rnE 'useGizmoStore\([^)]*setMode\)|gizmoStore\.setMode' src/` should match only `editorStore.ts:56` (the propagation site) — runs on every future chrome PR per dharana B11 W7 re-validation triggers.

**Reason:** The same input intent ("insert a keyframe at the current frame on the active channel") must produce a bit-identical Op shape regardless of entry point. Divergence creates the worst kind of UX bug — "the button does _almost_ the same thing as the shortcut, except…" — and the gap is often subtle (different default easing, different rounding, different time semantics). Catching it requires testing both routes, which means writing N×2 specs forever.

**Mechanism:** extract the Op-building logic to a pure named export in the keyboard handler (e.g., `buildKeyframeInsertOp`, `buildKeyframeDeleteOp` in P6 W6 commit `d31c1e1`). Both the keyboard branch and the toolbar button call the same helper; both go through `useDagStore.dispatchAtomic([op], 'user', label)` with the same label so undo entries are uniform.

**Test guard:** for every (keyboard, UI) pair on the same action, the e2e spec for the UI button must run the same observable as the keyboard spec (e.g., W6 #2 and W6 #3 are paired — K-press vs Key-click — both assert the same `keyframes.length === 4` outcome). If only one is tested, divergence creeps in undetected.

**Violation surface:** any UI handler that re-implements logic the keyboard handler already covers. Smell: a toolbar button's onClick lambda that contains its own filter+sort+dispatch instead of calling the keyboard helper. Smell: a keyboard branch that has special-cases the UI never gets.

**REF:** P6 W6 commit `d31c1e1` (pure helpers exported from KeyboardShortcuts.tsx); commit `6939a05` (toolbar buttons reuse the helpers); `tests/e2e/p6-w6-animate-ops.spec.ts` #2 (K keyboard) + #3 (Key button mirrors K). UI-SPEC.md §6.2 (keyboard model) + §5.9 (bottom toolbar).

**Sister case (P6 W7 — 2026-05-14):** gizmo tool dispatch. `src/app/stores/editorStore.ts:53-58` (`setActiveTool` is the single dispatcher; translate/rotate/scale propagate to gizmoStore.mode); `src/app/ToolRail.tsx:160` (R4 click → setActiveTool); `src/app/FloatingViewportToolbar.tsx` (R8 click → setActiveTool); `src/app/KeyboardShortcuts.tsx` Q/W/E/R branch (keyboard → setActiveTool). All three surfaces tested in `tests/e2e/p6-w7-floating-toolbar.spec.ts` #2/#3/#4 — V19 3-way sync. The W7 commit `959ae96` deleted `src/app/TransformToolbar.tsx` which carried the only direct `gizmoStore.setMode` writer outside the editorStore propagation — closing the asymmetry V19 was created to prevent.

### V20: A React-bypass mirror value must have exactly one writer, co-located with the source's single mutation chokepoint

**Status:** ALIGNED (P6 W9 — 2026-05-15)

**Span:** any value duplicated outside the React subscription path so a hot loop (rAF / animation / WebGL frame) can read it without forcing re-renders — an "escape hatch". P6 W9 instantiation: `viewportStore.currentFrameRef` ({ current: number }), read by the imperative `TimelineCanvas` rAF playhead loop, written by `timeStore`'s frame chokepoint. Predicted next span: any P7 imperative-canvas overlay (splats) that needs a React-bypass per-frame value.

**Reason:** A mirror copy diverges from its source the instant any mutation path to the source skips the mirror write. The only structure under which divergence is impossible-by-construction (not impossible-if-you-remember) is: one writer, placed at the single point through which every mutation of the source already flows. Place the write at a _consumer_ (the rAF owner, an effect, a handler) and it covers only the mutation paths that flow through that consumer — every other path is a silent divergence site with no error (see [[H33]] for the trap, the negative of this rule).

**Mechanism:** identify the source value's chokepoint — the one place where it is actually computed/assigned. For `timeStore.frame` that is `deriveFrame()` → `set({...frame...})`, invoked from exactly three setters (`setTime`, `setDuration`, `tick`). Add one private `mirrorFrame(frame)` helper called immediately after each `set`. The rAF owner (Clock.tsx) is a consumer and gets zero writes. Consumers only ever _read_ the mirror via `getState().<ref>.current`.

**Invariant to assert:** `mirror.current === source` after every state transition that can change the source. W9 evidence: `src/app/stores/viewportStore.test.ts` (15/15) asserts equality after `setTime`, `tick` (while playing), and `setDuration`, plus a negative case (a non-frame mutation leaves the mirror unchanged) and ref-object-identity stability (the `{current}` object is never reassigned — consumers hold the reference).

**Violation surface:** a `useRef`/`{current}` mirror written inside a component effect or an animation loop body; a denormalised store field written at each call site that produces it instead of at the one place it's derived; any "I'll also set X here" scattered across handlers. Smell: the same mirror assignment appears in 2+ files, or appears in a loop/effect while the source has setters elsewhere.

**REF:** P6 W9 C1 commit `a01ce47`; `src/app/stores/viewportStore.ts` (`currentFrameRef` field, init-once, never reassigned); `src/app/stores/timeStore.ts:87-150` (`mirrorFrame` + the 3-setter chokepoint); `src/app/Clock.tsx:29` (the consumer that does NOT write — the grounding correction); `tests/e2e/p6-w9-timeline-canvas.spec.ts` #3 (frame == readout cross-check). Negative pattern: [[H33]]. Sister: V19 (one _dispatcher_ for an action across input surfaces — V20 is the read-side analogue: one _writer_ for a mirror across mutation paths). Provenance: ORIGIN = W9 plan grounding correction (context memo D-W9-9 named Clock as the dual-writer; source showed Clock calls `tick()` not `setTime()` and scrub/setDuration bypass Clock). WHY without it: escape-hatch playhead silently freezes on the non-playback paths the rAF owner never sees. HOW: chokepoint-single-writer makes the sync invariant hold by construction, testable in isolation.

### V21: A "should-be-ignored" file class needs entries in EVERY ignore-file the repo uses (.gitignore + .prettierignore + ...) — single-file patching is incomplete coverage

**Status:** ALIGNED (P7.4 ext + #80 — 2026-05-20)

**Span:** any file class the repo treats as "not for processing" — working-state planning docs (`.planning/`), vendored third-party assets (`public/draco/`, `public/basis/`), generated artifacts, secrets, build output. Multiple tools scan the workspace with INDEPENDENT ignore policies: `git add -A` reads `.gitignore`; `prettier --check .` reads `.prettierignore`; eslint reads `.eslintignore`; docker reads `.dockerignore`. Each tool's scan is its own surface; the ignore-files do NOT share entries by default. Partial-coverage (one ignore-file entry but not the others) leaves a second sweep surface that WILL eventually catch the class — at a different gate, in a different PR, looking like a fresh problem.

**Reason:** The ignore-files are independent inputs to independent scans. Patching only one for a "should be ignored" class fixes ONE symptom (the tool whose ignore-file you updated) and leaves every OTHER tool free to sweep the class. The failure surfaces wherever the un-patched tool runs — the CI lint job for prettier, an accidental `git add -A` for git, a docker build for docker — and looks like a fresh problem because the tool was previously silent. The single-ignore-file patch is the textbook symptom-patch: it suppresses ONE observation of a structural fact ("this class is not for processing") without making the fact structurally true.

**Mechanism:** when adding a "should be ignored" file class C, audit every ignore-file the repo has — `ls -A .{git,prettier,eslint,docker,npm}ignore 2>/dev/null` — and add C to every one that's missing it. Verify with each tool: `git check-ignore <file>` and `prettier --check <file>` both report ignored. Do this in ONE commit per class addition, not as a follow-up "I forgot the other ignore-file" PR. If the project gains a new ignore-file consumer later (a new tool, a CI gate), re-audit existing classes for coverage in that new file.

**Instantiations (the 2-day recurrence that promoted this entry):**

1. **2026-05-19 P7.4 W7 (`8c7dc35`)**: a tracked `.planning/SECTION-INVENTORY.md` (committed accidentally in W4 `6ef2efa`) blocked CI lint via `prettier --check .` (W4 had committed a planning-docs file under the implicit "`.planning/` is untracked working state" convention, but the convention was never encoded). Fix: added `.planning/` to `.prettierignore`. PARTIAL — covered the prettier surface only.

2. **2026-05-20 #80 fix (`31ed8c2`)**: `git add -A` (intended for the gltf-fix files) swept 18 still-untracked `.planning/` docs into the commit, because `.planning/` was never in `.gitignore`. The W7 `.prettierignore`-only patch had been incomplete coverage of the SAME class. Fix: added `.planning/` to `.gitignore` in the SAME COMMIT as the gltf fix (root-cause hardening bundled with the symptom resolution it served).

**Invariant to assert:** for every file class C the repo treats as "should be ignored", every ignore-file in the repo contains an entry that matches C. A simple verification: `for C in <classes>; do git check-ignore "$C/probe" 2>/dev/null && echo "git-ignored: $C" || echo "GAP git: $C"; npx prettier --check "$C/probe" 2>&1 | grep -q "Code style" && echo "GAP prettier: $C" || echo "prettier-ignored: $C"; done`. Two-line shell, catches partial coverage in one pass.

**Violation surface:** a "should be ignored" class added to one ignore-file but not the others; relying on a "we just don't track that" convention without enforcement; symptom-patching one tool's output without auditing the others' coverage. Smell: a recurrence where the SAME class causes a second failure in a DIFFERENT tool weeks/PRs later.

**REF:** `.gitignore` (the `.planning/` entry added in commit `31ed8c2`), `.prettierignore` (the `.planning/` entry added in `8c7dc35` + the vendored-decoder block added in `31ed8c2` covering `public/draco/`, `public/basis/`), memory file `feedback_verify_own_framing.md` (the orchestrator-framing reflex that propagates "this is just untracked" without verifying its enforcement). Negative pattern at the meta level: [[H25]] (initial-authoring trap — single-tool ignore-file patching IS the initial-authoring assumption that the next tool's scan will violate). Provenance: ORIGIN = the same `.planning/` class causing failure first at the prettier surface (W7, 2026-05-19) then at the git surface (#80 PR, 2026-05-20) — two ignore-file gates, one class. WHY without it: every "should be ignored" class gets a second discovery cycle when the next tool's scan finds it, costing PR rework + force-pushes + the architectural confusion of "I thought we ignored that." HOW: the audit-every-ignore-file mechanism above, enforced as a one-shot per class addition.

### V22: Generated DAG node ids must be deterministic over `(args, state)` — never wall-clock, never RNG

**Status:** ALIGNED (2026-05-21, post PR #87/#92/#93).

**Span:** every site outside `src/nodes/**` that emits an `addNode` Op
with a freshly-generated `nodeId`. Includes agent tool handlers
(`src/agent/tools/**`), import chains
(`src/core/import/{bvh,fbx,gltf}ImportChain.ts`), drop chains
(`src/app/asset/dropChain.ts`), and any future Op-emitter that creates
DAG-resident state. Excludes UI-only stores and per-render ephemera
(those don't cross the V2 / THESIS §48 boundary).

**Invariant:** for a given `(args, relevant-state)` tuple, two adjacent
calls to the emitter produce **byte-identical Op[]**. This is the
"twice-call" determinism contract every tool's vitest spec already
asserts; V22 is the codification of WHY that contract must hold.

**Mechanism:** content-addressed ids via a deterministic hash over the
args tuple. Two acceptable shapes in the codebase today:

- **fnv1a-32** (dependency-free, 13-line helper): used by
  `gltfImportChain.ts:57-68` and `cameraSnapshot.ts` (`4c82536`).
  Output: `n_<prefix>_<8-hex>`. Fast; deterministic; non-cryptographic
  but determinism is the only property the seam needs.
- **`crypto.randomUUID()`** (browser + Node ≥ 14.17): used by
  `recorder.ts` (`b42fea7`) for telemetry `sessionId`. Acceptable when
  the field is **inherently non-deterministic by design** (a session
  id identifies one runtime; it is NOT the same shape as a DAG node
  id derived from args).

**Forbidden:** `Date.now()`, `performance.now()`, `Math.random()`,
any global counter that doesn't reset per-call, or any closure
that captures wall-clock state.

**Detection gate (grep — runs as part of any /anvi:quick / wave-close
gate touching emitter surfaces):**

```
grep -nE 'Date\.now\(\)|Math\.random\(\)|performance\.now\(\)' \
  src/agent src/app src/core src/viewport \
  | grep -v test \
  | grep -E "n_[a-zA-Z]+_\$\{"
```

Any hit on a node-id template literal is a V22 violation.

**Why not just trust V2:** V2 is scoped to `src/nodes/**` evaluators
(pure-lint enforced via eslint `no-restricted-syntax`). V22 covers
the adjacent surface — Op-emitters one layer up — where the same
determinism property must hold but no lint rule fires today. Promote
the eslint rule to V22's span if a fourth site recurs.

**Application across the 2026-05-19→21 arc:**

| Site                         | Original shape                                            | Fix                                                                                         |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `recorder.ts:96` (#17)       | `Math.random().toString(36) + Math.random().toString(36)` | `crypto.randomUUID()` (PR #87)                                                              |
| `cameraSnapshot.ts:52` (#93) | `cam_agent_${Date.now().toString(36)}`                    | `cam_agent_${fnv1a32(JSON.stringify([sceneNodeId, fov, position, lookAt]))}` (PR `4c82536`) |
| `gltfImportChain.ts` (P7.5)  | designed-in                                               | fnv1a-32 over `(assetRef, key)` from day one (no fix needed)                                |

Cross-ref [[H42]] (the recurring error pattern V22 codifies as
invariant), V2 (the pure-evaluator sibling — same principle, different
surface), THESIS §48, [[V13]] (closure preservation — the consumer
of V22's stability promise: Op-emitter ids must hash-stable so closure
diffs are deterministic). Provenance: 2026-05-21 — three independent
fixes converged on the same pattern within 2 days, lifting it from
"one-off oversights" to a named invariant.

### V24: Time-dependency lives at the value-shape, NOT at the React-prop chain

**Span:** All time-driven values flowing through the renderer chain — `TransformClipValue` (P7.10) and the `KeyframeChannel{Number,Vec3,Quat,Color}` family + `AnimationLayer` (P7.12 D-04). Any future impure or impure-rooted value that the React tree consumes during playback.

**Statement:** If a value's content depends on time, its TYPE MUST expose time as a typed function parameter on the value itself (e.g., `sample: (seconds: number) => T`). Consumers read live time imperatively at their own cadence (R3F's `useFrame`, or a local time subscription). The React tree itself MUST NEVER subscribe to `useTimeStore.seconds/frame/normalized` at a level where downstream value props would change per frame — most concretely, `SceneFromDAG.tsx` MUST NOT subscribe to time.

**Why it matters:** Per-frame React re-renders during animation playback are the B13 / H48 / H49 bottleneck. The mechanism: if any value-prop ref in the React tree changes per frame (because an impure node up-chain re-evaluates per frame), every React.memo down-chain misses, and the whole tree walks. Lifting time INTO the value-shape (`sample(t)` method) and removing time subscriptions at the React tree's root makes the value-prop ref stable across renders; React only re-renders on DAG state changes; the per-frame work moves to `useFrame` where the time-sample cadence belongs.

**Enforcement:**

- Type system: `TransformClipValue.sample(seconds: number)` is the typed contract; any consumer that reads `.tracks` (the pre-P7.10 shape) fails to typecheck. `src/nodes/types.ts:321` documents the contract; `src/nodes/TransformClip.test.ts` "declares no inputs" is the regression guard against re-adding the Time input socket (which would re-enable per-frame cache-miss propagation).
- The B13 perf benchmark `tests/e2e/perf-fox-benchmark.spec.ts` asserts `commits = 0` during 5s of playback at every Fox-count level (skinned + animated). A future regression that re-introduces a SceneFromDAG time subscription would fail this assertion immediately.

**Status:** ALIGNED (P7.10, extended P7.12). Time-driven value-shapes now in the codebase: `TransformClipValue` (P7.10) and the `KeyframeChannel{Number,Vec3,Quat,Color}` family + `AnimationLayer` (P7.12 D-04). Future impure additions (audio sync, physics, procedural animation) opt into the same pattern by design — no per-node-type wiring needed.

**Amendment (P7.12 D-04):** The `KeyframeChannel{Number,Vec3,Quat,Color}` family migrated to the same function-of-time value shape, joining `TransformClip`. Each channel value carries `sample(seconds)` and drops its Time input socket — consumers sample at their own cadence. `AnimationLayer` carries `sampleTarget(seconds)` (shape B-lite): the value's `.target` is the UN-PATCHED base, and the channel-patched target is produced by `sampleTarget(seconds)`. Any consumer reading `.target` for the animated value reads the base (0/static) — see [[H52]] (the value-shape migration missing test-inlined consumer copies). Back-compat: pre-D-04 `Time → channel` wires hydrate as harmless ghost bindings.

**REF:** `src/nodes/types.ts:321` (`TransformClipValue.sample`), `src/nodes/TransformClip.ts` (the closure builder), `src/nodes/AnimationLayer.ts:99` (`sampleTarget` closure, P7.12 D-04), `src/app/resolveEvaluatedTransform.ts` (read-side `sampleTarget(ctx.time.seconds)`), `src/viewport/SceneFromDAG.tsx:73` (the no-time-subscription site), `src/viewport/SceneFromDAG.tsx` `GltfAssetR` `useFrame` (the consumer-local cadence), `tests/e2e/perf-fox-benchmark.spec.ts` (the goal-backward gate), [[H48]], [[H49]], [[H52]], [[B13]]. Issues #114, #108.

### V23: Multi-file glTF sibling-path resolution MUST normalize `..`/`.` segments symmetrically on BOTH halves of the importer/renderer boundary, and MUST reject root-escape

**Status:** ALIGNED (2026-05-28, post P7.9 Wave F Task 12 / `26e6f1a`).

**Span:** `src/app/asset/opfsGltfResolver.ts` — the single shared
multi-file-glTF resolver consumed by BOTH halves of the [[B12]]
chokepoint:

- **Importer half:** `opfsSiblingPath` / `loadMultiFileGltf`'s
  parse-time `resolveBuffer` callback (reads sibling buffer bytes
  from OPFS when the parser hits a `buffers[*].uri`).
- **Renderer half:** `resolveBasherOpfsUrl` URL modifier + cache
  lookup (resolves textures and re-resolves buffers at render time,
  fed by the URL three.js composes via `LoaderUtils.resolveURL`).

A single shared helper (`normalizeOpfsPath`) is the only correct
implementation; both halves must call it. No parallel
normalization, no inline path-joining that skips the helper.

**Invariant:** for any multi-file glTF whose entry lives in a
subdirectory and references siblings via `../`-relative URIs
(e.g. `nested/gltf/scene.gltf` → `../buffers/foo.bin` →
`nested/buffers/foo.bin`), the resolver collapses `..` and `.`
segments BEFORE handing the path to the OPFS API. Both halves of
the boundary produce the SAME collapsed key for the SAME input
URI. Any path that resolves above the picked folder root is
REJECTED (root-escape attempt → error, not silent read of an
unrelated OPFS region).

**Mechanism:** `normalizeOpfsPath(baseDir, uri)`:

1. Strip the entry's own directory prefix from `baseDir`.
2. Join `baseDir` and `uri`.
3. Walk segments left-to-right; `..` pops the previous segment,
   `.` is skipped.
4. If the pop count exceeds the segment count (root-escape),
   throw.
5. Re-join the surviving segments — that is the OPFS key for both
   halves.

**Forbidden:**

- Hand-rolled `String.replace('/../', '/')` shortcuts (don't
  handle the leading-segment case).
- Asymmetric normalization (importer normalizes, renderer doesn't —
  or vice versa) — see [[H47]] for the silent-failure pattern.
- Passing literal `..` segments to `navigator.storage.getDirectory()`
  child handles — OPFS rejects with "Name is not allowed."
- Allowing root-escape to silently read an unrelated OPFS region.

**Detection gate (unit + e2e):**

- Unit (`src/app/asset/opfsGltfResolver.test.ts`) — path-
  normalization assertions: nested-entry `../sibling` collapses to
  the parent folder's sibling key; `..`-overflow throws; both
  halves' normalization output match byte-identical for the same
  input.
- E2E (`tests/e2e/p7.9-gltf-file-import.spec.ts` sub-case a2) —
  rendered-surface gate on the `public/fixtures/multifile/nested/`
  fixture: the asset must visibly render after ingest (proves the
  importer found the buffer AND the renderer found the texture
  through `../`).

**Why not just trust the importer's normalization:** the importer
and renderer use INDEPENDENT lookup paths (parser callback vs.
LoadingManager URL modifier). The importer normalizing is necessary
but not sufficient — the renderer's cache key derives from
three.js's `LoaderUtils.resolveURL`, which preserves traversal
segments unless the consumer explicitly normalizes. Both halves
must normalize. [[H47]] is the silent-failure pattern this
invariant blocks.

**Application across the P7.9 arc:**

| Wave                       | State before                                                                | Fix                                                                                |
| -------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A–E (`2977240`..`7785faf`) | unit tests used flat fixtures only; nested fixture not asserted             | shipped; gap latent                                                                |
| F Task 12 (`26e6f1a`)      | nested e2e on `multifile/nested/` failed with "Name is not allowed" on `..` | added shared `normalizeOpfsPath`, called from BOTH halves; unit asserts both sides |
| F Task 13 (`11b208c`)      | full regression gate — 17/17 e2e + 1072 vitest green on nested + spaced     | invariant validated end-to-end                                                     |

Cross-ref [[H47]] (the encode/decode sibling pattern V23 sits next
to — same boundary, different transform, same "asymmetric ⇒ silent
fail" structure), [[B12]] (the glTF chokepoint this invariant
lives in), [[V20]] (single-writer mirror principle — V23 is the
single-normalizer instantiation: one helper, both halves call it),
[[H40]] (which side of the boundary did I observe — V23's
detection gate observes BOTH sides). Provenance: 2026-05-28 — P7.9
Wave F Task 12 (`26e6f1a`); the gap surfaced when the headline e2e
exercised a real nested fixture for the first time (unit tests had
used flat fixtures only). Issue #110.

### V25: A `GltfSkeleton` is a PURE read-only projection of GltfAsset-captured bind data; pose ownership stays with GltfChild (no write-back), and every per-joint datum shares ONE `skin.joints[]` ordering

**Status:** ALIGNED (P7.11, #100).

**Span:** `src/nodes/GltfSkeleton.ts` (the node) + `src/core/import/projectGltfSkeleton.ts` (the pure join) + `src/core/import/gltfImportChain.ts` `buildSkinMetadata` (the capture) + `GltfAsset.skins` param (the captured datum). The invariant reaches the render boundary at `src/viewport/SceneFromDAG.tsx` GltfAssetR (the [[H40]] consumer side).

**Statement (two coupled clauses):**

1. **Read-only projection (extends [[V20]]/[[H36]] single-writer to a new boundary).** `GltfSkeleton.evaluate` is a PURE function of its `asset` input (a `GltfAssetValue` whose `skins` were captured at import) — `(params, inputs) → SkeletonValue`, no store handle, no `setParam`, no `dispatch`, no `GltfChild` reference. A `Skeleton` is a BIND-pose definition and the bind pose is import-time STATIC, so there is NO edge from (and NO read of) GltfChild's live pose. GltfChild remains the SOLE pose owner; the projection NEVER writes back. This is the architectural guarantee D-02 was chosen for — and it is ENFORCED, not merely claimed (see below).
2. **One joints-order spine (the index discipline).** Every per-joint array — `jointKeys`, `bindTRS`, `parentJointIndex`, `inverseBindMatrices` — is captured and projected in `skin.joints[]` order. Therefore BoneSpec index i == `skin.joints[]` position i == IBM index i == `parentJointIndex` space i == rendered `SkinnedMesh.skeleton.bones` index i. Rotation crosses a units boundary: captured `bindTRS.rotation` is DEGREES (DAG-storage convention), `BoneSpec.rotation` is RADIANS (the BVH/FBX adapter contract) — the projector converts, so a glTF-projected rig and a BVH/FBX rig are consumed identically by `specToThreeSkeleton`.

**Why it matters:** Clause 1 prevents a second persisted copy of pose and the dual-write trap [[H36]] reappears at every new surface that touches a glTF rig (the prior P7 surfaces — gizmo, NPanel — each re-litigated it). Clause 2 is the precondition that makes the [[H40]] render boundary-pair a trivial index-by-index name check instead of a fuzzy name-matching reconciliation; violating it scrambles the rig silently on permuted-joint rigs ([[H50]]).

**Enforcement (build gates, not prose):**

- **Read-only:** `src/nodes/GltfSkeleton.test.ts` greps `GltfSkeleton.ts` + `projectGltfSkeleton.ts` source (comments stripped) for write/store tokens (`setParam`/`dispatch`/`setState`/`getState`/`useStore`/`useDagStore`/`useViewportStore`/`GltfChild`) and asserts ABSENCE — a future "convenience" write-back fails the build. Mirrors the `gltfLoaderConfig.test.ts` regression-guard precedent.
- **Index spine:** `gltfSkinCapture.test.ts` + `projectGltfSkeleton.test.ts` assert ordering + parent on BOTH `skinned-bar` (`[1,0]`) and `many-bone-rig` (`[63..0]`); the reversed-order fixture fails loudly if a node-index slip creeps in ([[H50]]).
- **Boundary-pair:** `tests/e2e/p7.11-gltf-rig-nodes.spec.ts` F6a-2 observes BOTH sides — projected `bones[i].name` == rendered `skeleton.bones[i].name` (sanitized), index-by-index.
- **Determinism (extends [[V2]]):** `GltfSkeleton.test.ts` twice-eval deep-equal; `gltfSkinCapture.test.ts` re-import byte-identical ([[V22]]).
- **Separability (retarget needs no IBM):** retarget consumes only name+parent+position+rotation(+scale); IBM ([[V9]]: `number[16]`, never a `Matrix4`) rides for deform-fidelity + future DAG-side skinning. `retarget.test.ts` (F6b) proves the cross-vocabulary bridge with a NON-IDENTITY nameMap + falsification.

**Cross-ref:** [[V20]] (single-writer principle this extends to the projection boundary), [[H36]] (the dual-write trap clause 1 blocks), [[H50]] (joint-index-vs-node-index — the trap clause 2 blocks), [[H51]] (matrix-form bind capture), [[H40]] (the boundary-pair the index spine makes trivial), [[H45]]/[[H46]] (the render-side skin family), [[V2]]/[[V9]]/[[V22]].

**Provenance:** ORIGIN = P7.11 (#100), 2026-05-29 — Wave F closes #100's rig-projection + retarget half. WHY = without this invariant, the next rig consumer (DAG-side skinning, viewport bone-pick #100/D-06, FBX node-indexed clips) re-derives BOTH the no-write-back discipline AND the joints-order spine from scratch; the read-only clause in particular guards against a "just write the pose back here" shortcut reopening [[H36]] on a fourth glTF surface. HOW = a new rig-reading surface checks: does it read captured bind data only (no GltfChild edge, no store write)? does it preserve the `skin.joints[]` spine? — both are grep-/test-enforced here. REF: GROUND_TRUTH_GLTF.md DEFERRED (Wave E2) → interim grounding RESEARCH.md §B1 three.js citations (`GLTFLoader.js:3930-3993` loadSkin, `Skeleton.js:64-78` calculateInverses); `src/nodes/GltfSkeleton.ts`, `src/core/import/projectGltfSkeleton.ts`, `src/core/import/gltfImportChain.ts` `buildSkinMetadata`, `src/nodes/GltfSkeleton.test.ts`, `src/core/import/projectGltfSkeleton.test.ts`, `src/core/import/gltfSkinCapture.test.ts`, `tests/e2e/p7.11-gltf-rig-nodes.spec.ts`. Issue #100. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### V26: A baked GltfChild KeyframeChannel stores BOTH params.target (the dagId) AND params.childName — the two key-spaces are not interchangeable

**Status:** ALIGNED (P7.12 D-04 / Wave D, #108, 2026-05-30).

**Span:** The copy-on-write bake boundary — `src/agent/mutators/builders/bakeGltfChannel.ts` (the writer), `src/app/bakedGltfChannels.ts` (the renderer/read-side enumerator), `src/app/animate/paramAnimationState.ts` (the selection/dopesheet matcher), `src/app/animate/bakeOnEdit.ts` + `dispatchMutator.ts` (the idempotency/exists check). All consume the SAME baked KeyframeChannelVec3 node.

**Statement:** A P7.12 baked glTF-bone channel MUST carry, in its params, BOTH:

- `target` = the GltfChild **dagId** (`gltfChildDagId(assetRef, childName)`) — REQUIRED by `paramAnimationState` (`p.target === selectionNodeId`, where the selection id IS the GltfChild dagId) AND by the bake idempotency / "does a channel already exist for this bone" check.
- `childName` = the glTF child name — REQUIRED by the renderer/read-side enumerator (`bakedChannelSamplersForAsset`) so it resolves the bone by name with NO per-frame nodeNameMap inverse scan, and as the clip-track key ([[H53]]).

Plus `assetRef` (the owning asset) so the enumerator/B2 display predicate can scope by asset. All three are written by D1 construction and persist only because they are declared on the schema ([[H56]]).

**Why it matters:** the dagId space and the childName space are bridged ONLY by `nodeNameMap` (childName → dagId) and `gltfChildDagId`. Storing one and deriving the other per frame is either O(N) (inverse scan) or wrong (the wrong direction). The renderer's asset-membership test `nodeNameMap[childName] === target` is the cheap consistency assertion that the two stored keys agree.

**Enforcement:** `bakeGltfChannel.test.ts` asserts every baked channel carries BOTH `target === gltfChildDagId(assetRef, childName)` AND `childName`; the enumerator's membership test fails closed (a channel whose keys disagree is excluded). Cross-ref [[H53]] (the childName-not-dagId key trap), [[H54]] (edge-less bridge), [[H56]] (schema-declaration prerequisite), [[V22]] (deterministic ids), [[V20]] (single writer). REF: `src/agent/mutators/builders/bakeGltfChannel.ts`, `src/app/bakedGltfChannels.ts`, `src/app/animate/paramAnimationState.ts`, `src/core/import/gltfImportChain.ts` (`gltfChildDagId`/`gltfChannelDagId`). Issue #108. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### V27: An imported asset's DAG footprint is a content-addressed GROUP; lifecycle ops that remove the asset MUST remove the whole group (entry node + wrappers + satellites), never just the entry

**Statement:** `buildGltfImportOps` emits, for one `assetRef`, a whole subtree — the `GltfAsset` entry, its wrapper `Transform`/`Group`, the inputless `GltfChild` addressing satellites, and (when animated) the `TransformClip`/`ClipSelect` clip nodes. Every id is content-addressed off the assetRef (`hashId(prefix, assetRef, …)`), and the assetRef-carrying nodes (`GltfAsset`, `GltfChild`) additionally store `params.assetRef`. Any lifecycle op that removes the asset (break-refs delete) MUST act on the WHOLE group — recovered by `importGroupNodeIds(assetRef, state)` — not just the `GltfAsset`. Removing only the entry leaves orphan ghosts: an empty `Group`/`Transform` in the scene tree plus dangling `GltfChild`/clip nodes ([[H57]] family — closure that under-reaches).

**Why it matters:** the import footprint is created atomically as a unit (one `dispatchAtomic`), so it must be destroyed as a unit. The satellites are edge-less (unreachable by forward closure from `GltfAsset`), and a naive parent-closure would over-reach into user-wired consumers — so the safe membership is the content-addressed id scheme itself (a user node never matches `hashId('tx', assetRef)` nor carries the import's assetRef). The shared `Scene` anchor is NOT content-addressed off assetRef, so it is correctly excluded; boundary edges (`Group.out → Scene.children`, or a user node consuming a `GltfChild`) are disconnected, not deleted.

**Enforcement:** `importGroupNodeIds` lives in `gltfImportChain.ts` (the module that owns the id scheme — single source of truth, mirrors `buildGltfImportOps`). `deleteImportedAsset(name, { breakRefs: true })` expands each referencing asset to its group, disconnects every incident edge (internal + boundary), then `removeNode`s the whole group in one `dispatchAtomic` ([[K6]]; the op layer rejects removing a still-consumed node, so disconnect-all precedes removeNode-all — order-independent). Tests: `gltfImportChain.test.ts` (`importGroupNodeIds` selects the full footprint, excludes Scene + user nodes), `importCommon.test.ts` (break-refs removes the whole footprint through the real op layer, Scene survives), `tests/e2e/p7.14-my-imports-mgmt.spec.ts` (node count returns to pre-import baseline + zero assetRef-tagged nodes after break-refs). Cross-ref [[H57]] (the removeNode closure must root on the right set), [[K14]] (the rename/delete lifecycle this completes), [[K6]] (one atomic), [[V22]] (deterministic content-addressed ids make the group recoverable without a stored tag), [[V13]]. REF: `src/core/import/gltfImportChain.ts` (`importGroupNodeIds` + `buildGltfImportOps`), `src/app/asset/importCommon.ts` (`deleteImportedAsset` break-refs). Issue #127 (P7.14 follow-up). (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — clips/child-addressing §STAGE 7, clone/share boundary §STAGE 6.)

### V28: An override node's per-field "authored" set is EXPLICIT (carried, not derived from value≠default), sparse, and SHARED across override domains — because Basher's params are single-tier (seeded with the source value), the R-4 trap

**Statement:** for any node that overlays an override on a source value (`GltfChild` TRS over imported pose; `MaterialOverride` PBR over a cloned imported material), "which fields the director actually set" MUST be carried as an explicit per-field boolean set — it CANNOT be derived from "value differs from default," because Basher seeds the override params with the SOURCE's own value (R-4), so value==default ≠ untouched. The set is **sparse** (absent field = inherit source) and the merge rule (`set[field] ? override[field] : source[field]`) is **ONE shared primitive**, not re-implemented per node type.

**Why it matters (grounded):** Houdini/USD and Blender both treat property-override as generic+sparse but DERIVE "is overridden" from a two-tier model — `UsdAttribute.HasAuthoredValue()` (authored opinion vs schema fallback) / Blender's `IDOverrideLibraryProperty` list (operation vs linked-reference). Basher is **single-tier** (no fallback layer beneath the seeded param), so it must store the authored bit explicitly — this is the structural reason GltfChild already carries `overridden:{position,rotation,scale}` and the reason #99's map-presence heuristic was a workaround for the missing bit on MaterialOverride. Both DCCs keep TYPED override nodes over the generic substrate (Set-Material / Assign-Material-LOP are nodes, not operators) — so the consolidation is a SHARED PRIMITIVE consumed by typed nodes, NOT a generic `Override(path→value)` mega-node (which would lose typed value sockets, tailored NPanel UI, agent legibility).

**Status:** IMPLEMENTED (#124, 2026-06-02). The shared primitive lives in `src/core/override/overrideSet.ts` (`OverriddenSet<K>` sparse + `isOverridden`/`withOverride`/`clearOverride`/`mergeOverridden`). Two consumers, as the design demanded (D-06): (1) **GltfChild** — `resolveGltfChildTransform.ts` manual band now calls `mergeOverridden(lowerBands, childNode, childNode.overridden, TRS_FIELDS)` (pure refactor, the baked→clip→base order untouched; regression-proven by p7.7/p7.11/p7.12 staying green). (2) **MaterialOverride** — carries a sparse `overridden` set on `MaterialValue`; `resolveMaterialOverrideFields(override, maps, set?)` resolves roughness/metalness as "explicit-set ∪ map-aware-fallback": a field in the set FORCES the scalar over a source map (the #124 capability), absent falls to the #99 map-defends default. Backward-compat: empty/absent set = byte-identical #99 (D-03). The coarse "flatten / ignore source material" toggle is a SEPARATE primitive (D-05), NOT part of the per-field set.

**Enforcement:** `overrideSet.test.ts` (16 — sparse + immutable + merge-picks-override-only-where-set + value-equality-is-NOT-the-signal); `materialOverrideMerge.test.ts` (6 legacy #99 cases unchanged = backward-compat proof + 6 forced-channel cases); GltfChild `resolveGltfChildTransform.test.ts` (22) + p7.7/p7.11/p7.12 e2e green through the retrofit (the "2nd consumer justifies the module" proof). **Observed live** (Lokayata, H40/H59 boundary-pair): `tests/e2e/p124-material-force-channel.spec.ts` imports a textured-metal glTF (`public/fixtures/multifile/metal`, metallicRoughnessTexture → three.js `.metalnessMap`), forces `metalness=0` over the map (rendered `.metalness===0` while `.metalnessMap` ref survives = flatten not drop), and reverts (map defends again) — reading the real three.js material via `__basher_gltf_meshes`, NOT the node params. Cross-ref [[H59]] (map-aware tint — the default when a field is NOT in the set), [[V20]]/[[H36]] (single-writer material clone), the GltfChild R-4 value-equality trap, [[V27]] (sibling: content-addressed group; both are "the model carries the structural fact explicitly, don't infer it"). REF: `src/core/override/overrideSet.ts`, `src/viewport/materialOverrideMerge.ts`, `src/app/resolveGltfChildTransform.ts`, `src/nodes/MaterialOverride.ts`, `tests/e2e/p124-material-force-channel.spec.ts`; `.planning/phases/124-material-override-primitive/{CONTEXT,PLAN}.md` (decisions D-01..D-06, Houdini+Blender grounding). Issue #124 (successor to #99 D-06).

### V29: Every mesh consumer reads the ONE projected `EvaluatedMesh` (via `resolveEvaluatedMesh`), never a node-kind-specific `*Value` shape — the renderer and read-side surfaces apply each band identically at the same `ctx.time`

**Statement:** for any surface that needs "the mesh as it renders" — renderer, gizmo, inspector, and the future material (#2) / UV (#3) / transient-keyframe (#149) consumers — the source of truth is ONE projected `EvaluatedMesh{geometry: GeometryRef, uvs, material, transform: MeshTransform}` produced by the pure `resolveEvaluatedMesh(node, ctx)`. No consumer branches on producer kind (BoxMesh / SphereMesh / GltfChild). `geometry` is a deterministic-key HANDLE into the geometry registry (§48), NEVER inlined buffers (Ousterhout interface-depth — heavy buffers stay out of Ops/undo/hash). A NEW band threaded into the resolver MUST be threaded into the renderer too (the [[H40]] "one band, two callers" rule), or displayed ≠ rendered at mesh scope.

**Why it matters:** this generalizes [[V20]]/[[H36]]/[[H40]] from the transform band (`resolveEvaluatedTransform`, proven for #68) to the whole mesh — the v0.6 #1 foundation (#150). Without the single consumed face, each rider re-branches on glTF-vs-primitive and the four islands (`BoxMeshValue`/`SphereMeshValue`/`GltfAssetValue`/`GltfChildValue`) leak into every surface (N×M wiring). The producer-agnostic resolver makes "no producer is second-class" enforceable in ONE place.

**Status:** IMPLEMENTED for the transform band (v0.6 #1 / #150, 2026-06-03) — `transform.scale` is the visible vertical-proof slice: gizmo scale on a primitive writes `transform.scale`, renders, displays in the inspector, distinct from geometry `size`. `material`/`uvs` are stubbed (`null` for gltf / inline spec for primitives; `uvs` always null) and filled by #2/#3 as the next consumers. V4 satisfied: BoxMesh/SphereMesh are version 2 with a lossless `scale=identity` migration.

**Enforcement:** `src/app/resolveEvaluatedMesh.test.ts` (box/sphere/gltf/null projection + deterministic GeometryRef.key + the H40 band-parity assertion: resolver gltf scale == `resolveGltfChildTrs(...)`); `src/app/geometryRegistry.test.ts` (deterministic key, cache hit/miss, no false sharing, gltf→null); `src/core/project/migrations.test.ts` (the byte-identical v1→v2 gate). **Observed live** (Lokayata, [[H40]] boundary-pair): `tests/e2e/p150-evaluated-mesh.spec.ts` reads the REAL rendered three.js object world scale (`__basher_mesh_world_scale`) AND `resolveEvaluatedMesh(...).transform.scale` (`__basher_evaluated_mesh`) and asserts equality at identity + [2,3,4]; `tests/e2e/p150-uniformity-gate.spec.ts` extends to gizmo→inspector with the size-vs-scale independence falsification. Cross-ref [[V20]]/[[H36]] (single-writer / boundary-pair parent), [[H40]] (the displayed-≠-rendered class this prevents at mesh scope), [[V10]]/[[H14]] (the `?? [1,1,1]` hydrate guard on the new scale band), [[V30]] (BakedMesh — the 4th producer — adds the AUTHORITATIVE-store qualifier to V29's "geometry is a handle"), dharana [[B14]]. REF: `src/app/resolveEvaluatedMesh.ts`, `src/app/geometryRegistry.ts`, `src/nodes/types.ts` (EvaluatedMesh/GeometryRef/MeshTransform), `src/viewport/SceneFromDAG.tsx` (BoxMeshR/SphereMeshR), `.planning/phases/v06.1-unified-mesh-model/{CONTEXT,RESEARCH,PLAN}.md`. Issue #150 (foundation); riders #2/#3/#149/#151.

### V30: Baked geometry AND baked textures are AUTHORITATIVE state (not derived like the box/sphere registry cache) — they persist to OPFS keyed by a deterministic content hash; the DAG carries only the handle

**Statement:** for any geometry/texture that is the irreversible PRODUCT of a runtime operation — `BufferGeometry.applyMatrix4` on a clone (Apply-Transform #151), and the captured PBR texture maps of a baked glTF child — the bytes are AUTHORITATIVE: they CANNOT be rebuilt from DAG params, so they MUST persist to OPFS keyed by a deterministic content hash, and the DAG node carries ONLY a handle (`GeometryRef{kind:'baked', descriptor:{hash, vertexCount}}` / `BakedTextureRef{hash, colorSpace, flipY, wrap}`). This SHIFTS the geometryRegistry V1-EXEMPTION boundary: box/sphere geometry is rebuildable-from-params (a DERIVED, V1-exempt cache the registry reconstructs on demand) — baked geometry is NOT (authoritative, must be persisted or it is lost on reload). The content hash makes the store idempotent: two bakes of identical bytes resolve to ONE OPFS file (dedupe, the §48 determinism goal). The OPFS write is a side effect at Apply-DISPATCH time (mirrors `renameImportedAsset`, `importCommon.ts`), AWAITED before the Op composite commits the referencing node (reload-safe ordering, [[K15]] extension), NEVER inside a pure evaluator/resolver (which stays sync — [[V29]] purity).

**Why it matters:** §48 (no inline buffers — project.json stays a thin handle graph, `io.ts:60`) PLUS authoritativeness PLUS determinism are three distinct requirements that the box/sphere derived cache only ever had to satisfy the first of (it could always rebuild, so it never persisted). Conflating "geometry is a handle" ([[V29]]) with "geometry is rebuildable" is the trap: BakedMesh keeps the handle face but BREAKS the rebuildable assumption — so the registry needed a `'baked'` branch that LOADS from OPFS (async suspense) instead of building from params, and the OPFS write had to be a real persisted side effect, not a cache prime. Without this distinction tracked, a future producer of authoritative bytes (a sculpt result, a CSG output, a procedurally-modified texture) re-discovers from scratch that the derived-cache pattern silently loses its bytes on reload (the bake renders once, then reload shows nothing — an empty registry miss with no error). The texture half is the same rule: a baked map that referenced the source asset's bytes (option b) would break when the source is deleted ([[H60]] orphan made permanent) — so the bytes are COPIED self-contained (option a).

**Status:** IMPLEMENTED (#151, 2026-06-04). `src/app/asset/bakedGeometryStore.ts` — `serializeGeometry` (canonical fixed-order `{position, normal, uv, index}` binary blob + small header, NOT base64-in-JSON) → `hashValue` (FNV-1a + stableStringify, deterministic) → OPFS key `baked-geometry/<hash>-<vertexCount>.bin` (hash+vcount blunts the 32-bit FNV collision surface); `writeBakedGeometry` is read-or-skip idempotent (SC-4 dedupe). `src/app/asset/bakedTextureStore.ts` — `persistTexture` ships BOTH readback paths (path 1: copy original compressed bytes verbatim when a source-URI association survived the clone; path 2: universal `OffscreenCanvas.convertToBlob` PNG readback — always shipped so the wave cannot block on the MEDIUM-confidence path-1 item, the [[H40]]-style Lokayata-probe-first discipline), carrying `colorSpace/flipY/wrapS/wrapT` so the reload rebuilds the Texture identically (wrong colorspace washes out — M5). The registry `'baked'` branch + `useBakedGeometry`/`useBakedTexture` suspense hooks are the SOLE async readers; the pure resolver stays sync.

**Enforcement:** `src/app/asset/bakedGeometryStore.test.ts` (serialize→deserialize round-trip byte-identical; same geometry twice → identical hash + key, SC-4; `writeBakedGeometry` twice → one write, idempotent dedupe); `src/app/asset/bakedTextureStore.test.ts` (persist→load round-trip → `image.width>0` + colorspace matches the ref); `src/app/geometryRegistry.test.ts` (the `'baked'` prime → sync hit; unprimed → null miss → suspend). **Observed live** (Lokayata, [[H40]] boundary-pair, the [[V29]] sibling-spec rule): `tests/e2e/p151-apply-transform.spec.ts` SC-3 (bake → reload → BakedMesh still renders, world bounds byte-identical — proves the OPFS bytes survived) + SC-1/SC-2 (rendered world bounds == resolver geometry bounds == 2×1×1, BakedMeshR renders IDENTITY scale because the transform is IN the verts, [[H40]] cross-ref); `tests/e2e/p151-gltf-child-apply.spec.ts` SC-6 (reload → `map.image.width>0` + colorspace correct) + the self-contained gate (bake → delete source asset → reloaded baked mesh STILL textured, [[H60]] orphan avoided). Cross-ref [[V29]] (the handle face this qualifies — V30 is "the handle, when the bytes are authoritative, must persist"), [[V20]] (single OPFS-write chokepoint = the Apply dispatch helper), [[H40]] (BakedMeshR is the first registry-reading renderer; baked verts == resolver == render), [[H45]] (clone before `applyMatrix4` / read-only texture capture), [[H60]] (the orphan class the self-contained copy avoids), [[K15]] (the write-at-dispatch + load-at-render lifecycle), dharana [[B14]]/[[B12]]. REF: `src/app/asset/bakedGeometryStore.ts`, `src/app/asset/bakedTextureStore.ts`, `src/app/asset/bakedGeometryLoader.ts`, `src/app/asset/bakedTextureLoader.ts`, `src/app/geometryRegistry.ts` (`'baked'` branch), `src/core/dag/hash.ts` (`hashValue`), `src/core/storage/StorageCapability.ts`, `.planning/phases/151-apply-transform/{PLAN,RESEARCH}.md` (Q2/Q3/M4). Issue #151.

### V31: A transient edit is an EPHEMERAL, V1-EXEMPT, non-persisted UI projection (precedence transient > channel); it is overlaid by ONE shared `overlayTransients`, two callers (render + read), never an Op, and is cleared only on a frame-INT change

**Statement:** when a director edits an ANIMATED param with Auto-Key OFF (paused), the edit is HELD as a transient — a value in `transientEditStore` (a multi-slot `Map` keyed `${nodeId}|${paramPath}`), the same V1-EXEMPT ephemeral shelf as `timeStore`/`autoKeyStore`/`gizmoStore`. It is NEVER an Op, NEVER `setParam`, NEVER persisted to project.json. Precedence is **transient > channel**: the held value wins over the curve value at the same frame, applied by the ONE shared `overlayTransients(child, nodeId, edits)` primitive AFTER the channel patch. That ONE primitive has exactly TWO callers — the render side (`AnimationLayerR`, inside the sole TRS writer) and the read side (`resolveEvaluatedTransform` for transform fields + `resolveEvaluatedParam` for non-transform) — so render and read CANNOT drift ([[H40]] "one band, two callers"). The transient is discarded on a `timeStore` **frame-INT** change ONLY (the Blender depsgraph re-eval model, D-149-2) — selection/undo/Auto-Key-toggle do NOT clear it. It is persisted only on an explicit key (the NPanel diamond per-param, K/I whole-transform), via the EXISTING insert paths (`keyParamFromTransient` → `dispatchFirstKeyComposite`/`mutator.timeline.keyframe`), then the slot is cleared.

**Why it matters:** the transient is "a one-frame un-persisted keyframe". Three traps without this invariant pinned: (1) treating it as a DAG mutation (an Op or `setParam`) re-introduces the H36 double-write on an animated source — it must be V1-EXEMPT, held by construction (the OFF branch `return true` already skips the caller's raw write). (2) overlaying it on render but not read (or vice-versa, or with different precedence/sample-time) is the [[H40]] render≠read drift — solved by the ONE shared `overlayTransients`. (3) mutating the `edits` Map in place instead of producing a NEW Map breaks the subscribed selectors (the render dirty-check + the orange indicator never fire — the [[B12]] snapshot-not-subscribed class). The clear-trigger MUST compare the derived frame INT, not seconds, or a sub-frame jitter wipes the in-progress edit (the W9/[[V20]] frame-INT discipline). The orange field color (`text-warn`, TOP of the diamond precedence) is the MANDATORY non-silent indicator that REPLACES the removed Auto-Key-OFF reject alert (FLAG-A): without it a held edit would vanish on scrub silently — the exact #68/#77 "snaps right back" class the alert existed to kill.

**Status:** IMPLEMENTED (#149, 2026-06-04). `src/app/stores/transientEditStore.ts` (multi-slot Map, new-Map-every-write, module-init frame-INT subscription → `clearAll`, clearAll/clear no-op when empty so playback churn stays zero); `src/app/overlayTransients.ts` (the one primitive, reuses the exported `writeAt` from `src/nodes/AnimationLayer.ts`); `src/app/animate/autoKeyCommit.ts` (`routeAnimatedGrab` OFF branch → `transientEditStore.set`; `keyParamFromTransient` the shared commit fork); `src/viewport/SceneFromDAG.tsx` (`AnimationLayerR` overlay + transients in the dirty-check tuple, H40 form 2); `src/app/resolveEvaluatedTransform.ts` (C1 overlay) + `src/app/resolveEvaluatedParam.ts` (C2, channel `.sample()` not re-interp); `src/app/NPanel.tsx` (orange + diamond commit); `src/app/KeyboardShortcuts.tsx` (K/I whole-transform).

**Enforcement:** `transientEditStore.test.ts` (multi-slot, frame-INT clear, sub-frame no-clear, subscribe-fires/new-ref); `overlayTransients.test.ts` (transform + nested overlay, identity-on-no-match, base untouched); `routeAnimatedGrab.transient.test.ts` (held + ZERO ops + no alert); `resolveEvaluatedParam.test.ts` (channel `.sample()` + transient override + grep gate banning interp math). **Observed live** (Lokayata, [[H40]] boundary-pair, PAUSED): `tests/e2e/p149-transient-boundary-pair.spec.ts` (C3 rendered position == resolver == transient `[9,0,0]`; C4 rendered material == resolver, channel `#808080==#808080` AND transient `#ff0000==#ff0000`), `p149-clear-on-scrub.spec.ts` (edit→scrub→curve `x=3`, transient gone; sub-frame survives), `p149-commit.spec.ts` (diamond + K key the typed transient, source byte-unchanged H36, persists across scrub), `p149-four-color.spec.ts` (gray/green/yellow/orange + multi-slot + commit/scrub clears); perf-fox `commits=0` over 4s playback (the subscribed selector is paused-only safe, [[H48]]). Cross-ref [[V1]] (the EXEMPTION — same shelf as timeStore/autoKeyStore), [[V20]] (AnimationLayerR stays the sole TRS writer; overlay applied INSIDE it), [[V29]] (the resolver stays the one read producer; transient is a new BAND not a new resolver), [[H40]] (render==read, the one-band-two-callers enforcement), [[H36]] (non-Op non-setParam → zero double-write), [[B12]] (new-Map subscribed selector), dharana [[B1.1]]/[[B14]]. REF: issue #149; the bundled Blender manual `animation/introduction.rst:43-56`, `keyframes/editing.rst:36-39`, `bpy.types.Depsgraph.rst:10-13` (the two-layer base/evaluated contract); `~/.anvideck/projects/basher/ref/GROUND_TRUTH_BLENDER_KEYING.md`; `.planning/phases/149-transient-edit-keyframing/{CONTEXT,RESEARCH,PLAN}.md`.
