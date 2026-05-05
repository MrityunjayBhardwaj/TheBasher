# Changelog

All notable changes to Basher are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses semantic-ish versioning during the v0.5 phase plan.

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
