# Basher — Next Session Prompt (P2.5: AI Agent on the DAG)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P2.5 (AI Agent on the DAG)**. P0+P1+P2+P2.1+P2.6 (with .1/.2/.3 hotfixes) are merged or in PR. Your job: ship P2.5 — the agent edits the DAG via the SAME Op surface as the human user. **Do not regress thesis invariants** — V1 (Op-only mutation) plus the new V7 (agent tools return `Op[]`) are the load-bearing contracts.

P2.5 is the first time `B3: Agent ↔ DAG` is exercised. Expect new clustering at that boundary. Catalogue everything.

## What's already true after the P2.6.x train (PR `feat/p2.6-editor-polish` at `447c3b1`, 2026-05-06)

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/`
2. **Repo:** `git@github.com:MrityunjayBhardwaj/TheBasher.git`. Default branch `main`. PR open: `feat/p2.6-editor-polish` (P2.6 + .1 + .2 + .3).
3. **Source of truth:** `THESIS.md` §18-20 (agent surface), §50 (Op system).
4. **Catalogues:** `.anvi/{dharana,hetvabhasa,vyapti,krama}.md`. **H1-H15** (newest: H14 hydrate-seam, H15 ref-as-state for conditional R3F renders). V1/V2/V3/V4/V5/V6/V8/V9 ALIGNED, V7 NOT YET (P2.5 enforces it). K1-K9 cataloged.
5. **Memory:** `project_p2_shipped.md` + `project_p21_shipped.md` + `project_p26_shipped.md` cover the ground state.
6. **Dev port:** 5180 (strictPort).
7. **Quality gates:** 199 vitest, 39 Playwright, typecheck/lint/format/license-audit all green.
8. **25 node types** registered (BoxMesh + SphereMesh + 5 lights + 2 cameras + Group + Transform + MaterialOverride + Scatter + 7 P2 character chain + 2 aggregators).

### P2.6.x shipped (recap)

- **TransformToolbar** above Chrome — Move/Rotate/Scale + Snap + Studio/Wire/Rendered shading + 3D/UV space.
- **Editor shading projection** — `viewportStore.shading: 'studio' | 'wireframe' | 'rendered'`. Studio adds editor-only fill rig (must NOT leak into render — boundary B6). Wireframe flips `wireframe` on every material + traverses cloned glTF scenes.
- **UV Editor** read-only space — equirectangular grid for SphereMesh, canonical cross unfold for BoxMesh. Tab toggles 3D ↔ UV.
- **Add menu** — right-click in viewport / Shift+A / MenuBar Add. Categories: Mesh (Cube, UV Sphere), Light (Sun/Point/Spot/Area/Ambient), Camera (Persp/Ortho), Empty (Group/Transform). One pick = one atomic Op chain. Auto-selects new node.
- **SphereMesh node type** — pure, parallels BoxMesh.
- **Light rotation + selection + direction-aware ring** — every positional light has `rotation: vec3` default [0,0,0]. Helpers gain `pickId` + onClick. DirectionalLight ring's quaternion rotates +Z → direction; legacy fallback to `-position` when rotation is zero.
- **H14 hotfix:** evaluator-level defensive defaults on every positional-light evaluator (`params.rotation ?? [0,0,0]`) — hydrate seam bypasses zod's default-fill, so projects saved before the field existed crash without this guard.
- **H15 hotfix:** Gizmo's proxy `<group>` ref lifted to `useState<THREE.Group | null>` + callback ref so TransformControls remounts on every select → deselect → reselect cycle.

## Read order (do this before any code)

1. `THESIS.md` §18 (agent is a privileged user), §19 (Diff-first protocol), §20 (tool surface), §50 (Op system).
2. `.anvi/dharana.md` — boundary B3 + V7 NOT YET. Read the post-P2.6.x provenance entry.
3. `.anvi/hetvabhasa.md` — H5 (zod default widening), H10 (zustand snapshot stale), H14 (hydrate seam). H14 is the most relevant — it's a sister problem to the agent's tool boundary (any new field must be defensive).
4. `.anvi/krama.md` — K2 (Op dispatch lifecycle), K3 (Diff lifecycle — currently theoretical, P2.5 makes it concrete).
5. `src/core/dag/store.ts` — `dispatchAtomic`, `undo`, `redo` shapes the agent will reuse.
6. `src/core/dag/ops.ts` — five Op primitives + zod schemas; tool handlers must produce these shapes only.
7. `src/app/character/walkTo.ts` + `src/app/character/cameraFromView.ts` + `src/app/addPrimitives.ts` — the human-side macros that prove the same `Op[]` shape works for the agent path.
8. RubicsWorld donor (`/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`) — agent integration patterns, if relevant.

## Locked decisions (do NOT relitigate)

- **Op system is the only mutation path (V1).** Agent tools return `Op[]`; never `setState`.
- **Diff-first (THESIS.md §19).** Ops apply to a FORKED DAG; user accepts → ops flow through real dispatcher.
- **Agent gets ONE undo entry per accepted diff.** Use `dispatchAtomic` with description `Agent: <description>`.
- **Tool args validated with zod at the boundary.** H5 lesson: input may be wider than output (`z.ZodType<P, _, unknown>`).
- **Defensive defaults at evaluator level (H14).** Any new schema field added during P2.5 (agent params, tool args, etc.) must default at the evaluator until hydrate-time re-validation lands.
- **Conditional R3F renders gating on a value (H15) must use useState, not useRef.** The Diff overlay's ghost geometry will likely have similar mount/remount cycles — apply the lesson.
- **No DOM polyfills inside tool handlers.** Tools run in browser; the current Anthropic SDK shape works (web-fetch + token stream).
- **No new B-boundary; B3 is already cataloged.** Just flip its Status from "not exercised" to "exercised" once tools land.

## Wave plan (suggested)

### Wave A — Tool registry + zod-validated handlers

- `src/agent/tools/types.ts` — `ToolDefinition` interface: `{ name, description, paramSchema, handler: (args) => Op[] | Promise<Op[]> }`.
- `src/agent/tools/registry.ts` — `registerTool` + `getTool` + `listTools`.
- First tools (mirror existing macros for parity proof):
  - `character.walkTo` — same `Op[]` as `buildWalkToOps`.
  - `camera.snapshot` — same `Op[]` as `snapshotCameraFromOrbit`.
  - `library.import` — same chain as `buildAssetDropOps` (K6).
  - `mesh.add` — wraps `buildAddPrimitiveOps` (P2.6.1).
- Each tool ships with a Vitest twice-call test asserting deterministic output.

### Wave B — Diff system (forked DAG + accept/reject)

- `src/agent/diff/forkedDag.ts` — clone the DAG, apply `Op[]` to the fork, return the fork + the inverse list.
- `src/agent/diff/store.ts` — `useDiffStore` UI projection (pending diff, per-op selection, accepted/rejected state).
- Viewport overlay: ghost render of the forked scene alongside the real one (semi-transparent, dotted outlines). Mount inside SceneFromDAG (V8 file-rooted holds: ghost reads, doesn't dispatch).
- Accept path: feed selected ops through real dispatcher via `dispatchAtomic('Agent: <desc>')` — single undo entry.
- Reject path: discard fork; zero state changes (V1 hard rule).

### Wave C — LLM transport

- Anthropic SDK with `claude-opus-4-7` default; budget profile honored from `.anvi/settings`.
- Streaming text + tool calls via SSE.
- Activity log records `source: 'agent'` for every accepted op (extends K2).

### Wave D — Tests + Catalogue + Close

- Vitest: tool registry shape, forked DAG isolation (mutating fork doesn't touch real store), diff accept/reject undo cardinality.
- Playwright: end-to-end agent turn — text appears, tool call surfaces a diff, accept produces one undo entry, reject leaves state untouched.
- Catalogue:
  - V7 flips to ALIGNED (zod-validated + Op-only return).
  - K3 graduates from theoretical to cataloged with file:line REFs.
  - dharana B3 status update.

## Honesty Contract (do NOT violate)

- **Never** dispatch real Ops from a tool handler. Tool returns `Op[]`; Diff system applies them, user accepts, then real dispatcher takes over.
- **Never** put `data-testid` on R3F primitives (H11). Use `userData`.
- **Never** apply `position={...}` as a prop to drei's `<PerspectiveCamera>` (H12). Use ref + useEffect on primitive scalars.
- **Never** dispatch from a file inside `src/viewport/` (V8 file-rooted). Use a component imported from `src/app/`. Render-only helpers (EditorLights, LightHelpers) belong in `src/viewport/`.
- **Never** read `useFrame`, `useThree`, `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID` inside `src/nodes/**` evaluators (V2/V3 lint).
- **Never** ship without running goal-backward self-review (CLAUDE.md AnviDev §5).
- **Always** wrap an accepted diff in `dispatchAtomic` so one Cmd+Z = one agent action.
- **Always** `?? defaultValue` when destructuring a recently-added schema field at the evaluator + consumer (H14).
- **Always** use `useState<T | null>` + callback ref for conditional R3F renders that depend on the ref's current value (H15).
- **Always** verify quality gates before commit; per-wave atomic commits with gitmoji + Problem/Fix bodies; no AI co-author.

## Decision Defaults (when thesis is silent)

- Tool error → reject with reason; no state changes; show user the error.
- Streaming text → render as an in-progress assistant turn; ops only land when stream completes.
- LLM rate-limit → exponential backoff; surface "rate-limited" in UI.

## Hard-Stop Triggers (escalate to user)

- Any mutation path that bypasses the Op dispatcher.
- Tool handler that returns non-`Op[]` shape (e.g. raw `setState` patches).
- License violation in a new SDK dep (`license-audit`).
- Need to amend THESIS.md.

## Kill Phrase

If you ever see the user message **"stop, rethink"** — freeze immediately. Do not commit. Do not push. Output: (1) what you were about to do, (2) what's already committed, (3) what's uncommitted/stage-revertable, (4) wait.

## When P2.5 Is Done

1. Tool registry + 4 first tools shipped (`character.walkTo`, `camera.snapshot`, `library.import`, `mesh.add`).
2. Diff system (forked DAG, accept/reject, ghost overlay) integrated.
3. Streaming agent turn produces a diff and a single undo entry on accept.
4. V7 ALIGNED; K3 cataloged with REFs.
5. Goal-backward self-review run; 🔴 fixes folded inline.
6. End-of-phase summary in conversation.
7. Update `NEXT_SESSION.md` for P3 (Timeline = animation nodes).
8. **STOP.**

---

**Begin.** Read the catalogues. Then build.
