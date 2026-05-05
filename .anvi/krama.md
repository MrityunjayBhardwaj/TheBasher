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

**REF:** THESIS.md §19
**Why it matters:** the Diff-first contract is the trust contract with the user. Break it once and the agent is disabled.

### K4: Render job lifecycle (P4)

**Steps:**

1. User triggers render (UI button OR agent `render.shot` macro).
2. RenderJob node added to DAG with frame range, fps, output dir, pass list.
3. Job worker walks frames sequentially.
4. For each frame: set `Time` input → evaluate `scene` → for each pass: clone scene with material override → render to off-screen target → readback → encode → write file.
5. Update progress UI per frame.
6. On completion: finalize manifest; emit "render finished" event.
7. On failure: persist last-good-frame index; allow resume.

**Common violations:**

- Reading "current viewport time" instead of frame-N time → render and viewport diverge.
- Reusing material override targets across passes → race conditions, wrong colors.
- Encoding on main thread → frame budget blown, viewport drops to 5fps during render.
- No resume support → user re-renders 240 frames after one OOM.

**REF:** THESIS.md §27, §43
**Why it matters:** P4 is the production-quality milestone. Users measure trust by render reliability.

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
