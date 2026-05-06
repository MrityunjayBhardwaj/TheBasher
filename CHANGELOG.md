# Changelog

All notable changes to Basher are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses semantic-ish versioning during the v0.5 phase plan.

## [0.5.0-p2.1] — 2026-05-06

**P2.1 — Viewport polish + menu bar.** Selection multi-select +
click-to-pick (Wave A+B, already shipped at `5e4b1cf`). Inspector
drag-scrub, NPanel overlay, snap, grid + axis toggles (Wave C).
Blender-style File / Edit / Select / View menu bar with keyboard
shortcuts that work whether or not the menu is open (Wave D). 24 new
vitest specs + 5 new Playwright specs (Wave E).

### Added

- **viewportStore** (`src/app/stores/viewportStore.ts`) — UI projection
  for editor-only behaviors: pivot (median-only in v0.5), snapStep +
  snapEnabled, gridVisible, axisWidgetVisible. `snap` / `snapVec3` /
  `maybeSnapVec3` helpers. Snap applies to translation only.
- **NPanel** (`src/app/NPanel.tsx`) — Blender-style top-right overlay:
  gizmo mode buttons, snap controls, grid + axis-widget toggles,
  primary-selection summary. HTML, not R3F (lives outside the Canvas).
- **Inspector drag-scrub** (`src/app/dragScrub.ts` + `Inspector.tsx`) —
  drag the LABEL horizontally to scrub. Live preview is local React
  state; one drag commits one `setParam` Op on pointer-up. Sensitivity:
  default 0.01/px, Shift = fine 0.001/px, Cmd/Ctrl = coarse 0.1/px.
- **MenuBar** (`src/app/MenuBar.tsx`) — File (New / Duplicate / Rename /
  Delete / Save / Export glTF [stub] / Export DAG JSON), Edit (Undo /
  Redo / Reset to Default / Settings [stub]), Select (All / None /
  Invert / By Type), View (Frame Selected / Frame All / Camera-from-View
  / Toggle Grid / Toggle Axis / Set Mode). Hotkeys mirror the menu
  items and are owned by `KeyboardShortcuts.tsx` so they work
  regardless of menu state.
- **Frame Selected / Frame All** (`src/app/character/framing.ts`) —
  manual fit (target + offset preserved). Reads via `useThreeRef` so
  the action runs from outside the Canvas. F + Home keyboard shortcuts.
- **K9 — camera-from-view chain** (`.anvi/krama.md`) — atomic
  `[disconnect old → addNode PerspectiveCamera → connect new]` chain
  via `dispatchAtomic`. Single Cmd+Z reverts.
- **H13 — layout-shifting features invalidate pixel-diff baselines**
  (`.anvi/hetvabhasa.md`) — observed when the menu bar's row shrunk the
  viewport DIV by ~35px and acceptance #7 mismatched the prior darwin
  baseline despite no scene-content change.

### Changed

- **Layout** (`src/app/Layout.tsx`) — added a `menu` row above
  `chrome` so the menu bar is the topmost surface. Existing slot
  visibility (mode-driven `display:none`) preserved; Canvas still
  mounts ONCE (V8 / K1 step 6).
- **Gizmo** (`src/app/Gizmo.tsx`) — translate-mode setParam Op snaps
  via `maybeSnapVec3` when `viewportStore.snapEnabled`. Character
  drag-end walkTo target snaps the same way.
- **GroundClick** (`src/app/character/GroundClick.tsx`) — clicked
  worldPoint snaps before being fed to `buildWalkToOps`.
- **KeyboardShortcuts** (`src/app/KeyboardShortcuts.tsx`) — added F
  (Frame Selected) and Home (Frame All).
- **PostFx-beauty darwin baseline** regenerated to match the new
  viewport dimensions (35px shorter due to menu-row addition). Linux
  baseline regenerates on the first CI run via H8's recipe.

### Tests

- **+24 vitest** (now 161): selectionStore multi-select / invert /
  toggle, dragScrub sensitivity math, viewportStore snap / toggles,
  cameraFromView atomic-chain shape + no-op when no editor camera.
- **+5 Playwright** (now 27): Cmd+Z keyboard reverts last Op,
  Cmd+Shift+C bakes new PerspectiveCamera + reroutes scene.camera,
  menu bar opens File/Edit/Select/View, View → Toggle Grid flips
  NPanel state, NodeList click → Inspector header shows the node id.

### Catalogue

- `dharana.md` — post-P2.1 fatality test passes (no new B-boundary
  needed; viewportStore is a UI projection alongside selectionStore /
  gizmoStore / threeRef).
- `krama.md` — K9 (camera-from-view chain) cataloged.
- `hetvabhasa.md` — H13 (layout-shifting features invalidate pixel-diff
  baselines) cataloged.

## [0.5.0-p2] — 2026-05-06

**P2 — Character + Move.** Time becomes a typed socket. Click-to-move
emits an atomic Op chain. Multi-character isolation proven at unit + E2E.

### Added

- **Seven new P2 node types** (THESIS.md §40):
  - `TimeSource` (the impure singleton — output socket type `Time`,
    evaluator returns `ctx.time`; the only legal time producer).
  - `Skeleton` — POJO bone hierarchy with a default 3-bone stick figure.
  - `PosedSkeleton` — deterministic procedural sway driven by Time.
  - `AnimationClip` — piecewise-linear keyframe interpolator with
    looping. NO three.js AnimationMixer (it secretly clocks).
  - `Navmesh` — hardcoded ground-plane primitive with axis-aligned
    obstacles. Mesh-driven navmeshes deferred to P3 (recast).
  - `WalkPath` — straight-line sampling with obstacle clamping +
    navmesh half-extent clamping; deterministic given (params, navmesh).
  - `LocomotionState` — integrates path + clip + time into
    position + heading + pose; loops along the path.
  - `Character` — `SceneChild` kind that elevates a LocomotionState to
    a renderable. Placeholder per-bone box rig until skinning lands
    in P3.
- **Time injection** (`src/app/stores/timeStore.ts`): zustand
  projection of the playhead. `<Clock />` runs rAF and dispatches
  deltas; capped at 100ms so a stalled tab can't fast-forward time.
  The viewport reads from the store and threads time into
  `evaluate()`'s ctx — TimeSource hash flips per frame and propagates
  through `inputHashes` to flush downstream pure consumer caches.
- **Timebar** (`src/app/Timebar.tsx`): minimal play/pause + scrub UI in
  the timeline grid slot. Replaces the P0 placeholder; full
  clip-aware timeline still lands in P3 (THESIS.md §42).
- **`character.walkTo` macro + click-to-move** (THESIS.md §40, krama K7):
  `buildWalkToOps(state, characterId, worldPoint)` returns a 2-op (or
  3-op when replacing a previous path) chain. `<GroundClick />`
  captures pointer-down on an invisible ground plane inside the Canvas
  — file-rooted in `src/app/` so V8 stays clean. Mounted only when at
  least one Character exists. Gizmo precedence: when a node is
  selected, ground-clicks are ignored.
- **Vyapti V3 lands ALIGNED**. ESLint `no-restricted-syntax` on
  `src/nodes/**` extended to ban `useFrame` and `useThree` (R3F clock
  readers).
- **Dev-only handles**: `__basher_time` (timeStore) and
  `__basher_evaluate(nodeId, ctx)` (DAG eval seam). Mirror the
  established `__basher_dag` pattern; tree-shaken from prod.
- **Acceptance tests**: five P2 criteria, all green —
  - P2#1 time-scrub bit-exact at t=2.5s.
  - P2#2 click-to-move atomic 2-op chain reverts via one undo.
  - P2#3 navmesh clamps WalkPath samples out of obstacles.
  - P2#4 multi-character cache isolation (setParam on A doesn't flip B).
  - P2#5 reload restores poses + paths bit-exact via V4 migration runner.
    Plus ~46 new vitest cases (twice-eval determinism for every
    Time-aware pure node sampled at t∈{0, 0.5, 1, 2.5, 5}; walkTo macro
    chain shape + multi-character isolation; timeStore behavior). Total:
    134 vitest, 22 Playwright — all green locally on darwin.

### Changed

- `src/core/dag/types.ts`: `SocketTypeName` extended with
  `Character | Skeleton | PosedSkeleton | AnimationClip | Navmesh | WalkPath | LocomotionState`.
- `src/nodes/types.ts`: `SceneChild` union extended with `CharacterValue`.
- `src/viewport/SceneFromDAG.tsx`: subscribes to timeStore; threads
  `ctx.time` into evaluate(). MeshChild dispatcher gains a
  `'Character'` case rendered as a per-bone box rig.
- Refreshed darwin PostFx pixel-diff baseline (1-2px shift from the
  ctx-bearing eval path). Linux baseline pending CI artifact regen
  (Docker not available in dev env).

### Catalogued

- **H11**: `data-testid` on R3F primitive elements (`<mesh>`,
  `<group>`) crashes the entire Canvas. Use
  `userData={{ basherTestid: '...' }}`; tests drive through
  `__basher_dag` / `__basher_evaluate`.
- **K7**: character.walkTo chain (mirrors K6 asset-drop). 2-op or 3-op
  atomic; orphaned previous WalkPath stays in DAG (P2 trade-off
  pending a hygiene phase).

## [0.5.0-p1] — 2026-05-05

**P1 — First node types + Asset Library.** Library, scene tree, gizmo,
ScatterNode.

### Added

- **Ten new node types** (THESIS.md §39): `GltfAsset`, `Transform`,
  `Group`, `MaterialOverride`, `ScatterNode`, plus three new lights
  (`PointLight`, `SpotLight`, `AreaLight`), `AmbientLight` (closing the
  P0 V8 leak), and `OrthographicCamera`. All `pure: true`, all covered
  by the twice-eval determinism harness (V2). ScatterNode uses
  `mulberry32(seed)` and is hard-capped at 5000 instances (THESIS.md
  §53). V9 (materials = data, not code) lands ALIGNED with
  `MaterialOverride`.
- **Recursive viewport dispatcher** (`src/viewport/SceneFromDAG.tsx`):
  `MeshChild` switch on `value.kind` covering BoxMesh / GltfAsset /
  Transform / Group / MaterialOverride / Scatter, with material
  overrides threaded through to leaf renderers.
- **Asset Library** (THESIS.md §14): three bundled glTF primitives
  (cube, sphere, cone) generated by `npm run seed:assets` and copied
  into OPFS at first boot. HTML5-draggable rows, swatch thumbnails. The
  AssetDropZone wraps the viewport, captures drops, and dispatches the
  six-op chain via `dispatchAtomic` (one Cmd+Z reverts the whole drop).
- **Scene tree** (THESIS.md §12): Pro-mode hierarchy projection, walks
  the DAG from `state.outputs.scene` through Group / Transform /
  MaterialOverride. Sibling drag-reorder emits
  `[disconnect, connect(index)]` via dispatchAtomic. Two non-identical
  DAGs evaluating to the same hierarchy produce the same tree shape.
- **TransformControls gizmo** (`src/app/Gizmo.tsx`): drei
  `<TransformControls>` bound to the selected Transform node. Live-drag
  dispatches `setParam` Ops on every `objectChange` event; cache
  invalidates by content hash so the viewport reflects within budget.
- **Op protocol extension**: `connect` gains an optional `index?:
number`. When omitted it appends (P0 behaviour). When set it inserts at
  position. Five Op types unchanged; P0's 82 unit tests still green.
- **Dev-only store handle** (`window.__basher_dag`): exposed under
  `import.meta.env.DEV`, tree-shaken from prod. Used by the P1
  acceptance spec to drive scenarios native HTML5 D&D would make
  brittle. Existing P0 prod-absence test extended to assert the handle
  is absent from `dist/`.
- **Acceptance tests**: five P1 criteria, all green. Total Playwright
  suite: 16 pass.

### Cut from P1 scope (pulled to later phases)

- Real-image thumbnails (offscreen R3F preview) — v0.6.
- Cross-parent reparenting in the scene tree — P1 ships sibling reorder
  only.
- Gizmo rotate / scale modes — translate-only ships in P1.
- Single-writer queue for mid-drag agent ops — P2.5.
- TSL / OSL shader authoring — deferred to P4 per `dharana.md` §3.

### Notes

- 88 vitest unit tests (was 61 at P0 merge); 16 Playwright specs;
  production bundle ~488 KB gzipped (THESIS.md §53 budget: 2 MB).
- New catalogue entries: V9 ALIGNED, K6 (asset-drop chain), H9
  (GLTFExporter polyfill), H10 (zustand snapshot stale across async).
  Organizational fatality test re-run; structure still sound.

## [0.5.0-p0] — 2026-05-05

**P0 — Foundation + DAG core.** First runnable Basher.

### Added

- **DAG core** (THESIS.md §6-10): `NodeDefinition<P,O>` with zod
  `paramSchema`, version, pure flag, cost; FNV-1a content-hash evaluator
  with depth-32 cycle detection; five Op primitives + inverses; zustand
  store with single `dispatch()` mutator and undo/redo via inverse ops.
- **Five node types** (THESIS.md App. C): `PerspectiveCamera`,
  `DirectionalLight`, `BoxMesh`, `Scene`, `RenderOutput` — all `pure: true`,
  `version: 1`, deterministic POJO outputs.
- **Storage capability** (THESIS.md §33): `StorageCapability` interface,
  `OpfsStorage` with read-back-verify on every write, `TauriStorage`
  v0.6 stub, `MemoryStorage` for tests.
- **Project schema + migrations** (THESIS.md §52): versioned
  `formatVersion: 1`, two migration ladders (project format + per-node
  type), runner ships before first bump.
- **Editor shell** (THESIS.md §11, §17): CSS-grid Layout with named
  regions, Simple / Director / Pro modes (localStorage-persisted),
  ModeSwitcher, NodeList, Inspector with numeric + Vec3 fields, Chrome
  with save button, RightDrawer placeholder reserving the agent slot.
- **Viewport** (THESIS.md §11): R3F `Canvas` mounted at root, never
  unmounts on mode switch (V8); `SceneFromDAG` walks evaluated DAG output
  → R3F primitives; PostFx with ACES + SMAA driven by `RenderOutput`
  params; FpsMeter overlay (dev only).
- **Blender bridge** (THESIS.md §32): `BlenderBridgeCapability`
  interface, `BrowserBlenderBridge` polling `/__assets/active` every 2s
  in dev (inert in production via `import.meta.env.DEV` guard); Vite
  middleware mock at the same path; Python `serve.py` companion skeleton.
- **CI**: lint / typecheck / vitest / playwright / license-audit jobs.
- **Acceptance tests**: all eight P0 criteria + a prod-build absence
  check for the Blender beacon. Committed reference screenshot for the
  ACES + SMAA beauty pass.

### Cut from P0 scope (pulled to later phases)

- Scene tree projection — P1 (Director-mode `tree-slot` is a placeholder).
- Library / asset thumbnails — P1.
- TransformControls gizmo — P1 (drag-to-edit lands with the scene tree).
- DoF / Bloom / Vignette / ChromaticAberration / Grade / Noise — P4+ as
  additional render-graph node types. PostFx P0 ships ACES + SMAA only.
- Blender-companion live proxy from Vite to the Python server — P1.

### Notes

- 58 vitest unit tests; 9 Playwright E2E specs; production bundle ~360KB
  gzipped (THESIS.md §53 budget: 2MB).
- Default project file is the THESIS App. C 5-node DAG; built via the
  same `applyOp` dispatcher used at runtime — no special bootstrap path.
