# Basher — Next Session Prompt (P2.5: AI Agent on the DAG)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P2.5 (AI Agent on the DAG)**. P0+P1+P2+P2.1 are merged. Your job: ship P2.5 — the agent edits the DAG via the SAME Op surface as the human user. **Do not regress thesis invariants** — V1 (Op-only mutation) plus the new V7 (agent tools return `Op[]`) are the load-bearing contracts.

P2.5 is the first time `B3: Agent ↔ DAG` is exercised. Expect new clustering at that boundary. Catalogue everything.

## What's already true after P2.1 (PR #4 merged or open, 2026-05-06)

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/`
2. **Repo:** `git@github.com:MrityunjayBhardwaj/TheBasher.git`. Default branch `main`.
3. **Source of truth:** `THESIS.md` §18-20 (agent surface), §50 (Op system).
4. **Catalogues:** `.anvi/{dharana,hetvabhasa,vyapti,krama}.md`. H1-H13, V1/V2/V3/V4/V5/V6/V8/V9 ALIGNED, V7 NOT YET (P2.5 enforces it). K1-K9 cataloged.
5. **Memory:** `project_p2_shipped.md` + `project_p21_shipped.md` (write the latter if absent — capture the inventory).
6. **Dev port:** 5180 (strictPort).
7. **Quality gates:** at end of P2.1 — 161 vitest, 27 Playwright, typecheck/lint/format/license-audit all green. Linux pixel-diff baseline regenerates on first CI run after P2.1 merges (H8 / H13 pattern).

### P2.1 shipped (recap)

- **Selection multi-set + click-to-pick + grid + keyboard shortcuts** (Wave A+B, commit `5e4b1cf`).
- **Inspector drag-scrub** on labels — one drag = one Op (Wave C, `src/app/dragScrub.ts`).
- **NPanel overlay** — gizmo mode + snap + grid/axis toggles + primary summary (Wave C, `src/app/NPanel.tsx`).
- **viewportStore** UI projection — pivot/snap/visibility (Wave C, `src/app/stores/viewportStore.ts`). `maybeSnapVec3` honored by Gizmo translate + GroundClick.
- **MenuBar** — File / Edit / Select / View; hotkeys mirror items and work whether menu is open or closed (Wave D, `src/app/MenuBar.tsx`).
- **Frame Selected / Frame All** — F / Home keyboard + View menu (Wave D, `src/app/character/framing.ts`).
- **Camera-from-View** — Cmd+Shift+C / View menu → atomic 3-op chain (cataloged as **K9**, `src/app/character/cameraFromView.ts`).

## Read order (do this before any code)

1. `THESIS.md` §18 (agent is a privileged user), §19 (Diff-first protocol), §20 (tool surface), §50 (Op system).
2. `.anvi/dharana.md` — boundary B3 + V7 NOT YET.
3. `.anvi/hetvabhasa.md` — H5 (zod default widening), H10 (zustand snapshot stale), H4 (Uint8Array typing) — likely repeat offenders for tool-handler boundaries.
4. `.anvi/krama.md` — K2 (Op dispatch lifecycle), K3 (Diff lifecycle — currently theoretical, P2.5 makes it concrete).
5. `src/core/dag/store.ts` — `dispatchAtomic`, `undo`, `redo` shapes the agent will reuse.
6. `src/core/dag/ops.ts` — five Op primitives + zod schemas; tool handlers must produce these shapes only.
7. `src/app/character/walkTo.ts` + `src/app/character/cameraFromView.ts` — the human-side macros that prove the same `Op[]` shape works for the agent path.
8. RubicsWorld donor (`/Users/mrityunjaybhardwaj/Documents/projects/RubicsWorld`) — agent integration patterns, if relevant.

## Locked decisions (do NOT relitigate)

- **Op system is the only mutation path (V1).** Agent tools return `Op[]`; never `setState`.
- **Diff-first (THESIS.md §19).** Ops apply to a FORKED DAG; user accepts → ops flow through real dispatcher.
- **Agent gets ONE undo entry per accepted diff.** Use `dispatchAtomic` with description `Agent: <description>`.
- **Tool args validated with zod at the boundary.** Same H5 lesson: input may be wider than output (`z.ZodType<P, _, unknown>`).
- **No DOM polyfills inside tool handlers.** Tools run in browser; the current Anthropic SDK shape works (web-fetch + token stream).
- **No new B-boundary; B3 is already cataloged.** Just flip its Status from "not exercised" to "exercised" once tools land.

## Wave plan (suggested)

Read `dharana.md` lens configuration FIRST. Then:

### Wave A — Tool registry + zod-validated handlers

- `src/agent/tools/types.ts` — `ToolDefinition` interface: `{ name, description, paramSchema, handler: (args) => Op[] | Promise<Op[]> }`.
- `src/agent/tools/registry.ts` — `registerTool` + `getTool` + `listTools`.
- First tools (mirror existing macros for parity proof):
  - `character.walkTo` — same `Op[]` as `buildWalkToOps`.
  - `camera.snapshot` — same `Op[]` as `snapshotCameraFromOrbit`.
  - `library.import` — same chain as `buildAssetDropOps` (K6).
- Each tool ships with a Vitest twice-call test asserting deterministic output.

### Wave B — Diff system (forked DAG + accept/reject)

- `src/agent/diff/forkedDag.ts` — clone the DAG, apply `Op[]` to the fork, return the fork + the inverse list.
- `src/agent/diff/store.ts` — `useDiffStore` UI projection (pending diff, per-op selection, accepted/rejected state).
- Viewport overlay: ghost render of the forked scene alongside the real one (semi-transparent, dotted outlines).
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
- **Never** dispatch from a file inside `src/viewport/` (V8 file-rooted). Use a component imported from `src/app/`.
- **Never** read `useFrame`, `useThree`, `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID` inside `src/nodes/**` evaluators (V2/V3 lint).
- **Never** ship without running goal-backward self-review (CLAUDE.md AnviDev §5).
- **Always** wrap an accepted diff in `dispatchAtomic` so one Cmd+Z = one agent action.
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

1. Tool registry + 3 first tools shipped (`character.walkTo`, `camera.snapshot`, `library.import`).
2. Diff system (forked DAG, accept/reject, ghost overlay) integrated.
3. Streaming agent turn produces a diff and a single undo entry on accept.
4. V7 ALIGNED; K3 cataloged with REFs.
5. Goal-backward self-review run; 🔴 fixes folded inline.
6. End-of-phase summary in conversation.
7. Update `NEXT_SESSION.md` for P3 (Timeline = animation nodes).
8. **STOP.**

---

**Begin.** Read the catalogues. Then build.
