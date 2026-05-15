# Hetvābhāsa — Error Patterns

> Empty at project start. Patterns accumulate as bugs are diagnosed and fixed. Every fix that took >1 attempt OR revealed a non-obvious root cause MUST be cataloged here.

## Format

```
### H<N>: <short pattern name>

**Symptom:** what the user sees
**Trap:** the wrong fix (the one that "feels right" but doesn't address root cause)
**Root cause:** the actual mechanism
**Real fix:** what works
**Detection signal:** the early symptom that distinguishes this from look-alikes
**REF:** Ground Truth doc + file:line citations
**Origin:** session/date when first observed
```

## Predicted patterns (forward-looking, from THESIS.md §57)

These are not yet cataloged from real bugs — they are pre-mortem predictions. Promote to formal entries once observed.

- **Pure-flag lying** — node declares `pure: true` but reads `Math.random` or `Date.now`; cache corrupts; bugs look random.
- **Time-as-closure** — node captures time via `useFrame` closure instead of `Time` socket; render-frame-N ≠ viewport-at-time-T.
- **Op bypass** — direct `dagStore.setState` outside dispatcher; undo no-ops, agent control breaks at this node type.
- **Agent tool-call drift** — agent calls tool with valid-looking but wrong-shape params; zod rejects; agent loops trying same call.
- **OPFS quota silent fail** — save returns success but data truncated; reload loses last changes.
- **Capability leak** — code assumes desktop fs and breaks in web build (or vice versa); discovered at production time.
- **Triplex JSX-as-truth leak** — code expects Triplex's scene model; breaks because DAG is the truth, JSX is a view.

---

## Cataloged patterns

### H1: Vite scaffolder cancels silently on non-empty directory

**Symptom:** `npm create vite@latest .` exits with "└ Operation cancelled" — no error code, no diagnostic; Vite-shaped files never appear.
**Trap:** assume the scaffolder failed because of a missing flag; try `--yes`, `--force`, piped `printf 'y\n'`. None work — the prompt is interactive-only.
**Root cause:** `create-vite` refuses to overwrite a directory that already contains files (THESIS.md / .anvi/ / NEXT_SESSION.md in our case). It has no non-interactive override.
**Real fix:** write the Vite skeleton (package.json, vite.config.ts, tsconfig.{,app,node}.json, index.html, src/main.tsx, src/index.css, src/vite-env.d.ts) by hand. Cheap; gives full control. Avoids the "preserve THESIS.md" race.
**Detection signal:** "Operation cancelled" with no other output, even with `--yes` flag.
**REF:** P0 Wave A (2026-05-05).

### H2: Vite dep-scan walks unrelated subdirectories with index.html

**Symptom:** `npm run dev` fails with `The following dependencies are imported but could not be resolved: dist/bundle.js (imported by /path/to/blockbench/index.html)`.
**Trap:** assume the bundle is a real Basher dep; chase the missing file.
**Root cause:** Vite's `optimizeDeps` scanner crawls every `index.html` in the project root looking for entry points. The GPL `blockbench/` reference checkout has its own `index.html` referencing files that don't exist in our tree.
**Real fix:** scope the scan with `optimizeDeps.entries: ['index.html', 'src/**/*.{ts,tsx}']` AND `server.fs.deny: ['blockbench/**']`. The `.gitignore` exclusion is necessary but NOT sufficient — Vite scans the working tree, not just tracked files.
**Detection signal:** dep-resolution errors naming a file in a sibling directory you didn't import.
**REF:** P0 Wave F (2026-05-05); `vite.config.ts`.

### H3: Local port collision with another dev server

**Symptom:** Playwright tests all fail with "Layout testid not found"; the page snapshot shows an entirely different app's UI ("View / Visuals / Samples / Prefs / SonicPi.js").
**Trap:** assume our app's layout broke; debug React rendering, hydration, boot order — none of which is the issue.
**Root cause:** Vite's default port 5173 was already held by another local project. With `strictPort:false` (the default), Vite silently fell through to 5174. Playwright was still pointed at 5173 and got the OTHER project's HTML.
**Real fix:** pin a project-specific port (5180) and set `strictPort: true` so Vite refuses to fall through. Match `playwright.config.ts` baseURL + webServer URL to the same port.
**Detection signal:** test failures whose page-snapshot HTML doesn't look like your project at all.
**REF:** P0 Wave H (2026-05-05); `vite.config.ts:18`.

### H4: TypeScript Uint8Array<ArrayBufferLike> rejected by lib.dom BlobPart

**Symptom:** `tsc -b` fails with "Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'. Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'."
**Trap:** add `as BlobPart` cast — works but lies about the runtime type.
**Root cause:** Modern TS lib.dom typings constrain Blob/WritableStream inputs to `Uint8Array<ArrayBuffer>` specifically (excluding `SharedArrayBuffer`). Generic Uint8Array is widened to `Uint8Array<ArrayBufferLike>` which the strict typing rejects.
**Real fix:** copy through a fresh `ArrayBuffer` before constructing the Blob: `const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes); writable.write(new Blob([ab]));`. Costs one allocation; produces a value the strict typing accepts.
**Detection signal:** `BlobPart` / `WritableStream` write rejections specifically mentioning `SharedArrayBuffer`.
**REF:** P0 Wave C (2026-05-05); `src/core/storage/OpfsStorage.ts:52`.

### H5: zod `.default()` widens input type beyond `z.ZodType<P>`

**Symptom:** `paramSchema: z.object({ foo: z.number().default(1) })` fails to satisfy `paramSchema: z.ZodType<P>` because the schema's input allows `undefined` (which gets defaulted) while the output P does not.
**Trap:** make P include `| undefined` everywhere — propagates noise through the entire codebase.
**Root cause:** `z.ZodType<P>` defaults to `z.ZodType<P, ZodTypeDef, P>` (input == output). `.default()` makes input wider than output.
**Real fix:** widen the contract: `paramSchema: z.ZodType<P, z.ZodTypeDef, unknown>`. The boundary parses unknown bytes (the JSON we loaded, the agent's tool args) into a defaulted `P`. Internal code reads the strict P; external bytes are validated and filled at the seam.
**Detection signal:** `_input.foo` types are `T | undefined` but the schema's output type doesn't include undefined.
**REF:** P0 Wave D (2026-05-05); `src/core/dag/types.ts:65`.

### H6: Pixel-diff baseline corrupted by overlay text that updates every frame

**Symptom:** Reference screenshot for PostFx beauty fails on second run with high pixel-diff ratio even though the cube renders identically.
**Trap:** loosen `maxDiffPixelRatio` until tests pass — masks a real regression-detection signal.
**Root cause:** the FpsMeter overlay shows live frame stats inside the same DOM node we screenshot; its text changes every 500ms, so the diff is dominated by font-anti-alias differences in a 5px region.
**Real fix:** Playwright's `mask: [page.getByTestId('fps-meter')]` blacks out the overlay region during diff comparison. Keep the strict 2% threshold for the rendered geometry.
**Detection signal:** screenshot diff hot-spots concentrated in a small text region; rendered geometry pixels match.
**REF:** P0 Wave H (2026-05-05); `tests/e2e/acceptance.spec.ts:171`.

### H7: Uncontrolled `defaultValue` inputs silently desync from the store

**Symptom:** Inspector input field continues to show the pre-undo value after Cmd+Z (or any external param mutation — agent op, project reload). Acceptance test #5 still passes because it only writes through the input, never reads.
**Trap:** assume "the test passes so the binding is fine"; ship and discover the divergence the moment undo gets a UI binding.
**Root cause:** `<input defaultValue={value} onChange={...} />` is uncontrolled — React sets the DOM value once on mount. Subsequent renders DO NOT propagate `value` changes to the DOM. The store updates, the visible input doesn't.
**Real fix:** controlled inputs everywhere — `value={value}` keyed off a `useDagStore` selector, `onChange` dispatches `setParam`. Costs zero perf in zustand (selector-driven re-render only when the param changes).
**Detection signal:** input field value matches initial render but not subsequent store mutations from non-input sources. Use a focused regression test that mutates state from outside the input and asserts the input updates.
**REF:** P0 self-review (2026-05-05); `src/app/Inspector.tsx:21`; regression test `tests/e2e/acceptance.spec.ts` #10.

### H9: three.js GLTFExporter requires FileReader (DOM polyfill) in Node

**Symptom:** A one-shot `npm run seed:assets` script (Node 22) fails with `ReferenceError: FileReader is not defined` deep inside `three/examples/jsm/exporters/GLTFExporter.js` — even when emitting JSON `.gltf` (not binary `.glb`).
**Trap:** Switch from `binary: true` to `binary: false` and assume the FileReader path is binary-only — both code paths (lines ~581 and ~629 in three v0.169) use FileReader to encode buffer data-URIs, regardless of the format.
**Root cause:** GLTFExporter encodes embedded BufferViews via `new FileReader().readAsDataURL(blob)`. Node has `Blob` globally since v18 but never had `FileReader`. The exporter is "browser-first" and assumes the DOM Reader is present.
**Real fix:** polyfill `globalThis.FileReader` with a tiny class that converts a Blob to a base64 data URL via `Buffer.from`. Eight lines of polyfill code; works for both binary and JSON paths.
**Detection signal:** `ReferenceError: FileReader is not defined` thrown synchronously from `GLTFExporter.js`.
**REF:** P1 Wave B (2026-05-05); `scripts/seed-sample-assets.mjs:11-23`.

### H10: zustand `getState()` snapshot is stale across async hops

**Symptom:** Playwright test passes locally on the first store mutation but fails the second time it reads from `dag.state` — the second read returns the pre-mutation values.
**Trap:** Cache `const dag = w.__basher_dag.getState()` at the top of `page.evaluate` and re-use `dag.state` across multiple dispatch calls. The dispatches succeed but every read shows stale data.
**Root cause:** zustand's `getState()` returns the slice/snapshot at call time. Subsequent mutations create a new state object; the old reference is frozen. `dag.state` and `dag.dispatch` are the same closure but `state` is a value, not a getter.
**Real fix:** call `getState()` again after every mutation, or read the live value via `useDagStore.getState().state.nodes[id]` each time. Treat the store handle as a function, not a snapshot.
**Detection signal:** test setup adds nodes via dispatch but the assertion reads `state.nodes[id]` and gets `undefined` despite `dispatch` having been called.
**REF:** P1 Wave E (2026-05-05); `tests/e2e/p1-acceptance.spec.ts` P1#3.

### H12: declarative camera position prop fights OrbitControls

**Symptom:** OrbitControls drag rotates the editor camera, but the moment any zustand store mutates (e.g. timeStore tick, dispatch), the camera SNAPS back to the angle declared by the DAG's PerspectiveCamera node. The user can't keep a custom view while scrubbing time.
**Trap:** assume OrbitControls is the bug; tinker with `enableDamping`, `target.copy(...)`, `enabled` flag. None work — the snap is happening on every React render of the camera component, not from controls' own update loop.
**Root cause:** drei's `<PerspectiveCamera position={...}>` re-applies the position prop on every render. Even when `value.position` is the same array values `[3, 2, 3]`, the evaluator returns a fresh tuple identity each pass — so React re-renders the camera, the prop assignment runs, and the camera snaps back. OrbitControls then has to fight back to its drag-set pose every tick.
**Real fix:** drop the `position` prop. Use a ref + `useEffect` keyed on the PRIMITIVE scalars (`px, py, pz, lx, ly, lz`) rather than the array reference. Effect fires only when the actual values change (legitimate DAG param edits) — not on every re-render. OrbitControls owns the camera between authentic param changes.
**Detection signal:** OrbitControls works for one frame, then the camera snaps to a fixed pose. Ratio of "snap" to "settle" matches the ratio of store mutations.
**REF:** P2 Wave C / viewport-polish (2026-05-06); `src/viewport/SceneFromDAG.tsx` PerspectiveCameraNode + OrthographicCameraNode.

### H11: data-testid on R3F primitive elements crashes the Canvas

**Symptom:** All Playwright specs fail with `Cannot read properties of undefined (reading 'testid')` thrown synchronously from inside R3F's reconciler. The page renders the boot screen, then the Canvas Suspense boundary catches and the layout never appears.
**Trap:** assume the test infrastructure broke; check Vite, Playwright versions, port pinning. Wrong layer — the failure is in production code that crashes during Canvas render.
**Root cause:** R3F primitive elements (`<mesh>`, `<group>`, `<planeGeometry>`) are NOT DOM nodes — they are THREE objects. R3F's reconciler routes JSX props through `applyProps` which assumes any unknown prop is a property path on the THREE instance. `data-testid` gets split / parsed and dereferences `undefined.testid` deep in the path resolver.
**Real fix:** use `userData={{ basherTestid: 'ground-click' }}` instead. THREE.Object3D has a `userData` field that accepts arbitrary serializable bags. Tests that need to introspect drive through `__basher_dag` / `__basher_evaluate` (the dev-only window seam) — H3's pattern, generalized.
**Detection signal:** "Cannot read properties of undefined (reading 'X')" where X is the second segment of a `data-X` attribute, throwing from a stack frame inside chunk-PWGZE4B4.js (R3F reconciler).
**REF:** P2 Wave E (2026-05-06); `src/app/character/GroundClick.tsx:42`.

### H15: Conditional R3F render gated on a ref silently breaks on remount

**Symptom:** Selecting an object shows the gizmo. Deselecting hides it. Re-selecting the SAME object — gizmo never reappears, even though `primaryNodeId` flipped back. NodeList highlights the row, Inspector renders the params, but the proxy `<group>` and `<TransformControls>` stay invisible.
**Trap:** Suspect TransformControls; tinker with `mode`, `enabled`, mount keys. None work — the gizmo's own JSX is correct; the conditional gate is the bug.
**Root cause:** the gizmo rendered its proxy via `useRef<THREE.Group>(null)` and gated `<TransformControls>` on `groupRef.current`. On deselect → re-select, the proxy unmounts (ref → null) and remounts (ref → new instance), but **ref writes don't trigger re-renders**. The conditional `{groupRef.current ? <TransformControls/> : null}` evaluates during render, sees the still-stale ref, and renders null. The fresh ref attaches AFTER commit; nothing re-evaluates.
**Real fix:** lift the proxy node into React state via a callback ref:

```
const [groupNode, setGroupNode] = useState<THREE.Group | null>(null);
const groupRefCb = useCallback((g: THREE.Group | null) => setGroupNode(g), []);
<group ref={groupRefCb} />
{groupNode ? <TransformControls object={groupNode} ... /> : null}
```

The setter triggers a re-render the moment the new group attaches; TransformControls remounts on every selection cycle.
**Detection signal:** Conditional renders that depend on a ref's current value in the same component. Refs change without re-render; if the gate lives in JSX, the gate is permanently stale after any unmount/remount.
**REF:** P2.6.1 (2026-05-06); `src/app/Gizmo.tsx`; tests/e2e/p26-acceptance.spec.ts P2.6#9.

### H14: Hydrate seam bypasses zod default-fill — schema additions land as undefined

**Symptom:** A user pulls a release that adds a new schema field (e.g. `rotation: vec3` on lights). The browser canvas crashes on first render with `TypeError: can't access property Symbol.iterator, value.rotation is undefined` from inside the renderer or a helper that destructures the new field. Tests (vitest unit, fresh-project Playwright) all green — the bug only fires for users with persisted projects from BEFORE the field landed.
**Trap:** Add a migration runner entry. Migrations work but they're heavyweight — they touch every saved project, need a version bump, and only fix the project-load path. They DON'T fix in-memory state surgery (test fixtures, agent tool calls, dev-only setState patches).
**Root cause:** zod's `paramSchema.parse()` runs at `addNode` Op dispatch — it fills `.default()` values into params. The hydrate seam (project-load path) sets `state.nodes` directly via `useDagStore.hydrate()` — it skips paramSchema.parse() because saved projects are assumed validated. New schema fields with `.default()` only get filled on dispatch, never on hydrate. Old saved params reach the evaluator with the new field undefined.
**Real fix (v0.5):** defensive defaults at the EVALUATOR for any field added after a release:

```
evaluate(params) {
  const rotation = params.rotation ?? [0, 0, 0];
  return { ...spread, rotation };
}
```

Cheap, no migration, robust to any non-zod path (hydrate, agent state surgery, test fixtures). Belt-and-suspenders: consumers also `?? defaultValue` when destructuring the new field, so a future evaluator slip still doesn't crash.
**Real fix (v0.6+):** re-validate node.params through paramSchema during hydrate. One pass at load time fills all defaults across the graph. Eliminates the need for evaluator-level guards going forward.
**Detection signal:** Crash mentions `value.X is undefined` or `Symbol.iterator` on a destructure of a recently-added schema field. Fresh-project tests pass; load-and-render of a pre-existing OPFS project fails. Browser console shows the stack inside the renderer / helper, not inside the dispatcher.
**REF:** P2.6.3 hotfix (2026-05-06); `src/nodes/{DirectionalLight,PointLight,SpotLight,AreaLight}.ts`; `src/viewport/{SceneFromDAG.tsx,LightHelpers.tsx}`; tests `src/nodes/lightRotation.test.ts`. **Sister case (P2.6.4):** `scale: vec3` on the same four lights followed the identical pattern — same defensive defaults at evaluator + helper + renderer; regression coverage in `src/nodes/lightScale.test.ts`. Two occurrences promoted the pattern to vyapti V10.

### H13: Layout-shifting features invalidate the pixel-diff baseline

**Symptom:** Adding the P2.1 menu bar above Chrome shrinks the viewport DIV by ~35px (the menu's row height). Acceptance #7's PostFx-beauty pixel-diff fails immediately even though the rendered scene (cube + camera + light) is unchanged — the canvas is simply smaller, so pixel positions shift wholesale and the diff ratio explodes.
**Trap:** lower `maxDiffPixelRatio` until tests pass — masks future legitimate regressions; OR strip the new feature to keep tests green — destroys the feature's value.
**Root cause:** `page.getByTestId('viewport').toHaveScreenshot()` captures the viewport-testid div's dimensions. Layout changes that affect the slot's height (new rows in the grid template, different chrome heights, mode-switch column changes) propagate to every pixel-diff baseline.
**Real fix:** regenerate the affected baseline as part of the same PR that introduced the layout shift, document the change in CHANGELOG/dharana, and accept the cross-platform companion baseline (Linux when local is darwin) gets regenerated on the first CI run via H8's recipe (download CI artifact OR Docker image).
**Detection signal:** PostFx-beauty diff ratio jumps from ~1% to ≥5% between local + CI. The diff image's mismatched region matches the canvas dimensions exactly (translation, not localized differences).
**REF:** P2.1 Wave D (2026-05-06); `src/app/Layout.tsx:35` (added 'menu' grid row); `tests/e2e/acceptance.spec.ts-snapshots/postfx-beauty-chromium-darwin.png`.

### H16: Test dispatches asset-dependent op before OPFS seed lands — full React tree unmounts

**Symptom:** Playwright assertion `expect(page.getByTestId('scene-tree')).toBeVisible()` times out with "element(s) not found" five seconds after `selectOption('pro')`. The failure screenshot is solid black — not "scene-tree hidden", but the entire app gone. Scene tree, toolbar, NPanel, viewport — all missing.
**Trap:** Believe the message. "scene-tree not found" reads like a SceneTree mounting bug or a mode-switch race. Both are wrong inferences from the surface error. Without observing the screenshot you'd debug the wrong thing for hours.
**Root cause:** `beforeEach` clears OPFS recursively (`removeEntry('basher', { recursive: true })`) then reloads. The library re-seeds default assets asynchronously. The test then dispatches `addNode { type: 'GltfAsset', params: { assetRef: 'assets/cube.gltf' } }` BEFORE the seed lands. The blob URL points at an empty/missing file. `GLTFLoader.parse` rejects with "Unexpected end of JSON input". `<GltfAssetR>` throws synchronously, R3F's `<ErrorBoundary>` catches and unmounts the entire tree — Layout, mode-switcher, scene-tree, all of it. The next assertion looking for any testid times out because the DOM has no React-rendered content (just the dark theme `<body>` background).
**Real fix:** mirror the existing P1#1 pattern — wait for the library entry to be seed-available before dispatching anything that references it:

```ts
await expect(page.getByTestId('library-item-assets/cube.gltf')).toHaveAttribute(
  'data-available',
  'true',
  { timeout: 10_000 },
);
// THEN dispatchAtomic with the assetRef.
```

**Detection signal:** Black failure screenshot + Playwright trace shows `pageError` events with "Could not load blob:.../...: Unexpected end of JSON input" thrown from `GltfAssetR` BEFORE the failing assertion. Also: the test passes locally but fails on CI, AND the test fails AFTER an unrelated upstream test got faster/passed (less wall-clock slack between page-load and the assertion).
**Meta-pattern (worth its own entry the next time it bites):** CI test reliability often depends on incidental wall-clock slack from slow upstream tests. Speeding up the suite — even via legitimate fixes like landing a missing snapshot baseline — exposes pre-existing races that the slowness was silently masking. When fixing a single CI failure makes a _different_ unrelated test newly fail, the second failure is rarely a new bug; it's a latent race becoming observable. Hunt for the missing-await rather than blaming the speedup.
**REF:** PR #6 CI investigation (2026-05-07); `tests/e2e/p1-acceptance.spec.ts:258` (P1#4 fix in `e022d62`); trace evidence in run `25461120030`. Sister entries: H6 (overlay text in pixel diff), H8 (per-platform snapshots), H13 (layout-shift baseline) — same test/observation cluster, different mechanisms.

### H19: Zustand `getState()` snapshot stale after `set()` — user message lost

**Symptom:** Agent responds to a message with "I inspected the DAG" but the response doesn't reference the user's actual request. Follow-up prompt falls back to `"the user's request"` (literal string). Agent then acts on the DAG inspect results with no direction, adding random objects.

**Trap:** Suspect the LLM isn't following instructions, model doesn't support tool calling, or prompt needs tuning. Adding more rules to the system prompt doesn't fix it — the model never received the user message at all.

**Root cause:** `runAgentTurn` captures `sessionStore = useAgentSessionStore.getState()` at function start. Then `sessionStore.addMessage(...)` calls Zustand's `set()` which creates a NEW state object internally, but the local variable still points to the OLD snapshot. When `buildMessages` passes `sessionStore.session.messages` to construct the LLM messages array, it has the pre-`addMessage` state — empty or previous-turn messages only. The current user message is never included in the API request.

**Real fix:** Read the store fresh at every access point. Instead of `buildMessages(..., sessionStore.session.messages)`, use `buildMessages(..., useAgentSessionStore.getState().session.messages)`. Also use the `message` param (always the current turn's instruction) instead of `.find()` in the follow-up prompt construction.

**Detection signal:** Any Zustand store with `getState()` captured in a closure before `set()` is called. Check whether the captured state includes the mutation. If the API request body sent to the LLM is missing the user's latest message, this pattern is active.

**REF:** P2.5 v2 (2026-05-07); `src/agent/orchestrator.ts:57` (stale snapshot), `:76` (fresh read), `types.ts` at `useAgentSessionStore`.

**Why:** Zustand `set()` does NOT mutate the existing state object — it creates a new one. Any closure holding the old reference sees pre-mutation data. This is correct Zustand behavior, not a bug, but easy to miss because the local variable name suggests it's the live store. Sister entry: H10 (same mechanism in test code via `dag = w.__basher_dag.getState()` cached across dispatches).

### H20: Rotation units mismatch — DAG stores raw numbers, THREE Euler reads as radians

**Symptom:** Agent (or human) types "rotate 45 degrees on X". `dag.inspect`
shows `rotation: [90, 0, 0]` after three increments. Visually the cube
sits at ~116° (past 90°, top-edge tilting toward camera). User says "the
visual doesn't match the data."

**Trap:** Suspect the LLM's math — did it accidentally add wrong? Check
the increments: 45 + 20 + 25 = 90. The data is correct. Suspect
floating-point drift in setParam? No — 90 stored exactly. Suspect a
THREE quirk? Tinker with euler order, gizmo mode, axis basis. None of
that fires. The bug isn't in the math or the gizmo — it's at the units
boundary nobody declared.

**Root cause:** `params.rotation` is a `vec3` of raw numbers. THREE.js's
`<mesh rotation={[x,y,z]}>` interprets those numbers as **radians** via
`THREE.Euler`. The codebase had no conversion step anywhere — `grep -rn
degToRad` returned zero hits. The gizmo round-tripped in radians (so
gizmo-only edits worked), but the agent and the human both think in
degrees ("rotate 45 deg"), so any value entered as degrees gets
rendered as that-many-radians: 90 stored = 90 rad ≈ 5157° ≈ 116.6°
visual (mod 360).

**Real fix:** adopt the universal DCC/game-engine convention — degrees
in DAG params, radians at the THREE seam. Single helper module
`src/viewport/rotation.ts` exporting `degVec3ToRad` / `radVec3ToDeg`.
Convert at five sites:
1. `SceneFromDAG.tsx` — every `<mesh|group rotation={...}>` for BoxMesh,
   SphereMesh, Transform.
2. `SceneFromDAG.tsx` — directional light Euler for direction
   computation.
3. `LightHelpers.tsx` — directional light helper Euler + light-gizmo
   quaternion construction.
4. `DiffOverlay.tsx` — ghost rendering mirrors SceneFromDAG.
5. `Gizmo.tsx` — when reading stored params into the proxy
   group (deg → rad), and when writing the proxy back into params
   (rad → deg). Round-trip is exact (`radToDeg(degToRad(x)) ≈ x` to
   float precision).

Scatter `inst.rotation` is procedurally generated in radians by
`ScatterNode` (yaw uniform in [0, 2π)) — leave as radians. Bone rotation
in skeletal pose is also internal radians from animation clips —
leave. Character `heading` is computed via `atan2` in `walkTo` —
radians, leave.

Update agent system prompt to declare the convention explicitly:
"Rotations are in DEGREES (X, Y, Z Euler in degrees, like Blender /
Unity / Unreal). 90 means a quarter-turn."

**Detection signal:** stored rotation `[X, 0, 0]` produces a visual
roughly at `X * 180/π mod 360` instead of `X mod 360`. The off-by-
57.3× ratio is the radian-vs-degree fingerprint. For small values the
mismatch is invisible (0.1 rad = 5.7°, both look like ~zero rotation),
which is why the bug stayed hidden through P0-P2.6 — gizmo edits land
small radian values that look fine.

**Why nobody caught it earlier:** the gizmo round-trips in radians
internally. Inspector displays raw numbers (no unit label). The seed
scene uses `[0,0,0]` (unit-invariant). Acceptance pixel-diff tests use
`[0,0,0]`. The bug only appeared the moment a non-zero rotation was
entered as a degree value — which happened the first time the agent
was asked "rotate 45 degrees."

**REF:** P2.5 + agent integration (2026-05-07);
`src/viewport/rotation.ts` (helpers); `src/viewport/SceneFromDAG.tsx`
(BoxMesh/SphereMesh/Transform/DirLight conversion sites);
`src/viewport/LightHelpers.tsx` (helper Euler);
`src/viewport/DiffOverlay.tsx` (ghost render); `src/app/Gizmo.tsx:129,174`
(read/write conversion); `src/agent/orchestrator.ts` (system prompt
declares units convention).

**Sister patterns:** any other field where a raw number's interpretation
depends on the consumer's convention. Watch for: angles in animation
clips, FOV in cameras (THREE PerspectiveCamera takes degrees on the
constructor but the `.fov` property is also degrees — fine, consistent),
HSL color values, units of light intensity (lumens vs unitless). The
class is **silent unit boundary**: the value is correct in some unit,
just not the unit the consumer expected.

**Cross-refs:** `.anvi/dcc-reference.md` §1 (rotation units) and §2 (position
units) for the canonical industry-standard table. Future
units/convention bugs should consult that doc BEFORE picking a side
— it covers Blender / Houdini / Cinema 4D / 3ds Max / Maya / Unity /
Unreal / Godot / glTF for every decision Basher faces.

### H21: Agent invents node IDs from system-prompt placeholders

**Symptom:** Agent calls `dag.exec` with ops referencing `node: "scene"`.
DiffBar shows "Diff proposal failed: Node not found: scene". The DAG's
actual scene aggregator is `n_scene` (or whatever id the seed / user's
project picked). The agent never called `dag.inspect`, so it had no way
to know.

**Trap:** Suspect the LLM is hallucinating, suspect zod validation, suspect
a missing tool call. None of those — the model did exactly what the
system prompt taught it: copied the example verbatim. The model is
disciplined; the *prompt* is wrong.

**Root cause:** The agent system prompt's op-shape examples used
`"scene"` as a literal placeholder for the scene aggregator's node id:

```
{"type":"connect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}
```

A model with no other signal will copy that string verbatim. The
*Selection* block in the per-turn context gave the model selected node
ids, but the scene-root anchor isn't selected — it's reachable only
via `outputs.scene.node`, which the prompt never surfaced.

This is a class bug, not a one-off — every project-level named output
(scene, render, future ground/postFx pseudo-anchors) has the same gap.

**Real fix:** two layers, one cause.

1. **Make the placeholder syntactically distinct.** Replace literal
   `"scene"` in op examples with `<sceneId>` and add an explicit rule:
   "tokens like `<sceneId>` are PLACEHOLDERS; read the actual id from
   the Context block's Anchors section."
2. **Inject an Anchors block into the per-turn context** that resolves
   each named output to its concrete `(nodeId, type, socket)` triple.
   The model now sees:

   ```
   Anchors (project named outputs):
     - scene → n_scene (Scene), socket "out"
     - render → n_render (RenderOutput), socket "out"
   ```

   Combined, the model has both the hint (placeholder syntax) and the
   answer (resolved id) up front. No `dag.inspect` round-trip needed
   for the common case.

**Detection signal:** any "Node not found: <name>" error where `<name>`
matches a project-output key (`outputs[name]` exists in the DAG). The
mismatch is **placeholder-as-id** — the model used the output key as
the node id directly.

**Why nobody caught it earlier:** the original P2.5 macro tools
(`mesh.add`, `library.import`, `camera.snapshot`, `character.walkTo`)
all read `outputs.scene` server-side and constructed the connect op
with the resolved node id — the macros hid the gap. The new universal
`dag.exec` tool (P2.5 v2) lets the agent author connections directly,
exposing the prompt's literal `"scene"` to be copied. The bug appeared
on the first dag.exec that needed to wire a child to the scene.

**REF:** P2.5 v2 + agent integration (2026-05-08);
`src/agent/orchestrator.ts` (`buildContextBlock` Anchors block,
`buildStaticSystemPrompt` placeholder syntax + rule);
`src/core/project/default.ts:36` (seed Scene node id is `n_scene`);
`src/core/dag/ops.ts` (applyOp throws "Node not found: <id>"). Sister
class to **anchor / placeholder confusion** more generally — every
DAG that exposes named outputs has the same trap if the prompt
collapses placeholder names with real ids.

**Cross-refs:** `.anvi/dcc-reference.md` doesn't apply here (this isn't
a units/format convention, it's a name-resolution boundary). Future
related entries should track: (1) other named outputs added (P4
render/passes), (2) any case where a tool surface conflates a "concept
name" with a concrete id.

### H8: Playwright pixel-diff snapshots are platform-suffixed by default

**Symptom:** Local CI run on macOS green; GitHub Actions Ubuntu runner fails test #7 with `A snapshot doesn't exist at .../postfx-beauty-chromium-linux.png, writing actual.`
**Trap:** lower the threshold or skip the test in CI — both violate honesty contract.
**Root cause:** Playwright suffixes snapshot filenames by `${browser}-${platform}` to honor real GPU rasterization differences. A snapshot committed only as `chromium-darwin.png` does not match a Linux runner. This is a feature, not a bug.
**Real fix:** commit a Linux baseline alongside the macOS one. Generate it by (a) running Playwright in the official Docker image locally, OR (b) downloading the failed CI run's artifact (Playwright attaches the actual rendered PNG) and committing that as the baseline. Both baselines live in `tests/e2e/acceptance.spec.ts-snapshots/`.
**Detection signal:** "snapshot doesn't exist" error naming a path with a different platform suffix than what's committed.
**REF:** P0 CI fix (2026-05-05); `tests/e2e/acceptance.spec.ts-snapshots/postfx-beauty-chromium-{darwin,linux}.png`.

### H22: BFS over multi-direction edge kinds free-mixes traversals, leaks siblings

**Symptom:** Closure preservation gate accepts ops that target siblings
of the selected node, defeating PLAN §0 acceptance #2 ("rotate selected
can NEVER produce ops that mutate any other node"). Manifests as the
diff-store integration test "closure spec rejects ops outside the
closure" failing — the propose call doesn't throw despite the op
targeting an out-of-scope node.

**Trap:** Suspect the gate logic in `propose`. Tinker with the
introducedIds tracker. Suspect the check order. None of these are the
problem — the gate is fine; the input ClosureSet was wrong because
the BFS over-expanded.

**Root cause:** A naive BFS that processes the frontier in arrival
order and visits ALL declared edge kinds at each node free-mixes
direction semantics. For root `box` with edges `['parent', 'children']`,
the walk goes box → parent → scene (✓) and then from scene → children
→ sibling (✗). The intent is "ancestors of root + descendants of
root", a UNION of two per-direction subgraphs. Combining mid-walk
turns it into "everything reachable by any path under any kind",
which leaks every sibling under a shared parent.

**Real fix:** run one BFS per declared edge kind, each rooted only at
`spec.rootSelectors`. Within a per-kind BFS, traversal continues only
along that kind. Share a `visited` set across BFSes for membership
(so the closure is a union), but use per-kind `seenInKind` sets to
prevent within-kind loops. Mixing directions requires explicit
declaration in the spec — never an emergent property of the walker.

**Detection signal:** any closure containing a node that's a sibling
of root (under a shared parent) when the spec only declares
`['parent', 'children']`. Quick test: build a scene with two children
under one Scene, root a closure at child A with edges `['parent',
'children']`, assert child B is NOT in `closure.nodes`.

**REF:** P2.5.2 Wave A (2026-05-08); `src/agent/closure/expand.ts`
(`expandClosure`, `walkKind` — the per-kind BFS isolation is the
fix); `src/agent/closure/expand.test.ts` ("['parent','children'] from
a leaf does NOT reach a sibling" — the regression).

**Why it stayed hidden until tests:** for the seed scene + an
empty-closure test the over-expansion didn't matter (no out-of-scope
ops were emitted to challenge it). The bug only fired when a sibling
sat under the same parent AND the test asserted rejection. This is
why the diff-store integration tests were essential — closure
expansion correctness is observable only at the gate, not at the
walker output in isolation.

**Sister patterns:** any future per-direction graph operation that
declares multiple edge kinds. Specifically watch for: P3 animation
edges (`'animation'`), P4 render-pass edges (`'pass-input'`). When
those land, every walker that consumes them must run per-kind BFSes
unless the spec semantics are explicitly "free-mix any reachable
path".

**Cross-refs:** vyapti V13 (closure preservation — V13's enforcement
hinges on H22's avoidance); dharana B7 (Agent identifier ↔ DAG
node-set — closure roots come from this seam). PLAN §5 Wave A.

### H23: Tool surface advertises information the receiver doesn't expose

**Detection signal:** A tool's parameter description points the LLM at
another tool's output for shape/format/example info, but the named
output drops or never carried that info. Live-smoke symptom: gate-2
(param_schema) rejection on the FIRST call to the dependent tool, with
the LLM emitting plausible-but-wrong field names.

**REF:** `src/agent/mutators/tool.ts:57` (proposePlan's spec
description "see agent.listMutators for shapes"); `src/agent/mutators/catalog.ts:30-45`
(listMutatorMetadata pre-fix dropped the spec shape despite the
doc-comment claim).

**Source:** P2.5.2 Wave C live smoke (2026-05-08). User prompt: "take
the pink sphere and move it away from the cube." The LLM resolved
both anchors via agent.identify (B7 worked), called agent.listMutators
(it received only name + description + contract), then called
agent.proposePlan with `mutator.translate` and a malformed spec
missing `targetSelectors`. Gate 2 caught it cleanly — but the rejection
was the FIRST signal the LLM had that the spec shape was undefined.

**Five-limbed argument:**
1. **Claim:** When tool A's parameter description points the LLM at tool
   B's output for X, tool B must actually return X. Otherwise the
   advertised contract is a fiction the gate has to enforce after the
   fact.
2. **Reason:** LLMs treat tool descriptions as authoritative. They don't
   probe to verify the claim — they construct calls assuming the docs
   are accurate. A missing field in the receiver shows up as guessing.
3. **Universal principle:** Same family as H21 (agent invents node IDs
   from system-prompt placeholders). Both are surface-receiver
   mismatches: the surface promises something, the receiver doesn't
   carry it. H21 was at the prompt-context boundary; H23 is at the
   tool-self-description boundary.
4. **Application:** every tool whose description references another
   tool's output must be paired with a registration-time test that
   inspects that other tool's actual return shape and asserts the
   referenced fields are present.
5. **Conclusion:** the bug class is mechanically eliminable. Failure to
   add the test means the next tool added with cross-tool references
   re-reproduces H23.

**The trap:** filing this as "model didn't read the description carefully
enough" or "needs prompt engineering." The model reads descriptions as
expected; the description was wrong. Fixing the model is hopeless;
fixing the surface is one-line.

**The real fix:** every Mutator now carries a `specExample` field
(`MutatorDefinition.specExample`); listMutators emits it; a test
asserts every specExample parses through its own zod schema. The
proposePlan tool description tells the LLM to copy the matching
specExample.

**Sister patterns:** any future LLM-facing tool whose description
points at another tool's output. Inspection tools (dag.inspect),
catalogue tools (agent.listStrategies), introspection tools — all
candidates if their consumer-tool description references their fields.

**Cross-refs:** dharana B8 (Mutator catalog ↔ Op constructor — the
shape-advertising boundary); H21 (sister pattern at the prompt
boundary). PLAN §5 Wave C.

### H24: Identify resolver coverage assumed singular nouns; multi-target intent fell through silently

**Detection signal:** A user prompt referencing multiple objects via a
quantifier ("each", "all", "every", "both") or a generic plural noun
("objects", "things", "everything", "the cubes") returns
`type: "no-match"` with rationale "no exact id, no selection match,
no type alias, no color match." The orchestrator's `earlyExit` fires;
the turn ends; the user has to rephrase.

Sister mode of failure: the alias matches but `hint = 'unique'` (LLM
default), so multi-candidate resolution returns `'ambiguous'` with
candidate list — wasting a turn waiting for the user to disambiguate
something they already disambiguated with the quantifier.

**REF:** `src/agent/identify/identify.ts:288-298` (pre-fix
`inferNodeTypes` regex matched only singulars + a small set of cubes/
boxes/balls aliases; no generic-noun aliases; no quantifier handling
elsewhere in the resolver).

**Source:** P2.5.2 live LLM smoke (2026-05-08). User prompt: "assign
random color rotation and scale to each of the object" → no-match.
Filed as #24 + #25, fixed in P2.5.3 Wave A.

**Five-limbed argument:**
1. **Claim:** A resolver advertised as "the LLM-facing way to point at
   nodes by description" must accept the natural-language quantifier
   forms a director uses. Singular-only is an arbitrary scope.
2. **Reason:** LLMs generate prompts that mirror the user's verbal
   reference patterns. "Each cube", "all spheres", "the objects" — the
   resolver's regex shape determines what fraction of natural intent
   passes through. The fraction was too low.
3. **Universal principle:** When a resolver consumes natural-language
   input, its alias / quantifier coverage is a load-bearing surface,
   not a "nice to have." Coverage gaps don't error — they no-match —
   so they're invisible until live observation.
4. **Application:** `inferNodeTypes` gains plural forms (`cubes?`,
   `spheres?`) AND generic-primitive aliases (object/thing/everything/
   nodes → all visible primitives). A new `hasMultiTargetIntent`
   helper auto-promotes `hint` to `multiple-allowed` when quantifiers
   or generic plurals are detected, so the candidate-count threshold
   doesn't bounce a legitimately-multiple resolution to ambiguous.
5. **Conclusion:** "each of the objects" resolves; "all spheres"
   resolves; "the cubes" resolves — all without further LLM rounds.

**The trap:** filing this as "the LLM should rephrase" or "user
education." It's a coverage gap in a resolver. The resolver was the
fix surface, not the prompt.

**The real fix:** plural noun forms + generic-primitive alias map +
quantifier-aware hint promotion. ~40 LoC in identify.ts; +12 unit
tests. The verb-noun co-reference cleanup in shouldRunIdentifyRound
(#15) is a sister fix — same family of "natural-language coverage"
hardening.

**Sister patterns:** any future natural-language resolver
(`agent.identify` for animation channels in P3, render-pass aliases
in P4) carries the same risk. Coverage tests should run on a corpus
of director-style prompts, not just the single-noun happy path.

**Cross-refs:** dharana B7 (Agent identifier ↔ DAG node-set — span
scope updated post-fix); vyapti V13 (closure preservation — closures
rooted on multi-target identifies pass through correctly because each
selector becomes a closure root). PLAN P2.5.3 §2 Wave A.

### H25: Naming-similarity ≠ functional-similarity (spec-from-memory framing trap)

**Span:** any spec or design document authored before reading the code it describes.

**Symptom:** the spec frames two files as "duplicate / mergeable" because their names rhyme (`Inspector.tsx` + `NPanel.tsx`, `assetStore.ts` + `assetCache.ts`, etc.); the spec proposes a merge / delete that would silently lose load-bearing functionality if executed; the error is only caught when someone actually opens both files.

**Root cause:** the spec was authored from memory of file *names* and the surrounding domain language, not from observation of file *contents*. Domain words ("inspector", "panel", "store", "cache") cluster around boundaries because the boundary is the thing being named — but two files at the same boundary often have orthogonal jobs (one mutates, one displays; one props-edits, one HUD-toggles). Naming similarity is downstream of the same boundary; functional overlap is a separate question.

**The trap:** writing the merge into the locked-decisions table (D-UX-N) and pulling forward into a wave's atomic commit before reading both files. Once "merge X and Y" is locked, the discovery that they aren't duplicates feels like late-breaking noise instead of the actual signal it is.

**The real fix:** before any "merge / delete / replace" decision lands in a spec, open the two files end-to-end. State each file's job in one sentence. Only if the sentences overlap does the merge framing apply. Add a "what each file actually does today" pass to the spec authoring routine, *before* the locked-decision table is populated.

**Five-limbed argument:**
1. **Claim:** Functional roles must be observed from code, not inferred from filenames.
2. **Reason:** Filenames cluster at boundaries; functional roles span boundaries. Two files at the same boundary may have non-overlapping jobs.
3. **Universal principle:** Lokayata at the *spec* level — observation runs alongside specification, not after.
4. **Application:** P6 spec D-UX-8 framed `Inspector.tsx` (property editor) + `NPanel.tsx` (viewport HUD: gizmo mode, snap, grid/axis toggles) as duplicate inspectors based on name similarity. They have orthogonal roles.
5. **Conclusion:** Caught at W1 start by reading both files; D-UX-8 corrected mid-wave (NPanel deleted in W7 with functions absorbed into R8, Inspector kept as canonical). One round-trip lost; one decision-table cell rewritten.

**Update 2026-05-11 (W2.6):** the W1 correction was itself reversed two waves later. By W2 the TopToolbar absorbed NPanel's mode + snap groups, leaving only grid/axis toggles unique to NPanel — and those were already slated to move to W7's FloatingViewportToolbar. The "they're not duplicates" claim that was true at W1 (lokayata-validated then) was false at W2.6 (lokayata-disconfirmed by the new chrome shape). The DEEPER lesson under H25: spec re-validation is a *cycle*, not a one-time fix. Every wave that touches adjacent chrome can shift whether two surfaces remain distinct. The sister pattern H27 below captures this directly.

**Sister patterns:** any future spec that proposes a merge based on name resemblance — `MaterialOverride.ts` + `MaterialPreset.ts`, `KeyframeChannel*.ts` siblings, `*Store.ts` lookalikes. Read both before locking. AND: any prior "they're not duplicates" claim should be re-validated after every wave that absorbs chrome (H27).

**Cross-refs:** docs/UI-SPEC.md §1 D-UX-8 (W2.6 restoration entry); §5.8 NPanel canonical Inspector; H27 (parallel-surface evolution drift); vyapti V13.

### H26: happy-dom localStorage non-functional at module-load time

**Span:** any zustand store under `src/app/stores/` that reads `localStorage` at module-load time AND has a unit test that imports it directly.

**Symptom:** `TypeError: localStorage.getItem is not a function` at module-load — the test file fails before any test body runs. `(node:NNN) Warning: --localstorage-file was provided without a valid path` appears before the failure.

**Root cause:** vitest's `happy-dom` environment exposes `localStorage` as a globalThis property, but its method bindings are not attached at the moment a `src/app/stores/*.ts` module is imported by the test file. `typeof localStorage === 'undefined'` returns `'object'` (truthy guard misfires); the call to `getItem` then bombs because the slot is a partially-constructed Storage stub.

**The trap:** asserting `typeof localStorage === 'undefined'` is sufficient defense. It isn't — the value is *defined*, but methods aren't.

**The real fix:** defensive helpers that check for *callable* methods, not just defined globals:
```ts
function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch { return null; }
}
```
And in the test file, install an in-memory Storage mock in `beforeAll` BEFORE importing the store (so the store's module-load-time read sees a working API).

**Five-limbed argument:**
1. **Claim:** Defensive localStorage access requires method-callable checks, not just defined-global checks.
2. **Reason:** Test envs supply Storage as a partially-constructed object; `typeof` returns truthy for partial stubs.
3. **Universal principle:** When the boundary is "browser API in test env", stub completeness is the failure mode, not stub presence.
4. **Application:** `src/app/stores/chromeStore.ts` originally guarded with `typeof localStorage === 'undefined'`; module load failed in vitest. Fix: `safeGetItem` / `safeSetItem` helpers + in-memory mock in test `beforeAll`.
5. **Conclusion:** Pattern applies to every future store that touches localStorage at boot — `modeStore` (W2 retrofit, commit `8b70ac8` — H26 hit when ComfyStatusIndicator's test pulled modeStore in earlier than W1's tests had), `viewportStore`, future `leftSidebarStore`, etc. **Vyapti V18 codifies this as a structural rule.**

**Sister patterns:** sessionStorage, IndexedDB transactions, `navigator.storage.getDirectory()`, `window.matchMedia`, any Web API surfaced through the global. Same defense: callable check + try/catch + in-test mock.

**Cross-refs:** `src/app/stores/chromeStore.ts:30` (safeGetItem / safeSetItem); `src/app/stores/modeStore.ts` (same wrappers, retrofitted P6 W2 commit `8b70ac8`); `src/app/stores/chromeStore.test.ts:5` (beforeAll mock); vyapti V18; vitest config `test.environment: 'happy-dom'` in `vitest.config.ts:11`. P6 W1 commit `cc151fa`.

### H27: Parallel-surface evolution drift — "they're not duplicates" decays as adjacent chrome absorbs sections

**Span:** any spec entry of the form "X and Y are NOT duplicates because each has unique sections" — the claim is true at the moment of authoring but decays whenever a third surface absorbs one of those unique sections.

**Symptom:** spec asserts two surfaces are functionally distinct; at some later wave one surface's sections shrink to zero unique content; the spec entry still claims distinctness; nobody notices until a user asks "why are these the same panel" and an audit reveals the merge has been overdue for N waves.

**Root cause:** specs lock claims at a snapshot; chrome evolution moves sections between surfaces wave-by-wave. The "X has Y, Z, W sections unique to it" claim is conjunctive — when Y, Z, W all migrate elsewhere, the conjunction goes false silently. There's no automatic re-validation; the spec's earlier "they're distinct" verdict reads as authoritative even when the underlying premises have evaporated.

**The trap:** trusting a frozen-in-time "they're not duplicates" claim. A claim that was lokayata-validated against W1's chrome shape is just a memory once W2's chrome ships. H25 caught the *first* iteration of this trap (don't lock from memory before reading code); H27 catches the *recurring* iteration (don't trust prior validation across structural waves).

**The real fix:** every wave that absorbs chrome (TopToolbar absorbing NPanel mode/snap groups; FloatingViewportToolbar absorbing grid/axis toggles; etc.) triggers a re-validation pass over any spec entry of the form "X and Y are distinct because…". Test: list each surface's *current* unique sections; if the count is 0 or 1, the merge is unblocked and the spec entry is stale.

**Five-limbed argument:**
1. **Claim:** Spec entries asserting surface distinctness must be re-validated after every wave that touches adjacent chrome.
2. **Reason:** Distinctness claims are conjunctions of "X has unique section Y, Z, W" — chrome evolution can empty the conjunction silently.
3. **Universal principle:** Lokayata at the spec level is *recurring*, not one-time. The first observation validates the claim at W_N; the same observation must run again at W_(N+k) if any adjacent chrome shifted.
4. **Application:** D-UX-8 swung once at W1 ("they're not duplicates", true at the time). At W2 TopToolbar absorbed NPanel's mode + snap groups; W7 was already slated to take the grid/axis toggles. By W2.6 NPanel had nothing unique left. The spec entry still read "they're distinct, merge in W7". User pushed merge forward to W2.6 after observing — restoration was the right call once observation re-ran.
5. **Conclusion:** Add a "section inventory" pass to every wave plan that touches multi-surface chrome. If any surface's unique-section count drops to ≤1, flag it for merge consideration.

**Detection signal:** open both surfaces' files, list each section, cross-check what's unique. When a unique-section list shrinks below ~50% of the surface's total content, the merge is overdue.

**Sister patterns:** any "X and Y serve different roles" spec claim. Examples to re-validate at every chrome-touching wave: AddMenu / AssetsPopover (currently distinct: creation vs asset import); Library tab / SceneTree tab (W2.5 dropped Library tab — re-validation predicted). The pattern also generalizes to non-chrome boundaries: any "module A handles X; module B handles Y" claim with overlapping span.

**Cross-refs:** H25 (parent — the first-iteration trap); UI-SPEC.md §1 D-UX-8 (the swing → restore ledger captures provenance); P6 W2.6 commit `c19b43a` (Inspector → NPanel merge); dharana B11 (Design spec ↔ source code authoring boundary — H27 strengthens its WHY).

### H28: applySetParam silently rejects unknown paramPaths via paramSchema validation

**Span:** every direct `setParam` Op dispatch — e2e test seeds, agent tool builders, UI handlers that bypass the Mutator path, project migrators. The trap surfaces whenever code dispatches `setParam(nodeId, paramPath, value)` for a `paramPath` the node's `paramSchema` doesn't declare.

**Symptom:** in P6 W6 e2e #2/#3 (K-keyboard inserts keyframe), the test seed dispatched `setParam(box, 'intensity', 7)` so K-insert could read the target's live value at press time. The Op did NOT throw to the caller; the resulting DAG still appeared healthy (other ops in the batch survived); but `target.params.intensity` remained `undefined` and K-insert returned `null` (no-op). Test failure on `expect(keyframes).toHaveLength(4)` with 3 actual — the K-press had no effect.

**Trap:** assume Op dispatch is universal — "I can setParam any (node, path, value) triple." Try to debug by inspecting the keyboard handler, the channel state, the target selection. None are wrong. The setParam itself was silently rejected by `applySetParam`'s paramSchema re-validation at `src/core/dag/ops.ts:271`. The Op throws OpError; `dispatchAtomic` may catch + log + skip the bad op rather than propagating; the caller's `try/catch`-free e2e evaluate continues; the test reads stale state.

**Root cause:** **applySetParam re-validates the entire `params` object against `def.paramSchema.safeParse()` after the setAtPath write** (`ops.ts:271`). Unknown paramPaths fail strict zod schemas; the Op throws; the failure path is whatever the dispatcher does on Op failure (in atomic mode: often "skip + continue", which presents as silent rejection upstream).

**Real fix:** for test seeds OR ad-hoc UI setParam paths, **use a node type whose `paramSchema` natively contains the paramPath you need.** In W6's case: seed a `DirectionalLight` (whose schema has `intensity: z.number()`) and target it from the channel, instead of seeding a synthetic `intensity` field on `BoxMesh` (which has no such field). Sister fixes: (a) extend the node's paramSchema if the field is genuinely needed; (b) bypass Ops entirely via the dev seam for test-only state (last resort — violates V1).

**Detection signal:** "I dispatched an Op and the DAG read still shows old state." Or: "the test seed runs without throwing but later assertions on the seeded state fail." Or: e2e log shows OpError in dispatch label "seed" but the test continues. Run the same setParam through `validatePlan` (any Mutator that uses setParam) instead of direct dispatch — the five-gate validator's gate 2 ('param_schema') would surface the rejection with a clear reason.

**Five-limbed argument:**
1. **Claim:** Direct `setParam` Op dispatch fails silently for paramPaths outside the node's paramSchema.
2. **Reason:** `applySetParam` re-validates the post-write params object against `def.paramSchema.safeParse()` at `src/core/dag/ops.ts:271`; failure throws OpError; atomic batch dispatchers may swallow + continue.
3. **Universal principle:** Schema-strict mutation paths require the caller to know the schema OR route through a validator that surfaces rejections. "Set any property" is not a universal Op semantic in this system.
4. **Application:** W6 e2e seed needed a number-valued target param. BoxMesh has no number-valued param. The setParam(box, 'intensity', 7) Op was rejected. K-insert read undefined → returned null. Fix: swap target to a `DirectionalLight` node whose schema has `intensity: z.number().min(0).max(20)` at `src/nodes/DirectionalLight.ts:6`.
5. **Conclusion:** When seeding test scenes for animation, render, or any code path that reads `target.params[paramPath]` after a write, pick a node whose schema natively contains the paramPath. The applicability extends to project migrators (don't write fields the schema rejects), agent tools (return Ops the dispatcher can apply), and future UI surfaces that bypass Mutators.

**Sister patterns:** addNode params validation (same paramSchema check at `ops.ts:110`); migration runners writing legacy fields not in the current schema; an agent tool returning an Op whose params shape doesn't match the target node's schema.

**Cross-refs:** `src/core/dag/ops.ts:271` (paramSchema re-validation); `src/core/dag/ops.ts:110` (addNode paramSchema check, sister site); `src/agent/mutators/validate.ts` (gate 2: 'param_schema' surfaces the rejection cleanly through the Mutator path); `tests/e2e/p6-w6-animate-ops.spec.ts` (the seed-with-DirectionalLight fix that mitigates this trap); P6 W6 commit `7eac917`.

---

### H29: Testid-migration grep gate scoped to the "owning" file misses legacy specs that reference the same testid

**Span:** every chrome wave that deletes or renames a `data-testid` value. Author's mental model: "the testid lives in component X, so I'll grep its tests + the test file named after X." Reality: testids are global identifiers — *any* spec across the entire `tests/e2e/` tree can reference them as setup, side-effect verification, or unrelated coverage.

**Symptom:** P6 W7 C2 deleted `TransformToolbar.tsx` and its `toolbar-shading-*` testids. The C2 grep gate matched testids inside the obviously-related `tests/e2e/p26-acceptance.spec.ts` (P2.6 was where the component originally landed) and migrated 3 specs cleanly. The full e2e suite passed locally because Playwright was run scoped to the migrated specs. A separate top-level acceptance suite at `tests/e2e/acceptance.spec.ts:233` used `toolbar-shading-rendered` as a SETUP step for the PostFx beauty pixel-diff test (#7 PostFx beauty matches reference within 2% pixel diff) — caught only by the post-PR critical-self-review running the full suite, not by the wave's verification gate.

**Trap:** scope the grep to the file you EXPECT to find the testid in. P26's specs were the OWNING reference for this testid family; W7 migrated all 3. The grep `grep -rnE 'toolbar-shading-' tests/e2e/p26-acceptance.spec.ts` is clean. The grep `grep -rnE 'toolbar-shading-' tests/` is NOT clean — `acceptance.spec.ts` references the same name without being "about" the deleted component.

**Root cause:** **testids are project-global names; their consumer set is unbounded.** The migration grep gate must be project-global too. The mental shortcut "I'll check the file where the original testid was introduced" is a false ownership inference — testids have no owners, only authors and consumers. Any wave that exposes a chrome affordance for an effect (shading, snap, mode, selection) becomes a downstream consumer the next wave's migration must find.

**Real fix:** the grep gate for ANY testid deletion or rename must run with **NO file scope** — the regex applied to the entire `tests/` and `src/` tree. For W7 the gate was conceptually right (`grep -rnE 'toolbar-shading-|toolbar-snap-|toolbar-mode-(translate|rotate|scale)|transform-toolbar' src/ tests/`), but it was only run after C4's commit, not at the end of C2. Move the project-wide grep gate to be a HARD verification step at the end of every chrome-deletion commit, before the commit message even gets drafted.

**Detection signal:** "I migrated all the obvious specs and they pass, but a screenshot/integration test from an unrelated phase suddenly fails with `Locator not found: getByTestId('old-name')`." Or: `--reporter=list` on the full suite shows a single failure in a spec whose name has no obvious connection to the changed component. Or: CI fails on a spec the author never opened during the migration. All three are the same signature: a non-obvious consumer.

**Five-limbed argument:**
1. **Claim:** Scoping a testid-migration grep to the file you mentally associate with the testid will miss legacy specs that consume the testid as setup or side-effect verification.
2. **Reason:** Testids are project-global names; the original component owns the *production* of the name, but its CONSUMERS can be anywhere — including specs from earlier phases that wired the testid as a "click this before the real test" setup step.
3. **Universal principle:** When a name is global, the migration gate must be global too. File-scoped greps encode a false ownership relationship onto a flat namespace.
4. **Application:** W7 C2 deleted `TransformToolbar.tsx`. Grep gate ran inside the `p26-acceptance.spec.ts` file (the "owning" tests). Clean. But `tests/e2e/acceptance.spec.ts:233` used `toolbar-shading-rendered` as a setup step for the PostFx beauty test — completely unrelated to the chrome migration's intent, yet still a hard consumer. The orphaned reference was caught only by post-PR critical self-review (`50eec3b`).
5. **Conclusion:** Run testid-deletion grep gates with `tests/ src/` as the search root, never a single file. Add the project-wide grep to the wave's verification gate list, BEFORE the deletion commit message gets written. Sister rule applies to type renames, store-key renames, and any other global-name change.

**Sister patterns:** type rename where one re-export survives in an unexpected barrel file; store-action rename where one Storybook story or fixture references the old name; environment variable rename where one bash script or Dockerfile retains the old value. All share the same shape: file-scoped grep makes a false ownership assumption.

**Cross-refs:** `tests/e2e/acceptance.spec.ts:233` (the orphan that survived C2's file-scoped grep); P6 W7 commit `50eec3b` (the self-review fold-in that migrated it); P6 W7 commit `959ae96` (the C2 split that introduced the gap). The grep that catches the case: `grep -rnE 'toolbar-shading-|toolbar-snap-|toolbar-mode-(translate|rotate|scale)|transform-toolbar' src/ tests/` — note the project-wide scope.

---

### H30: Pixel-diff snapshot baselines invalidate when an absolute-positioned overlay is added to a screenshot-targeted container

**Span:** every Playwright `toHaveScreenshot` call on an HTML container element (a `<div>` rather than a `<canvas>` directly) that has or could gain absolute-positioned descendants. Affects acceptance suites that capture editor regions for visual regression — P2.6's PostFx beauty test is the current instance.

**Symptom:** P6 W7 C1 added `<FloatingViewportToolbar />` as an `absolute bottom-4` overlay inside `<div data-testid="viewport" className="relative">`. The `tests/e2e/acceptance.spec.ts#7 PostFx beauty matches reference within 2% pixel diff` test, which captures `page.getByTestId('viewport').toHaveScreenshot('postfx-beauty.png')`, started failing with `Expected an image 660px by 557px, received 660px by 570px. 14765 pixels (ratio 0.04 of all image pixels) are different.` The Canvas-render content was unchanged; only the surrounding chrome region grew (the absolute child extended the element's screenshot extent by ~13px).

**Trap:** assume `position: absolute` children don't change the parent's bounding box (true for CSS *layout* purposes — absolute removes children from normal flow). Therefore assume the screenshot of the parent stays the same. False — Playwright's element-screenshot captures the laid-out bounding rect *including* visible descendants when `overflow: visible` (the default). Absolute children with `bottom-N` painted within the parent's frame ARE captured.

**Root cause:** **Playwright `toHaveScreenshot` on a locator uses the element's full painted bounds, not its CSS content-box.** When an absolute child paints outside the inline content area (which `bottom-4` does — it's positioned relative to the parent's bottom edge, not stacked at the end of inline flow), the screenshot extent grows to include the painted child. The "trap" only fires when (a) the parent's CSS has no explicit `overflow: hidden` AND (b) the absolute child paints a visible region (background, border, content).

**Real fix two options:**

- **Option A — rebaseline.** When the overlay is a *permanent* part of the new editor reality (as R8 is post-W7), the right move is `npx playwright test --update-snapshots` to capture the new ground truth. Verify the rebaseline is intentional in the commit message + body so future readers understand it wasn't just "the test was flaky."

- **Option B — narrow the screenshot target.** When the overlay is incidental to what the test is *about* (e.g., the PostFx beauty test is about the canvas render, not the surrounding chrome), change the target from the wrapper div to the canvas itself: `page.locator('canvas').toHaveScreenshot('postfx-beauty.png')`. This is a one-time baseline migration but produces a more honest test going forward.

W7 used Option A (R8 is permanent; preserve the existing test framing).

**Detection signal:** `toHaveScreenshot` fails with a small dimension delta (~10-50px on one axis) on a test that previously passed, AND a recent commit added an absolute-positioned descendant to the screenshot-targeted element. The fingerprint is dimensional, not content-based — the pixel ratio in the diff will be misleadingly low (~0.04 in the W7 case) because most pixels match; the failure is the framing, not the content.

**Five-limbed argument:**
1. **Claim:** Adding an absolute-positioned overlay child to a Playwright-screenshot-targeted container breaks the existing baseline by extending the captured extent.
2. **Reason:** Playwright element-screenshot captures the full painted bounds of the locator including overflowing descendants (default `overflow: visible`); absolute children painted within or near the parent ARE part of those bounds.
3. **Universal principle:** Element-screenshots are not coupled to CSS layout boxes — they capture paint extent. Any visible painted region inside or extending from the targeted element will appear in the snapshot.
4. **Application:** P6 W7 C1 added R8 as `absolute bottom-4` inside the viewport div. The PostFx beauty snapshot grew from 660×557 to 660×570; the Canvas content remained correct; only the new chrome region was novel. Fixed in `50eec3b` by rebaselining (Option A — R8 is permanent editor reality).
5. **Conclusion:** When introducing absolute-positioned chrome inside an element that is currently the target of a pixel-diff snapshot, decide BEFORE committing: rebaseline (overlay is permanent) or retarget the screenshot to a non-affected inner element (overlay is incidental). Run the affected screenshot tests as part of the wave's verification gate so the decision happens at authoring time, not at post-PR review.

**Sister patterns:** floating tooltips that paint over screenshot targets; modal/popover layers that overlay screenshot-captured regions; any portal-rendered child that lands within the captured element's box; CSS shadow elements with significant blur that paint outside the content rect.

**Cross-refs:** `tests/e2e/acceptance.spec.ts:226` (the affected test); `tests/e2e/acceptance.spec.ts-snapshots/postfx-beauty-chromium-darwin.png` (the rebaselined image, 44764B → 48806B); P6 W7 commit `50eec3b` (the rebaseline fold-in). H8 covers platform-suffix snapshot naming; H13 covers layout-shifting features specifically — H30 is the sister case where the shift comes from an OVERLAY rather than a layout change.

---

### H31: Tailwind content scanner destabilised by class-name regex literals inside test sources

**Span:** every Tailwind v3 project whose `content` glob picks up test files that contain string literals shaped like utility classes (`focus:outline-none`, `text-base`, `bg-bg-2/90`, etc.) inside regex sources or fixture data. The pathological inputs cause PostCSS extraction to throw partway through the candidate scan.

**Symptom:** P6 W8 C3 added `src/a11y/focusRingGate.test.ts` whose body contained the literal substrings `focus:outline-none` and `focus-visible:` as part of a regex meant to detect their presence in chrome `.tsx`. Vitest passed. But `npm run dev` died with `Cannot read properties of undefined (reading 'raws')` deep inside Tailwind's `generateRules.js`, breaking the entire CSS build — HMR stopped working, the editor rendered unstyled until the test file was reverted.

**Trap:** assume Tailwind's content scanner cares only about JSX `className` strings and ignores test files. False — the default content glob `./src/**/*.{ts,tsx}` includes test sources, and the candidate extractor is regex-based (it doesn't AST-parse), so any substring that looks like a Tailwind candidate is fed into the rule-generation pipeline. Most candidates resolve cleanly; pathological ones (regexes constructed from utility-class fragments, certain nested-pseudo combinations) crash deep AST stages.

**Root cause:** **Tailwind v3's content scanner is unsafe under hostile input.** Its candidate extractor (`lib/lib/expandApplyAtRules.js` + `lib/lib/generateRules.js`) constructs PostCSS AST nodes for every captured candidate string. When a candidate hits a malformed parse path (specifically: pseudo-class chains the scanner generates from regex source text), the downstream `raws` field is undefined and the rule generator throws. The test source is "valid" Tailwind input by the scanner's heuristics; the scanner's heuristics are wrong.

**Real fix:** **exclude test sources from Tailwind's content globs** — `'!./src/**/*.test.{ts,tsx}'`. Test files have no CSS contribution; their content is irrelevant to the production bundle. The exclusion costs nothing and isolates the scanner from the only source of hostile candidates that's likely to appear in our codebase. Applied in `tailwind.config.ts` at C3 authoring.

**Detection signal:** dev server fails to start (or HMR fails on next change) with PostCSS error citing `generateRules.js` line numbers; the failure references a `raws` property of `undefined`; the chrome renders unstyled in the browser; the test that triggered it passes cleanly under vitest (vitest doesn't run the Tailwind pipeline). The crash is BUILD-stage, not test-stage — `vitest` + `tsc --noEmit` both pass, the symptom only appears when running the dev server or production build.

**The trap (wrong fix):** rewrite the test's regex to "look less Tailwind-y" — e.g., split `focus:outline-none` into `'focus' + ':' + 'outline-none'` so the substring never appears whole in the file. This works but encodes the wrong invariant. The Tailwind scanner shouldn't see test files at all; the right fix is the content-glob exclusion, not source-level evasion. The split-string form is fine as belt-and-braces (P6 W8 C5's `grepGates.test.ts` uses it), but the primary defense is the glob exclusion.

**Five-limbed argument:**
1. **Claim:** Including test sources in Tailwind's content globs lets hostile candidate strings reach the rule generator, which can throw on regex-constructed pseudo-class fragments.
2. **Reason:** Tailwind's candidate extractor is regex-based and AST-unaware; any substring shaped like a utility class is fed into the same code path as real className strings.
3. **Universal principle:** Build-time scanners that consume source code should be scoped to the files that actually contribute to the build. Tests don't produce CSS; their content should not enter the CSS pipeline.
4. **Application:** P6 W8 C3 added `focusRingGate.test.ts` containing literal `focus:outline-none` in a regex. Tailwind's scanner consumed it; PostCSS extraction threw. Fix: `'!./src/**/*.test.{ts,tsx}'` added to `tailwind.config.ts` content globs.
5. **Conclusion:** Always exclude test files from CSS / asset / bundler content globs. The exclusion is cheap and prevents an entire class of "test file unexpectedly breaks the dev build" failures.

**Sister patterns:** ESLint custom rules that scan for "class-like strings" in source code; PostCSS plugins with `glob` config; Stylelint with `--ignore` paths set too narrowly; any tool that AST-parses source for class-name candidates without distinguishing test sources from production.

**Cross-refs:** P6 W8 C3 commit `bc09f72` (production fix in `tailwind.config.ts:7-11`); `src/a11y/focusRingGate.test.ts:12-14` (the comment documenting the split-string defense at source level); H30 (the sister case where a chrome change broke a test baseline — different direction: chrome→test there, test→chrome here).

---

### H32: Test-grep coverage gate false-positives on token-shaped substrings inside source-code comments

**Span:** any vitest spec that greps a project's `src/` tree for class-name patterns (`text-*`, `bg-*`, etc.) and uses raw substring matching. JSX comments, JSDoc bodies, and inline `//` comments containing hyphenated phrases that share a prefix with a Tailwind utility match the grep without being actual class usages.

**Symptom:** P6 W8 C4 strengthened the contrast-matrix coverage assertion (`src/a11y/contrastMatrix.test.ts`) to grep every `text-*` and `bg-*` token across `src/app/`, `src/viewport/`, `src/timeline/` and fail if any token was not covered by a matrix row OR an explicit WHITELIST entry. The first run flagged a phantom class — an inspection traced it to a JSX comment in `ModeBadge.tsx` containing the hyphenated phrase `text-bearing` (used in the comment as English prose: "the text-bearing label"). The substring matched the grep's `\btext-[a-z]+\b` pattern even though no such Tailwind class exists or is rendered anywhere.

**Trap:** raw substring grep over source code can't distinguish syntactic context. The class-pattern regex matches inside string literals, comments, identifiers — anywhere the characters appear. The author's mental model is "I'm looking for className tokens" but the regex sees "any text matching the pattern."

**Root cause:** **regex scans over source text don't have a parser.** To distinguish "this `text-bearing` is a class candidate" from "this `text-bearing` is a comment", you need either (a) AST awareness to filter to JSX attribute values, or (b) a syntactic scope marker like `className="..."` to anchor the match. The bare `\btext-[a-z]+\b` pattern has neither.

**Real fix two options:**

- **Option A — author convention (lightweight, applied in C5):** in source code comments, prefer parenthetical phrasing over hyphenated compounds that share Tailwind class prefixes. "(which holds the label text)" instead of "the text-bearing label". Costs zero engineering effort; prevents future occurrences from the moment the convention is adopted. Documented in this catalogue entry; not enforced by any tool.

- **Option B — test-side fix (heavier, deferred):** scope the grep to JSX `className` attribute contexts only — match `className="[^"]*\btext-[a-z]+"` or wrap matches inside a `className={\`...${var}...\`}` template-literal pattern. This requires either a lightweight JSX parser or a heuristic match that excludes lines beginning with `//` or sitting inside `/* */`. The complexity isn't justified by a single occurrence; revisit if the pattern recurs.

C5 used Option A. The whitelist was NOT widened — that would have been a workaround (papering over a single false positive at the cost of admitting a bogus token into the gate's accepted set, which would shadow real misses).

**Detection signal:** matrix coverage gate fails citing a "class" that the implementation has never rendered; `grep -rn 'text-bearing\|bg-bearing\|...' src/` returns the source line; the source line is inside a `//` or `/* */` comment or a JSX `{/* */}` block. Verify by checking whether the same string appears inside a real `className=` attribute anywhere in the codebase — if not, it's a comment false-positive.

**The trap (wrong fix):** add the bogus class to the gate's WHITELIST. This makes the gate pass but the whitelist now contains an entry that doesn't correspond to any production CSS. Future genuine misses with similar patterns can ride into the whitelist on precedent ("we exempted text-bearing, why not text-floating?"). The right move is to fix the source so the regex doesn't match in the first place, OR to fix the regex so it doesn't see comments.

**Five-limbed argument:**
1. **Claim:** Raw substring greps over source code that scan for class-name patterns will produce false positives on hyphenated phrases inside comments.
2. **Reason:** Regex matching has no syntactic awareness; the pattern engine treats source code as a flat character stream.
3. **Universal principle:** When a code-quality gate runs on raw source, it must either (a) parse to a syntactic level above the gate's concern, or (b) accept a noise floor and document the convention that avoids it.
4. **Application:** C4's matrix coverage gate matched `text-bearing` in a JSX comment in `ModeBadge.tsx` that had no corresponding class. Resolved at C5 authoring time by rewriting the comment to parenthetical phrasing; H32 documents the pattern so the convention propagates.
5. **Conclusion:** Prefer parenthetical phrasing in comments over hyphenated compounds sharing Tailwind class prefixes. The convention costs zero and prevents the recurrence of an entire false-positive class. The whitelist remains reserved for legitimate documented exemptions, not pattern-match artefacts.

**Sister patterns:** ESLint custom rules grepping for "magic strings"; ripgrep-based pre-commit hooks that fail on banned patterns; security scanners flagging "secret-like" substrings in comments; any text-scan gate that doesn't parse to AST level.

**Cross-refs:** P6 W8 C4 commit `655fa25` (the matrix coverage strengthening + the C5 source-comment rewrite); `src/viewport/ModeBadge.tsx` (the file that surfaced the false-positive); `src/a11y/contrastMatrix.test.ts` (the gate that produced the false positive). H31 covers the sibling pattern where the regex problem hits the BUILD pipeline (Tailwind scanner) rather than a test gate; both share the same root cause family: text-level pattern matching over source code without AST awareness.

### H33: React-bypass escape-hatch value mirrored at the rAF owner instead of the state chokepoint

**Span:** any "escape hatch" where a value is duplicated outside the React subscription path so a hot loop (rAF/animation) can read it without triggering re-renders. P6 W9 instantiation: `currentFrameRef` on `viewportStore`, read by the imperative `TimelineCanvas` rAF playhead loop. Predicted recurrence: the next imperative-canvas surface (P7 splats viewport overlay) — same boundary class.

**Symptom (caught at planning, not runtime — the deductive win):** P6 W9 context memo D-W9-9 specified "Clock.tsx dual-writes `timeStore.setTime(seconds)` AND `currentFrameRef.current = frame`". Source read before planning showed `Clock.tsx:29` calls `useTimeStore.getState().tick(delta)` — there is **no `setTime` call in Clock**, and Clock's `tick` early-returns when `!playing`. Non-playback scrub (dragScrub, ruler drag) and `setDuration` reframing mutate the frame **directly via timeStore, bypassing Clock entirely**. A Clock-sited dual-write would mirror the frame ONLY during playback — the escape-hatch playhead silently freezes during scrub and on duration change while every React `seconds`-subscriber keeps updating. The exact silent-failure the decision was written to prevent, relocated to the paths the rAF owner doesn't touch.

**Trap (the wrong fix):** site the mirror write at the rAF/animation owner because "that's where the tick happens." The animation owner is one *consumer* of frame changes, not the *producer*. Mirroring there covers only paths flowing through that owner; every other mutator of the source is an uncovered divergence site. Adding a second mirror at each missed call site (scrub handler, setDuration) is the workaround cascade — N call sites, N places to forget.

**Root cause:** **the mirror was placed at a consumer, not at the single producer chokepoint.** `timeStore.frame` is derived inside exactly three setters that all call `deriveFrame()` → `set({...frame...})`: `setTime`, `setDuration`, `tick`. That is the chokepoint. A value mirrored for a React-bypass hatch must be written there — once — so it holds by construction for every path that can change the source.

**Real fix:** write the mirror inside the state store's frame chokepoint (the three setters, via one private `mirrorFrame()` helper); the rAF owner gets zero changes. The invariant `viewportStore.currentFrameRef.current === useTimeStore.getState().frame` then holds after every state transition — playback, scrub, duration — because there is only one writer. (P6 W9 C1, commit `a01ce47`.)

**Detection signal:** a value duplicated for a hot loop; the mirror write sits in a component/effect/loop body rather than the store action that owns the source; there exist mutation paths to the source that don't pass through that component (scrub vs playback, programmatic vs UI). Ask: "list every call site that changes the source — does the mirror fire for all, or only the one I was looking at?"

**Five-limbed argument:**
1. **Claim:** A React-bypass escape-hatch value must be mirrored at the single state chokepoint that mutates its source, never at one of its consumers.
2. **Reason:** The consumer sees only the subset of source changes that flow through it; other mutators bypass it and leave the mirror stale with no error.
3. **Universal principle:** Duplicated state must have exactly one writer co-located with the source's single mutation point; single-writer-at-the-chokepoint is the only structure under which a derived copy cannot diverge.
4. **Application:** W9 moved `currentFrameRef`'s write from the memo's Clock.tsx site to `timeStore`'s three frame setters; the sync-invariant vitest (15/15, `viewportStore.test.ts`) is the Lokayata evidence that playback + scrub + setDuration all keep the copy equal.
5. **Conclusion:** The escape hatch is divergence-free by construction, not by remembering to mirror at each call site. The fix strengthened the locked decision's intent (never diverge) while correcting its impossible mechanism (Clock can't dual-write what it never calls).

**Sister patterns:** cache/denormalised fields that must equal a source (cache-invalidation family); `useRef` mirrors updated in a wrong-dependency `useEffect`. V20 is this entry's positive statement (H33 = the trap, V20 = the rule). Cross-ref: [[V20]], W9 plan "Grounding corrections applied", `src/app/stores/timeStore.ts:87-150` (mirrorFrame + 3 setters), `src/app/Clock.tsx:29` (the consumer the memo wrongly named). Provenance class: spec-from-memory framing trap — sister of H25 (H25 = naming similarity, H33 = wrong site for a write; both = "the decision named a mechanism the source contradicts").
