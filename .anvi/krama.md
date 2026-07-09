# Krama — Lifecycle Patterns

> Numbered execution sequences that must hold. Violations are subtle: code "works" until ordering shifts.

## Format

```
### K<N>: <sequence name>

**Steps:**
  1. ...
  2. ...
**Common violations:** the wrong-order patterns to watch for
**REF:** THESIS.md section + file:line
**Why it matters:** what breaks if order is wrong
```

---

### K1: Application boot sequence (P0)

**Steps:**

1. Detect platform (browser / PWA / future-Tauri).
2. Initialize zustand stores in dependency order: `mode` → `project` → `dag` → `selection` → `agent`.
3. Load persisted project from OPFS (if any) or initialize default 4-node DAG.
4. Mount React root.
5. Mount layout shell (chrome reads `mode`).
6. Mount R3F Canvas at root (Canvas mounts ONCE; never on mode switch).
7. Evaluator computes `scene` output → renders.
8. Mount PostFx pass.
9. Start Blender beacon poll (dev only).
10. Show start screen / project picker.

**Common violations:**

- Hydrating `dag` before `mode` → first render uses default mode, then snaps to user's saved mode (visible flash).
- Mounting Canvas inside a mode-conditional → mode switch remounts Canvas → loses GPU state, flashes black.
- Starting beacon in production → silent prod-only network spam.

**REF:** THESIS.md §38 (P0 acceptance test #3, #6)
**Why it matters:** boot path is the most visible failure surface; users abandon broken-looking apps within seconds.

### K2: Op dispatch lifecycle

**Steps:**

1. UI/agent emits `Op` (typed, zod-validated).
2. Dispatcher validates op against current DAG state (e.g. node exists for `removeNode`).
3. Compute inverse op for undo.
4. Apply forward op to DAG store atomically.
5. Push (forward, inverse) to undo stack.
6. Invalidate evaluator cache for affected node + downstream.
7. Emit "op applied" event with source ('user'/'agent'/'macro').
8. Activity log appends entry.
9. Subscribed surfaces re-render.

**Common violations:**

- Skipping step 2 (validation) → invalid ops corrupt state, undo fails.
- Skipping step 6 (cache invalidate) → viewport shows stale scene.
- Computing inverse AFTER applying → can't capture original state for undo.
- Applying ops in non-atomic batches → partial state visible mid-batch.

**REF:** THESIS.md §50, App. B
**Why it matters:** undo + agent + multiplayer + save all rely on this exact sequence.

### K3: Diff (agent transaction) lifecycle

**Steps:**

1. Agent emits text + tool calls (streaming).
2. Tool handler validates args (zod) → returns `Op[]`.
3. Ops applied to FORKED DAG copy (not real store).
4. Viewport renders ghost overlay (semi-transparent + dotted) in addition to real scene.
5. User sees diff with per-op checkboxes.
6. User accepts (selected/all) or rejects.
7. Accept: feed accepted ops through real Op dispatcher (K2); single undo entry titled "Agent: <description>".
8. Reject: discard fork; no real state change.

**Common violations:**

- Step 3 → applying to real store: bypasses accept/reject; user can't preview.
- Step 7 → one undo entry per op instead of per diff: undo becomes painful (hit it 30 times to revert one agent action).
- Skipping validation (step 2): malformed agent output corrupts forked DAG; reject still leaves zombie state if forked DAG leaks.

**REF:** THESIS.md §19; `src/agent/diff/forkedDag.ts:1` (createFork); `src/agent/diff/store.ts:1` (useDiffStore + acceptSelectedOps); `src/app/DiffBar.tsx:1` (accept/reject UI); `src/viewport/DiffOverlay.tsx:1` (ghost render)
**Why it matters:** the Diff-first contract is the trust contract with the user. Break it once and the agent is disabled.

### K4: Render job lifecycle (P4 — narrowed shipping shape)

**Compose phase (DAG mutation, agent or user authored):**

1. RenderJob node added to DAG via `dag.exec` (no Mutator yet — opt-in;
   DEFAULT_OPS does not seed one). Params: jobId, frameStart, frameEnd,
   fps, outputPath.
2. RenderJob.time wired to project TimeSource (the singleton seeded by
   PR #40 lock-in).
3. For each desired pass: `mutator.render.addPass({ jobId, passKind })`.
   Mutator auto-resolves Scene + Camera + TimeSource and connects them
   into the new pass; final connect lands on `jobId.'pass-input'`.
   Diff gates: V13 closure preservation (pass-input edge), V14 unique
   contract signature.
4. User accepts the Diff. DAG now describes the render plan.

**Execute phase (impure side, runRenderJob in src/render/):**

5. Caller invokes `runRenderJob(jobNodeId, dagState, { storage,
encoder })`. V8 file-rooted: NO Op emission from src/render/.
6. Read JobResultValue at frame 0 to derive (frames.start..end, fps,
   outputPath, passKinds[]).
7. For each frame in [start, end]:
   a. Build `EvalCtx { time: { frame, seconds=frame/fps, normalized=0 } }`.
   b. For each pass-input ref: evaluate the pass at this ctx → ImageValue
   (sourceHash flips per frame because Time threads through V3).
   c. Resolve Scene + Camera by walking the pass node's input bindings
   and evaluating each producer at the same ctx.
   d. Hand (pass, scene, camera, frame, seconds) to the injectable
   `PassEncoder` → PNG bytes.
   e. Write via `StorageCapability.write(outputPath/passKind_NNNN.png,
bytes)`. V6 capability — no direct fs/opfs.
8. Return RenderJobReport { jobId, framesWritten, passKinds, outputs[] }.

**Describe phase (read-only, agent surface):**

9. `agent.render.summarizePass({ jobId, passKind, frame })` evaluates
   the matching pass at the requested frame and returns
   `{ sourceHash, descriptor, outputPath, ambiguous }`. The agent
   describes a render result by sourceHash without needing pixels.

**Common violations:**

- Reading `ctx.realTime` or `Date.now()` inside a pass evaluator →
  V2/V3 violation; lint catches via the no-impure-source rule for
  `src/nodes/**`. RenderJob is the ONLY exception (pure: false), and
  even RenderJob's evaluator only touches params, not ctx.time.
- Importing the dispatcher from src/render/ → V8 violation; mechanical
  textual import-only test in runRenderJob.test.ts fails CI.
- Adding a pass node socket NOT named exactly `'pass-input'` (the
  EdgeKind literal). The closure walker matches socket name to kind
  string — typo → silent fall-through, sibling leak.
- Reusing the same outputPath across two RenderJobs → frame collisions
  on disk. Each job needs a unique prefix.
- Encoding on main thread without yield (Wave B.1 Worker upgrade
  candidate) — fine for 60-frame demos, blocks UI on long renders.

**REF:** THESIS.md §27, §43, §49, §51; vyapti V2/V3/V6/V8/V13/V14;
hetvabhasa H22 (per-kind BFS isolation, now under live `'pass-input'`);
`src/render/runRenderJob.ts`; `src/agent/mutators/builders/addPass.ts`;
`src/agent/tools/renderSummarizePass.ts`.

**Why it matters:** P4 is the seam between "agent describes a render"
and "frames land on disk." Splitting compose (DAG mutation, Diff-
mediated, user-accepted) from execute (impure, capability-mediated,
side-effecting) keeps each phase auditable. The Diff log shows what
the user authorized; storage shows what was produced; the sourceHash
is the cross-link.

### K5: Project save/load lifecycle

**Steps:**

1. (Save) Serialize DAG → JSON via zod schema.
2. Compute integrity hash.
3. Write to OPFS with versioned filename.
4. Read-back-verify in dev mode.
5. (Load) Read project file from OPFS.
6. Validate JSON against current schema.
7. If older version: run migrations (per node type) until current.
8. Hydrate DAG store.
9. Trigger evaluator → first render.

**Common violations:**

- Skipping step 4 → silent data loss when OPFS quota exceeded.
- Skipping step 7 → load older project crashes or corrupts.
- Running migrations after hydrate → stores see old-shaped data first → component crashes.

**REF:** THESIS.md §52
**Why it matters:** every saved project is a trust commitment. Migration policy lives or dies here.

### K6: Asset-drop chain (P1)

**Steps:**

1. Library item drag emits `application/x-basher-asset` MIME with the OPFS-relative path.
2. AssetDropZone captures `drop`, reads `state.outputs.scene.node` to learn the parent.
3. `buildAssetDropOps` returns the 6-op chain: `addNode(GltfAsset) → addNode(Transform) → connect(gltf→tx.target) → addNode(Group) → connect(tx→grp.children) → connect(grp→scene.children)`.
4. `dispatchAtomic` applies the chain as one undo entry (`description: "import asset: <path>"`).
5. The viewport's GltfAssetR component resolves the assetRef via `useResolvedAssetUrl` (OPFS read → blob URL), then `useGLTF` loads the glTF and renders.
6. Subsequent drops append (no Group reuse — every drop creates its own Group).

**Common violations:**

- Calling `dispatchBatch` (per-op undo entries) instead of `dispatchAtomic` → user must hit Cmd+Z six times to revert one drop. Acceptance #1 fails.
- Reading `state.outputs.scene` from a stale getState() snapshot → drops attach under a different parent than the user expects.
- Passing the asset's filesystem URL (`/assets/cube.gltf`) as `assetRef` in production → bypasses OPFS, breaks save/reload portability across machines.

**REF:** THESIS.md §39, krama K2; `src/app/asset/dropChain.ts:36`; `src/app/AssetDropZone.tsx:33`; `src/app/asset/dropChain.test.ts`.
**Why it matters:** the drop-chain is the canonical example of a multi-Op user action. P2.5's agent macros (e.g. `library.import`) reuse the same chain — if the human path mutates correctly under undo, the agent path inherits the property for free.

**P7.11 EXTENSION — skin metadata capture rides the SAME atomic op (not a new lifecycle).** When a skinned glTF is imported, `buildSkinMetadata` (joint keys + bind TRS + parentJointIndex + inverse-bind matrices, all in `skin.joints[]` order — [[V25]] clause 2) is captured at parse time and emitted as the `skins` param ON the GltfAsset `addNode` op, inside the SAME ops array as the per-child `GltfChild` emissions (the 7.7 child-addressing chain). So capture + asset node + all child nodes are ONE `dispatchAtomic` = ONE Cmd+Z (the K6 invariant, unbroken). Ordering precondition: `parseGltfContainer` + `resolveBuffers` (async — buffers needed for the IBM `readAccessor`) MUST complete, then `buildNodeNameMap` (sync — `keyByGltfNodeIndex` + `childHierarchy` for the joint-key + parent-resolution lookups), THEN `buildSkinMetadata` (sync). The capture is content-addressed off `json` ([[V22]] — re-import byte-identical); no new undo entry, no new dispatch. Both import callers (drag-drop `boot.ts`, My-Imports `importGltf.ts`) get it for free because it is on the shared op. **Common violation:** emitting `skins` as a separate `setParam` after the addNode (splits the atomic boundary → a partial-capture state is observable mid-undo). REF: `src/core/import/gltfImportChain.ts` (`buildSkinMetadata` + the GltfAsset addNode op emission), `src/core/import/gltfSkinCapture.test.ts` (V22 determinism + parallel-length), [[V25]], [[V22]], [[H50]]. Issue #100.

### K7: character.walkTo chain (P2)

**Steps:**

1. User clicks a point on the navmesh ground plane via the `<GroundClick />` mesh inside the Canvas.
2. `GroundClick.tsx` checks `selectionStore.selectedNodeId === null` (gizmo precedence — selection means manipulation, not navigation). Returns early if a node is selected.
3. Picks the first `Character` node from `useDagStore.getState().state.nodes`. Returns early if none exists.
4. Calls `buildWalkToOps(state, characterId, [worldPoint.x, 0, worldPoint.z])`. The macro discovers the character's existing `LocomotionState` and the project's `Navmesh`. Returns null if either is missing.
5. The macro returns `{ ops, description, newWalkPathId }`:
   - **If a previous WalkPath is wired to `loco.path`:** ops = [disconnect old → addNode new (navmesh pre-wired) → connect new]
   - **Else:** ops = [addNode new (navmesh pre-wired) → connect new]
6. `useDagStore.getState().dispatchAtomic(ops, 'user', description)` applies them as a single atomic group → one Cmd+Z reverts the whole interaction.
7. The previous WalkPath becomes orphaned (V1: ops are emitted as intended, not auto-cleaned). A future hygiene phase may add a "garbage-collect orphans" pass.

**Common violations:**

- Calling `dispatchBatch` (per-op undo entries) instead of `dispatchAtomic` → user must hit Cmd+Z three times to revert one click. P2 acceptance #2 fails.
- Skipping the disconnect-old step → multiple `connect` ops on the same `loco.path` socket; the `applyOp` validator rejects the second connect.
- Using `data-testid` on R3F primitive elements (`<mesh>`) → THREE reconciler throws `Cannot read properties of undefined (reading 'testid')`; whole Canvas crashes (cataloged as H11).
- Mounting `<GroundClick />` unconditionally → the invisible plane interferes with depth/blending and the canonical default-project pixel-diff baseline shifts. Gate on `hasCharacter(state)`.

**REF:** THESIS.md §40; `src/app/character/walkTo.ts:46`; `src/app/character/GroundClick.tsx:30`; `src/app/character/walkTo.test.ts`.
**Why it matters:** click-to-move is the first user-perceivable proof that the agent and the user share the same Op surface. P2.5's `character.walkTo` agent tool will return the SAME `Op[]` shape — if the human path mutates correctly under undo, the agent path inherits the property for free (mirrors K6's reasoning).

### K8: Boot-with-last-project (P2 viewport-polish)

**Steps:**

1. K1 step 1-2 (registry → storage pick) unchanged.
2. Read `localStorage['basher.lastProjectId']`. If present, attempt `loadProject(storage, lastId)`.
3. On miss/corrupt/absent: fall through to `loadProject(storage, DEFAULT_PROJECT_ID)`.
4. On second miss: build the seed project + persist it (covers first-ever boot AND catastrophic data loss).
5. After load: `persistLastProjectId(project.id)` so the chosen project becomes the next-boot default.
6. K1 step 3-9 (hydrate + Canvas + beacon) unchanged.

**Switch flow** (user clicks a different project in `<ProjectsMenu />`):

1. Auto-save the OUTGOING project via `saveCurrent()` before swapping. (No "did you save?" modal — saves are cheap, idempotent, atomic per K5.)
2. Load the target project's bytes via `loadProject(storage, targetId)`.
3. `persistLastProjectId(targetId)`.
4. `useProjectStore.setCurrent(target)` + `useDagStore.hydrate(target.state)`. The hydrate seam bypasses the Op log by design (V1 documented exception).

**Common violations:**

- Skipping step 1 (auto-save outgoing) → user loses uncommitted edits when switching.
- Mutating the DAG store via `setState` instead of `hydrate` → V1 leak; the Op log gains incoherent entries that don't match either project's history.
- Persisting `lastProjectId` BEFORE the load succeeds → a corrupt project poisons the boot loop forever (every boot re-attempts, fails, retries the same id).

**REF:** `src/app/boot.ts` (boot, switchProject, createNewProject, deleteProject, duplicateCurrentProject, renameCurrentProject); `src/app/ProjectsMenu.tsx`.
**Why it matters:** multi-project is the first feature where the user has expectations about UI continuity across sessions. Get the persisted-handle wrong and the user sees their work disappear on reload — irreversible trust loss.

### K9: camera-from-view chain (P2.1)

**Steps:**

1. User triggers Cmd+Shift+C (KeyboardShortcuts.tsx) or View → Camera-from-View (MenuBar.tsx).
2. Both routes call `snapshotCameraFromOrbit()` in `src/app/character/cameraFromView.ts`.
3. Read editor pose from `useThreeRef.getState()` — populated each frame by `<ThreeBridge />` (lives inside Canvas; pushes `useThree(camera)` + `controls.target` into the projection store). Returns early when no camera is mounted yet.
4. Read `state.outputs.scene` and the Scene aggregator's `inputs.camera`. Returns early when missing or list-shaped (Scene's camera socket is single-cardinality).
5. Build atomic op chain:
   - **If a camera is currently wired:** `[disconnect old → addNode PerspectiveCamera{fov, position, lookAt} → connect new → scene.camera]`
   - **Else (rare in seed projects but possible after Edit→Reset):** `[addNode PerspectiveCamera{...} → connect new → scene.camera]`
6. `useDagStore.getState().dispatchAtomic(ops, 'user', 'camera-from-view')` — single Cmd+Z reverts the snapshot end-to-end.

**Common violations:**

- Calling `useThree()` from outside Canvas (KeyboardShortcuts is in the React tree but not inside Canvas) → undefined hook context. Fix: read via `useThreeRef`, populated by `<ThreeBridge />`.
- Writing to `state.outputs.scene.camera` directly (outputs are not Op-managed in v0.5; only inputs are) — the right plumbing is to disconnect/reconnect the Scene aggregator's `camera` input. Mirrors the asset-drop pattern (K6).
- Skipping the disconnect when an existing camera is wired → `applyOp` rejects the second connect because Scene.camera is single-cardinality.

**REF:** THESIS.md §11; `src/app/character/cameraFromView.ts:21`; `src/app/character/threeRef.ts:24`; `src/app/character/ThreeBridge.tsx:11`; `src/app/character/cameraFromView.test.ts`.
**Why it matters:** camera-from-view is the killer move for the director-first thesis — frame a shot via OrbitControls, bake it into the DAG, and renders reproduce the pose deterministically. The same `Op[]` shape will be the agent's `camera.snapshot` tool surface when P2.5 lands.

### K10: AI render workflow lifecycle (P5 — extends K4's compose/execute/describe shape)

**Compose phase (DAG mutation, agent or user authored):**

1. RenderJob node added via `dag.exec` (default project does NOT seed
   one; user opts in).
2. For each preset.requiredPass: `mutator.render.addPass({ jobId,
passKind })`. addPass auto-resolves Scene + Camera + TimeSource and
   wires the pass into `jobId.pass-input`. V13 closure preservation +
   V14 signature uniqueness gates.
3. `mutator.render.addAIPass({ jobId, presetId, promptText, ... })`
   adds Prompt + ComfyUIWorkflow + connects existing required passes
   to the workflow's pass-input list. Workflow's outputPath = `${job.
outputPath}/stylized_${sanitize(presetId)}` (D-04 formula).
4. Optional: `mutator.render.addStitch({ jobId, workflowId, fps?,
codec? })` adds VideoStitch consuming the workflow's stylized
   output. Stitch's outputPath = `${job.outputPath}/final.mp4`.
5. User accepts the Diff. DAG describes the AI render plan.

**Execute phase (impure side, src/render/):**

6. (Pre-condition) `runRenderJob` produces raw passes at
   `${job.outputPath}/${passKind}_NNNN.png`. Without raw bytes on disk,
   the workflow has nothing to feed ComfyUI.
7. `runComfyUIWorkflow(workflowNodeId, dagState, { capability, storage,
compileWorkflow, onFrameComplete })` walks frames
   [max(frameStart, lastGoodFrame + 1), frameEnd]:
   a. Build EvalCtx { time: { frame, seconds=frame/30, normalized: 0 } }.
   b. Resolve Prompt + pass-input nodes via evaluator at this ctx.
   c. Compute prevFrameStylizedPath: null on first frame, else
   `framePath(workflowOutputPath, frame - 1)`.
   d. Call compileWorkflow → { workflowJson, inputs }. The preset's
   compile factory reads raw pass bytes from the job's parent dir
   and the prev-frame stylized bytes from prevFrameStylizedPath
   (or substitutes a 1×1 black ZERO_FRAME_PNG on first frame /
   missing-path soft-fail).
   e. `await capability.submit(workflowJson, inputs)` → bytes.
   f. Write bytes via `storage.write(framePath(workflowOutputPath,
   frame), bytes)`. V6 capability — no direct fs/opfs.
   g. `onFrameComplete(frame)` → caller (src/app/render/runWorkflow.ts)
   dispatches `setParam` Op advancing `lastGoodFrame`. V8 file-
   rooted: src/render/\* never dispatches.
   h. On capability rejection: throw with `partialReport` attached;
   caller's wrapping code catches and surfaces error. Resume:
   next call starts at `lastGoodFrame + 1`.
8. `runVideoStitch(stitchNodeId, dagState, { storage, encoder })`
   walks each upstream ComfyUIWorkflow's frame range:
   a. Read each frame's stylized PNG bytes via `storage.read(
framePath(upstream.outputPath, frame))`.
   b. Pass collected `framesPng[]` to `deps.encoder({ framesPng,
codec, fps })` → encoded video bytes.
   c. Write bytes via `storage.write(stitch.outputPath, videoBytes)`.

**Describe phase (read-only, agent surface):**

9. `agent.render.dryRunWorkflow({ workflowNodeId })` probes one frame
   through the capability + writes to D-04 path. Returns
   `{ frames, estimatedSeconds, samplePath, probeJobId }`. Cache
   parity: subsequent execute reads the probe's bytes by sourceHash
   identity (THESIS §51).
10. `agent.render.summarizeStylized({ workflowNodeId, frame })`
    evaluates the workflow at the frame, returns
    `{ workflowId, presetId, frame, sourceHash, descriptor,
outputPath, bytesPresent, lastGoodFrame }`. Agent describes
    progress without loading bytes.

**Common violations:**

- Calling capability.submit from inside the workflow node's
  evaluator → V8 + V2 violation (pure-flag lying). Wave A4 narrowly
  avoided this by making compileWorkflow + submit live in
  src/render/, not inside ComfyUIWorkflow.evaluate. Future presets
  must follow the same split.
- Reading raw pass bytes via `OpfsStorage` / `node:fs` directly
  from the preset compile() function → V6 violation. The preset
  receives a StorageCapability handle via the compile factory closure;
  reads MUST flow through that handle.
- Letting prevFrameStylizedPath race a slow disk → soft-fall to
  ZERO_FRAME_PNG so frame 1 doesn't crash. Documented in the
  preset's readPrevFrameBytes; reviewers reject any change that
  hard-fails here without a UX-driven alternative.
- Dispatching the lastGoodFrame writeback from inside
  runComfyUIWorkflow.ts → V8 violation. Always callback-driven;
  caller (src/app/render/runWorkflow.ts) does the dispatch.
- Wiring a non-ComfyUIWorkflow upstream into VideoStitch.pass-input →
  v0.5 stitches stylized output only; runVideoStitch rejects with a
  clear "wire a ComfyUIWorkflow" message.
- Submitting frame N before runRenderJob produced raw N → preset
  compile() throws "raw pass not found"; caller surfaces error and
  the agent's failure handler routes to "produce raw passes first".

**REF:** THESIS §28 (AI render presets), §44 (P5 spec), §49 (Time
first-class), §51 (caching correctness); vyapti V2/V3/V6/V8/V13/V14;
hetvabhasa H19 (stale snapshot — runComfyUIWorkflow keeps state
local), H22 (per-edge BFS isolation under live D-01 stylized output);
`src/render/runComfyUIWorkflow.ts:1`,
`src/render/runVideoStitch.ts:1`, `src/render/dryRun.ts:1`,
`src/agent/strategy/presets/stylizedRealism.ts:1`,
`src/app/render/runWorkflow.ts:1`.

**Why it matters:** P5 is the seam between "agent describes a
stylized render" and "frames + MP4 land on disk." Splitting compose
(DAG mutation, Diff-mediated, user-accepted) from execute (impure,
capability-mediated, side-effecting) keeps each phase auditable. The
Diff log shows what the user authorized; storage shows what was
produced; the sourceHash + framePath formula bridge them. Resume on
failure works because lastGoodFrame is a regular Op, not a side
channel.

### K11: Persisted-store boot lifecycle (mode + chrome stores)

**Span:** any zustand store that reads localStorage at module-load and exposes its persisted state to the rest of the app. Currently: `useModeStore`, `useChromeStore`. Future: `useLeftSidebarStore` (W3), `useInspectorSectionStore` (W4), `useTimelineDockStore` (W5).

**Steps (in strict order):**

1. **Module-load fires.** zustand `create<T>(...)` invokes the initializer. The initializer's `state` argument expression runs synchronously — anything that throws here aborts module load.
2. **Defensive Storage probe.** Helpers (`safeGetItem`) check `typeof localStorage?.getItem === 'function'` AND wrap the call in try/catch. Test envs where Storage is partially-stubbed (vitest happy-dom) return `null`; production browsers return the persisted JSON. (See H26.)
3. **Parse + validate.** Persisted JSON parses inside try/catch; on parse failure → return defaults. Per-field type-narrows (`typeof parsed.toolRailCollapsed === 'boolean'`) reject malformed values without throwing.
4. **Legacy-value coercion (mode store specifically).** If the persisted value is in the _previous_ type's set but not the _current_ type's set (e.g. legacy density `'simple' | 'pro'` after the D-UX-5 repurpose), coerce to the safest current default (`'edit'`). Don't preserve the legacy value just because parse succeeded — the _meaning_ changed, not just the shape.
5. **Default fallback.** Anything that didn't match a legitimate current value returns the type's safe default. For `mode`, that's `'edit'` (full chrome, non-modal, no surprises). For `chrome*Collapsed`, that's `false` (everything visible).
6. **Initial state spread into store.** `...readPersisted()` is the first key in the initializer object literal. The store object's setters / togglers come after, so any setter call before module-load completion would already have the persisted state.
7. **First setter call writes back.** The setter runs `writePersisted` _after_ `set({...})`, so an in-memory update is reflected before any I/O failure could roll it back. For non-persistable values (mode `'run'`, mode `'director'`), the setter skips the write step entirely.
8. **Reload round-trips.** On reload, step 1 runs again with the value step 7 wrote. For `mode`, only persistable values (`'edit'`, `'animate'`) reach this step; transient modes (`'run'`, `'director'`) reset to last persisted on reload.

**Common violations (each one historically caught):**

- Reading `localStorage` outside the initializer (e.g. inside a useEffect on mount) — adds a one-frame flash of default state before the persisted value lands. Solution: always read at module-load.
- Skipping the legacy-coercion step (#4) when changing a Mode/State type signature — old persisted values seep into a type they no longer fit, narrowing assertions break downstream. Solution: every type-shape change requires a coercion clause in `readPersisted`, even if the new set is a strict superset of the old.
- Writing every value to storage (no PERSISTABLE filter) — transient modes survive reload, surfacing the user back inside Director Cut after a refresh. Solution: explicit `PERSISTABLE` set; setter checks before write.
- Stomping the entire stored object on a partial setter (`setItem(key, JSON.stringify({ singleField: v }))`) — drops sibling fields. Solution: re-merge with `{ ...get(), [field]: value }` before stringify.

**REF:** `src/app/stores/modeStore.ts:32–47` (readPersisted + setMode + PERSISTABLE filter); `src/app/stores/chromeStore.ts:41–57` (readPersisted + writePersisted re-merge); `src/app/stores/chromeStore.test.ts` (multi-flag persistence test); docs/UI-SPEC.md §7.3 (persistence rules); hetvabhasa H26 (defensive helpers); vyapti V16 (chrome-hiding mode keyboard escape — depends on this lifecycle producing a coherent post-reload state); P6 W1 commits `7657d27`, `515afda`, `a3a283e`, `cc151fa`.

**Why it matters:** every UI projection store that persists has the same boot shape. Codifying the lifecycle catches sister bugs early: when W3 adds `useLeftSidebarStore` (active-tab persistence), W4 adds inspector-section collapse-by-node-type persistence, W5 adds timeline-dock height persistence — each follows K11. The legacy-coercion step (#4) becomes load-bearing for every future type-shape change in any persisted store.

### K12: Test affordance lifecycle — chrome change → dev seam, not chrome restoration

**Span:** any wave that deletes / repurposes / collapses-by-default a chrome surface that e2e tests reach through a `data-testid` click. Currently exercised by W2.5 (Library panel deletion → AssetsPopover behind a button) and W2.6 (SceneTree default-collapsed; Inspector→NPanel merge).

**Steps (when chrome surface evolves and breaks e2e selection paths):**

1. **Identify the broken e2e path.** Failure is usually one of: `getByTestId(...).click()` times out (element unmounted or hidden behind chrome), `expect(...).toBeVisible()` fails (display:none flipped), or testid-rename collateral (selector points at a deleted ID).
2. **Classify the breakage.** Three flavors:
   - **Surface still exists, just unreachable** (collapsed panel) → expand it programmatically before interacting. Don't add a click-the-chevron step inside every test (brittle: ordering-dependent because chromeStore persists across tests).
   - **Surface deleted, behavior moved to another store** (NPanel grid toggle gone, viewportStore.gridVisible still flips) → verify via the underlying store directly through its `__basher_*` dev seam.
   - **Surface deleted, no equivalent** (NodeList — flat list of all DAG nodes, no successor) → the test was using chrome as a selection mechanism; route selection through the relevant store's seam (e.g. `__basher_selection.select(id)`).
3. **Expose the relevant store via dev seam.** In `src/app/boot.ts` under the `import.meta.env.DEV` block, add `void import('./stores/<store>').then((m) => { w.__basher_<name> = m.use<Store>; })`. Production builds tree-shake this branch entirely — zero runtime cost in user binaries.
4. **Wait for the seam to land in the test.** The dynamic import is async, so tests need `await page.waitForFunction(() => Boolean(w.__basher_<name>))` before dereferencing. Pattern is already established by `__basher_dag` / `__basher_selection` waits in p0/p1/p21 specs.
5. **Drive the test through the seam.** `await page.evaluate(() => { w.__basher_<name>.getState().<action>(...) })`. Programmatic; immune to chrome shape changes; matches the production code path because both go through the store's setter.
6. **Update the test comment.** Note that the test no longer depends on the chrome surface (e.g. "P6 W2.6 — SceneTree default-collapsed; expand via dev seam"). Future readers know this isn't accidental store-poking but a deliberate test contract.
7. **Do NOT restore chrome to make the test pass.** A button "test-only-expand" or `data-testid="invisible-trigger"` is the wrong path — chrome should serve users, not tests.

**Common violations (each historically caught):**

- Inserting a `getByTestId('chevron').click()` step in every affected test — works first run, breaks on parallel-run order changes because chromeStore persists across tests.
- Restoring deleted chrome (e.g. re-mounting a hidden NodeList) just so `node-list-item-${id}` selectors work — the Spec is now lying about what the user sees.
- Not waiting for the dynamic import → flaky-on-cold-cache failures (`Cannot read properties of undefined (reading 'getState')`).
- Adding `__basher_*` seams in production code paths (not under `import.meta.env.DEV`) — leaks store internals to user runtime.

**REF:** `src/app/boot.ts:144–166` (**basher_editor / **basher_selection / \_\_basher_chrome dev seams); `tests/e2e/acceptance.spec.ts:42–71` (#2 example: tree-row visibility via expanded chromeStore); `tests/e2e/p21-acceptance.spec.ts:178–200` (#4 example: viewportStore.gridVisible direct check after npanel-grid-toggle deletion); `tests/e2e/p6-w2-toolbar.spec.ts` (P6 W2 examples: chromeStore + editorStore via seams). hetvabhasa H27 (parallel-surface evolution drift — K12 is its e2e migration counterpart). P6 W2.5 commit `95291aa`; P6 W2.6 commit `c19b43a`.

**Why it matters:** chrome shape is the most volatile thing in the codebase — every UX wave moves panels around. e2e tests that anchor selection through chrome become collateral every wave. The dev-seam pattern decouples tests from chrome shape: the _contract_ (a store action that can be invoked) is stable across waves; the _chrome_ that surfaces it is not. K12 is the migration recipe so future waves don't burn an hour rediscovering it. Sister: V11 (agent tools must carry selection state via context — same lesson, different consumer) — both rely on stores being the stable contract while their UI mirrors evolve.

### K13: Imperative-canvas hot-path lifecycle — static-layer cache + React-bypass rAF strip-redraw

**Span:** any surface that renders bounded static geometry plus a value that changes 60×/sec, where re-rendering the static geometry per tick is the perf bottleneck. P6 W9 instantiation: `TimelineCanvas` (channel-row diamonds = static; playhead = per-tick). Predicted recurrence: P7 splats viewport overlay, any future canvas-2D timeline/graph surface. This is the _execution-order_ contract; [[V20]] is the data-ownership invariant it depends on, [[H33]] the trap it avoids.

**Steps (mount → steady state → teardown):**

1. **Mount (sync, owned by the component).** Create the visible `<canvas>` + an offscreen cache canvas at the SAME backing dims. Derive `dpr = min(max(devicePixelRatio,1),2)` (capped — D-W9-10). Scale the _visible_ context by dpr so draw code is CSS-px; the offscreen/visible blit is a 1:1 backing-px copy (`drawImage(offscreen,0,0)`), NOT re-dpr-scaled. Build the static layer into the offscreen once. Start the rAF loop only after the offscreen exists. Publish DOM mirror data-attrs (the test contract) in a **dims-independent effect**, not the draw effect — happy-dom `getBoundingClientRect()→0×0` means a dims-gated draw never publishes the contract (W9 C3 observed deviation).
2. **rAF tick (the hot path, ≤16.6ms — must NOT re-render React).** Read every mutable input via `getState()` / stable `ref.current` _inside the loop body_ — never close over render-scope vars (stale-closure trap; effect deps `[]` is correct precisely because nothing render-scoped is captured). Compute new playhead x from C2-style pure geometry. **Idle early-out:** if x unchanged → return early but ALWAYS re-`requestAnimationFrame` (keep the loop registered; do NOT cancel/re-arm — matches Clock.tsx:9-11 "loop runs even when paused, just no-ops"; a getState()+compare is cheaper than wake-signal coupling). On change: `drawImage(offscreen, oldStripRect → same rect)` to restore static pixels under the OLD playhead, then stroke the playhead at the NEW x **last / on top**. Update the playhead mirror attr.
3. **DAG/data change (batched via React).** Diamond `useEffect` keyed on the data + dims + dpr: rebuild the offscreen static layer, blit to visible, update count attrs. **Reset the last-playhead-x sentinel to a never-equal value (-1)** so the next rAF tick re-strokes the playhead over the freshly-rebuilt static layer (else the idle early-out suppresses it and the playhead vanishes after any rebuild — W9 C4 wiring).
4. **Resize (async — ResizeObserver callback).** Recompute dims + dpr → rebuild offscreen + visible backing stores → step 3's rebuild path. The drawer is user-resizable (200–480px); a missed resize → blurry/clipped canvas (silent).
5. **Idle (paused, no scrub).** Step 2's early-out is the whole mechanism — no separate idle state machine.
6. **Unmount (leak guard).** `cancelAnimationFrame(rafId)` AND `resizeObserver.disconnect()`. Both, separately owned (rAF in the loop effect, observer in its own effect). A contract test must assert the observer disconnects on unmount.

**Common violations (each historically caught in W9):**

- **dpr double-scale at strip-restore** (W9 C4 in-gate catch): scaling the visible ctx by dpr AND pre-multiplying offscreen source coords by dpr → the restored strip is offset/wrong-size, smears the static layer. Fix: the offscreen↔visible blit is identity backing-px space; only the _initial_ static draw is dpr-scaled (once, in step 1/3). Candidate H-entry if it recurs.
- Closing over `dims`/`duration`/`rows` in the rAF callback → frozen at first render (the [[H33]]-adjacent stale-closure family applied to geometry, not the mirror value).
- Forgetting step 3's sentinel reset → playhead disappears after the first DAG edit/resize until the next x-change tick.
- rAF cancel/re-arm on play/pause for "efficiency" → adds a wake-signal coupling that the cheap early-out makes unnecessary; also a re-arm race if the wake fires before cancel completes.
- Publishing the test mirror attrs from the dims-gated draw effect → contract reads `null`/`0` under jsdom/happy-dom and in the pre-first-layout frame.

**P7.1 EXTENSION — keyframe drag (D-W9-7) sub-lifecycle on the SAME loop.** The drag adds an _interaction_ layer over the K13 hot path; it introduces ZERO new rAF and ZERO new React subscription on the hot path. Steps:

- **1d. pointerdown (sync, owned by the canvas pointer handler).** Hit-test the cursor against every keyframe via the SAME `keyframeToRect` + `LABEL_GUTTER_PX` offset the static layer paints with (do NOT re-derive a different offset); on hit, read the EXACT stored sample `time` float off the LIVE DAG (this becomes `fromTime`, the D-03 exact-`===` discriminator — NOT a pointerup-recomputed seconds, or `removeKeyframes` silently no-ops and the drag DUPLICATES the key), read `getBoundingClientRect().left` ONCE into `dragRef.canvasLeft` (per-tick `getBoundingClientRect` is the K13 perf footgun), set `dragRef`, set `timelineSelection.activeKeyframe`, `setPointerCapture`. NO DAG mutation.
- **2d. pointermove (sync, O(1)).** Write `dragRef.pointerClientX` only. NO setState, NO DAG, NO draw — the rAF loop draws (V20 hot-path discipline; the move handler is off the React render path).
- **3d. rAF ghost (the FLAG-1-critical step).** The ghost is a SIBLING block in the SAME tick, AFTER the playhead idle-guard (W9 overlay-last ordering), gated on its OWN `if (dragRef.current)` + `if (ghostX !== lastGhostXRef.current)` — **NEVER nested in the playhead's `if (newX !== lastPlayheadXRef.current)`** (a paused director scrubbing a key has a moving cursor but zero playhead delta; nesting freezes the ghost — [[H39]] / FLAG-1). Compute `localX` from `dragRef.pointerClientX − canvasLeft − LABEL_GUTTER_PX` (pure arithmetic — the rect was read once at 1d), `xToSeconds` (the [[H37]]-correct inset-aware inverse), strip-restore the OLD ghost rect from the offscreen cache (same `drawImage` mechanism step 2 uses), draw the ghost diamond in `PALETTE.ACTIVE_DIAMOND` (existing token — B11 no-shift). Inert when not dragging (one null-check per tick — the perf gate proves it: p95 9.60ms, unchanged from W9 baseline).
- **4d. pointerup/cancel (sync, the atomic boundary).** `xToSeconds(final localX)` → `toTime`; if `toTime !== fromTime` (exact `!==`; unmoved click is a no-op), ONE `dispatchRetimeKeyframe({channelId, fromTime, toTime})` seam call → the V13 composite (`removeKeyframes`+`keyframe`, value+easing captured pre-remove — [[H38]]) → one undo entry. Clear `dragRef`, release capture, set `lastGhostXRef = -1` so the next tick cleanly restores under the stale ghost; the DAG-keyed static repaint (step 3 — `nodes` change) repaints the diamond at its committed time and also resets the ghost sentinel. The DAG is touched EXACTLY ONCE, here.

**Common violations (P7.1):** ghost nested in the playhead idle-guard ([[H39]]); `getBoundingClientRect` in the rAF tick (perf footgun — read once at 1d); `fromTime` recomputed at pointerup instead of read off the live sample at pointerdown (silent no-op + duplicate key — D-03); the `keyframe` re-add omits `easing` ([[H38]]); a second equality rule to match `fromTime` instead of the exact stored float ([[H36]] one-honest-discriminator).

**REF:** P6 W9 commits C3 `28d6a3b` (static layer + offscreen + dims-independent attr effect) + C4 `28350ab` (rAF strip-redraw + idle/stale-closure guards + sentinel reset); P7.1 commits `94eee7c` (pointer/hit-test/ghost layer) + `c9063bf` (`dispatchRetimeKeyframe` composite seam) + `79b8df1`/`f38cdc4` (`xToSeconds` + round-trip); `src/timeline/TimelineCanvas.tsx`; `src/timeline/timelineCanvasGeometry.ts` (the pure geometry the shell is thin over — `playheadStripRect`, `PLAYHEAD_STRIP_HALF_WIDTH_PX`, `xToSeconds`); `tests/e2e/p6-w9-timeline-canvas.spec.ts` (scrub/cull/ref-sync/R3F-no-remount) + `tests/e2e/p6-w9-perf.spec.ts` (the 240-frame ≥60fps Lokayata gate, observed p95≈9.60ms WITH the ghost code present — D-04 non-regression) + `tests/e2e/p7.1-keyframe-retime.spec.ts` (the drag→retime→evaluated-delta goal gate). Depends on [[V20]] (currentFrameRef single-writer; the ghost reads `dragRef`, a plain ref, adding no writer/subscription) and the V8 mount-once rider (the new 2D canvas must not perturb the R3F Canvas — asserted, not assumed). Sister: K1 step 6 (R3F Canvas mounts once — same "don't remount the heavy canvas" family, different canvas).

**Why it matters:** the naive "redraw everything in the rAF tick" is the SVG-dopesheet perf wall W9 exists to remove. The lifecycle's value is the _separation_: static geometry rebuilt only on data/resize (React-batched), the per-tick cost reduced to one `drawImage` strip-restore + one stroke + one attr write, with the source-of-truth value read React-bypass via [[V20]]. Future imperative-canvas surfaces (P7 splats) inherit this recipe instead of rediscovering the dpr/stale-closure/sentinel traps under a perf deadline.

### K14: Imported-asset rename/delete lifecycle — fail-safe move on a no-move substrate (copy → verify → rewrite-refs → delete-old)

**Span:** any rename/move/delete of an imported-asset folder backed by `StorageCapability`, which exposes no atomic move/copy/recursive-delete (`StorageCapability.ts:17-42`). P7.14 (#112) instantiation: `renameImportedAsset` / `deleteImportedAsset` in `src/app/asset/importCommon.ts`, moving/removing a `user-imports/<name>/` tree that a `GltfAsset.params.assetRef` may point inside. This is the execution-ORDER contract; [[H60]] is the trap it avoids, [[K6]] the one-atomic-dispatch invariant it depends on.

**Rename steps (the hard one — every step is ordered for crash-safety):**

1. **Resolve the destination name (sync, pure).** `sanitizeFolderName(new)`; if it equals the old name → no-op return. `resolveFreeImportName` suffixes on collision against `storage.list(user-imports)` (V22, no RNG). The OLD folder still exists at this point, so a rename-to-self must short-circuit BEFORE resolveFree (else it suffixes against its own presence).
2. **Recursive-list the source tree.** `listFilesDeep(storage, oldRoot)` — `storage.list` is one-level, so walk it (backend-agnostic: `list(file)` returns `[]` on MemoryStorage, throws on OpfsStorage — both caught → "leaf"). Empty list → report "not found", abort.
3. **Copy ALL files to the new root** (read+write each — no move primitive). Nesting preserved verbatim (multi-file glTF keeps `buffers/`,`textures/`).
4. **VERIFY all new files exist** (`exists` each) BEFORE touching the old tree. A verify miss throws → the old tree is still intact (fail-safe: a crash here leaves a recoverable DUPLICATE, never a dangling ref).
5. **Rewrite assetRefs in ONE `dispatchAtomic`** ([[K6]], undoable): for every `nodesReferencingImport(old)` node, `setParam assetRef` old-prefix→new-prefix (paramPath-based, merges — preserves `nodeNameMap`). glTF only; BVH/FBX leave no ref → this step is empty (CONTEXT D-03 asymmetry).
6. **Delete the old tree** — `deleteOpfsTree` (files → empty subdirs deepest-first → root; `removeEntry` removes empty dirs, [[H60]]). Only NOW, after new is verified + refs repointed.
7. **`useImportRefreshStore.bump()`** AFTER the delete so the My-Imports list re-enumerates the final state (pre-mortem #3 — a pre-delete bump would show a stale/half-state).

**Delete steps:** `refs = nodesReferencingImport(name)`. If `refs.length && !breakRefs` → return `{deleted:false, referencedBy}` (BLOCK, the UI shows the banner — D-06), OPFS untouched. Else: if breakRefs, expand each referencing asset to its WHOLE content-addressed import footprint (`importGroupNodeIds` — GltfAsset + wrapper Transform/Group + GltfChild satellites + clip nodes, #127/[[V27]]; removing only the GltfAsset left orphan ghosts), disconnect EVERY edge incident to the group (internal + boundary, so no group node stays consumed) then `removeNode` the whole group in ONE `dispatchAtomic` ([[H57]]/[[V13]] — the op layer rejects removing a still-consumed node; the shared Scene anchor and any user consumers are disconnected but survive); then `deleteOpfsTree(root)`; then bump.

**Common violations:** delete-old before verify (orphans the ref — [[H60]]); rewrite assetRef before the new files exist (a render between the two load-errors); delete files but not the empty dir (residue — [[H60]]); `removeNode` a referenced GltfAsset without disconnecting consumers first (op-layer throw); break-refs removing ONLY the GltfAsset, leaving the wrapper Transform/Group + GltfChild/clip satellites as orphan ghosts (#127/[[V27]] — the import footprint is a content-addressed group, GC it as a unit via `importGroupNodeIds`); bump before the OPFS mutation completes (stale list). Observe the REAL backend: unit test asserts file-absence (MemoryStorage), e2e asserts the OPFS _directory handle_ no longer resolves.

Provenance: ORIGIN = #112 (P7.14 Wave B), 2026-06-01; AMENDED #127 (2026-06-01) — break-refs now removes the whole content-addressed import footprint, not just the GltfAsset. WHY = without this ordered contract the next storage-backed asset move repeats the delete-before-verify orphan or the file-only-delete residue, and a break-refs delete leaves orphan wrapper/satellite ghosts. HOW = copy→verify→rewrite-refs(atomic)→deleteOpfsTree→bump; break-refs expands to `importGroupNodeIds` then disconnects-all-incident-then-removeNode-all in one atomic. REF: `src/app/asset/importCommon.ts` (`renameImportedAsset`/`deleteImportedAsset`/`deleteOpfsTree`/`listFilesDeep`), `src/core/import/gltfImportChain.ts` (`importGroupNodeIds`), `src/app/asset/importRefs.ts`, `tests/e2e/p7.14-my-imports-mgmt.spec.ts`, [[H60]] [[K6]] [[H57]] [[V13]] [[V27]]. Issues #112, #127.

### K15: Evaluated-mesh resolution lifecycle — migrate(hydrate) → evaluate → resolveEvaluatedMesh → (renderer | read-side) at the SAME ctx.time

**Sequence (v0.6 #1, #150):**

1. **migrate (on hydrate, once)** — `loadProject` → `migrateProjectFormat` → `ProjectSchema.parse` → `migrateNodes` (`src/core/project/io.ts:73-75`). BoxMesh/SphereMesh v1→v2 steps add `scale=[1,1,1]` BEFORE any evaluate or render. This MUST run first: a consumer reading `value.scale` on an un-migrated node relies on the `?? [1,1,1]` guard (the C-1 belt-and-suspenders), not on the migration alone.
2. **evaluate** — the node's pure `evaluate()` emits the value (BoxMeshValue now carries `scale`). Shared evaluator cache.
3. **resolveEvaluatedMesh / renderer** — BOTH consume at the SAME `ctx.time`: the renderer (`SceneFromDAG.tsx` BoxMeshR/SphereMeshR) applies `value.scale` on the `<mesh>`; the read-side (`resolveEvaluatedMesh` → gizmo/inspector) projects `transform.scale`. For GltfChild the resolver delegates to `resolveEvaluatedTransform` → `resolveGltfChildTrs` (one band).

**Common violation:** reading a new EvaluatedMesh band at a consumer BEFORE the migration/guard is in place, or at a DIFFERENT `ctx.time` than the renderer → displayed ≠ rendered ([[H40]]). The structural defense is the single resolver ([[V29]]) + the boundary-pair e2e that observes both sides at the same time. REF: `src/app/resolveEvaluatedMesh.ts`, `src/core/project/migrations.ts`, `src/viewport/SceneFromDAG.tsx`, dharana [[B14]]. Sibling of K13 (the imperative-playback cadence) — K15 is the resolution order, K13 the per-frame hot path.

**#151 extension (2026-06-04) — the BakedMesh authoritative-store sub-lifecycle: OPFS write-at-DISPATCH (awaited) + async suspense load-at-RENDER.** Apply-Transform (#151) adds the 4th producer (`BakedMesh`) and TWO new timing-sensitive steps that bracket K15's core sequence. They are ORDERED for reload-safety ([[V30]] — baked bytes are authoritative, not rebuildable):

**A. Apply DISPATCH (synchronous-then-awaited, ordered — the write side):**

1. **Resolve (sync)** — read the resolved transform via `resolveEvaluatedMesh(state, selectedId, ctx)`; for a glTF child also read the resolved geometry + POST-override material off the live mounted clone (`gltfCloneRegistry.getGltfClone(assetRef)` — the production-safe accessor, NOT the DEV seam, [[H65]]). Compose the masked (`all`/`location`/`rotation`/`scale`) 4×4 matrix.
2. **Clone + bake (sync)** — `srcGeom.clone()` THEN `applyMatrix4` ([[H45]] — never mutate the shared registry/clone instance), recompute normals on rotation/scale; capture the material scalars + texture refs READ-ONLY ([[H45]]/[[H59]] — the capture never writes the live clone material).
3. **OPFS write (async, AWAITED before step 4)** — `writeBakedGeometry(storage, baked)` + per-map `persistTexture(storage, tex)`. **All awaited BEFORE the Op composite** so a reload immediately after Apply finds the bytes (the reload-safe ordering — committing the node before the bytes exist would render an empty registry miss). The OPFS write is the single chokepoint ([[V20]]), a side effect at dispatch, NOT a DAG mutation ([[V1]]).
4. **Atomic Op composite (sync)** — ONE `proposeAndAccept`/`dispatchAtomic` ([[K6]] — one Cmd+Z): `addNode` BakedMesh + `connect`-before-`disconnect` (preserve sibling index) + `removeNode` original [for glTF: `+ setParam` GltfAsset.suppressedChildren so the source child renders ONCE]. Move selection to the baked id.

**B. RENDER load (async/suspense, NEW step before render — the read side):** `BakedMeshR` calls `useBakedGeometry(value.geometry)` (and `useBakedTexture` per map) — a suspense hook that, on a registry MISS, throws the in-flight OPFS-read promise (glTF-suspense analog, `opfsLoader.ts`), resolves via `readBakedGeometry`/`loadBakedTexture`, primes the registry, and re-renders to a hit. **The async lives in the renderer hook ONLY — the pure resolver stays sync** ([[V29]] purity; making the resolver async would break the gizmo/inspector sync consumers). BakedMeshR renders IDENTITY scale (the transform is in the verts — [[H40]] band-drift guard).

**Common violation (the new ones):** committing the BakedMesh Op composite BEFORE the OPFS write resolves → a reload-between-the-two finds the handle but not the bytes (registry miss, blank render, no error); making the resolver async to accommodate the load → breaks [[V29]] purity + every sync consumer; applying `value.scale` in BakedMeshR (the verts are already at world size — double-transform). REF (#151): `src/app/animate/dispatchApplyTransform.ts` (the dispatch ordering), `src/app/asset/bakedGeometryStore.ts`/`bakedTextureStore.ts` (the awaited writes), `src/app/asset/bakedGeometryLoader.ts`/`bakedTextureLoader.ts` (the suspense load), `src/app/asset/gltfCloneRegistry.ts` (the live-clone read), `src/viewport/SceneFromDAG.tsx` BakedMeshR, `tests/e2e/p151-apply-transform.spec.ts` (SC-3 reload-safe), [[V30]] [[V20]] [[K6]] [[H40]] [[H45]] [[H65]], dharana [[B14]]/[[B12]]. Issue #151.

## K16 — The render lifecycle: ONE offscreen production pipeline; the still renders ONE frame, the animation loops it over the timeline reusing one scratch (#168, #189)

**Why ordered:** a render is a deterministic product of the PROJECT, not the transient editor view (V37). Every render — still or animation frame — goes through the SAME offscreen path so the still and every frame have identical production parity (production camera + explicit resolution + chrome-excluded + ACES/DoF). The still is one invocation; the animation is the still LOOPED over the playhead. Getting the order wrong leaks chrome, renders the wrong camera, mutates the live viewport, or crashes the context.

**Sequence (the shared per-frame core — `renderSceneToImageCanvas`):**

1. **clamp resolution** — `clampRenderSize(gl, w, h)` (GPU max-texture fit, aspect preserved) — an oversized target loses the context.
2. **acquire scratch** — reuse the caller's `RenderScratch` (animation) iff res+samples match, else allocate a one-shot (still). The scratch owns the MSAA target + readback buffer + canvas + ImageData.
3. **hide editor chrome** — record + hide every `userData.editorChrome` object + the TransformControls gizmo (V37). Restore in `finally`.
4. **render** — DoF on → composer (RenderPass → DepthOfField+SMAA+ToneMapping); off → manual MSAA + `gl.toneMapping`. Read pixels into `scratch.readBuf`.
5. **flip + draw** — `flipRowsY` (GL bottom-up → top-down) → `scratch.imageData.data.set` → `putImageData` → return `scratch.canvas`. Renderer state restored in `finally`; the one-shot scratch is disposed, a reused one is NOT.

**Animation wrapper (`renderAnimationToFile` → `renderAnimation` loop):**

1. **read static config ONCE** — RenderOutput resolution+postFx, production camera pose+DoF (frozen-time evaluate). frameCount = `floor(durationSeconds·FPS)+1`.
2. **pick the sink** — MP4 (`createMp4Sink`: WebCodecs `isConfigSupported` probe → null → PNG-seq fallback + a surfaced warning, V38) or PNG-seq (fflate zip).
3. **pause playback + create ONE scratch** — pause so the rAF Clock doesn't fight `setTime`; one scratch for the whole render (the [[H99]] guard — per-frame allocation crashes the context).
4. **loop, per frame** — `setTime(f/fps)` → `waitForApply` (await 2 rAF so the live scene applies the new time) → `renderSceneToImageCanvas(opts, scratch)` → `sink.addFrame(canvas)` (consume the reused canvas BEFORE the next frame) → progress; abort-checked each iteration.
5. **finish + download** — `sink.finish()` → `downloadBlob`.
6. **ALWAYS restore (`finally`)** — dispose the scratch, restore the playhead to its pre-render time, resume play if it was playing, clear the progress store.

**Common violations:** allocating the render target/buffers PER FRAME instead of reusing one scratch → context crash on a long render ([[H99]]); rendering the editor orbit camera instead of the production camera, or at the window size not the explicit resolution ([[H68]] siblings, V37); not restoring `gl.toneMapping`/render-target/chrome-visibility in `finally` → the live viewport is left mutated; not restoring the playhead after the loop → the scrub jumps to the timeline end; consuming the reused scratch canvas AFTER the next frame already overwrote it (the sink must encode each frame before the loop advances). REF: `src/render/renderToImage.ts` (`renderSceneToImageCanvas`/`createRenderScratch`/`clampRenderSize`), `src/render/renderAnimation.ts` (the loop + sinks), `src/app/renderAnimationAction.ts` (the wrapper + restore), `src/app/renderImageAction.ts` (the still), `tests/e2e/p168-render-to-image.spec.ts` + `p189-render-animation.spec.ts`. Cross-ref [[H99]] (per-frame allocation crash), [[H68]] (blank-render trap), [[V37]]/[[V51]] (viewport↔render parity), [[V38]] (surface every outcome — the MP4 fallback warning + the toasts). Issues #168, #189.

## K17 — glTF material per-frame animation lifecycle: the override EFFECT establishes the cloned write-targets, the useFrame OVERLAYS each frame in a fixed precedence (base IR → channel → transient → re-tint LAST) (#188, #198)

**Why ordered:** glTF material animation splits a STRUCTURAL step (clone + assign materials — expensive, React effect) from a PER-FRAME step (overlay scalar deltas onto those live clones — cheap, `useFrame`), the SAME split as the TRS useFrame ([[K13]] sibling). Re-cloning per frame would churn GC. The per-frame overlay precedence is LOAD-BEARING: the MaterialOverride tint must be re-layered LAST so it wins for its forced channels (#198 composition), and the transient must sit above the channel so an Auto-Key-OFF held edit previews ([[V57]]). Get the order wrong → the animation clobbers the tint, the held edit doesn't preview, or the useFrame reads stale/absent write-targets.

**Sequence:**

1. **Override EFFECT (`[cloned, override, depNodeMap]`)** — clone each mesh material, overlay the captured base IR (`overlayDagMaterial`), apply the override tint/flatten. Record each animatable slot into `childSlotMaterials.current`: `{ mat }` (plain), `{ mat, reapplyOverride }` (non-flatten tint — #198 composition), or `null` (flatten / array-material). This MUST run before the useFrame reads the map; the bottom `useEffect([cloned, override, depNodeMap])` resets `lastMaterialApplied` so the next frame re-applies onto the fresh clones.
2. **useFrame, per frame** (frameloop "always") — early-out if no material channels. Snapshot live `seconds` + the transient SET via `getState()` (NEVER subscribe — [[H48]]). Dirty-check on `(seconds, channels, transients)` → a PAUSED unchanged scene pays nothing.
3. **Overlay precedence per child** — `overlayChannels({materials: base}, channels, 1, seconds)` (sampled curve) THEN `overlayTransients(…, childId, transients)` (held edit ON TOP, transient > channel) → `animated` materials.
4. **Write + re-tint** — for each slot: `applyOpenpbrScalars(slot.mat, openpbrToThree(animated[i]))` (animated base, in place — no clone) THEN `slot.reapplyOverride?.()` (re-layer the tint's forced fields LAST). `applyTintFields` deliberately omits `.wireframe` (the `[cloned,shading]` effect owns it).

**Common violations:** recording a tint slot as `null` → its channel/transient silently frozen (the pre-#198 limitation); re-tinting BEFORE writing the animated base → the channel value wins over the tint (inverted precedence); overlaying the transient BELOW the channel → a held edit doesn't preview; subscribing to time/transients in the useFrame instead of `getState()` → [[H48]] re-render storm; omitting `transients` from the dirty-check → a paused held edit never re-applies; re-applying `.wireframe` in the per-frame reTint → clobbers a wireframe toggle made during playback. REF: `src/viewport/SceneFromDAG.tsx` (GltfAssetR override effect + the material `useFrame` + `applyTintFields`/`tint`/`applyOpenpbrScalars`), `src/nodes/overlayChannels.ts`, `src/app/overlayTransients.ts` (generic `<T>`), `tests/e2e/p188-gltf-material-anim-boundary-pair.spec.ts` + `p198-channel-over-override-composition.spec.ts` + `p198-gltf-material-transient-preview.spec.ts`. Cross-ref [[V57]] (the direct-channel road + #198 enforcement), [[V53]] (one material IR), [[H40]] (displayed≠rendered), [[H104]] (the custom-control affordance gap the converged editor closes), [[K13]] (the TRS per-frame sibling). Issues #188, #198.

## K18 — The Compositor composite lifecycle: PLAN (pure: visibility + remap) → DECODE (impure, cached) → DRAW (back→top, opacity/transform/blend) at the comp playhead ([[V83]] spine 1d, #237)

**Why ordered:** the composite splits a PURE planning step (decide which layers draw + which source frame each shows) from an IMPURE pixel step (decode + draw), the SAME purity discipline as the evaluator↔renderer split. The plan is the ONE place the visibility (enabled/solo/trim) + comp-frame→source-frame remap rules live, so the live viewer and the export (1e) cannot drift ([[V37]] render==viewport). The DRAW order is LOAD-BEARING: layers paint **back→top** (the comp `layers` list is back→front = the draw order; the timeline shows it reversed for front-on-top display — three orderings that must agree, [[B24]]). Get the order wrong → wrong stacking; remap inlined instead of `mediaClipFrameAt` → preview drifts from source ([[H40]]); read raw params instead of `resolveEvaluatedParam` → keyframed opacity/rotation don't animate in the viewer.

**Sequence (per playhead frame / per change):**

1. **Collect inputs** (`collectCompositeInputs`, impure read) — walk the comp's `layers` (back→front) from the DAG; for each Layer read authored params + OVERLAY `opacity`/`transform.rotation` via `resolveEvaluatedParam` (the renderer-identical channel path — NOT raw params, [[H40]]); resolve the source MediaClip to its OPFS `path` + metadata (null when no decodable source yet).
2. **Plan** (`planComposite`, PURE) — drop layers with no source / hidden (the solo rule: if ANY layer solos, only solos draw; else the eyeball) / playhead outside the trimmed span (`layerBarSpan`). For survivors, remap comp frame → source-local seconds `(compFrame − startFrame + inPoint)/fps` → source frame via `mediaClipFrameAt` (the SAME map the evaluator uses; image → frame 0). Output is back→front, the draw order.
3. **Decode** (`ensureBitmap`, impure, cached) — for each planned draw, OPFS `storage.read(path)` → `MediaDecodeCapability.decodeFrame` → ImageBitmap, cached module-wide by `path#frame` (a still decodes once; a scrub re-plans but re-uses the cache). A decode failure → `console.warn` + skip (the layer is omitted, not a crash).
4. **Draw** (`drawComposite`, impure) — clear, fill the comp background, then for each draw back→top: `globalAlpha = opacity`, `globalCompositeOperation = blendOp(blendMode)`, translate to comp-centre + position, rotate, scale, draw the source FIT-CONTAINED + centered. A missing bitmap (still decoding) is skipped; the next redraw paints it. Then bump `nonce` (the "a frame completed" signal for the e2e).

**Common violations:** inlining the comp→source frame remap instead of calling `mediaClipFrameAt` → preview drifts from the source ([[H40]]); reading `node.params.opacity` instead of `resolveEvaluatedParam` → animated opacity is frozen in the viewer; painting front→back (or using the timeline's reversed display order) → inverted stacking; the export (1e) re-implementing the composite instead of reusing `planComposite`+`drawComposite` → viewer≠export ([[V37]] break); a decode error that blanks a layer with no surfaced reason ([[B24]] silent-blank — only `console.warn` today, surface to `assetErrorStore` as a follow-up); the module-global `bitmapCache` growing unbounded across a session (no eviction yet). REF: `src/app/video/composite.ts` (`planComposite`/`drawComposite`/`fitContain`/`blendOp` — the pure core), `src/app/video/CompositeViewer.tsx` (`collectCompositeInputs` + `ensureBitmap` + the draw effect), `src/nodes/MediaClip.ts` (`mediaClipFrameAt`), `src/core/media/` (decode capability), `src/app/resolveEvaluatedParam.ts` (the [[V57]] overlay), `src/app/video/composite.test.ts` + `tests/e2e/p-compositor-viewer.spec.ts`. Cross-ref [[V83]] (the epic invariant), [[V37]] (render==viewport), [[V57]] (evaluated overlay), [[H40]] (displayed≠rendered), [[B24]] (the boundary), [[K16]] (the 3D render lifecycle sibling). Issue #237.

## K19 — The ComfyUI keyframe→controller RENDER lifecycle (ingest → bind → bake → inject/write controller → submit → collect → stitch)

The ordered pipeline that turns a Basher-authored ComfyUIWorkflow layer into a rendered clip. **REWRITTEN 2026-06-30 (task 3):** the legacy inference-rewrite (classify→insert-schedule→rewire `BasherValueSchedule` + demotions) is DELETED; ONE transport (`basher_controller`+OUTPUT_IS_LIST) now serves both modes (the [[V81]] unification). Steps:

1. **Ingest** — `importComfyGraph(apiJson, meta)` (`comfyGraph.ts`) walks every node's LITERAL inputs → a LEAN param manifest with `valueKind` only (no scheduleHint/classification anymore). Pure, GPU-free, snapshot-tested. Links (`[id,idx]`) skipped — wired, not authored. (Mode A skips this entirely — `scanBasherControllers` reads only the author's `basher_controller` nodes.)
2. **Bind** — a free-floating `KeyframeChannel*` ([[V57]]) targets the node: Mode A at `controller:<nodeId>` (authored controller), Mode B at `comfy:<nodeId>.<inputName>` (foreign param). Authored in the Controls panel by valueKind dispatch ([[H104]]/[[H124]]); float/int/string keyframeable, enum/bool/structural read-only (`isStructuralParam`), image/video = media bind pickers.
3. **Bake** — sample each channel via the render-identical `resolveEvaluatedParam` ([[H40]]) over [frameStart,frameEnd] (or [0,N-1] when a bound video sets N, [[H128]]). Mode A: `bakeBasherControllerValues` (per controller). Mode B: `bakeComfyBatchedTracks` (per keyframeable SCALAR param → `InjectableTrack[]`). SAME sampler the dopesheet uses → no drift.
4. **Write/inject the controller** — Mode A: `writeBasherControllerValues` writes the baked array onto the AUTHORED controller (+ `writeBasherControllerFrameCounts` for bound video, [[H128]]). Mode B: `injectBasherControllers` AUTO-INJECTS a `basher_controller` per VARYING scalar track (kind by valueKind, `values_json`+`frame_count`) and rewires `inputs[name]=[bctl_<id>_<input>,0]`; a CONSTANT track substitutes the literal and injects NOTHING → an un-keyframed vanilla graph is the PASSTHROUGH (submits as-authored, no extension needed). Media inputs (image/video) travel OUT-OF-BAND via `applyComfyImageBindings` either way. NO classification, NO demotions, NO foreign-graph rewrite beyond the user-declared input.
5. **Submit** — `cap.submitBatch` (N frames); checks `comfyHasNodeTypes` first when controllers are present/injected (the extension must be installed — §16 Q-E) and uses `batchTimeoutMs` not the 30s single-frame budget ([[H126]]). (No injected/authored controller → skip the check → submit the plain graph.)
6. **Collect** — declared `basher_export` sinks → ONE MediaClip per export (`framesByNode`); else Http `submitBatch` gathers EVERY output image across nodes (a batched SaveImage emits N); the stub returns N deterministic frames.
7. **Stitch** — frames → `createMp4Sink` (the SAME 3D-render encoder) → OPFS → a project video MediaClip (`compileComfyBatch`), reusing the `saveRenderPassesToProject` on-ramp.

**Common violations:** introducing a SECOND keyframe sampler for workflow params instead of reusing `resolveEvaluatedParam` → render/dopesheet drift; resurrecting the inference path (walk/classify/rewire a foreign graph) instead of declaring control via a controller (the H121-class brittleness task 3 retired); injecting a controller for a CONSTANT param → needless extension dependency (the constant-skip IS the passthrough); reusing the single-frame timeout for the batch → abort-on-success ([[H126]]); collecting only the first output image in `submitBatch` → a batch returns one frame; routing a render failure to the view3d-covered banner instead of the app-root toast ([[H122]]). REF: `src/core/comfy/comfyGraph.ts` (lean ingest), `src/core/comfy/basherControllers.ts` (scan/write/INJECT controllers — the transport), `src/app/video/compileComfyBatch.ts` (bake + the action), `src/core/comfy/{Http,Stub}ComfyUICapability.ts` (submitBatch), `src/app/video/compositeDecode.ts` (static comfy-layer decode — no per-frame scrub compile), `custom_nodes/BasherSchedule/` (the MIT `basher_controller`/`basher_export`, separate repo). Cross-ref [[V81]] (the epic), [[V57]] (the channel road), [[K16]] (the 3D render lifecycle sibling), [[H40]]/[[H122]]/[[H126]]/[[H128]], dharana B24.

## K20 — The overlay-resolution render lifecycle: value-flow render tree ⊕ id-keyed overlay graph — SceneChildNode/RenderChild → OverlayDispatch → (ConstrainedR | DirectChannelsR | MeshChild) → container renderer → RenderChild (recursion) at ANY depth (#266 B1–B3, [[V88]] N6/N2, [[H144]])

**Why ordered:** an operator relationship (a Track-To constraint, a free-floating direct channel) is **edge-less in the value-flow/wire graph but edge-ful in the dependency/cook graph — two graphs over the same nodes** (the Houdini two-graph, `ref/GROUND_TRUTH_HOUDINI_OPERATORS.md` §0). The render tree threads VALUES (`SceneObject`s) but drops node-ids at every nesting boundary (`GroupR`/`TransformR` render children by value, id-less). An overlay is keyed by a `target` node id that lives OUTSIDE the wire graph — so it must be resolved by FLAT-ID LOOKUP against a membership set, NEVER by walking the render tree (walking = the pre-#266 nested no-op, [[H144]]). Get the order wrong → a nested constrained/channeled node silently renders its authored value (no error), OR the whole subtree re-renders per frame (H48 storm), OR a newly-added overlay never mounts until an unrelated edit (stale receiver, N2).

**Sequence (SceneFromDAG render):**

1. **Build membership ONCE (O(N), before the early return so it's a hook)** — `directChannelTargetSet(state.nodes)` + `constraintTargetSet(state.nodes)`: the flat id sets of every node driven by a free-floating channel / an active Track-To. Per-child test is then O(1), never O(N²) ([[B13]]).
2. **Synthesize the dependency edge (B2)** — compute `overlaySig` = sorted-join of the two sets (a CONTENT signature). `useMemo` the `OverlayMembershipContext` value on `[overlaySig]` (exhaustive-deps intentionally skipped — the sig IS the content dependency). Provide via `<OverlayMembershipContext.Provider>`. This memoized context ref IS the edge-less overlay's synthesized edge into React's dependency graph.
3. **Top-level children** — map `value.scene.children[i]` → node id via `childRefs[i].node` (index-correspondence with the Scene aggregator's `inputs.children`); render each `SceneChildNode` with PRE-BUILT boolean membership props (`hasDirectChannels`/`isConstrained` tested against the sets directly — the top level needs no context).
4. **Dispatch (B3, the ONE shared branch)** — both `SceneChildNode` (top-level) and `RenderChild` (nested) funnel into `OverlayDispatch`: `isConstrained && nodeId` → `ConstrainedR` (derived aim, [[V60]], takes precedence); else `hasDirectChannels && nodeId` → `DirectChannelsR` ([[V57]] channel overlay); else → `MeshChild` (the bare value-flow, id-threaded but un-overlaid).
5. **Overlay renderers re-emit MeshChild(patched, nodeId)** — `ConstrainedR`/`DirectChannelsR` apply their overlay then render `MeshChild(patchedValue, nodeId)`, so a constrained/channeled CONTAINER still recurses with its nodeId intact (value-flow and overlay stay separate concerns, B3).
6. **Container recursion (B1, the nested seam)** — `MeshChild` → `GroupR`/`TransformR`/`MaterialOverrideR` resolve each child's node id via `childEdges(state, nodeId, value)` (the EXPORTED value→id map from `resolveWorldTransform` — reuse the proven walk, do NOT author a second, Chesterton) and render each through `RenderChild`.
7. **RenderChild does the flat-id lookup** — `useContext(OverlayMembershipContext)` → `directChannelTargets.has(nodeId)` / `constraintTargets.has(nodeId)` → back to `OverlayDispatch` (step 4). Recursion continues at any depth. A child with NO id (should never happen — every rendered child comes from an edge) degrades to the bare `MeshChild`.
8. **The B2 re-mount trigger** — adding/removing an overlay ANYWHERE flips `overlaySig` → the memoized context ref changes → every mounted `RenderChild` re-runs `useContext` → a newly-overlaid nested target mounts its overlay THIS render. A non-membership edit (a param tweak) keeps the sig stable → the context ref is identity-stable → nested `RenderChild`s bail ([[H48]]/[[B13]] preserved — the subtree is NOT re-rendered per frame).

**Common violations:** resolving a nested overlay by WALKING THE RENDER TREE (threading the id through `GroupR`/`TransformR`) instead of flat-id lookup → the walk drops ids at nesting → nested no-op ([[H144]] — Houdini's lesson is _don't traverse the tree at all_ for overlay targeting); memoizing the context on identity / rebuilding it each render without the content sig → EITHER the nested overlay never re-mounts (stale, N2) OR every `RenderChild` re-renders on every param edit (H48 storm); subscribing to time inside a container renderer → per-frame subtree re-render ([[H48]]/[[B13]]); an overlay renderer that re-emits `MeshChild` WITHOUT threading `nodeId` → a constrained/channeled container's descendants lose their ids → their own nested overlays silently degrade to bare value-flow; authoring a SECOND value→id walk instead of reusing the exported `childEdges` (Chesterton — the resolver already trusts that one, `resolveWorldTransform.ts:166`). REF: `src/viewport/SceneFromDAG.tsx` (`OverlayMembershipContext`/`overlaySig`+`useMemo` `SceneFromDAG.tsx:145-216`, `OverlayDispatch` `:1459-1480`, `RenderChild` `:1492-1511`, `GroupR`/`TransformR`/`MaterialOverrideR` `childEdges` call sites `:3094-3181`), `src/app/resolveWorldTransform.ts` (`childEdges` exported `:166`), gated by `tests/e2e/p266-nested-overlay.spec.ts`. Cross-ref [[H144]] (the two-graph pattern — the render-vs-read boundary), [[V88]] (N6 edge-less overlay mounts by lookup / N2 stale receiver), [[V45]] (nested-constraint KNOWN-LIMIT → IMPLEMENTED), [[V57]] (the direct-channel road), [[V60]] (Track-To aim), [[K13]] (the per-frame hot-path sibling — this is the STRUCTURAL mount lifecycle, K13 the per-frame overlay). **KNOWN-LIMIT (#268):** the READ side (`resolveEvaluatedTransform` gizmo/inspector) still matches TOP-LEVEL scene children only — a nested constrained/channeled node's gizmo shows the authored value while this render lifecycle shows the overlay ([[H40]] at depth). Issues #266, #267.

## K21 — The channel-fold resolution lifecycle: per (target,param), acc=base → contributions ordered bottom→top by `order` → `foldChannelValue(blend[mode])` per contribution → written once (#283 Phase 1 NLA, [[V88]] I-2/I-4/I-5)

The multi-writer composition order, run IDENTICALLY by the renderer (`overlayChannels`) and the compositor/inspector read seam (`resolveEvaluatedParam`) so render == read == compositor (H40, one reducer).

1. **Base snapshot** — `acc = base` (the node's cloned param value at `paramPath`). Empty contribution list ⇒ `acc` returned verbatim ⇒ byte-identical to pre-#283.
2. **Group by paramPath** — all channels targeting ONE param fold together; different params fold independently (separate slots, cross-param order irrelevant).
3. **Stable-sort by `order`** (default 0 → DAG/insertion order preserved; `Array.sort` stable ES2019+). This is the bottom→top strip stack; reorder ⇒ different result, but DEFINED (never scan-order-dependent — the V88 D3 fix).
4. **Fold each contribution** — `acc = blend[mode](acc, sample, identity, influence, valueType)`; `inf==0` short-circuits to `acc` (muted/zero-weight). Replace = lerp (quat slerp); Combine = additive / scale-multiply / quat-manifold over the per-TYPE identity.
5. **Write once** — `writeAt(clone, paramPath, acc)`.

**The critical ordering dependency:** the fold is SEQUENTIAL over `acc` — a Replace at the top wins; a Combine adds onto whatever is below it. The base MUST be captured BEFORE the loop, and the Combine reference is the per-TYPE identity (0/1/quat-id), NOT the running `acc` ([[V88]] I-4 — the two-reference trap). **Common violations:** expecting order-independence from Replace (only additive Combine is commutative); folding without the per-type identity → a full-influence Combine over the empty stack ≠ the source; unstable sort → default-order-0 channels flicker; wiring the fold into ONE consumer (render) but not the other (read/compositor) → render≠read for stacked params; componentwise quaternion blend (I-5 — wobble for ≥2 stacked rotations). REF: `src/nodes/foldChannel.ts` (`foldChannelValue`/`blendOne`/`combineBlend`), `src/nodes/overlayChannels.ts:53-78` (group→sort→fold→write), `src/app/resolveEvaluatedParam.ts` (collect-all→fold), `src/nodes/quatMath.ts` (the shared slerp). Gated by `foldChannel.test.ts` + `overlayChannels.test.ts` (stacking) + `resolveEvaluatedParam.test.ts` (fold-not-first-match) + the live :5180 boundary-pair (n_box + two Combine channels → render==read==additive SUM). Cross-ref [[V88]] (I-2/I-4/I-5), [[K20]] (the mount lifecycle this fold runs INSIDE), [[K13]] (the per-frame overlay sibling), [[H40]] (one reducer, all consumers), [[V57]] (the channel road), dharana [[B26]]. Branch `ux-overhall`.

**PHASE 2 EXTENSION (#283, Action/Strip/Track) — the contribution list now includes STRIPS, enumerated BEFORE the fold (`src/app/layeredChannels.ts`):** a pre-step 0 runs the track-driven strip scan that FEEDS the same steps 1-5 above (strips enter as synthetic `KeyframeChannelValue`s; the reducer is untouched):

- **0a. Enumerate tracks** bottom→top by `Track.order` (tie-break node id); a track with `mute` drops; if ANY track soloes, non-solo tracks drop (global solo).
- **0b. Per track, per strip (array order)** — skip if already emitted (single-owner: lowest-order track wins), if `strip.muted`, if `strip.target≠targetId`, or if its Action is missing/empty. Mute/solo are applied HERE (at enumeration) so BOTH seams receive already-gated values → render==read for mute, free.
- **0c. Per Action-channel** — emit one synthetic channel value: `order = trackRank·1000 + stripIndex` (feeds step 3's sort), `weight = clamp01(strip.influence)`, `blendMode = strip.blendMode`, `sample(s) = channelEvaluate(ch).sample(remapStripTime(s, placement))` (the strip retime BEFORE the channel's own sampler — a two-stage time pipeline). Touched-domain (I-3) is free: a strip emits values only for the params its Action keys.
- **The critical ordering:** the strip retime (`remapStripTime`, K-new) composes BEFORE the F-Modifier time phase (`resolveSampleTime`) inside the channel sampler — global→strip-local→action-F-modifier-local. **Common Phase-2 violations:** enumerating strip-driven but not gating mute/solo at enumeration → render (gated by membership mount) ≠ read; folding strips into render but not the read seams (`resolveEvaluatedTransform` for transform params, `resolveEvaluatedParam` for the rest) → the one-consumer trap; a strip in two tracks double-folded (needs the seen-set dedupe). REF: `src/app/layeredChannels.ts` (`stripChannelValuesForTarget`/`layeredChannelValues`), `src/app/stripRetime.ts` (`remapStripTime`), `src/viewport/SceneFromDAG.tsx` (`useLayeredChannels` render seam), `src/app/resolveEvaluatedTransform.ts:230` + `resolveEvaluatedParam.ts` (read seams). Gated by `layeredChannels.test.ts` + `stripRetime.test.ts` + `tests/e2e/nla-strip-{render,boundary-pair}.spec.ts`.

**PHASE 3 EXTENSION (#283, crossfade) — the fold influence is now a FUNCTION OF TIME:** step 4's `influence` scalar, formerly baked once at enumeration (`weight = clamp01(strip.influence)`), is now `ch.influenceAt(sampleTime)` WHEN the contribution carries an `influenceAt` closure, else the static `weight`. `syntheticChannelValue` (step 0c) attaches `influenceAt` ONLY when the strip authors a crossfade (`blendIn>0||blendOut>0`) — an `effectiveInfluence` ramp over `[start, start+actLen·timeScale·repeat]` — else omits the key (byte-identical static path). BOTH fold consumers evaluate `influenceAt` at THEIR sample time in LOCKSTEP: render `overlayChannels.ts:82` (`seconds`, ×caller weight), read `resolveEvaluatedParam.ts:103` (`ctx.time.seconds`, ×1). **New critical ordering:** the single-match read fast path (`resolveEvaluatedParam.ts:91`) MUST be BYPASSED when the lone match carries `influenceAt` (guarded on `!influenceAt`) — else it returns the raw sample, skipping BOTH the influence AND the toward-base fold → render≠read for a lone crossfading strip. **Common Phase-3 violations:** threading `influenceAt` into one fold twin but not the other (the H40 twin desync — invisible until a crossfade); leaving the `:91` fast path un-guarded (the lone-strip bypass); attaching `influenceAt` to a plain hold strip (`effectiveInfluence` zeroes OUTSIDE the range → breaks Phase-2 hold-past-end — attach only for authored crossfades). REF: `src/nodes/types.ts` (`KeyframeChannelValueBase.influenceAt`), `src/app/layeredChannels.ts` (`syntheticChannelValue` ramp build), `src/nodes/channelModifiers.ts:295` (`effectiveInfluence`), `src/nodes/overlayChannels.ts:82` + `src/app/resolveEvaluatedParam.ts:91,103` (the twin + guard). Gated by `src/app/nlaInfluence.test.ts` (6 cases incl. the site-#2 :91/:103 coverage) + `tests/e2e/nla-{retarget,fade,crossfade}.spec.ts`.

**PHASE 4 EXTENSION (#283, agent mutators) — the AUTHORING lifecycle that PRODUCES the strip contributions (`src/agent/mutators/builders/{createAction,addStrip,setStripTiming,setStripBlend,setTrackState}.ts`):** the ordered sequence an agent runs to build the graph steps 0-5 above then fold. **1. `createAction`** — mint an immutable, target-less Action (a relative-path channel bundle); nothing renders yet (I-1: the source is inert until placed). **2. `addStrip`** — REQUIRES an existing Action (`requiredNodeTypes:['Action']`), binds it to a `target`, and MUST land the strip in a Track (auto-creating one when `trackId` is omitted): a strip is INVISIBLE until a Track references it in `strips` (`layeredChannels.ts:174` `track.params.strips.forEach` — step 0b enumerates strips ONLY via tracks), so a strip with no track never reaches the fold → render==read is unobservable. The array append is a read-current-then-`setParam(Track,'strips',[...prev,stripId])` (whole-array replace; the Track is the single owner of its strip order). **3. `set{StripTiming,StripBlend,TrackState}`** — edit the placement (start/timeScale/repeat/reverse), blend (blendMode/influence/blendIn/blendOut → the Phase-3 `influenceAt` seam), or track state (order/mute/solo → step 0a/3 ordering + gating). **Common Phase-4 violations:** an `addStrip` that leaves the strip out of any track → invisible strip (the render==read gate cannot even run — a false "broken" reading); the auto-create-Track `addNode` emitted AFTER the `strips` setParam → the fresh track not yet in `introducedIds` at gate-3 (emit the Track addNode BEFORE the setParam); a `set*` mutator whose zod `.refine("≥1 field")` is NOT re-guarded in `preconditions` → a validatePlan-direct caller (tests, the #22 probe) bypasses safeParse → empty-ops silent no-op ([[feedback_precondition_seed_truth]]); dispatching against `useDagStore` but asserting only "no throw" in e2e → a gate-rejected `{ok:false}` (which does NOT throw, `dispatchMutator.ts:80-121`) leaves the DAG unchanged and the failure is mis-attributed to the fold (assert `res.ok`). REF: the five builders + `src/agent/mutators/mutators.test.ts` (V14 signature + #22 op-shape probe + behavior), `src/app/animate/dispatchMutator.ts` (`dispatchMutatorFromUI` five-gate path), `tests/e2e/nla-mutator-{place,edit,track}.spec.ts` (render==read via `__basher_dispatchMutator`). Cross-ref [[V88]] D2, [[H36]] (the create-collision the mutator set designs around), dharana [[B26]].

**PHASE 5 EXTENSION (#283, NLA-lane UI) — the UI-GESTURE step that FEEDS the same authoring lifecycle (`src/timeline/NlaLanePane.tsx` + `nlaCommit.ts`):** a director gesture runs pointerdown (lane width measured ONCE into the drag record) → pointermove = PREVIEW ONLY (component-local state; the DAG is untouched; `NLA_DRAG_THRESHOLD_PX` gates click-vs-drag) → ONE `dispatchMutatorFromUI` at pointerup (the SAME `setStripTiming`/`setStripBlend`/`setTrackState`/`addStrip` ops the agent dispatches — step 1-3 of the Phase-4 sequence; strip `muted` = the one sanctioned raw setParam) → the store re-derivation is the rendered truth (the preview is DISCARDED; `nlaLaneModel.buildNlaLanes` mirrors the step 0a-0c enumeration read-only, drift-guarded by its parity test against `layeredChannelValues`). The 5D popover/inspector follow the same shape: draft field state → ONE dispatch at commit-on-blur-or-Enter. **Phase-5 violations:** dispatching per pointermove (undo spam — one gesture must be ONE undo entry); trusting the preview after a `{ok:false}` rejection (the DAG is byte-unchanged — re-render from the store, surface the reason via `useNotificationStore`, never freeze the preview as if it committed); the view deriving rows from its own bookkeeping instead of the node table (mirror drift — the parity gate exists so the display can never disagree with the fold silently). **The 5E "push down" step — the one director road that MINTS an Action:** the selected object's bare channels → `createAction` (explicit actionId, validated vs BASE) → fork → `addStrip {start: min key time}` (validated vs the FORK — the Action only exists there; start==actStart makes the strip remap the identity inside the key span) → fork → `mutator.deleteNode` on every bare channel id (validated vs the twice-evolved fork) → union-closure → ONE propose→accept = ONE undo entry (`dispatchPushDownToStrip`, the `dispatchBakeThenRetime` fork-evolve pattern — a COMPOSITE over the shipped vocabulary, NOT a new mutator). **Push-down violations:** deleting the channels in a SECOND dispatch = half-revertable undo (undo restores the channels but leaves the strip → double-drive); NOT deleting them at all = immediate double-drive (bare channels fold below strips, `layeredChannels.ts:224-226`); silently mapping a channel whose state the placement overrides (mute/weight/blendMode/order/extend≠hold/F-Modifiers/per-axis) instead of REFUSING by name — the fold would differ outside the key span or in the blend (the honesty guard in `bareChannelToActionChannel`). REF: `src/timeline/{NlaLanePane.tsx,nlaCommit.ts,nlaLaneModel.ts,nlaLaneGeometry.ts}`, `src/app/animate/dispatchMutator.ts` (`dispatchPushDownToStrip`), `tests/e2e/nla-lane-{gesture,authoring}.spec.ts`, `tests/e2e/nla-push-down.spec.ts` (byte-identical before/after + one-undo). Cross-ref [[V88]] D2 Phase 5, dharana [[B26]].

**Common violations:** introducing a SECOND keyframe sampler for workflow params instead of reusing `resolveEvaluatedParam` → render/dopesheet drift; resurrecting the inference path (walk/classify/rewire a foreign graph) instead of declaring control via a controller (the H121-class brittleness task 3 retired); injecting a controller for a CONSTANT param → needless extension dependency (the constant-skip IS the passthrough); reusing the single-frame timeout for the batch → abort-on-success ([[H126]]); collecting only the first output image in `submitBatch` → a batch returns one frame; routing a render failure to the view3d-covered banner instead of the app-root toast ([[H122]]). REF: `src/core/comfy/comfyGraph.ts` (lean ingest), `src/core/comfy/basherControllers.ts` (scan/write/INJECT controllers — the transport), `src/app/video/compileComfyBatch.ts` (bake + the action), `src/core/comfy/{Http,Stub}ComfyUICapability.ts` (submitBatch), `src/app/video/compositeDecode.ts` (static comfy-layer decode — no per-frame scrub compile), `custom_nodes/BasherSchedule/` (the MIT `basher_controller`/`basher_export`, separate repo). Cross-ref [[V81]] (the epic), [[V57]] (the channel road), [[K16]] (the 3D render lifecycle sibling), [[H40]]/[[H122]]/[[H126]]/[[H128]], dharana B24.
