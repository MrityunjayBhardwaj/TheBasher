# Basher — Next Session Prompt (P2.1: Resume from Wave C)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P2.1 (Viewport Polish + Menu Bar)**. P0+P1+P2 + viewport-polish are merged. P2.1 Waves A + B already shipped on PR #4 in commit `5e4b1cf`. Resume from Wave C.

P2.1 closes Blender table-stakes gaps so Basher feels like a real DCC tool. **Do not regress thesis invariants** — V1 (Op-only mutation), V2/V3 (purity, time-as-socket), V8 (file-rooted viewport boundary), V9 (materials = data) all still bind.

Your job: ship Waves C + D + E (and the menu bar), open a draft PR if not on the existing one, run goal-backward self-review, fold top fixes inline, and stop.

## What's already true after Waves A + B (commit `5e4b1cf`, 2026-05-06)

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/`
2. **Repo:** `git@github.com:MrityunjayBhardwaj/TheBasher.git`. Default branch `main`. Branch you'll work on: `feat/p2-character-and-move` (PR #4 — open). All P2 + viewport-polish + Waves A+B sit on this branch.
3. **Source of truth:** `THESIS.md`. P2.1 introduces no new thesis commitments.
4. **Catalogues:** `.anvi/{dharana,hetvabhasa,vyapti,krama}.md`. H1-H12, V1/V2/V3/V4/V5/V6/V8/V9 ALIGNED, V7 NOT YET (P2.5). K1-K8 cataloged.
5. **Memory:** auto-loads at session start. `project_p2_shipped.md` has the post-P2 inventory.
6. **Dev port:** 5180 (strictPort).
7. **Quality gates:** at end of A+B — 137 vitest, 22 Playwright, typecheck/lint/format/license-audit all green.

### Wave A shipped (selection model refactor)

`src/app/stores/selectionStore.ts` extended:
- `selectedNodeIds: ReadonlySet<NodeId>` — the multi-set
- `primaryNodeId: NodeId | null` — most-recent; gizmo binds here
- `selectedNodeId: NodeId | null` — DEPRECATED mirror of `primaryNodeId`, kept so P0/P1/P2 callers don't break
- API: `select / selectAdditive / selectMany / clear / selectAll / invert`

Inspector + Gizmo already updated to read `primaryNodeId`. NodeList + SceneTree still use the deprecated single-id mirror — extending those to shift-click / box-select is part of Wave C if you want to.

### Wave B shipped (click-to-pick + grid + keyboard shortcuts)

- `src/viewport/SceneFromDAG.tsx` — each top-level scene child wraps in a `<group onClick>` that walks back to the producer nodeId via Scene aggregator's `inputs.children[i]`. Click selects; shift-click adds. **selectionStore writes only — V1 stays clean.**
- `src/viewport/Viewport.tsx` — drei `<Grid />` (cell+section Blender-style floor) + `<Canvas onPointerMissed>` clears selection.
- `src/app/Gizmo.tsx` — `gizmoStore.mode: 'translate' | 'rotate' | 'scale'`. Gizmo dispatches setParam to position/rotation/scale paramPath. Character is locked to `translate`.
- `src/app/KeyboardShortcuts.tsx` (NEW) — global window-level handler. G/R/S, Esc, Cmd+Z, Cmd+Shift+Z (or Cmd+Y) for redo, Cmd+S, Cmd+A, **Cmd+Shift+C** for camera-from-view. Skips when inputs are focused.
- `src/app/character/cameraFromView.ts` (NEW) — macro that snapshots the editor's OrbitControls pose into a new PerspectiveCamera node + reroutes scene.camera. Atomic.
- `src/app/character/{threeRef.ts, ThreeBridge.tsx}` (NEW) — UI-projection store + bridge that pushes the active camera + controls target into the store every frame so out-of-Canvas code can read them without useThree().
- `src/app/App.tsx` — mounts `<KeyboardShortcuts />` alongside `<Clock />`.

## Read order (do this before any code)

1. `THESIS.md` §11 (viewport), §12 (scene tree), §15 (right rail), §17 (mode hierarchy), §50 (Op system).
2. `.anvi/dharana.md` — boundaries B1-B5, post-P2 fatality test result.
3. `.anvi/hetvabhasa.md` — H11 (data-testid on R3F), H12 (camera-snap-back) are recent and critical.
4. `.anvi/krama.md` — K2 (op dispatch), K7 (walkTo), K8 (boot-with-last-project).
5. `src/app/Gizmo.tsx` — current Transform + Character + mode wiring.
6. `src/app/Inspector.tsx` — your XYZ inputs target for Wave C drag-scrub.
7. `src/app/KeyboardShortcuts.tsx` — extend with menu-bar shortcuts in Wave D.
8. `src/app/character/cameraFromView.ts` — already wired to Cmd+Shift+C; extend to a menu item in Wave D.
9. `src/app/{Layout,Chrome}.tsx` — where the menu bar mounts.

## Locked decisions (do NOT relitigate)

- Op system is the only mutation path; UI projections (selection, gizmo, time, mode) live in their own zustand stores.
- `<GroundClick />` mounts only when a Character exists.
- `data-testid` is FORBIDDEN on R3F primitives (`<mesh>`, `<group>`, etc.) — H11. Use `userData`; tests drive through `__basher_dag` / `__basher_evaluate`.
- Camera position must NOT use the `position` prop on drei's `<PerspectiveCamera>` — H12. Use a ref + `useEffect` keyed on primitive scalars.
- IndexedDB is the universal fallback after OPFS — pickStorage chain stays OPFS → IDB → Memory.
- Last-open project id persists in `localStorage['basher.lastProjectId']` (K8).
- selectionStore exposes `primaryNodeId` as the canonical "what's the gizmo bound to" + `selectedNodeIds` as the multi-set. Don't go back to a single-id model.

## Wave C — Inspector drag-scrub + N-panel overlay + pivot/snap toggles

Files to add:
- `src/app/stores/viewportStore.ts` — pivot + snapStep + gridVisible + axisWidgetVisible + snap()/snapVec3() helpers.
- `src/app/NPanel.tsx` — semi-transparent overlay top-right of viewport. Reads primary node + transform, shows quick toggles (mode buttons, snap-step input, grid/axis toggles).
- `src/app/Inspector.tsx` — extend NumericField + VectorField with drag-scrub on the LABEL (not the input itself — Blender-style). Click+drag horizontally → preview in local state, commit setParam Op on pointer-up. Shift = fine (0.001), Cmd/Ctrl = coarse (0.1), default 0.01 per pixel.
- `src/viewport/Viewport.tsx` — wrap Grid + GizmoHelper in `<FloorGrid />` and `<AxisWidget />` that read `viewportStore.gridVisible / axisWidgetVisible`. Mount `<NPanel />` outside the Canvas (it's HTML, not R3F).
- Apply snap in `src/app/Gizmo.tsx` translate path AND in `src/app/character/GroundClick.tsx` worldPoint.

Pivot point selector — defer to Wave C polish OR cut from P2.1 if budget bites. Multi-select isn't yet exercised so pivot has no observable effect today.

## Wave D — Menu bar (File / Edit / Select / View)

Build a Blender-style menu bar across the top of the page **above** the existing `<Chrome />` header. Native `<details><summary>` popovers OR a small custom popover component (your call — drei doesn't ship one).

### File menu
- New Project (prompt for name, calls `createNewProject`)
- Open… (opens ProjectsMenu's panel — or absorb ProjectsMenu into File entirely; pick whichever is cleaner)
- Duplicate Current
- Rename Current
- Delete Current (with confirm)
- Save (Cmd+S)
- Export Scene as glTF (stub OK if blocking)
- Export DAG as JSON (download the project JSON via Blob — easy)

### Edit menu
- Undo (Cmd+Z)
- Redo (Cmd+Shift+Z)
- Reset to Default Scene
- Settings (stub)

### Select menu
- All (Cmd+A)
- None (Esc)
- Invert
- By Type → submenu of distinct node types in the current DAG, each one selectMany on those ids

### View menu
- Frame Selected (F) — set OrbitControls target to primary node's evaluated position
- Frame All (Home)
- **Camera-from-View (Cmd+Shift+C)** — already wired in `cameraFromView.ts`
- Toggle Grid
- Toggle Axis Widget
- Set Mode → Simple / Director / Pro (mirrors ModeSwitcher, can absorb it)

Keyboard shortcuts in the menu bar:
- Hotkeys MUST work whether the menu is open or not (already true for Cmd+Z/S/A/Shift+C).
- Add F + Home in `KeyboardShortcuts.tsx`. F/Home need access to `useThreeRef.getState().camera + controlsTarget` AND a way to fit the camera — drei's OrbitControls doesn't ship `.fit()`; either compute manually (camera.position = target + offset where offset preserves direction; OrbitControls.target = node position) OR swap to `<CameraControls />` which has `.fit()`. Pick the simpler path.

Cmd+S in browsers triggers the native save dialog — already preventDefault'd. Same pattern for any new shortcut that conflicts.

## Wave E — Tests + Catalogue + Close

- Vitest:
  - selectionStore multi-select toggling, selectAll, invert.
  - dragScrub math (sensitivity scaling per modifier).
  - cameraFromView macro shape.
  - viewportStore snap helpers.
- Playwright:
  - Click-to-select fires selectionStore.
  - Cmd+Z reverts the last Op.
  - Cmd+Shift+C bakes a new PerspectiveCamera node + reroutes scene.camera.
  - Menu bar opens + every action fires (or stub gracefully).
- Catalogue updates:
  - K9 (camera-from-view chain) — add to krama.md if not yet there.
  - Any new hetvabhasa from the round (e.g. browser keyboard collisions, focus-trap surprises).
  - Bump dharana.md provenance entry.
- README + CHANGELOG entries.
- Open or extend the existing PR #4 (it's still the same branch). Run goal-backward self-review; fold 🔴 fixes inline.

## Honesty Contract (do NOT violate)

- **Never** put `data-testid` on R3F primitive elements (H11). Use `userData`.
- **Never** apply `position={...}` as a prop to drei's `<PerspectiveCamera>` (H12). Use ref + useEffect on primitive scalars.
- **Never** dispatch from a file inside `src/viewport/` (V8 file-rooted). Use a component imported from `src/app/`.
- **Never** mutate the DAG store outside the Op dispatcher (V1) — `hydrate()` is the only legal exception (project load).
- **Never** read `useFrame`, `useThree`, `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID` inside `src/nodes/**` evaluators (V2/V3 lint).
- **Never** ship without running goal-backward self-review (CLAUDE.md AnviDev §5).
- **Always** preserve the file-rooted V8 boundary: any new component that dispatches lives in `src/app/`.
- **Always** wrap multi-Op user actions in `dispatchAtomic` (one Cmd+Z = one user action).
- **Always** verify quality gates before commit; per-wave atomic commits with gitmoji + Problem/Fix bodies; no AI co-author.

## Decision Defaults (when thesis is silent)

- DragScrubInput: **commit on release** (pointer-up). Live preview via local state. One drag = one undo entry.
- Multi-select pivot rule: **median by default** (when implemented). v0.5 ships median-only; settings add others later.
- Menu bar styling: **monospace, low-saturation, follows existing chrome aesthetic**. No icons in v0.5.
- Frame Selected (F): manual fit (target + offset). If complex, swap to `<CameraControls />` from drei — its `.fit()` solves it. Verify the swap doesn't break existing OrbitControls mouse map.
- Snap: applies to translation only (rotation + scale are continuous-by-default in v0.5).

## Hard-Stop Triggers (escalate to user)

- Selection model issues that bite more than 5 existing tests after Wave C.
- `<CameraControls />` swap breaks existing acceptance tests.
- Native browser keyboard shortcut conflicts you can't `preventDefault` cleanly (e.g. Cmd+Q on macOS).
- License violation discovered (any new dep must pass `license-audit`).
- Need to amend THESIS.md.

## Kill Phrase

If you ever see the user message **"stop, rethink"** — freeze immediately. Do not commit. Do not push. Output: (1) what you were about to do, (2) what's already committed, (3) what's uncommitted/stage-revertable, (4) wait.

## When P2.1 Is Done

1. All 🔴 (1-4 from the audit: click-to-select ✓, grid ✓, keyboard shortcuts ✓ done in A+B; drag-scrub still TODO in C).
2. All 🟡 (pivot, snap, multi-select wiring, N-panel, camera-from-view).
3. Menu bar (File/Edit/Select/View) shipped with keyboard shortcuts.
4. Goal-backward self-review run; 🔴 fixes folded inline.
5. Mark PR #4 ready (it may already be ready).
6. End-of-phase summary in conversation:
   - What shipped (mapped to audit items).
   - What cut (deferred).
   - What surprised.
   - Risk register updates.
   - Confidence for P2.5.
7. Update `NEXT_SESSION.md` for P2.5 (AI Agent on the DAG).
8. **STOP.**

---

**Begin.** Read the catalogues. Then build.
