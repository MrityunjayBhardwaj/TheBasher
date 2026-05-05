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

**Span:** All animation and render node evaluators.
**Enforcement:** Lint rule bans reading time from `useFrame`/`Date.now`/`performance.now` inside evaluators. Reviewer enforces.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §49
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

**Span:** `src/core/storage/` (`StorageCapability` → `OpfsStorage`/`TauriStorage`/`MemoryStorage`); `src/integrations/blender/` (`BlenderBridgeCapability` → `BrowserBlenderBridge`). v0.6 will add `core/file-picker/` and `core/render-encoder/`.
**Enforcement:** No code outside `src/core/storage/` or `src/integrations/blender/` imports a Tauri or `node:fs` symbol. `pickStorage()` selects at runtime via `isAvailable()`.
**Status:** ALIGNED for storage + Blender bridge. v0.6 swap point is a one-line provider change in `src/app/boot.ts`.
**REF:** THESIS.md §33; `src/core/storage/StorageCapability.ts:1`

### V7: Agent tool handlers return `Op[]`; do not mutate state directly

**Span:** Every agent tool definition.
**Enforcement:** Tool handler signature is `(args) => Op[] | Promise<Op[]>`. No exceptions.
**Status:** NOT YET IMPLEMENTED (P2.5)
**REF:** THESIS.md §18, §20
**Why it matters:** agent edits via the same path as the user; one undo system; one diff system; one audit log.

### V8: Viewport never mutates DAG; viewport renders evaluated DAG output

**Span:** R3F `Canvas` (`src/viewport/Viewport.tsx`) + `SceneFromDAG` (`src/viewport/SceneFromDAG.tsx`).
**Enforcement:** `SceneFromDAG` calls `evaluate(state, target.node, { cache })` and walks the result. The rule is now **file-rooted, not call-stack-rooted**: no source file under the `src/viewport/` tree contains a `dispatch(...)` call or `useDagStore.setState`. Components imported from `src/app/` that dispatch (e.g. `src/app/Gizmo.tsx` — the TransformControls authoring surface) are allowed even when they render inside the Canvas — the dispatch is defined in their own file's source. Mode switches do not unmount the Canvas — Layout flips slot visibility via `display:none` (K1 step 6).
**Status:** ALIGNED. Click-to-select handlers in NodeList live in `src/app/`, not `src/viewport/`, and update `selectionStore` (a UI projection, not the DAG). The P1 Gizmo (`src/app/Gizmo.tsx`) follows the same pattern — file location, not Canvas containment, defines the boundary.
**REF:** THESIS.md §11; `src/viewport/SceneFromDAG.tsx:30`; `src/app/Gizmo.tsx:1`

### V9: Materials are data, not code (in v0.5)

**Span:** `src/nodes/MaterialOverride.ts` + any node exposing material parameters.
**Enforcement:** Material nodes expose preset choice + scalar/texture params only. No string-typed shader source, no JS callback that returns a `Material`, no TSL/OSL/GLSL/WGSL authoring surface in v0.5. Reviewer rejects any `new ShaderMaterial({ vertexShader, fragmentShader })` outside `core/render/` (none expected in v0.5).
**Status:** ALIGNED (P1). `src/nodes/MaterialOverride.ts` exposes preset PBR scalars (`color`, `roughness`, `metalness`, `opacity`, `emissive`, `emissiveIntensity`) only. The viewport applies via `MeshStandardMaterial`; no shader-source pathway exists anywhere in `src/`.
**REF:** THESIS.md §39 (`MaterialOverride`); deferred-decision rationale in `dharana.md` §3 ("Shader-as-node-graph"); `src/nodes/MaterialOverride.ts:10`.
**Why it matters:** PBR via GLB + parameter overrides keeps the asset library decoupled from the renderer. Allowing shader-as-code in P1 leaks renderer concerns into content authoring, breaks determinism/caching guarantees (V2), and pulls TSL's WebGPU surface area into a phase whose job is content placement. Re-evaluate when the render graph lands (P4).
