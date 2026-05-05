# Basher — Next Session Prompt (P2.1: Viewport Polish + Menu Bar)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P2.1 (Viewport Polish + Menu Bar)**. P0+P1+P2 are merged; the P2 branch (`feat/p2-character-and-move`, PR #4) added time-as-socket plumbing, character chain, click-to-move macro, multi-project picker, IndexedDB storage, OrbitControls + axis widget. The user tested it and ran a Blender-table-stakes audit — five 🔴 + four 🟡 gaps fall out as P2.1 scope.

P2.1 closes the table-stakes gap so Basher feels like a real DCC tool. **Do not regress thesis invariants** — V1 (Op-only mutation), V2/V3 (purity, time-as-socket), V8 (file-rooted viewport boundary), V9 (materials = data) all still bind.

Your job: ship P2.1 to acceptance, open a draft PR, run goal-backward self-review, fold top fixes inline, and stop.

## What's already true after P2 + viewport-polish round (2026-05-06)

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/`
2. **Repo:** `git@github.com:MrityunjayBhardwaj/TheBasher.git`. Default branch `main`. Branch off `main` (P2 PR #4 may or may not be merged when you start — check `gh pr view 4`; if open, base your branch off `main` not `feat/p2-character-and-move`).
3. **Source of truth:** `THESIS.md`. P2.1 is below P2 in the cut list — these are quality-of-life features that don't introduce new thesis commitments. NO changes to THESIS.md unless you discover an architectural gap.
4. **Catalogues:** `.anvi/{dharana,hetvabhasa,vyapti,krama}.md`. H1-H12, V1/V2/V3/V4/V5/V6/V8/V9 ALIGNED, V7 NOT YET (P2.5). K1-K8 cataloged.
5. **Memory:** auto-loads at session start. `project_p2_shipped.md` has the post-P2 inventory.
6. **Dev port:** 5180 (strictPort).
7. **Quality gates locally:** `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run license-audit && npm run format:check` all green at end of P2 viewport-polish round (137 vitest, 22 Playwright). Re-run before starting P2.1.

## Read order (do this before any code)

1. `THESIS.md` §11 (viewport), §12 (scene tree), §15 (chat drawer — context only), §17 (mode hierarchy), §50 (Op system).
2. `.anvi/dharana.md` — boundaries B1-B5, post-P2 fatality test result.
3. `.anvi/vyapti.md` — V1, V8 are the ones P2.1 must not violate.
4. `.anvi/hetvabhasa.md` — H11, H12 are recent and relevant (R3F primitives + camera-snap-back).
5. `.anvi/krama.md` — K2 (op dispatch), K7 (walkTo), K8 (boot-with-last-project).
6. `src/app/Gizmo.tsx` — current TransformControls integration (Transform + Character).
7. `src/app/stores/{selectionStore,gizmoStore,modeStore,timeStore}.ts` — all the UI projections.
8. `src/viewport/Viewport.tsx` + `SceneFromDAG.tsx` — V8 enforcement surface.
9. `src/app/Inspector.tsx` — XYZ inputs you'll be extending with drag-scrub.
10. `src/app/character/walkTo.ts` — the macro pattern you'll mirror for camera-from-view.

## Locked decisions (do NOT relitigate)

- Op system is the only mutation path; UI projections (selection, gizmo, time, mode) live in their own zustand stores.
- `<GroundClick />` mounts only when a Character exists — keeps default-project pixel baseline bit-exact.
- TransformControls binds to Transform AND Character; OrbitControls is suppressed while gizmo is dragging via `gizmoStore.dragging`.
- `data-testid` is FORBIDDEN on R3F primitives (`<mesh>`, `<group>`, etc.) — H11. Use `userData` if needed; tests drive through `__basher_dag` / `__basher_evaluate`.
- Camera position must NOT use the `position` prop on drei's `<PerspectiveCamera>` — H12. Use a ref + `useEffect` keyed on primitive scalars.
- IndexedDB is the universal fallback after OPFS — pickStorage chain stays OPFS → IDB → Memory.
- Last-open project id persists in `localStorage['basher.lastProjectId']` (K8). Switch flow auto-saves outgoing first.

## P2.1 Scope — verbatim from the audit

### 🔴 Critical (blocks usability — must ship in P2.1)

1. **Click-to-select objects in viewport** (raycast pick). Click a mesh → `selectionStore.select(nodeId)`. Click empty ground → `select(null)`. Multi-select: shift-click adds to selection. The current selectionStore has `selectedNodeId: NodeId | null` — extend to `selectedNodeIds: Set<NodeId>` (or `NodeId[]`) and provide a primary getter for backward compatibility with the gizmo.
2. **Background grid + ground plane.** Drei ships `<Grid />`. Mount in Viewport.tsx alongside the OrbitControls. Default extent matches navmesh half-size (10×10), large enough to feel like a world floor.
3. **Keyboard transform shortcuts.** G/R/S → switch gizmo mode (translate/rotate/scale). X/Y/Z while dragging → axis-lock. Esc during drag → cancel and revert. The gizmo currently only supports translate; extend to rotate + scale modes via `<TransformControls mode="translate|rotate|scale">`. Mode is per-session (not in the DAG).
4. **Numeric drag-scrub on Inspector XYZ inputs.** Click+drag horizontally on a number field → nudge the value (Blender-style). Shift = fine, Ctrl = coarse. Existing Inspector inputs are controlled — extend with a `<DragScrubInput value={...} onChange={...} />` component.

### 🟡 Strong UX gap (ship in P2.1)

5. **Pivot point selector.** Median / Individual Origins / 3D Cursor / Active. UI: dropdown or pie menu in viewport overlay. Affects the Gizmo's mounting position when multiple nodes are selected.
6. **Snap toggles.** Grid increment + axis-aligned vertex snap. UI: a toggle in the viewport overlay. Implementation: `Math.round(value / step) * step` applied at the gizmo's setParam emit + at click-to-move's `worldPoint`.
7. **Multi-select.** Shift-click in NodeList; box-select (drag-rectangle) in viewport. Extend `selectionStore`. Gizmo position becomes the median (or per-pivot rule).
8. **N-panel viewport overlay.** Top-right of the viewport, semi-transparent: shows active object name, transform XYZ, vertex count if applicable. Read-only first cut; editable in P3.
9. **Camera-from-view** (thesis-aligned). One-click "snapshot OrbitControls pose into a new PerspectiveCamera node and set it as `outputs.scene.camera`". Lives in the View menu. Lets the director frame a shot via OrbitControls then bake it into the DAG — the killer feature of director-first.

### Menu bar (top of layout)

A Blender-style menu bar across the top of the page above the existing Chrome:

- **File**: New Project, Open (project picker, replaces ProjectsMenu's main path), Duplicate, Rename, Delete Current, Save (Cmd+S), Export Scene as glTF (stub OK if blocking), Export DAG as JSON (stub OK).
- **Edit**: Undo (Cmd+Z), Redo (Cmd+Shift+Z), Reset Project to Default, Settings (stub).
- **Select**: All (Cmd+A), None (Esc), Invert, By Type → submenu of node types.
- **View**: Frame Selected (F), Frame All (Home), Camera-from-View (Ctrl+Shift+C), Toggle Grid, Toggle Axis Widget, Set Mode (Simple / Director / Pro).

UI: native `<details><summary>` popovers OR a small custom menu component. Keyboard shortcuts MUST work even when no menu is open. Shortcuts that conflict with browser defaults (Cmd+S triggers browser save) → preventDefault inside the handler.

## Execution Protocol

### Wave A — Selection model refactor (UNBLOCKS everything else)

- `selectionStore`: change `selectedNodeId: NodeId | null` → `selectedNodeIds: Set<NodeId>` + `primaryNodeId: NodeId | null` (the most-recently-selected, used by the gizmo).
- Update every reader (Gizmo, GroundClick, NodeList, Inspector, SceneTree). Add a `primaryNodeId` selector for places that conceptually want one id.
- `select(id)` → replace; `selectAdditive(id)` → toggle in set; `clear()` → empty.

### Wave B — Click-to-select via raycast pick + background grid + axis lock keys

- Click any mesh inside the Canvas → walk up the React tree to find the producing nodeId. Approach: each MeshChild registers its nodeId in a context, raycast hit → context gives nodeId. OR: emit an `onClick` handler at every MeshChild that calls `useSelectionStore.select(nodeId)`. Skip GroundClick.
- Empty-canvas click → clear selection.
- Background `<Grid />` from drei. Subtle styling (low contrast, fades at distance).
- Keyboard shortcuts via a top-level `<KeyboardShortcuts />` component mounted in App.tsx. G/R/S/X/Y/Z/Esc/F/Cmd+Z/Cmd+Shift+Z/Cmd+S/Cmd+A.

### Wave C — Inspector drag-scrub + N-panel + pivot/snap toggles

- `<DragScrubInput />` reusable component: pointer-down → start drag, deltaX → value delta scaled by sensitivity (0.01 default, 0.001 with Shift, 0.1 with Ctrl). Pointer-up commits the final value via `setParam` Op. (Per-frame setParam during drag = many undo entries — wrap in an atomic group or debounce; pick the simpler path that preserves undo semantics.)
- `<NPanel />` overlay: position absolute top-right inside Viewport.tsx slot. Read primaryNode + its evaluated value. No mutation.
- `pivotStore` + `snapStore`. Toggles in the N-panel.

### Wave D — Camera-from-view + Menu bar

- Camera-from-view: read OrbitControls' camera position + target. Emit `addNode(PerspectiveCamera, {position, lookAt: target, fov: same})` + `connect → scene.camera` + `disconnect` previous if any. dispatchAtomic. Pure macro pattern (mirror of walkTo).
- `<MenuBar />` at the top of the layout, ABOVE Chrome. Native `<details>` or custom popover. Keyboard shortcuts. Cmd+S preventDefault. File/Edit/Select/View per spec above.

### Wave E — Tests + Catalogue + close

- Vitest: selectionStore multi-select, dragScrub math, camera-from-view macro shape.
- Playwright: click-to-select, keyboard shortcut undo, menu bar opens + actions fire, camera-from-view bakes a new PerspectiveCamera node.
- New hetvabhasa entries IF any patterns emerge (e.g. native browser keyboard collisions).
- New krama entry IF a new lifecycle is introduced (camera-from-view chain probably qualifies — K9).
- README + CHANGELOG entries.
- Open draft PR; goal-backward self-review; fold 🔴 fixes inline before marking ready.

## Honesty Contract (do NOT violate)

- **Never** put `data-testid` on R3F primitive elements (H11). Use `userData`.
- **Never** apply `position={...}` as a prop to drei's `<PerspectiveCamera>` (H12). Use ref + useEffect on primitive scalars.
- **Never** dispatch from a file inside `src/viewport/` (V8 file-rooted).
- **Never** mutate the DAG store outside the Op dispatcher (V1) — `hydrate()` is the only legal exception, used only for project load.
- **Never** read `useFrame`, `useThree`, `Math.random`, `Date.now`, `performance.now`, `crypto.randomUUID` inside `src/nodes/**` evaluators (V2/V3 lint).
- **Never** ship without running goal-backward self-review (CLAUDE.md AnviDev §5).
- **Always** preserve the file-rooted V8 boundary: any new component that dispatches lives in `src/app/`, even if it renders inside the Canvas.
- **Always** wrap multi-Op user actions in `dispatchAtomic` (one Cmd+Z = one user action).
- **Always** verify quality gates before commit; per-wave atomic commits with gitmoji + Problem/Fix bodies; no AI co-author.

## Decision Defaults (when thesis is silent)

- DragScrubInput per-frame setParam vs commit-on-release: **commit on release**. Cleaner undo. Show live preview by setting CSS `--preview-value` and applying to the input visually; only emit the Op on pointer-up.
- Multi-select pivot rule: **median by default**, settings panel can switch to individual-origins later.
- Camera-from-view fov: **inherit from OrbitControls' active camera** so the bake matches what the director sees.
- Menu bar styling: **monospace, low-saturation, follows existing chrome aesthetic**. No icons in v0.5.
- Keyboard shortcut conflicts: **preventDefault explicitly per shortcut**, don't add a global capture.

## Hard-Stop Triggers (escalate to user)

- Selection model refactor breaks more than 5 existing tests after Wave A — the `Set` shape may bite zustand's shallow equality. Pause + ask before brute-forcing.
- Click-to-select in the canvas conflicts with the existing GroundClick in unexpected ways (e.g. event order, propagation).
- Native browser keyboard shortcut conflicts you can't `preventDefault` cleanly (e.g. Cmd+Q on macOS).
- License violation discovered (any new dep must pass `license-audit`).
- Need to amend THESIS.md (escalate; this is QoL, not new thesis commitment).

## Kill Phrase

If you ever see the user message **"stop, rethink"** — freeze immediately. Do not commit. Do not push. Output: (1) what you were about to do, (2) what's already committed, (3) what's uncommitted/stage-revertable, (4) wait.

## When P2.1 Is Done

1. All 🔴 (1-4) shipped + verified locally.
2. All 🟡 (5-9) shipped + verified locally.
3. Menu bar (File/Edit/Select/View) shipped with keyboard shortcuts working.
4. Goal-backward self-review run; 🔴 fixes folded inline.
5. Draft PR opened, marked Ready after self-review pass.
6. End-of-phase summary in conversation:
   - What shipped (mapped to audit items + thesis sections).
   - What cut from P2.1 scope (deferred with justification).
   - What surprised (anything that took >1.5x estimate or revealed a thesis gap).
   - Risk register updates (new B<N> boundaries observed).
   - Confidence for P2.5 (high/med/low and why).
7. Update `NEXT_SESSION.md` for P2.5 (AI Agent on the DAG).
8. **STOP.** Do not start P2.5.

---

**Begin.** Read the thesis. Then build.
