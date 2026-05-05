# Basher — Next Session Prompt (Autonomous P0 Execution)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P0 (Foundation + DAG core)**. The architecture, plan, and disciplines are fully specified. Your job is to build P0 to acceptance, open a draft PR, summarize, and stop. The user is asleep. Do not wait for input that isn't required.

## What's already true

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/` (currently contains only `THESIS.md`, `.anvi/`, and `NEXT_SESSION.md` — this file).
2. **Source of truth:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/THESIS.md` — 11 parts, 65 sections, 3 appendices. Read it FIRST, end-to-end. Every architectural question has an answer there.
3. **Catalogues seeded:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/.anvi/{dharana,hetvabhasa,vyapti,krama}.md` — read and update as you work.
4. **Memory loaded:** `/Users/mrityunjaybhardwaj/.claude/projects/-Users-mrityunjaybhardwaj-Documents-projects-basher/memory/MEMORY.md` lists all relevant memories. They are auto-loaded at session start.
5. **Anvi framework:** active globally (`~/.claude/CLAUDE.md`). Use `/anvi:execute-phase 0` if you want the formal workflow; otherwise execute directly per the protocol below.

## Read order (do this before any code)

1. `/Users/mrityunjaybhardwaj/Documents/projects/basher/THESIS.md` — entire file. Especially Parts II, III, VII, VIII.
2. `/Users/mrityunjaybhardwaj/Documents/projects/basher/.anvi/dharana.md` — boundaries B1-B5.
3. `/Users/mrityunjaybhardwaj/Documents/projects/basher/.anvi/vyapti.md` — invariants V1-V8 you must enforce.
4. `/Users/mrityunjaybhardwaj/Documents/projects/basher/.anvi/krama.md` — lifecycle K1, K2, K5 are P0-relevant.
5. `/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld/src/world/{PostFx.tsx, RealismFX.tsx, FpsMeter.tsx}` and `RubicsWorld/src/App.tsx:169-184` (Blender beacon) — donor code reference.

## Locked decisions (do NOT relitigate)

- **Browser-first.** Vite + React 19 + TypeScript + PWA manifest. No Electron. No Tauri until v0.6.
- **Stack:** R3F + drei + @react-three/postprocessing + zustand + Tailwind + shadcn/ui + Theatre.js + zod + dnd-kit. (Not all needed in P0; ship only what P0 requires.)
- **Storage v0.5:** OPFS only. Capability interface: `core/storage/StorageCapability.ts` + `OpfsStorage.ts`. `TauriStorage.ts` is a stub for v0.6.
- **License:** MIT. Permissive deps only. Reject any GPL/AGPL/LGPL.
- **Theme default:** dark, electric green accent `#5af07a`, geometric mono wordmark (Geist Mono / JetBrains Mono).
- **Modes:** Simple / Director / Pro. P0 ships the shell; only Director default-renders the placeholder full chrome. Right drawer placeholder renders empty but reserves slot.

## P0 Goal (verbatim from THESIS.md §38)

> Stand up a Basher dev environment that boots a Vite+React+R3F shell, persists a Project to OPFS, exposes Simple/Director/Pro routes, integrates RubicsWorld's PostFx + Blender live-link companion-script polling, evaluates a default 4-node DAG, and renders the result at 60fps.

## P0 Acceptance Tests (8 — all must pass)

1. Dev server up in <5s.
2. Default project = 4-node DAG (PerspectiveCamera + DirectionalLight + BoxMesh + Scene aggregator + RenderOutput per THESIS.md App. C). Evaluator produces correct scene.
3. Mode toggle (Simple/Director/Pro) reconfigures chrome correctly.
4. Save → OPFS write succeeds; reload → identical state restored.
5. Inspector edits a node param → viewport updates within 16ms.
6. Beacon endpoint exists at `/__assets/active`; in dev mode polls for Blender companion-script; absent in prod build (verified by build-output check).
7. PostFx beauty matches a reference screenshot (committed) within 2% pixel diff.
8. ≥60fps on M1 baseline with default scene (FPS meter visible in dev).

## Execution Protocol

### Wave A — Repo + tooling
- `git init`. Create initial commit with the existing THESIS.md, .anvi/, NEXT_SESSION.md.
- `gh repo create mrityunjaybhardwaj/basher --public --source=. --license=MIT --description="Director-first, agent-native, procedural AI video platform"`. If `gh` auth fails, skip GitHub creation and note in summary.
- `npm create vite@latest . -- --template react-ts` (handle "directory not empty" by initializing in-place; preserve THESIS.md, .anvi/, NEXT_SESSION.md).
- Install only what P0 needs: `react three @react-three/fiber @react-three/drei @react-three/postprocessing zustand zod tailwindcss @tailwindcss/vite shadcn/ui` and dev deps for typescript, vitest, playwright, @playwright/test, eslint, prettier.
- Configure: `tsconfig.json`, `tailwind.config.ts`, `vite.config.ts`, `eslint.config.js`, `playwright.config.ts`, `.prettierrc`.
- License-audit GitHub Action skeleton (run on every PR).

### Wave B — DAG core (THESIS.md Part II)
- `src/core/dag/types.ts` — `NodeId`, `SocketId`, `NodeRef`, `TypeDescriptor`, `NodeDefinition<P, I, O>` interface, `Node`, `Op`, `InverseOp`, `Diff`. ALL with zod schemas.
- `src/core/dag/registry.ts` — node-type registry; agent-introspectable.
- `src/core/dag/evaluator.ts` — topological sort, lazy eval, content-hash caching (use `xxhash-wasm` or simple JSON-stringify hash), cycle detection (visited set + depth limit 32).
- `src/core/dag/ops.ts` — five Op primitives + dispatcher. Each Op has `apply(state) → newState` and `inverse(state) → InverseOp`.
- `src/core/dag/store.ts` — zustand store; `dispatch(op)` is the only mutation entry.
- Tests in `src/core/dag/*.test.ts` — unit-test every Op + inverse round-trip + evaluator determinism.

### Wave C — Storage & Project (THESIS.md §52, §38)
- `src/core/storage/StorageCapability.ts` — interface.
- `src/core/storage/OpfsStorage.ts` — implementation using `navigator.storage.getDirectory()` + File System Access API.
- `src/core/storage/TauriStorage.ts` — STUB only; throws "v0.6".
- `src/core/project/schema.ts` — `Project` zod schema with `version: 1`.
- `src/core/project/migrations.ts` — runner skeleton; no migrations yet.
- `src/core/project/store.ts` — load/save/create.
- Round-trip tests.

### Wave D — Default 4-node DAG (THESIS.md App. C)
- `src/nodes/PerspectiveCamera.ts`, `DirectionalLight.ts`, `BoxMesh.ts`, `Scene.ts`, `RenderOutput.ts` — node definitions.
- All `pure: true` for v0.5. Test harness verifies determinism.
- Bootstrap `src/core/project/default.ts` returning the 4-node DAG.

### Wave E — Editor shell (THESIS.md §11, §17)
- `src/app/App.tsx` — root; hydrates stores in K1 order; renders Layout.
- `src/app/Layout.tsx` — CSS-grid named regions (`viewport`, `library`, `tree`, `inspector`, `timeline`, `chrome`, `right-drawer`).
- `src/app/modes/{Simple,Director,Pro}Layout.tsx` — only differ in slot visibility.
- `src/app/ModeSwitcher.tsx` — title-bar dropdown; persists to localStorage.
- `src/app/RightDrawer.tsx` — placeholder for P2.5 agent.

### Wave F — Viewport + render (THESIS.md §11, RubicsWorld donor)
- `src/viewport/Viewport.tsx` — R3F Canvas mounted at app root, NEVER unmounts on mode switch (V8).
- `src/viewport/SceneFromDAG.tsx` — calls `evaluate('scene', currentTime)` and emits R3F primitives from the result.
- `src/render/PostFx.tsx` — port from RubicsWorld (`/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld/src/world/PostFx.tsx`); strip game-specific bits; keep ACES + SMAA.
- `src/render/FpsMeter.tsx` — port from RubicsWorld.

### Wave G — Blender bridge (browser-shaped)
- `src/integrations/blender/BlenderBridgeCapability.ts` — interface.
- `src/integrations/blender/BrowserBlenderBridge.ts` — polls a localhost companion script (Python) at `/active` every 2s in dev. Companion script lives in `tools/blender-companion/serve.py` (write skeleton; document setup in README).
- Vite middleware `vite-plugin-blender-mock.ts` for the dev endpoint when companion not running.

### Wave H — Lint, tests, CI
- ESLint rules: ban `Math.random`/`Date.now`/`performance.now`/`crypto.randomUUID` in files matching `src/nodes/**` (V2 enforcement).
- Vitest config + run all unit tests.
- Playwright E2E for the 8 acceptance tests.
- GitHub Actions: lint, typecheck, vitest, playwright, license-audit.
- Reference screenshot committed for test #7.

### Wave I — Docs + close
- `README.md` — quickstart, "what is this", link to THESIS.md.
- `CHANGELOG.md` — `## [0.5.0-p0] - YYYY-MM-DD` entry summarizing what shipped.
- Update `.anvi/dharana.md` with any new boundaries observed during P0.
- Update `.anvi/hetvabhasa.md` with any patterns hit during P0.
- Update `.anvi/vyapti.md` — flip status of V1-V8 from NOT YET IMPLEMENTED to ALIGNED where true.
- Open draft PR (or skip if no GitHub remote): title `"P0: Foundation + DAG core"`. Body references THESIS.md §38 and lists which acceptance tests pass.
- Final summary message in conversation: what shipped, what cut, what surprised, ETA confidence for P1.

## Honesty Contract (do NOT violate)

- **Never** mark a `pure: true` node as such if it isn't.
- **Never** skip an acceptance test to make a deadline.
- **Never** copy GPL code under any circumstances.
- **Never** push to main without CI green.
- **Never** ship without the migration runner (even no-op).
- **Always** run twice-eval test for every pure node.
- **Always** validate every Op via zod before dispatch.
- **Always** record provenance in `.anvi/dharana.md` for every new boundary.

## Decision Defaults (when thesis is silent)

- Smell vs. blocker: ship-and-document for smells; fix before merge for invariant violations.
- Fork-in-the-road: pick the most reversible option; document in PR; flag in summary.
- Unclear license on a transitive dep: reject and find an alternative.
- Bundle size at risk: lazy-load before sacrificing a feature.

## Hard-Stop Triggers (escalate to user)

- Security vulnerability discovered.
- License violation discovered.
- Blocked >1 day on a single problem.
- Need to amend THESIS.md (architectural change).
- Acceptance test failing with no clear path to pass.

## Kill Phrase

If you ever see the user message **"stop, rethink"** — freeze immediately. Do not commit. Do not push. Output: (1) what you were about to do, (2) what's already committed, (3) what's uncommitted/stage-revertable, (4) wait.

## When P0 Is Done

1. All 8 acceptance tests green in CI.
2. Draft PR opened (or skip-noted if no remote).
3. End-of-phase summary posted in conversation:
   - What shipped (bullet list, mapped to thesis sections).
   - What cut from P0 scope (deferred to P1+ with justification).
   - What surprised (anything that took >1.5x estimate or revealed a thesis gap).
   - Risk register updates (any new B<N> boundaries observed).
   - Confidence for P1 (high/med/low and why).
4. **STOP.** Do not start P1. P0 is the foundation; user reviews before stacking on it.

---

**Begin.** Read the thesis. Then build.
