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

### V8: Viewport never mutates DAG; viewport renders evaluated DAG output

**Span:** R3F `Canvas` (`src/viewport/Viewport.tsx`) + `SceneFromDAG` (`src/viewport/SceneFromDAG.tsx`).
**Enforcement:** `SceneFromDAG` calls `evaluate(state, target.node, { cache })` and walks the result. The rule is now **file-rooted, not call-stack-rooted**: no source file under the `src/viewport/` tree contains a `dispatch(...)` call or `useDagStore.setState`. Components imported from `src/app/` that dispatch (e.g. `src/app/Gizmo.tsx` — the TransformControls authoring surface) are allowed even when they render inside the Canvas — the dispatch is defined in their own file's source. Mode switches do not unmount the Canvas — Layout flips slot visibility via `display:none` (K1 step 6).
**Status:** ALIGNED. Click-to-select handlers in NodeList live in `src/app/`, not `src/viewport/`, and update `selectionStore` (a UI projection, not the DAG). The P1 Gizmo (`src/app/Gizmo.tsx`) follows the same pattern — file location, not Canvas containment, defines the boundary.
**REF:** THESIS.md §11; `src/viewport/SceneFromDAG.tsx:30`; `src/app/Gizmo.tsx:1`

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
