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

**Span:** All zustand stores (DAG, selection, mode, agent, render-job).
**Enforcement:** Reviewer rejects `setState` outside `dispatch(op)`. Future: lint rule.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §50
**Why it matters:** undo, agent control, save/load, multiplayer all assume one mutation path.

### V2: Pure node evaluators are bit-exact reproducible given (params, inputs)

**Span:** Every node-type definition where `pure: true`.
**Enforcement:** Lint bans `Math.random`/`Date.now`/`performance.now`/`crypto.randomUUID` inside pure evaluators. CI test harness runs each pure node twice on identical inputs.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §48, §51
**Why it matters:** cache correctness; agent reproducibility; render = viewport at same time.

### V3: Time enters as a `Time` socket, never as a closure or global

**Span:** All animation and render node evaluators.
**Enforcement:** Lint rule bans reading time from `useFrame`/`Date.now`/`performance.now` inside evaluators. Reviewer enforces.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §49
**Why it matters:** scrubbing, frame-stepping, agent's "what does scene look like at t=2.5?" all depend on this.

### V4: Every node type carries a `version: number`; project loaders migrate

**Span:** Every node-type definition + project loader + storage backend.
**Enforcement:** Type system requires `version` field. CI runs migration corpus on every PR.
**Status:** NOT YET IMPLEMENTED (P0 ships runner; v1 = no migrations)
**REF:** THESIS.md §52
**Why it matters:** every saved project from every Basher version must load. Without this, P3+ schema changes break P0/P1 demo files.

### V5: Permissive licenses only in dependency tree

**Span:** Every `package.json` dependency, transitive included.
**Enforcement:** CI license-audit step on every package.json diff.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §35; memory/feedback_license.md
**Why it matters:** GPL infection forces Basher under GPL. One-way door.

### V6: Capability interfaces decouple browser/native impls

**Span:** `core/storage/`, `core/blender-bridge/`, `core/file-picker/`, `core/render-encoder/`.
**Enforcement:** No code outside these directories imports `tauri-*` or `node:fs` directly. Reviewer enforces.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §33; memory/project_stack.md
**Why it matters:** v0.6 Tauri swap is a capability impl swap, not a feature rewrite.

### V7: Agent tool handlers return `Op[]`; do not mutate state directly

**Span:** Every agent tool definition.
**Enforcement:** Tool handler signature is `(args) => Op[] | Promise<Op[]>`. No exceptions.
**Status:** NOT YET IMPLEMENTED (P2.5)
**REF:** THESIS.md §18, §20
**Why it matters:** agent edits via the same path as the user; one undo system; one diff system; one audit log.

### V8: Viewport never mutates DAG; viewport renders evaluated DAG output

**Span:** R3F `Canvas` and all components inside it.
**Enforcement:** R3F components are read-only consumers of `evaluate('scene', t)`; user-input handlers emit Ops via dispatchers passed in via props/context.
**Status:** NOT YET IMPLEMENTED
**REF:** THESIS.md §11
**Why it matters:** the DAG is the truth; the viewport is the result. Reverse this and the entire architecture inverts.
