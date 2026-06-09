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
disciplined; the _prompt_ is wrong.

**Root cause:** The agent system prompt's op-shape examples used
`"scene"` as a literal placeholder for the scene aggregator's node id:

```
{"type":"connect","from":{"node":"box1","socket":"out"},"to":{"node":"scene","socket":"children"}}
```

A model with no other signal will copy that string verbatim. The
_Selection_ block in the per-turn context gave the model selected node
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

**Root cause:** the spec was authored from memory of file _names_ and the surrounding domain language, not from observation of file _contents_. Domain words ("inspector", "panel", "store", "cache") cluster around boundaries because the boundary is the thing being named — but two files at the same boundary often have orthogonal jobs (one mutates, one displays; one props-edits, one HUD-toggles). Naming similarity is downstream of the same boundary; functional overlap is a separate question.

**The trap:** writing the merge into the locked-decisions table (D-UX-N) and pulling forward into a wave's atomic commit before reading both files. Once "merge X and Y" is locked, the discovery that they aren't duplicates feels like late-breaking noise instead of the actual signal it is.

**The real fix:** before any "merge / delete / replace" decision lands in a spec, open the two files end-to-end. State each file's job in one sentence. Only if the sentences overlap does the merge framing apply. Add a "what each file actually does today" pass to the spec authoring routine, _before_ the locked-decision table is populated.

**Five-limbed argument:**

1. **Claim:** Functional roles must be observed from code, not inferred from filenames.
2. **Reason:** Filenames cluster at boundaries; functional roles span boundaries. Two files at the same boundary may have non-overlapping jobs.
3. **Universal principle:** Lokayata at the _spec_ level — observation runs alongside specification, not after.
4. **Application:** P6 spec D-UX-8 framed `Inspector.tsx` (property editor) + `NPanel.tsx` (viewport HUD: gizmo mode, snap, grid/axis toggles) as duplicate inspectors based on name similarity. They have orthogonal roles.
5. **Conclusion:** Caught at W1 start by reading both files; D-UX-8 corrected mid-wave (NPanel deleted in W7 with functions absorbed into R8, Inspector kept as canonical). One round-trip lost; one decision-table cell rewritten.

**Update 2026-05-11 (W2.6):** the W1 correction was itself reversed two waves later. By W2 the TopToolbar absorbed NPanel's mode + snap groups, leaving only grid/axis toggles unique to NPanel — and those were already slated to move to W7's FloatingViewportToolbar. The "they're not duplicates" claim that was true at W1 (lokayata-validated then) was false at W2.6 (lokayata-disconfirmed by the new chrome shape). The DEEPER lesson under H25: spec re-validation is a _cycle_, not a one-time fix. Every wave that touches adjacent chrome can shift whether two surfaces remain distinct. The sister pattern H27 below captures this directly.

**Sister patterns:** any future spec that proposes a merge based on name resemblance — `MaterialOverride.ts` + `MaterialPreset.ts`, `KeyframeChannel*.ts` siblings, `*Store.ts` lookalikes. Read both before locking. AND: any prior "they're not duplicates" claim should be re-validated after every wave that absorbs chrome (H27).

**Cross-refs:** docs/UI-SPEC.md §1 D-UX-8 (W2.6 restoration entry); §5.8 NPanel canonical Inspector; H27 (parallel-surface evolution drift); vyapti V13.

### H26: happy-dom localStorage non-functional at module-load time

**Span:** any zustand store under `src/app/stores/` that reads `localStorage` at module-load time AND has a unit test that imports it directly.

**Symptom:** `TypeError: localStorage.getItem is not a function` at module-load — the test file fails before any test body runs. `(node:NNN) Warning: --localstorage-file was provided without a valid path` appears before the failure.

**Root cause:** vitest's `happy-dom` environment exposes `localStorage` as a globalThis property, but its method bindings are not attached at the moment a `src/app/stores/*.ts` module is imported by the test file. `typeof localStorage === 'undefined'` returns `'object'` (truthy guard misfires); the call to `getItem` then bombs because the slot is a partially-constructed Storage stub.

**The trap:** asserting `typeof localStorage === 'undefined'` is sufficient defense. It isn't — the value is _defined_, but methods aren't.

**The real fix:** defensive helpers that check for _callable_ methods, not just defined globals:

```ts
function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
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

**The trap:** trusting a frozen-in-time "they're not duplicates" claim. A claim that was lokayata-validated against W1's chrome shape is just a memory once W2's chrome ships. H25 caught the _first_ iteration of this trap (don't lock from memory before reading code); H27 catches the _recurring_ iteration (don't trust prior validation across structural waves).

**The real fix:** every wave that absorbs chrome (TopToolbar absorbing NPanel mode/snap groups; FloatingViewportToolbar absorbing grid/axis toggles; etc.) triggers a re-validation pass over any spec entry of the form "X and Y are distinct because…". Test: list each surface's _current_ unique sections; if the count is 0 or 1, the merge is unblocked and the spec entry is stale.

**Five-limbed argument:**

1. **Claim:** Spec entries asserting surface distinctness must be re-validated after every wave that touches adjacent chrome.
2. **Reason:** Distinctness claims are conjunctions of "X has unique section Y, Z, W" — chrome evolution can empty the conjunction silently.
3. **Universal principle:** Lokayata at the spec level is _recurring_, not one-time. The first observation validates the claim at W*N; the same observation must run again at W*(N+k) if any adjacent chrome shifted.
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

**Span:** every chrome wave that deletes or renames a `data-testid` value. Author's mental model: "the testid lives in component X, so I'll grep its tests + the test file named after X." Reality: testids are global identifiers — _any_ spec across the entire `tests/e2e/` tree can reference them as setup, side-effect verification, or unrelated coverage.

**Symptom:** P6 W7 C2 deleted `TransformToolbar.tsx` and its `toolbar-shading-*` testids. The C2 grep gate matched testids inside the obviously-related `tests/e2e/p26-acceptance.spec.ts` (P2.6 was where the component originally landed) and migrated 3 specs cleanly. The full e2e suite passed locally because Playwright was run scoped to the migrated specs. A separate top-level acceptance suite at `tests/e2e/acceptance.spec.ts:233` used `toolbar-shading-rendered` as a SETUP step for the PostFx beauty pixel-diff test (#7 PostFx beauty matches reference within 2% pixel diff) — caught only by the post-PR critical-self-review running the full suite, not by the wave's verification gate.

**Trap:** scope the grep to the file you EXPECT to find the testid in. P26's specs were the OWNING reference for this testid family; W7 migrated all 3. The grep `grep -rnE 'toolbar-shading-' tests/e2e/p26-acceptance.spec.ts` is clean. The grep `grep -rnE 'toolbar-shading-' tests/` is NOT clean — `acceptance.spec.ts` references the same name without being "about" the deleted component.

**Root cause:** **testids are project-global names; their consumer set is unbounded.** The migration grep gate must be project-global too. The mental shortcut "I'll check the file where the original testid was introduced" is a false ownership inference — testids have no owners, only authors and consumers. Any wave that exposes a chrome affordance for an effect (shading, snap, mode, selection) becomes a downstream consumer the next wave's migration must find.

**Real fix:** the grep gate for ANY testid deletion or rename must run with **NO file scope** — the regex applied to the entire `tests/` and `src/` tree. For W7 the gate was conceptually right (`grep -rnE 'toolbar-shading-|toolbar-snap-|toolbar-mode-(translate|rotate|scale)|transform-toolbar' src/ tests/`), but it was only run after C4's commit, not at the end of C2. Move the project-wide grep gate to be a HARD verification step at the end of every chrome-deletion commit, before the commit message even gets drafted.

**Detection signal:** "I migrated all the obvious specs and they pass, but a screenshot/integration test from an unrelated phase suddenly fails with `Locator not found: getByTestId('old-name')`." Or: `--reporter=list` on the full suite shows a single failure in a spec whose name has no obvious connection to the changed component. Or: CI fails on a spec the author never opened during the migration. All three are the same signature: a non-obvious consumer.

**Five-limbed argument:**

1. **Claim:** Scoping a testid-migration grep to the file you mentally associate with the testid will miss legacy specs that consume the testid as setup or side-effect verification.
2. **Reason:** Testids are project-global names; the original component owns the _production_ of the name, but its CONSUMERS can be anywhere — including specs from earlier phases that wired the testid as a "click this before the real test" setup step.
3. **Universal principle:** When a name is global, the migration gate must be global too. File-scoped greps encode a false ownership relationship onto a flat namespace.
4. **Application:** W7 C2 deleted `TransformToolbar.tsx`. Grep gate ran inside the `p26-acceptance.spec.ts` file (the "owning" tests). Clean. But `tests/e2e/acceptance.spec.ts:233` used `toolbar-shading-rendered` as a setup step for the PostFx beauty test — completely unrelated to the chrome migration's intent, yet still a hard consumer. The orphaned reference was caught only by post-PR critical self-review (`50eec3b`).
5. **Conclusion:** Run testid-deletion grep gates with `tests/ src/` as the search root, never a single file. Add the project-wide grep to the wave's verification gate list, BEFORE the deletion commit message gets written. Sister rule applies to type renames, store-key renames, and any other global-name change.

**Sister patterns:** type rename where one re-export survives in an unexpected barrel file; store-action rename where one Storybook story or fixture references the old name; environment variable rename where one bash script or Dockerfile retains the old value. All share the same shape: file-scoped grep makes a false ownership assumption.

**Cross-refs:** `tests/e2e/acceptance.spec.ts:233` (the orphan that survived C2's file-scoped grep); P6 W7 commit `50eec3b` (the self-review fold-in that migrated it); P6 W7 commit `959ae96` (the C2 split that introduced the gap). The grep that catches the case: `grep -rnE 'toolbar-shading-|toolbar-snap-|toolbar-mode-(translate|rotate|scale)|transform-toolbar' src/ tests/` — note the project-wide scope.

---

### H30: Pixel-diff snapshot baselines invalidate when an absolute-positioned overlay is added to a screenshot-targeted container

**Span:** every Playwright `toHaveScreenshot` call on an HTML container element (a `<div>` rather than a `<canvas>` directly) that has or could gain absolute-positioned descendants. Affects acceptance suites that capture editor regions for visual regression — P2.6's PostFx beauty test is the current instance.

**Symptom:** P6 W7 C1 added `<FloatingViewportToolbar />` as an `absolute bottom-4` overlay inside `<div data-testid="viewport" className="relative">`. The `tests/e2e/acceptance.spec.ts#7 PostFx beauty matches reference within 2% pixel diff` test, which captures `page.getByTestId('viewport').toHaveScreenshot('postfx-beauty.png')`, started failing with `Expected an image 660px by 557px, received 660px by 570px. 14765 pixels (ratio 0.04 of all image pixels) are different.` The Canvas-render content was unchanged; only the surrounding chrome region grew (the absolute child extended the element's screenshot extent by ~13px).

**Trap:** assume `position: absolute` children don't change the parent's bounding box (true for CSS _layout_ purposes — absolute removes children from normal flow). Therefore assume the screenshot of the parent stays the same. False — Playwright's element-screenshot captures the laid-out bounding rect _including_ visible descendants when `overflow: visible` (the default). Absolute children with `bottom-N` painted within the parent's frame ARE captured.

**Root cause:** **Playwright `toHaveScreenshot` on a locator uses the element's full painted bounds, not its CSS content-box.** When an absolute child paints outside the inline content area (which `bottom-4` does — it's positioned relative to the parent's bottom edge, not stacked at the end of inline flow), the screenshot extent grows to include the painted child. The "trap" only fires when (a) the parent's CSS has no explicit `overflow: hidden` AND (b) the absolute child paints a visible region (background, border, content).

**Real fix two options:**

- **Option A — rebaseline.** When the overlay is a _permanent_ part of the new editor reality (as R8 is post-W7), the right move is `npx playwright test --update-snapshots` to capture the new ground truth. Verify the rebaseline is intentional in the commit message + body so future readers understand it wasn't just "the test was flaky."

- **Option B — narrow the screenshot target.** When the overlay is incidental to what the test is _about_ (e.g., the PostFx beauty test is about the canvas render, not the surrounding chrome), change the target from the wrapper div to the canvas itself: `page.locator('canvas').toHaveScreenshot('postfx-beauty.png')`. This is a one-time baseline migration but produces a more honest test going forward.

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

- **Option B — test-side fix (heavier, deferred):** scope the grep to JSX `className` attribute contexts only — match `className="[^"]*\btext-[a-z]+"` or wrap matches inside a `className={\`...${var}...\`}`template-literal pattern. This requires either a lightweight JSX parser or a heuristic match that excludes lines beginning with`//`or sitting inside`/\* \*/`. The complexity isn't justified by a single occurrence; revisit if the pattern recurs.

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

**Trap (the wrong fix):** site the mirror write at the rAF/animation owner because "that's where the tick happens." The animation owner is one _consumer_ of frame changes, not the _producer_. Mirroring there covers only paths flowing through that owner; every other mutator of the source is an uncovered divergence site. Adding a second mirror at each missed call site (scrub handler, setDuration) is the workaround cascade — N call sites, N places to forget.

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

---

### H34 — AnimationLayer orphan: wrapper output produces no motion unless spliced into the render chain

**Span:** any transparent Mesh→Mesh wrapper node (AnimationLayer, and by structural analogy Transform/MaterialOverride if authored bare) whose contribution is visible ONLY when its `.out` socket is itself consumed by the render chain. The evaluator (`src/core/dag/evaluator.ts:97-113`) resolves a node strictly by walking its declared `node.inputs` bindings from the root output ref; a node not reachable along that input chain is never evaluated and contributes nothing. Predicted recurrence: any future layer-mixer / post node, any agent Mutator that adds a wrapper but forgets the scene-rewire edge.

**Symptom:** KeyframeChannelVec3 → AnimationLayer.animation is wired, playback advances, dopesheet shows the channel row — but the mesh does not move in the viewport. The evaluated `scene.children[0]` is still the raw un-patched mesh value (or, if `target` is also unwired, the layer renders nothing).

**Trap (the wrong fix):** assume the closure/eval walk auto-splices AnimationLayer between the mesh and the Scene because AnimationLayer.ts:19-23 references H22 multi-direction closure specs. It does not. H22 closure walking is for Mutator _scope computation_ (which nodes a mutation touches), NOT for render evaluation. The render evaluator only follows input bindings. Adding more channels, toggling weight, or re-dispatching the channel never helps — the layer is an orphan node off the render path.

**Root cause (data-flow / scene-graph ownership):** `Scene.children` (a _list_ input socket — `src/core/dag/ops.ts:192-197`) is bound to the raw mesh's `.out` in the default seed (`src/core/project/default.ts:60-64`). AnimationLayer produces a patched deep-clone on its `.out` (`src/nodes/AnimationLayer.ts:82-93`) but nothing consumes that socket. The evaluator never reaches the layer; the un-patched seed box keeps flowing into the scene. Two edges are missing/wrong: (1) `mesh.out → layer.target` (without it `patchTarget(null,…)→null`, layer renders nothing — AnimationLayer.ts:112, SceneFromDAG.tsx:381); (2) `Scene.children` must be **rewired** — disconnect `mesh.out → scene.children` and connect `layer.out → scene.children`. Because children is a list, a bare `connect` without the matching `disconnect` renders BOTH the raw box and the layer side-by-side.

**Real fix (seed topology, not a code bug):** four edges — `time.out→channel.time`, `channel.out→layer.animation`, `mesh.out→layer.target`, and `disconnect mesh.out→scene.children` then `connect layer.out→scene.children`. Verified by dev-seam observation: evaluated `scene.children[0]` becomes the AnimationLayer value whose `.target.rotation` advances `[0,0,0]→[0,90,0]→[0,180,0]→[0,360,0]` across t=0→2s.

**Detection signal:** an animation wrapper is wired to its channels but `Scene.children` (or the relevant downstream list socket) still names the raw target node, not the wrapper's `.out`. Ask: "trace from `outputs.render` through input bindings only — is the wrapper on that path? Is its `target` wired?"

**Five-limbed argument:**

1. **Claim:** An AnimationLayer animates the viewport only if its `.out` is on the input-binding path from the active render output AND its `target` input is wired to the mesh.
2. **Reason:** The evaluator resolves nodes exclusively by walking declared input bindings (evaluator.ts:97-113); an orphan wrapper is never evaluated, and a targetless wrapper patches `null`.
3. **Universal principle:** In a pull-based DAG evaluator, a node contributes to an output iff it is reachable from that output's root through input edges — producing a value on an unconsumed output socket is inert.
4. **Application:** The seed binds `Scene.children ← n_box.out`; the layer's `.out` is unconsumed, so the cube renders un-patched. Rewiring `Scene.children ← spin_layer.out` and `spin_layer.target ← n_box.out` puts the layer on the path; observed rotation advances 0→360° over 2s.
5. **Conclusion:** The motion is absent purely because of orphan topology; the pipeline is correct. The fix is two wiring edges plus a list-socket disconnect, not a code change.

**Test-coverage gap (catalogue note):** `tests/e2e/p3-acceptance.spec.ts:113-127` (P3#3) wires channel→layer.animation and box→layer.target but **never rewires `Scene.children` to `box_layer.out`**, then only asserts the dopesheet row renders — it does NOT assert visual motion. P3#3 therefore exercises the exact orphan topology described here and passes anyway. This is a real coverage gap: there is no test asserting an AnimationLayer produces a changed evaluated transform at the render root over time. Worth a P7 follow-up test (`__basher_evaluate(outputs.render, ctx)` rotation-delta assertion, mirroring the dev-seam probe used to confirm H34). Cross-ref: H22 (closure scope ≠ render reachability — the distinction this entry sharpens), `src/core/project/default.ts:60-64`, `src/core/dag/evaluator.ts:97-113`, `src/nodes/AnimationLayer.ts:82-93`, `src/viewport/SceneFromDAG.tsx:379-381`.

### H35 — Cardinality-mirror passes while pixels are clipped: the "count ≠ visible" escape (canvas coordinate maps with no edge inset)

**Span:** any canvas/imperative surface whose automated test asserts a _count_ mirror-attribute (`data-rendered-keyframes`, `data-*-count`) as a proxy for "the thing is on screen", while the actual draw uses a coordinate map that can place elements off the drawable area. P6 instantiation: `TimelineCanvas` — `cullVisibleKeyframes` (inclusive bounds) counts a keyframe at `t=0` or `t=duration` as "rendered" (count=2), but `secondsToX` maps `[0,dur]→[0,widthPx]` with no inset, so `keyframeToRect` centered an 8px diamond at x∈[-4,+4] / [w-4,w+4] — half-clipped off both edges, the frame-0 keyframe (the most common keyframe in any animation) effectively invisible behind the label gutter. Predicted recurrence: any future canvas surface (P7 splats overlay, node-graph minimap) that count-asserts visibility.

**Symptom:** the W9 e2e (`data-rendered-keyframes` constant/equal) passes; the user sees fewer diamonds than keyframes. Count says N, eyes say <N. No error anywhere.

**Trap (the wrong fix):** trust the green count test and conclude "rendering is fine, the seed/data is wrong" — exactly the inference that cost the orchestrator four wrong console snippets before reading `timelineCanvasGeometry.ts`. Or: widen the cull bounds (the cull is _correct_; the keyframes ARE in range — the bug is the x-map, not the filter). Or: pixel-diff the canvas to catch it (forbidden — H30/D-W9-4; and it would only catch it after the fact, not state the cause).

**Root cause (boundary / coordinate-mapping):** `data-rendered-keyframes` is a **cardinality** mirror — it proves "how many passed culling", NOT "how many are within the visible pixel rectangle". A coordinate map `[0,span]→[0,widthPx]` with **no edge inset** places terminal elements with their _center_ on the canvas extreme, so any element with width clips by half. The mirror-attr test is structurally blind to this because the count is computed pre-projection (from cull) while the clip happens post-projection (in `keyframeToRect`). This is the **concrete escape of the FLAG-2 "count ≠ pixels" limitation** that was _predicted_ at W9 (D-W9-4 / W9 shipped memo: "count-constant ≠ pixels-restored") and recorded as a known automated-observation gap — H35 is its promotion from predicted-gap to demonstrated-pattern (per the dharana decision model: predicted-then-occurred = catalogue).

**Real fix:** inset the _element_ coordinate map, not the cull. F-7 (`4762d49`): `keyframeToRect` maps into `[inset, widthPx-inset]` (`effective inset = max(KEYFRAME_EDGE_INSET_PX, diamondPx/2)` so any diamond size is fully on-canvas), `secondsToX`/playhead untouched, zero-guard preserved. The proof surface is the **pure-geometry vitest** (D-W9-4's tested-pure layer): assert `keyframeToRect(t=0,…).x ≥ 0` and `t=dur → x+w ≤ widthPx`. This closes the _specific_ escape; the _general_ lesson is the detection signal below.

**Detection signal:** a canvas test asserts a `*-count` mirror-attr as evidence of visibility; the geometry maps a value range flush onto `[0,widthPx]` (or `[0,height]`) with no inset; elements have non-zero width/height. Ask: "does the count test prove _cardinality_ or _on-screen position_? Can a counted element be drawn with its center on x=0 or x=width?" If the count is computed before the projection that can clip, the test is blind to clipping by construction — add a pure-geometry bounds assertion (not a pixel-diff).

**Five-limbed argument:**

1. **Claim:** A cardinality mirror-attribute (`data-*-count`) cannot serve as a visibility assertion for a canvas surface whose coordinate map can place elements off the drawable rectangle.
2. **Reason:** the count is computed pre-projection (from culling); the clip occurs post-projection (in the rect map); no information flows from the clip back to the count, so a green count is consistent with invisible elements.
3. **Universal principle:** a proxy assertion is only valid if every failure mode of the real property also fails the proxy; here a real failure (element off-canvas) leaves the proxy (count) passing — the proxy is unsound for the property.
4. **Application:** W9's `data-rendered-keyframes` count test passed while a t=0 keyframe was half-clipped; the sound proxy is a pure-geometry bounds assertion on `keyframeToRect` (F-7's vitest), which fails iff a terminal element leaves `[0,widthPx]`.
5. **Conclusion:** keep the count test for cardinality, but visibility of a canvas element must be proven in the tested-pure geometry layer (D-W9-4), never inferred from a count and never from a forbidden pixel-diff.

**Cross-ref:** FLAG-2 (the predicted gap this concretises — W9 shipped memo + UI-REVIEW.md CI-1), F-7 (the fix, commit `4762d49`, UI-REVIEW.md §7), H30 (why pixel-diff is not the answer), D-W9-4 (the tested-pure-geometry layer that IS the answer), `src/timeline/timelineCanvasGeometry.ts` (`keyframeToRect`, `secondsToX`, `cullVisibleKeyframes`), `src/timeline/timelineCanvasGeometry.test.ts` (the F-7 bounds cases). Sister of H32 (test instrument blind to a class of real defect by construction) and the FLAG-2 family (count ≠ pixels). Provenance: predicted at W9 as a known automated-observation gap; escaped concretely 2026-05-17 during the W10 FLAG-2 manual-scrub confirmation when a user-pasted seed with terminal keyframes rendered one diamond instead of two; promoted predicted→numbered per the decision model.

---

### H36 — Gaming a mechanical distinctness gate produces a semantically false contract (preserves ∩ lossy overlap to win V14)

**Span:** any Mutator whose `(requiredEdges, requiredNodeTypes, preserves)` V14 signature would collide with an existing Mutator, "resolved" by placing a token in `preserves` purely to make the tuple unique. P7 instantiation: `deleteKeyframe.contract` lists `'keyframe-identity'` in BOTH `preserves` and `lossy`, and claims `preserves:['animation-shape']` though deleting a mid-curve key changes the curve arbitrarily (no ε bound — strictly weaker than `simplifyChannel`'s identical-looking claim). Predicted recurrence: every future delete/replace-class Mutator that must be V14-distinct from an append/fit-class one while the V14 signature excludes `lossy`.

**Symptom:** the V14 mechanical collision test (`src/agent/mutators/mutators.test.ts`) is GREEN and provably non-blind (`listMutators()` includes the new name), all suites pass — but the Mutator's contract asserts it preserves an aspect it actually destroys. No test fails; the lie surfaces only when a consumer trusts `preserves` (plan-preview hints, closure-preservation reasoning, an agent choosing a Mutator by contract).

**Trap (the wrong fix):** add the distinguishing token to `preserves` because that is the only field the V14 signature reads, and the suite goes green. This treats "make the mechanical gate pass" as the goal; the gate is a proxy for "contracts are honest and non-redundant" — gaming the proxy satisfies the letter while inverting the intent. Adding the token to `lossy` instead does nothing (V14 ignores `lossy`), which is precisely the pressure that pushes it into `preserves`.

**Root cause (boundary / proxy-vs-property):** V14's distinctness signature is `(requiredEdges, requiredNodeTypes, preserves)` — `lossy` is excluded (`mutators.test.ts:155-159`). For two Mutators that differ only in what they DESTROY (append vs delete a sample), the only honest discriminator lives in `lossy`, but the gate cannot see it — so honest contracts collide and the mechanically-rewarded escape is a false `preserves` entry. The gate's input set is too narrow for the property it certifies.

**Real fix (the invariant, not the artifact):** widen V14's signature to include the `lossy` aspect set so delete-class Mutators are distinct _by their honest loss declaration_, then state `deleteKeyframe` truthfully (`keyframe-identity` in `lossy` ONLY; drop the false `preserves:['animation-shape']`). This is a change to the V14 vyapti definition + its mechanical test, scoped on its own (it re-touches every Mutator's distinctness computation) — not an inline patch. Until then the false contract is a documented LOW-impact caveat (it feeds preview hints, not the evaluated motion path; P7's GOAL gate asserts the evaluated transform delta, which is unaffected).

**Detection signal:** a token appears in BOTH a contract's `preserves` and `lossy`; OR a `preserves` claim is identical to another Mutator's but the operation is strictly more destructive; OR a commit message / deviation note says "added X to preserves so V14 passes". Ask: "is this token in `preserves` because the op preserves it, or because the distinctness gate only reads `preserves`?" If the latter, the gate's input set — not the contract — is what must change.

**Five-limbed argument:**

1. **Claim:** Making a Mutator V14-distinct by adding a token to `preserves` that the operation does not preserve produces a green gate and a false contract.
2. **Reason:** V14's distinctness tuple excludes `lossy`, so the only field that can break a delete-vs-append collision is `preserves`; a truthful `lossy`-only declaration leaves them colliding, so the mechanically-rewarded move is a `preserves` entry the op contradicts.
3. **Universal principle:** when a mechanical gate certifies a property using a strict subset of the contract, optimising for the gate diverges from the property exactly where the excluded fields carry the real distinction — the proxy must read every field the property depends on, or it rewards lies.
4. **Application:** `deleteKeyframe` won V14 distinctness via `'keyframe-identity'` in `preserves` (also duplicated in `lossy`) and a false `preserves:['animation-shape']`; V14 is green, the contract is dishonest, impact is LOW only because no current consumer on the GOAL path trusts it.
5. **Conclusion:** the fix is to widen V14's signature to include `lossy` (the invariant), not to keep editing `preserves` (the artifact); the green gate was certifying the wrong thing.

**Cross-ref:** [[V14]] (the invariant whose signature was too narrow — widened 2026-05-18 to read `lossy[].kind`; see V14's "Signature widening" note), B1/B2 in `.planning/phases/07-animation-authoring/PLAN.md` (where the literal contract text drove the overlap), VERIFICATION.md C-1 (the verifier finding), `src/agent/mutators/builders/removeKeyframes.ts` (the parameterized successor — `clearChannel` + `deleteKeyframe` collapsed under V14's "parameterize over fork" preference once their honest contracts collided), `src/agent/mutators/types.ts` (the `PreservedAspect` union — `'keyframe-identity'` retired), `src/agent/mutators/mutators.test.ts` (the V14 mechanical assertion + its widened signature). Sister of H32/H35 (test instrument blind to a real defect class by construction — here the gate was blind to `lossy`, so it certified a lie). Provenance: flagged at the P7 Wave B execution checkpoint as an open review item; confirmed a real defect by the adversarial P7 verifier 2026-05-18 (single-pass diagnosis); promoted to numbered entry per the decision model (predicted-then-confirmed).

**RESOLUTION (2026-05-18, issue #60):** V14's signature widened to include `lossy[].kind`. Under the widened gate, honest `deleteKeyframe` collided with honest `clearChannel` (both destroy `animation-shape` + `keyframe-density` at different scales) — V14 correctly flagged the parameterization candidate. The two were merged into `mutator.timeline.removeKeyframes` with `scope: 'all' | { time: number }`. The dishonest `'keyframe-identity'` PreservedAspect was retired as dead. 895/895 vitest, 13/13 e2e regression incl. the P7 motion gate (unchanged: `[0,0,0]→[0,180,0]→[0,360,0]`). The H36 pattern itself remains catalogued — the trap is reachable for any future mechanical gate whose input set is a strict subset of the property it certifies.

---

### H37 — Inverting the wrong forward map: a pixel→value inverse blind to an edge inset (H35-family sibling)

**Span:** any inverse coordinate function whose forward partner applies an edge inset (or any non-identity affine term) that a _sibling_ forward function does NOT. P7.1 instantiation: `xToSeconds` must invert `keyframeToRect`'s center-x map (`inset + secondsToX(t,dur,widthPx-2*inset)`, `inset = max(KEYFRAME_EDGE_INSET_PX, diamondPx/2)`), NOT bare `secondsToX` — the diamonds a director grabs are inset (F-7); the playhead is deliberately not. Predicted recurrence: any future hit-test/drop inverse for an inset/padded canvas element (CurveEditor value-drag, splat overlay, a zoomed timeline).

**Symptom:** drag hit-test and drop _seem_ to work in the track interior but drift by exactly the inset at the track edges — grabbing or dropping the t=0 or t=duration keyframe (the single most common keyframe in any animation) lands off by `KEYFRAME_EDGE_INSET_PX`. A round-trip vitest written against the _bare_ forward map (`secondsToX`) passes for the wrong inverse — the test is blind to the inset by construction (sister of H32/H35).

**Trap (the wrong fix):** invert the simpler/more-visible forward function (`secondsToX`) because it is "the time→x map" — the inset lives one call up in `keyframeToRect` and is easy to not see. Then "fix" the edge drift with a +inset fudge at the call site, which is a second uncatalogued map (the H36 one-honest-discriminator family applied to geometry).

**Real fix:** invert the EXACT forward map the grabbed element uses, including every term (`inset`, `innerWidth`, and the degenerate `innerWidth ≤ 0` else-branch `keyframeToRect` falls back to). Prove it with a tested-pure round-trip whose x is derived from `keyframeToRect` _exactly as the canvas computes it_ (NOT `secondsToX`), and whose cases INCLUDE t=0 and t=duration — an inset-blind inverse fails there specifically and only there. Never a pixel-diff (H30 / D-W9-4 / D-W9-8).

**Detection signal:** an inverse function pairs with a forward function whose name suggests it is "the" map, but the element being inverted is positioned by a _wrapper_ that adds padding/inset/zoom. Ask: "which exact expression computes the pixel I am inverting — is it the bare map, or the bare map wrapped in an inset/transform? Does my round-trip test derive its input from the wrapper or the bare map?" If the test uses the bare map, it cannot catch an inset-blind inverse.

**Five-limbed argument:**

1. **Claim:** Inverting `secondsToX` instead of `keyframeToRect`'s inset-aware center-x yields a hit-test/drop that drifts by the inset at the track edges.
2. **Reason:** the diamond's pixel is `inset + secondsToX(t,dur,widthPx-2*inset)`; the inverse of `secondsToX` alone omits the `inset` shift and the `widthPx-2*inset` rescale, so the error is zero only at the inset's symmetric midpoint and maximal at t=0 / t=dur.
3. **Universal principle:** an inverse is correct only against the exact forward expression that produced the value; inverting a sub-expression of the true forward map is correct only where the omitted terms vanish.
4. **Application:** P7.1 `xToSeconds` mirrors `keyframeToRect:177-182` term-for-term incl. the `innerWidth ≤ 0` fallback; the round-trip vitest derives x via `keyframeToRect` and asserts t=0 & t=duration < 1e-9 (an inset-blind inverse fails exactly these).
5. **Conclusion:** the bounds-faithful round-trip in the tested-pure layer (not a pixel-diff, not a secondsToX round-trip) is the only sound proof the inverse is the true inverse.

**Cross-ref:** [[H35]] (parent — count/coord map blind to edge insets; this is the _inverse-direction_ sibling), F-7 / `KEYFRAME_EDGE_INSET_PX` (the forward inset this undoes), [[H36]] (the "+inset fudge at call site" would be the second-discriminator trap), D-07 (the locked decision), `src/timeline/timelineCanvasGeometry.ts` (`xToSeconds`, `keyframeToRect`), `src/timeline/timelineCanvasGeometry.test.ts` (the `xToSeconds (D-07 inverse)` block — t=0/t=dur edge cases). Provenance: predicted in CONTEXT D-07 pre-mortem; built correctly first pass with the edge round-trip as the guard; catalogued per the framework mandate (a >0-attempt-prevented pattern — the test design is what prevented the attempt).

---

### H38 — Composite retime drops `easing`: the channel's per-type default silently overwrites it

**Span:** any composite that removes-then-re-adds a record through a builder that _defaults_ an omitted field. P7.1 instantiation: `dispatchRetimeKeyframe` = `removeKeyframes({scope:{time:fromTime}})` + `keyframe({time:toTime,value,easing})`; `keyframe.ts:105` falls `easing` through to a per-channel-type default (`linear`/`cubic`) when omitted. Predicted recurrence: any "move/duplicate X" built as remove+add where X carries fields the add-builder defaults (easing, tangents, interpolation mode, per-key metadata).

**Symptom:** the keyframe retimes to the right time with the right value, but its easing silently reverts to the channel default — a `cubic`-eased key dragged on a Number channel comes back `linear`. No error; the interpolation just changes. Surfaces only when a consumer inspects easing or the curve shape visibly differs after a drag.

**Trap (the wrong fix):** pass only `{channelId, time, value}` to the `keyframe` builder (the obvious "move it to the new time with its value" shape) and let easing default — the happy-path test that only asserts time+value is green, so the loss is invisible.

**Real fix:** capture EVERY defaulted field of the original record from the live DAG _before_ the remove, and pass each explicitly into the re-add spec. Assert the field survives the round trip in the verify (the dispatch vitest asserts `easing` preserved; the e2e asserts it through the evaluated path).

**Detection signal:** a composite reads a record, removes it, re-adds it via a builder; the re-add spec omits a field the builder is documented to default. Ask: "what does the add-builder do with every field I did NOT pass? Is any of them present on the original record?" If yes and omitted → silent overwrite.

**Five-limbed argument:**

1. **Claim:** Omitting `easing` from the retime's `keyframe` spec silently changes the keyframe's interpolation to the channel default.
2. **Reason:** `keyframe.ts:105` is `spec.easing ?? DEFAULT_EASING_BY_TYPE[type]`; an undefined spec field is indistinguishable from "use the default", so the original easing is lost the moment it is not threaded through.
3. **Universal principle:** a remove+re-add is value-preserving only if every field the source carried is explicitly carried into the re-add — defaulted fields are dropped unless named.
4. **Application:** `dispatchRetimeKeyframe` reads `value` AND `easing` from the matched sample before `removeKeyframes` and passes both into the `keyframe` spec; the dispatch test asserts `easing:'cubic'` survives a retime, the e2e asserts `easing:'linear'` survives through `__basher_evaluate`.
5. **Conclusion:** capture-pre-remove + explicit pass-through is the structural defense; a test that asserts only time+value cannot catch this — the verify must assert the defaulted field too.

**Cross-ref:** D-01 (the locked decision naming this as the pre-mortem defect), [[K13]] drag-lifecycle extension (step "capture value+easing at pointerdown — MUST precede the remove"), `src/app/animate/dispatchMutator.ts` (`dispatchRetimeKeyframe`), `src/agent/mutators/builders/keyframe.ts:105` (the defaulting line), `src/app/animate/dispatchMutator.test.ts` (the value+easing-preserved assertion). Sister of H37 in the same phase (both are "the obvious shape silently loses information the structure must preserve"). Provenance: predicted in CONTEXT/D-01 pre-mortem; defended by design first pass; catalogued per mandate.

---

### H39 — A transient overlay gated on ANOTHER overlay's idle-compare freezes when that other overlay is idle (FLAG-1)

**Span:** any imperative canvas with ≥2 independently-driven overlays sharing one rAF loop, where overlay B's redraw is nested inside overlay A's "did A change?" idle-guard. P7.1 instantiation: the drag ghost (driven by the cursor) nested inside the playhead's `if (newX !== lastPlayheadXRef.current)` (driven by time) — a PAUSED director scrubbing a key has a moving cursor but ZERO playhead delta, so the ghost freezes mid-drag. Predicted recurrence: any future canvas overlay added to K13's loop (splat handles, selection marquee, snap guides) gated on the playhead's or another overlay's change-compare.

**Symptom:** the ghost (or second overlay) tracks fine _while the playhead is also moving_ (playing back), but FREEZES the instant playback is paused — exactly when a director is most likely to be precisely placing a key. Looks like the drag "stopped working" with no error; resumes if playback restarts.

**Trap (the wrong fix):** nest the new overlay's draw inside the existing idle-guard because "it's the same rAF tick and the guard is already there" — it couples overlay B's liveness to overlay A's driver. A worse second workaround: force the playhead to redraw every tick (kills the K13 idle early-out → perf regression) to "unfreeze" the ghost.

**Real fix:** each imperative overlay owns its OWN change-gate keyed to ITS OWN driver, as a SIBLING block in the shared loop — not nested in any other overlay's guard. The ghost block is `if (dragRef.current) { … if (ghostX !== lastGhostXRef.current) { … } }`, a sibling AFTER (W9 overlay-last ordering) the playhead's `if (newX !== lastPlayheadXRef.current)`, never inside it. Verify by performing the gesture with the other driver IDLE (drag with playback PAUSED) — observe the overlay still tracks.

**Detection signal:** a new per-frame draw is added inside an existing `if (somethingChanged)` block whose `somethingChanged` is driven by a DIFFERENT input than the new draw. Ask: "what makes THIS overlay need a redraw, and is that the same signal as the guard I'm nesting under? Can my driver change while the guard's driver is static?" If yes → the overlay freezes whenever the guard's driver is idle.

**Five-limbed argument:**

1. **Claim:** Nesting the ghost redraw in the playhead idle-guard freezes the ghost whenever the playhead is static.
2. **Reason:** the guard body runs only when `newX !== lastPlayheadXRef`; a paused playhead has constant `newX`, so the body (and the nested ghost) never executes even though the cursor — the ghost's actual driver — is moving.
3. **Universal principle:** a redraw must be gated on a change-compare of its OWN driver; gating it on an unrelated driver's compare makes its liveness a hostage to that driver's activity.
4. **Application:** P7.1's ghost is a sibling block gated on `dragRef` + its own `lastGhostXRef`; the Task 4 verify drags with playback PAUSED and observes the ghost tracking + the retime committing (proved in the live browser AND the e2e).
5. **Conclusion:** sibling-block + own-driver change-gate is the structural fix; the proof must exercise the gesture with the other overlay's driver IDLE, or the freeze is invisible.

**Cross-ref:** [[K13]] (the shared-rAF-loop lifecycle this extends — the drag-lifecycle steps added there), FLAG-1 (the checker-predicted gap this concretises — CONTEXT/PLAN pre-mortem #6), [[V20]] (the ghost reads `dragRef` not a store — no second writer/subscription on the hot path), D-04 (the locked decision), `src/timeline/TimelineCanvas.tsx` (the sibling ghost block + the playhead idle-guard it sits after). Sister of the K13 "rAF cancel/re-arm on play/pause" violation (both are "coupling an overlay's liveness to the wrong signal"). Provenance: predicted as FLAG-1 in CONTEXT/PLAN; defended by the sibling-block design first pass; verified by a paused-playhead live drag (the first observation harness's coordinate bug was fixed, then the FLAG-1 behavior observed correct); catalogued per mandate.

---

### H40 — A UI surface bound to a node's SOURCE params reads a stale value when a wrapper patches the rendered clone (H22/H34 sibling — #68)

**Span:** any UI surface (gizmo proxy, inspector field, overlay label, snap guide) that seeds from `node.params.X` while the RENDERED value of X is produced by a wrapper node (AnimationLayer / Transform / MaterialOverride) that deep-clones the target and patches X onto the _clone_ at eval time — the source node is never mutated. #68 instantiation: `Gizmo.getManipulable` read `n_box.params.position` (static authored) while the cube rendered at `AnimationLayer.patchTarget`'s clone position (`AnimationLayer.ts:107-122`); once position was animated they diverged and the gizmo froze at the authored point for the whole animation. Predicted recurrence: the NPanel inspector showing live evaluated values during playback (the explicit sibling — D-08 follow-up issue), any future viewport HUD/label/handle that reads `params` while a wrapper patches the rendered value (CurveEditor value readout, splat transform handle, a material swatch under MaterialOverride).

**Symptom:** the surface FREEZES at the authored value while the rendered object visibly moves/changes — the gizmo sits at the cube's start position while the cube animates away from it; scrubbing/playing does not move the surface even though the render tracks. No error; the binding is "correct" against a now-false assumption ("`params.X` IS X") that held only until a wrapper made X reachable for animation.

**Trap (the wrong fix):** "make the surface evaluate the node" — `evaluate(state, selectedId)` returns the node's RAW value, NOT the wrapper's patched clone (the animated value lives in the WRAPPER output keyed by the channel's paramPath, not on the node). The naive evaluate looks like it should work, re-introduces the same stale value one indirection deeper, and a unit test that only asserts "the surface changed when I evaluated" passes against the wrong source. A second workaround (force the surface to read `channel.keyframes` directly) re-implements the evaluator and drifts from the real render.

**Real fix:** a pure resolver that MIRRORS the renderer's own scene-child correspondence + wrapper unwrap — evaluate from `outputs.render`, walk `value.scene.children[i]` ↔ `sceneNode.inputs.children[i].node` (the SAME index-correspondence the renderer/click-select uses — Chesterton: it already exists, do not invent a parallel walk), then for an `AnimationLayer` child unwrap `value.target` (the patched clone — the H34 mechanism). One tested-pure helper consumed by every surface that needs "where it actually renders" (`resolveEvaluatedTransform`). The unit proof is a DISTINCTNESS assertion: resolver output ≠ `evaluate(node)` raw for an animated node (proves the unwrap, not a re-evaluate).

**Detection signal:** a surface seeds from `params.X`; somewhere a wrapper node (AnimationLayer/Transform/MaterialOverride) can sit between that node and `outputs.render`. Ask: "is X reachable for animation/override via a wrapper? If so, does this surface read the SOURCE param or the EVALUATED render value? Did I verify the SURFACE side of the boundary, or only the evaluator side?" The boundary-pair check: P7's E2 asserted the evaluator output and NEVER the gizmo proxy — only one side was observed, which is exactly why #68 shipped.

**Five-limbed argument:**

1. **Claim:** A surface bound to `node.params.X` shows a stale value the moment a wrapper patches X onto the rendered clone, and "evaluate the node" does not fix it.
2. **Reason:** `patchTarget` deep-clones the target and writes the channel value onto the clone (`AnimationLayer.ts:114-121`); the source node's `params.X` is never mutated, and `evaluate(node)` returns that untouched source — the live value exists only in the wrapper's output, indexed by the renderer's scene-child correspondence.
3. **Universal principle:** the single source of truth for "where/what a thing renders" is the evaluated render tree, not the authored params; a surface is correct only if it reads the same evaluated value the renderer does, by the same traversal.
4. **Application:** `resolveEvaluatedTransform` (`src/app/resolveEvaluatedTransform.ts`) mirrors `SceneFromDAG.tsx:88-142` + unwraps `AnimationLayer.target`; the Gizmo seeds from it per-param with static fallback; the D-06 e2e asserts `proxy == evaluated render-walk` at ≥2 playhead times for box AND layer select — the boundary-pair P7's E2 never observed.
5. **Conclusion:** the structural defense is one pure resolver mirroring the renderer's correspondence + a BOTH-SIDES boundary-pair observation; verifying only the evaluator side (as P7 did) leaves the surface side unobserved and lets exactly this class ship.

**Cross-ref:** [[H22]] (closure scope ≠ render reachability — same family: a thing is "set" but not where the render reads it), [[H34]] (orphan/4-edge-splice — the `patchTarget` clone mechanism this rides on; the AnimationLayer rewires Scene.children to the layer so the source box is no longer the scene child), [[H36]] (the grab's re-route-instead-of-double-write defense in the same fix — keying the channel AND setParam'ing the dead source is the sibling dishonest path), issue #68 (the diagnosis), [[V20]] (the resolver runs in the React seeding effect at playhead-change cadence, NOT the W9 rAF loop — K13 non-regression re-proven: p95 9.70ms ≤ 16.6ms), the boundary-pair lesson (verify BOTH sides of a producer/consumer boundary — P7 E2 verified only the evaluator), `src/app/resolveEvaluatedTransform.ts`, `src/app/Gizmo.tsx` (the manip branch + D-01 layer-select synthesize), `src/app/resolveEvaluatedTransform.test.ts` (the distinctness anti-trap assertion), `tests/e2e/p7.3-gizmo-evaluated-transform.spec.ts` (the D-06 boundary-pair gate). Sibling CLOSED 2026-05-19 (Phase 7.4 / #69): the NPanel inspector now consumes the same evaluated source via `resolveTransformParam` (`src/app/resolveTransformParam.ts`, a transform-param adapter over `resolveEvaluatedTransform`) — wired in `NPanel.tsx` `NumericField`/`VectorField` (commit `b0ac811`). D-06 boundary-pair gate `tests/e2e/p7.4-npanel-evaluated-display.spec.ts` (commit `1a8eb48`) asserts displayed input.value == evaluated render-walk at t=0.5 AND t=1.5, box AND layer select (3 tests, all green). The H40 class now has TWO catalogued consumers (gizmo + inspector), both unit + e2e verified — the predicted recurrence converted to a deductive lookup. H36-class second surface — CLOSED 2026-05-19 (P7.4 extension / D-05 / #77): the inspector edit path now routes through the SAME `routeAnimatedGrab` chokepoint the gizmo uses. W5.1 (commit `915360f`) lifted `routeAnimatedGrab` out of `Gizmo.tsx` into the shared `src/app/animate/autoKeyCommit.ts` (`export function routeAnimatedGrab(selectedId, paramPath, value): boolean`, line 66 — `selectedId` became a parameter instead of a closure read; body byte-identical) and rewired BOTH the gizmo grab AND the inspector commit handlers (`NumericField`/`VectorComponent` onChange + scrub onCommit) to call it BEFORE the raw `setParam`; when it returns `true` the raw `setParam` and the separate `autoKeyCommit` are BOTH skipped. The inspector is now H36-correct: an animated+paused+AutoKey-ON inspector edit produces EXACTLY ONE write (the keyframe via the seam); the dead `setParam` on the animated source no longer fires. The pre-W5.1 "open variant" (both writes firing) is eliminated, not deferred. Proof gate: `tests/e2e/p7.4-npanel-evaluated-display.spec.ts` Test 3 was REWRITTEN (W6.1) from the OLD double-write assertion (`boxPos[0]==5`) to the corrected single-write contract — the #77 boundary-pair: side A = the keyframe landed at the playhead with the typed X and kfCount grew by exactly 1; side B = `node.params.position` on the SOURCE box is byte-UNCHANGED (runtime-observed `boxPos [0,0,0]→[0,0,0]`). Two adjacent W6.1 tests prove the rest of the D-05 behaviour-preservation matrix: row 4 (animated+paused+AutoKey-OFF inspector edit → `window.alert` fires + ZERO ops — the intentional, desirable delta that kills the pre-D-05 silent dead-write and unifies inspector↔gizmo; observed `alerts=[…animated…] dagChanged=false`) and the #78 WYSIWYK non-perturbation contract (observed `keyAtT1=[9,5,-3] yz@t [5,-3]→[5,-3] yz@t2 [7.5,-4.5]→[7.5,-4.5]`). The fixture `seedAnimatedCube` (both p7.3 and p7.4 copies) was restaged from the diamond+inspector-edit seam (which relied on the now-removed silent dead-write) to direct DAG dispatch ops (the `p3-observe.spec.ts:48-110` precedent) — bug-independent, every downstream assertion unchanged, p7.3's D-06 gate restored (4/4 green). No new H entry — this is the SAME H36 class, its second surface now closed onto the one chokepoint (Domain-Aligned-Abstraction: one Auto-Key spine, two callers); cross-ref [[H36]]. Issues #77 + #78 CLOSED. Provenance: ORIGIN = issue #68 (user-surfaced post-P7/P7.1, gizmo frozen while the cube animates); promoted to a recurrence-class entry because H22/H34 are the SAME family (source/closure ≠ rendered/evaluated) and the NPanel sibling guaranteed a second occurrence — not a one-off. WHY = without this entry the next wrapper-stale-surface bug (a future HUD, snap guide, overlay label) gets diagnosed from scratch and the "evaluate the node" trap re-attempted. HOW = the pure-resolver + boundary-pair pattern above; the detection question ("which side of the boundary did I observe?") is the reusable check. REF: issue #68, #69 (NPanel sibling, CLOSED 2026-05-19), CONTEXT D-01/D-05/D-06/D-07/D-08, vyapti V1/V8/V20, krama K7/K13.

**v0.6 #1 extension (2026-06-03, #150) — THIRD consumer family: the mesh resolver.** `resolveEvaluatedMesh` (`src/app/resolveEvaluatedMesh.ts`) generalizes the H40 boundary from the transform to the whole `EvaluatedMesh{geometry, uvs, material, transform}`, adding a NEW band — `transform.scale` on primitives (BoxMesh/SphereMesh gained a `scale` param, version 2). The "one band, two callers" rule held: the renderer (`SceneFromDAG.tsx` BoxMeshR/SphereMeshR apply `scale={value.scale ?? [1,1,1]}`, mirroring TransformR) and the resolver read the SAME `value.scale`/`params.scale`; for GltfChild the resolver delegates the transform to `resolveEvaluatedTransform` (→ the one `resolveGltfChildTrs` band) so glTF never gets a parallel walk. Boundary-pair gate `tests/e2e/p150-evaluated-mesh.spec.ts` observes BOTH the REAL rendered three.js object world scale (side A — `__basher_mesh_world_scale`, a scene-walk seam mirroring `__basher_gltf_meshes`, the C-3 hard deliverable) AND `resolveEvaluatedMesh(...).transform.scale` (side B — `__basher_evaluated_mesh`) and asserts equality at identity + [2,3,4]; `tests/e2e/p150-uniformity-gate.spec.ts` extends it to the gizmo→inspector surfaces. This is NOT a new H-class — it is the SAME H40 (verify both sides of the producer/consumer boundary), now with a third catalogued consumer (gizmo + inspector + mesh resolver). **Realized-and-gated secondary risk (the migration-identity rule):** adding `scale` to a versioned schema could change an existing project's render; gated by an IDENTITY default in BOTH the zod `.default`, the `migrations[1]` fn, AND the evaluator `?? [1,1,1]` (C-1 / [[V10]]/[[H14]] two-layer guard), proven byte-identical by `src/core/project/migrations.test.ts` (real serialized v1 BoxMesh → v2, every non-scale param deep-equal, geometry size unchanged). **C-4 size-vs-scale history note (NOT a bug — [[H25]]/[[H46]] fixture-migration family):** existing saved boxes encoded visible scale in `size`; post-v0.6-#1 that history STAYS in `size` (the parametric capability) while new gizmo scale goes to `transform.scale` (the band) — lossless and intended. The migrated #144 e2e (`gizmo-autokey-record.spec.ts`) asserts `paramPath==='scale'` (was `'size'`): a deliberate contract migration, not a regression. REF (v0.6 #1): `src/app/resolveEvaluatedMesh.ts`, `src/app/geometryRegistry.ts`, `src/viewport/SceneFromDAG.tsx` (BoxMeshR/SphereMeshR scale + `MeshScaleProbe`), `src/nodes/{BoxMesh,SphereMesh}.ts` (v2 + migration), `tests/e2e/p150-evaluated-mesh.spec.ts`, `tests/e2e/p150-uniformity-gate.spec.ts`, dharana [[B14]].

**#151 extension (2026-06-04) — FOURTH producer + the first registry-READING renderer.** Apply-Transform (#151) adds `BakedMesh` as the 4th `EvaluatedMesh` producer. Two H40-relevant facts: (1) **`BakedMeshR` is the FIRST renderer to read `geometryRegistry.get()`** (Box/SphereR build geometry inline with `<boxGeometry>`/`<sphereGeometry>`; the §48/V29 handle→registry→buffer path only comes ALIVE here, via the `useBakedGeometry` suspense hook). The boundary-pair held three-way: `tests/e2e/p151-apply-transform.spec.ts` SC-2 + `p151-gltf-child-apply.spec.ts` assert the RENDERED baked object's world-space vertex bounds (side A — `__basher_mesh_world_bounds`, scene-walk) == the resolver's BakedMesh geometry bounds (side B — `__basher_baked_geometry_bounds`) == the PRE-bake rendered object's world bounds. (2) **The band-drift trap (the [[H40]] core, here in a new guise): BakedMeshR renders with IDENTITY scale** — the TRS is BAKED INTO the verts by `applyMatrix4`, so applying `value.scale` on the `<mesh>` again would DOUBLE-transform (the verts are already at world size, transform.scale==[1,1,1]). The rendered-bounds == resolver-bounds == 2×1×1 equality (SC-1) is exactly the assertion that catches a re-application regression. (3) **Material capture is bake-what-renders, POST-override** (the [[H59]]/[[H58]] siblings): `captureBakedMaterial` reads `clone.getObjectByName(childName).material` AFTER the override effect ran — the same resolved-not-raw discipline H40 established for the transform band. REF (#151): `src/viewport/SceneFromDAG.tsx` (BakedMeshR + `useBakedGeometry`/`useBakedTexture`), `src/app/asset/gltfCloneRegistry.ts`, `src/app/animate/captureBakedMaterial.ts`, `tests/e2e/p151-apply-transform.spec.ts` + `p151-gltf-child-apply.spec.ts`, [[V30]] [[V29]] [[H45]] [[H65]], dharana [[B14]]/[[B12]]. Issue #151.

**#153 closure (2026-06-04) — the primitive mesh-resolver path now ANIM-TRACKS (latent gap CLOSED).** The v0.6 #1 extension above shipped `resolveEvaluatedMesh` reading the Box/Sphere transform band STRAIGHT FROM `node.params` — static. Unlike the GltfChild branch (which delegates to `resolveEvaluatedTransform`) and `resolveEvaluatedTransform` itself, the primitive path did NOT unwrap an AnimationLayer driving the node: for an animated primitive the resolver returned the AUTHORED value while the renderer drew the ANIMATED one — the exact H40 displayed≠rendered class, one indirection deeper. Latent at #150 (only the DEV seam consumed the mesh resolver), but #151's `dispatchApplyTransform` became a REAL consumer (guarded only by Apply's D-04 animated-block), and v0.6 #2/#3 (material/UV) are about to consume it for animated primitives. **Fix:** the Box/Sphere branch now delegates its transform band to `resolveEvaluatedTransform` via a shared `resolvePrimitiveTransform` helper (walk-or-fallback-to-raw-params — same precedence the GltfChild branch uses; no parallel walk; geometry/material/uvs untouched). The "one band, two callers" rule now holds for primitives too. Boundary-pair gate `tests/e2e/p153-animated-primitive-boundary-pair.spec.ts`: an AnimationLayer drives a box scale t0→[1,1,1] t2→[3,3,3]; at t=0.5 and t=1.5 the REAL rendered three.js world scale (side A — read by the scene-child producer id, the layer) == `resolveEvaluatedMesh(...).transform.scale` at the same ctx.time (side B) == the lerp, AND scale(t1)≠scale(t2) (the resolver TRACKS — the static-read regression would return [1,1,1] at every time). `p150` static boundary-pair still green (no regression). Same H40 class, NOT a new entry. REF (#153): `src/app/resolveEvaluatedMesh.ts` (`resolvePrimitiveTransform`), `src/app/resolveEvaluatedTransform.ts`, `tests/e2e/p153-animated-primitive-boundary-pair.spec.ts`. Issue #153 (PR #155, merged main `8e8ad8a`).

**#149 extension (2026-06-04) — the TRANSIENT-OVERLAY consumer family (two NEW forms of the drift + their gates).** A held transient ([[V31]]) must be overlaid on BOTH the render and read sides at the SAME precedence (transient > channel) + SAME sample time (`ctx.time.seconds`). Solved by the ONE shared `overlayTransients` (`src/app/overlayTransients.ts`), two callers — the SAME "one band, two callers" rule [[B1.1]]/[[B14]] established. Two CONCRETE forms of the H40 drift this guards, each with its gate:

- **Form 1 — the read side re-implements interpolation instead of sampling the channel VALUE.** `resolveEvaluatedParam` (the NET-NEW generic non-transform resolver, C2) MUST `evaluate` the `KeyframeChannel*` node and call its value's `.sample(seconds)` — the render-identical path. Re-walking `params.keyframes` with hand-rolled lerp/slerp/HSL drifts from the renderer (which samples the value). Mitigation: the resolver only calls `.sample()`; a grep gate in `resolveEvaluatedParam.test.ts` bans interpolation math in the file. Gated by the NON-transform PAUSED boundary-pair e2e (`p149-transient-boundary-pair.spec.ts` C4 (a): rendered material `#808080` == `resolveEvaluatedParam` channel sample — no drift).

- **Form 2 — the render dirty-check omits the transient ref, so a PAUSED edit freezes the viewport.** `AnimationLayerR`'s `useFrame` is gated by a `lastApplied` tuple; pre-#149 it was `{seconds, sampleTarget}`. A paused edit changes neither → the `useFrame` early-returns → the viewport stays at the curve value while the inspector shows the transient (the #68 "snaps right back" displayed≠rendered class). Mitigation: SUBSCRIBE `useTransientEditStore(s=>s.edits)` (the FIRST subscribed selector in this H48-perf-sensitive path — SAFE only because transients are paused-only + `clearAll` no-ops when empty, so playback churn is zero, `commits=0` observed on perf-fox) AND add `transients` as a third field of the dirty tuple. A paused `set` changes the ref → re-render → fresh `useFrame` closure → overlay re-applies. Gated by the transform PAUSED boundary-pair e2e (`p149-transient-boundary-pair.spec.ts` C3: rendered position `[9,0,0]` == resolver == typed transient; `p149-clear-on-scrub.spec.ts`: paused edit moves the rendered object, then a frame change reverts it).

The transform read side (`resolveEvaluatedTransform`, C1) overlays the SAME primitive after the AnimationLayer unwrap; it reads the live `transientEditStore.getState().edits` (the one UI-store read in the otherwise-pure resolver, empty store → identity so the purity unit suite stays green). NEW side-A/side-B seams: `__basher_mesh_world_position` (render), `__basher_evaluated_transform`/`__basher_evaluated_param` (resolver). The boundary now has FOUR consumers (gizmo + inspector + mesh-resolver + transient-overlay) — SAME H40 class, the transient is a NEW BAND not a new boundary. NOT a new H-class. **FLAG-A note:** the removed Auto-Key-OFF reject alert is SUPERSEDED (not deleted into silence) by the orange field color ([[V31]]) — the held edit is non-silent from Wave B (viewport moves) and explicitly held from Wave F (orange). REF (#149): `src/app/overlayTransients.ts`, `src/viewport/SceneFromDAG.tsx` (AnimationLayerR overlay + dirty tuple + `__basher_mesh_world_position`), `src/app/resolveEvaluatedTransform.ts` (C1) + `src/app/resolveEvaluatedParam.ts` (C2), `src/app/boot.ts` (`__basher_evaluated_transform`/`_param`/`_transient`), `tests/e2e/p149-transient-boundary-pair.spec.ts` + `p149-clear-on-scrub.spec.ts`, [[V31]] [[V29]] [[V20]] [[H36]] [[H48]] [[B12]], dharana [[B1.1]]/[[B14]]. Issue #149. (Grounded: `~/.anvideck/projects/basher/ref/GROUND_TRUTH_BLENDER_KEYING.md`.)

### H41 — A test fixture stages its precondition via the very code path a fix correctly removes — its failure looks like a regression of the fix

**Span:** any e2e/integration fixture that stages its "desired animated / wrapped / derived state" by executing a code path that contains a latent bug, then asserts downstream behaviour depending on that bug-induced state. When the bug is correctly removed by a structural fix, the fixture's staging silently no-ops (or alerts) → the asserted downstream state is wrong → the test fails → the failure masquerades as a regression of the FIX. 2026-05-19 instantiation (P7.4 extension / D-05 / #77): four merged-phase fixtures relied on the pre-D-05 inspector silent dead-write on `node.params` of an animated param with Auto-Key OFF. (1) `p7.3-gizmo-evaluated-transform.spec.ts` `seedAnimatedCube` (lines 101-160): diamond click @t=0 creates the channel with `[0,0,0]@0`, then `posX.fill('4')` at t=2 (AutoKey OFF) dead-wrote `n_box.params.position=[4,0,0]` (the bug), then a second diamond click keyed the authored value `[4,0,0]@2`. Pre-D-05 the cube animated `[0,0,0]→[4,0,0]`. Post-D-05 the fill alerts+no-ops; the second diamond keys `[0,0,0]@2`; cube never moves; `expect(evalPos[0]).toBeGreaterThan(0)` fails. (2) `p7.4-npanel-evaluated-display.spec.ts:252` (same `seedAnimatedCube` twin). (3) `p7-animation-authoring.spec.ts:278` step-3 (`rotY.fill('360')` with AutoKey OFF on already-animated rotation). (4) `p7.4-npanel-evaluated-display.spec.ts:411` Test 3 (its own comment explicitly: "documents the current behavior so a future H36-style inspector re-route would intentionally invert it"). The fixtures were embedded in MERGED-PHASE specs (P7, P7.1, P7.3, P7.4 W3.1) — the bug was structurally encoded into the test suite, not just one new test.

**Symptom:** one-or-more previously-green merged-phase e2e tests turn red when a fix correctly removes a latent bug; the rendered/evaluated state assertion fails; the failure surfaces in a test whose code is byte-untouched by the fix. The natural reflex is "the fix broke things" — incorrect.

**Trap:** three wrong reframes all hide the cause: (a) "the fix must be wrong — revert it" (rolls back the correct fix to preserve broken tests; the architectural ratchet); (b) "weaken the failing assertion / mark `.skip` to make CI green" (paper over the bug-dependency, silently weaken the merged-phase contract); (c) "the fix has scope creep, narrow it" (drops the structural correctness for symptom alignment). Each preserves the broken fixture's grip on the codebase; none classifies whether the fix is correct or whether the fixture relied on the bug.

**Real fix:** classify before responding. For each failing test, ask: (1) does the fix violate any row of its locked-decision behaviour-preservation matrix (a real production regression, e.g. matrix row 1 broken)? OR (2) does the fixture's staging path go through the removed-bug code path (bug-dependent staging)? If (1) → real regression, fix production. If (2) → restage the fixture WITHOUT the bug — use a path that doesn't depend on the bug (e.g. direct DAG dispatch ops, the `p3-observe.spec.ts:48-110` precedent), preserving every downstream assertion BYTE-IDENTICAL. Prove no contract weakening by showing the assertion lines unchanged in the diff (only the staging body changes). 2026-05-19 application: `seedAnimatedCube` restaged via direct dispatch (addNode AnimationLayer + Scene.children rewire + KeyframeChannelVec3 with explicit `[0,0,0]@0` and `[4,0,0]@2` + TimeSource wiring) — bug-independent, every p7.3 D-06 assertion line byte-identical (diff confined to one hunk in the helper region); p7-animation-authoring:278 step-3 restaged with Auto-Key ON before the inspector fill (the post-#77 real affordance — the fill keys via `routeAnimatedGrab` directly, no separate diamond click needed); Test 3 was REWRITTEN to assert the corrected single-write contract (the #77 boundary-pair: keyframe landed AND `node.params` byte-unchanged).

**Detection signal:** previously-green merged-phase tests turn red after a structural fix; the failing assertion is downstream of a staging step that goes through the same code surface the fix changes; pre-fix, the same staging observably created the desired state; post-fix it doesn't, and the staging step is in fixture/helper code (`seedXxx`, `setupYyy`, `beforeEach`), not in the assertion body. The classification question: "does the fix's behaviour-preservation matrix still hold for THIS test's contract? If yes → bug-dependent fixture; restage. If no → real regression; revisit production." The proportionality lesson: a SHARED-CHOKEPOINT fix has blast radius across every caller (gizmo + inspector + every test that staged via the chokepoint's bug); the merge gate must be the FULL e2e suite (not just the touched specs), or bug-dependent fixtures stay invisible until CI catches them reactively.

**Five-limbed argument:**

1. **Claim:** When a structural fix correctly eliminates a latent bug, any test fixture that staged its precondition via the bug's code path silently breaks; the failure mode masquerades as a regression of the fix.
2. **Reason:** A fixture's STAGING is downstream of the fix's surface, not the contract; if staging traverses removed-bug code, the precondition isn't established → downstream assertions correctly fail; but the failure's locality (a merged-phase test the fix author didn't touch) misdirects diagnosis to the fix.
3. **Universal principle:** A fixture's correctness is independent of any latent bug it might happen to traverse; relying on a bug to stage state is staging by accident, not by contract — a fixture that needs the bug to function is a fixture that asserts the bug.
4. **Application:** D-05 (#77) lifted `routeAnimatedGrab` to the shared chokepoint; the gizmo's `proxy==eval` invariant + behaviour-preservation matrix rows 1-2 held byte-identical (matrix rows 3-4 changed BY DESIGN — the H36 fix); but `seedAnimatedCube` (×2), `p7-animation-authoring:278`, and the W3.1 `Test 3` contract all relied on the pre-D-05 silent dead-write for staging. W6.1/W7.1 restaged all four bug-independently (commits `e097b8d`, `443f3a3`) — contract assertions byte-identical, diffs confined to staging mechanisms — and the rewritten Test 3 now PROVES the corrected single-write contract instead of documenting the pre-fix double-write.
5. **Conclusion:** Bug-dependent staging is the common cause of "the fix broke things" after a correct structural fix; the structural defense is (a) classify against the locked matrix before reverting/weakening, (b) restage via the proper affordance (preserve every contract assertion), (c) gate shared-chokepoint changes on the FULL e2e suite (not a target-spec subset — proportionality misses the blast radius across merged-phase fixtures).

**Cross-ref:** [[H36]] (the route-before-setParam family — #77 is the second-surface instance whose fix exposed the fixtures), [[H40]] (the H-family parent — both are "fix the boundary, but verify both sides"), [[H25]] (initial-authoring trap — a fixture authored against a then-correct path that the fix later removes), CONTEXT D-05 behaviour-preservation matrix (P7.4 ext — the row-by-row classification template), `tests/e2e/p7.3-gizmo-evaluated-transform.spec.ts` (bug-independent restaged seed), `tests/e2e/p7.4-npanel-evaluated-display.spec.ts` Test 3 (the contract-rewrite proof), `tests/e2e/p7-animation-authoring.spec.ts:278` (the third fixture-fix), commits `e097b8d` (W6.1 restage + Test 3 rewrite + #78 non-perturbation proof) and `443f3a3` (W7.1 p7-anim fix + p5-cost-preview C5.2 `test.slow()` + prettier on 3 files). Provenance: ORIGIN = W5.1's #77 production fix (`915360f`) exposed 4 fixture failures across 3 specs; promoted to entry because it RECURRED across 4 distinct fixture sites from the SAME root cause; W7's "FULL e2e suite as the merge gate" is the structural catch (the proportionality shortcut of running only the 2 target specs missed every one). WHY without this entry: the next shared-chokepoint fix's bug-dependent-fixture failures get diagnosed as fix-regressions and reverted, leaving the underlying bug in place AND the fixture brittle; the architectural ratchet bites every shared-spine refactor. HOW: per shared-chokepoint change, (a) run the FULL e2e suite before declaring the fix safe (not the touched specs alone), (b) on red, classify against the behaviour-preservation matrix BEFORE reverting/weakening, (c) restage via direct dispatch (the `p3-observe.spec.ts:48-110` precedent) preserving every contract assertion byte-identical, with the diff confined to the staging helper. REF: issues #77 / #78 (both CLOSED 2026-05-19), vyapti V8 / [[V20]] (the cadence + chokepoint discipline that #77's fix instantiates), [[H36]] (the catalogued pattern this is a fixture-side variant of).

### H42 — `Date.now()` / `Math.random()` in a deterministic-twice-call test is a latent ms-boundary flake that only fires under CI load

**Span:** any Op-emitter / tool handler / id-generator that derives a node id from `Date.now()` or `Math.random()` and is exercised by a "twice-call" test asserting byte-identical Ops across two adjacent invocations with the same args. Locally both calls usually land in the same millisecond → ids match → test passes. Under a slower CI runner (or under heavier total test load that shifts when this case runs), the two calls sometimes straddle a ms boundary → ids differ → test red. Three instantiations within the 2026-05-19→21 arc: (1) `src/agent/telemetry/recorder.ts:96` (#17 — `sessionId` from `Math.random().toString(36)` ×2; corrected to `crypto.randomUUID` in PR #87). (2) `src/core/import/gltfImportChain.ts` P7.5 — pre-empted at design time, content-addressed via fnv1a-32 over `(assetRef, key)`. (3) `src/agent/tools/cameraSnapshot.ts:52` (#93 — `cam_agent_${Date.now().toString(36)}` was the original shape; CI exposed it under PR #92's added test load, fixed in PR `4c82536` by fnv1a-32 over `(sceneNodeId, fov, position, lookAt)`).

**Symptom:** a vitest twice-call determinism assertion (`expect(result1.ops).toEqual(result2.ops)` after two `tool.handler(args, ctx)` calls) passes locally for months, then turns red on PR CI; the failing diff shows two Ops that differ only in a node-id suffix; the test owner often hasn't touched the failing file.

**Trap:** "re-run CI, it's flaky" — masks the latent race indefinitely; the next id-generator added under the same pattern repeats the cycle. Or "increase the test's tolerance / loosen the equality assertion" — silently weakens the determinism contract (V2 / THESIS §48) at a layer where the value is supposed to be byte-deterministic.

**Real fix:** content-addressed id via a deterministic hash over the (args, relevant-state) tuple — fnv1a-32 is a 13-line dependency-free helper that's sufficient for non-cryptographic determinism. Pattern: `n_<prefix>_${fnv1a32(JSON.stringify([…tuple]))}` (or, for crypto-strong session correlation, `crypto.randomUUID()` is fine — it's only banned inside `src/nodes/**` evaluators by the pure-lint, not at the tool/emitter layer). The fix is mechanical once you classify the surface; the discovery cost is hours of "CI is flaky" if the pattern isn't catalogued.

**Detection signal:** any node-id generation site outside `src/nodes/**`. Quick grep gate: `grep -nE 'Date\.now\(\)|Math\.random\(\)' src/agent src/app src/core src/viewport | grep -v test`. Anything that landed in a `` `n_…_${…}` `` template literal is a candidate. The companion test signal: a twice-call `` `expect(opsA).toEqual(opsB)` `` that consumes the same `args` twice.

**Five-limbed argument:**

1. **Claim:** Deriving DAG node ids from wall-clock or RNG in an Op-emitter creates a CI-load-dependent flake that only fires when the two adjacent calls happen to cross a millisecond boundary.
2. **Reason:** The "twice-call" determinism contract demands byte-identical Ops; `Date.now()` resolution is ms; two same-thread calls usually fall in the same ms locally but not always under CI load; the failure mode is data-dependent (timing) rather than logic-dependent (input) — the test SAW two different inputs (wall-clocks), not two different code paths.
3. **Universal principle:** Determinism over `(args, state)` is the structural property; any side-channel (clock, RNG, env) leaks non-determinism through. The Op-emitter / tool-handler layer has the same V2 / THESIS §48 obligation as the pure-node evaluator layer — just at a different surface.
4. **Application:** Three site-fixes within a 2-day arc — #17 (sessionId), P7.5 (importer ids), #93 (cameraSnapshot) — all converged on the same pattern: replace the wall-clock/RNG seed with a content-hash over the inputs. Pre-empted at design time in P7.5; caught reactively at #17 and #93. The reactive cost was one extra CI cycle per surface; the pre-emptive cost was zero.
5. **Conclusion:** The flake class is fully eliminable by the grep gate above before code lands. The catalogue's contribution is the "this is a CATEGORY of bug" framing — single instances looked like one-off oversights; three in one arc proved the pattern.

**Cross-ref:** [[V22]] (the invariant this enforces — "generated DAG node ids must be deterministic over (args, state)"); commits `b42fea7` (#17 fix), `6553b0d` (P7.5 importer determinism), `4c82536` (cameraSnapshot fix). Provenance: ORIGIN = three independent occurrences (#17 / P7.5 / #93) within the 2026-05-19→21 backlog sweep; WHY = without catalogue framing, each next site gets diagnosed as a one-off; HOW = the grep gate above should run as part of any "/anvi:quick" or wave-close gate touching files outside `src/nodes/**` that emit Ops. REF: `src/agent/telemetry/recorder.ts:96` (the radix-36 shape), `src/agent/tools/cameraSnapshot.ts:52` (the `Date.now` shape — fixed at `4c82536`), `src/core/import/gltfImportChain.ts:57-68` (the fnv1a-32 helper others can borrow), THESIS §48.

### H43 — A Suspense resolver that throws the in-flight promise on every retry suspends FOREVER on rejection (never reaches the error boundary)

**Span:** any React Suspense data-loader that follows the "throw a Promise to suspend, cache the resolved value, return it on retry" pattern but caches ONLY the success value. When the promise rejects, the cache miss persists, so the next render re-throws the _same already-settled_ promise — React re-subscribes to a promise that will never re-resolve, and the component is stuck suspended. No error is ever thrown to the nearest error boundary, no console error fires, the suspense fallback (often `null`) shows indefinitely. Instantiated at `src/app/asset/opfsLoader.ts::useResolvedAssetUrl` (#83) — a GltfAsset pointing at a missing OPFS path produced a permanent blank viewport with ZERO console/page errors.

**Symptom:** a suspense-driven surface (asset, lazy route, data panel) shows its fallback forever for a specific bad input, with no error logged anywhere. An error boundary wrapping it never fires. In an e2e: `page.on('console')` + `page.on('pageerror')` capture NOTHING; the awaited element/banner never appears; the test times out rather than failing on an assertion.

**Trap:** "add an error boundary" — necessary but NOT sufficient. The boundary can only catch what is THROWN; this loader never throws (it re-suspends). Shipping the boundary alone and "verifying" it by reading the code passes inference but the live behaviour is still a silent hang. Only running it (Lokāyata) exposes that nothing was thrown.

**Real fix:** track rejection in the resolver and throw the real Error on retry. The resolution promise must always FULFILL — settle into a success cache OR an error cache — so React's retry re-runs the hook, which then returns the cached value (success) or throws the cached Error (failure → caught by the boundary). Pattern:

```
const failed = errorCache.get(key); if (failed) throw failed;       // surface to boundary
let p = promiseCache.get(key);
if (!p) { p = load(key).then(v => okCache.set(key,v), e => errorCache.set(key, asError(e))); promiseCache.set(key,p); }
throw p;                                                            // still loading
```

**Detection signal:** grep for suspense loaders that `throw <promise>` where the `.then` has only an onFulfilled handler (no onRejected) AND the cache `.set` only happens in the success path. Companion runtime signal: a bad input yields a permanent fallback with empty `console`/`pageerror` capture — the "silent suspend" fingerprint distinct from the "throws and blanks" fingerprint.

**Five-limbed argument:**

1. **Claim:** A suspense resolver caching only success re-throws a settled (rejected) promise on retry, suspending forever instead of erroring.
2. **Reason:** React retries the render when the thrown promise settles; the retry re-reads the cache (still empty on failure) and throws the same rejected promise; React subscribes to a promise that will never transition again → permanent suspend, no throw, no boundary.
3. **Universal principle:** Suspense surfaces an ERROR only when the component THROWS a non-promise on retry. A loader that wants failures visible must convert "promise rejected" into "throw the error synchronously on the next render" — i.e. the promise must fulfill into a terminal state the retry can branch on.
4. **Application:** `useResolvedAssetUrl` (#83) split its single `.then(url => urlCache.set)` into `.then(onFulfilled→urlCache, onRejected→errorCache)`; the hook now throws `errorCache.get(path)` before re-suspending. The per-asset `AssetErrorBoundary` then catches it and reports to `assetErrorStore` → the user sees "asset failed: <ref> — <reason>".
5. **Conclusion:** The error boundary is the catcher; the loader's rejection-surfacing is the thrower. Both are required — the boundary alone is a no-op against a loader that never throws.

**Cross-ref:** [[H42]] (sibling "silent until observed" class — both hide until a live run surfaces them), the boundary-pair discipline (observe the loader's THROW behaviour, not just the boundary's CATCH behaviour), #82 (loud-failure sibling on the importer side — missing sibling throws at import time). Provenance: ORIGIN = #83 gap 2; the e2e proved the boundary-only fix was insufficient (zero errors, permanent suspend) — found by Lokāyata, not inference. WHY = without this entry the next suspense loader added under the success-only-cache pattern repeats the silent hang and a future "add a boundary" fix looks correct in code review but fails in the browser. HOW = when adding/auditing any `throw promise` suspense loader, verify the rejection path throws on retry; in e2e, assert via `console`/`pageerror` capture that a bad input produces a CAUGHT error, not silence. REF: `src/app/asset/opfsLoader.ts::useResolvedAssetUrl` (errorCache + rejection-surfacing), `src/viewport/AssetErrorBoundary.tsx` (the catcher), `tests/e2e/p83-asset-error-boundary.spec.ts` (the live observation), PR #101.

### H44 — Converting a synchronous emitter to async breaks downstream readers that observe state immediately after the call — the emitter's own tests stay green

**Span:** any change that makes a previously-synchronous state mutation path asynchronous — a fire-and-forget handler (`void (async () => {…})()`), an `await`-ed parse/IO step inserted before the dispatch, a sync function returning a Promise. Every consumer that previously read the resulting state on the next line/tick now reads it BEFORE the async work completes. The emitter's direct unit tests (which `await` the function) and adjacent feature e2e (which stage via an `await`-ed dev seam) all pass — only a consumer that fires the trigger and reads synchronously regresses. Instantiated at #90: `AssetDropZone` `.gltf` routing moved from the synchronous `buildAssetDropOps` to the async `buildGltfImportOps`; the `onDrop` handler is fire-and-forget, so the DAG nodes land a tick later than the old path.

**Symptom:** a test/consumer that dispatches an action then immediately asserts on the resulting state sees the PRE-action state (count delta of 0, `undefined` lookup, stale value). The error reads like the action did nothing — "Expected 9, Received 6" — when in fact it merely hadn't finished. The unit tests for the changed function pass; the gltf/feature e2e pass; one wiring/integration test that reads synchronously fails. CI catches it; a partial local e2e run (only the feature's own specs) misses it.

**Trap:** "the node count is wrong, my op emission is broken" → re-examine the emitter's ops. The ops are fine; the timing changed. Adding a fixed `waitForTimeout`/`sleep` is the workaround-cascade smell (papers over ordering). Re-running only the changed feature's e2e locally and seeing green is the inference trap — the regressed consumer lives in a DIFFERENT spec (here `p1-acceptance`, not `p7.5-gltf-animation`).

**Real fix:** the consumer must wait for the completion signal of the now-async path before observing — `await page.waitForFunction(() => <state predicate>)` in e2e, `await`/`findBy*` in component tests, or thread a real completion promise through the caller. The predicate keys on the actual landed state (e.g. a `n_gltf_…` node appears), not a timeout.

**Detection signal:** when a PR makes any path async (new `async`/`await`, a handler wrapped in `void (async…)()`, a return type changing to `Promise`), grep the e2e + component tests for callers of that trigger that read state on the immediately-following line without an `await`/`waitFor`. Run the FULL e2e for the changed file's chokepoint, not just the feature's own specs — async-conversion at a shared chokepoint (importer, drop handler, store writer) regresses consumers you didn't author.

**Five-limbed argument:**

1. **Claim:** Making a synchronous emitter async regresses consumers that read the emitted state on the next synchronous step, while leaving the emitter's own tests green.
2. **Reason:** The consumer's read now races the async work and wins; the state it reads is the pre-emit state. The emitter's tests `await` the function so they see the post-emit state and pass — the regression is invisible from the emitter's side.
3. **Universal principle:** Changing the synchrony of a producer changes the happens-before contract of every consumer that didn't opt into awaiting. Sync→async is a breaking change to the read-after-write ordering, even when the data is identical.
4. **Application:** #90 routed `.gltf` through async `buildGltfImportOps`; `P1#1b` read `nodes` count immediately after the drop event (correct for the old sync `buildAssetDropOps`) and saw +0. Fix: `await page.waitForFunction(() => …some(id => id.startsWith('n_gltf_')))` before asserting. `cube.gltf` (data-URI buffer, no animations) produces the identical 3-node chain, so only the timing — not the assertion values — needed to change.
5. **Conclusion:** The regression is an ordering bug, not a data bug. The fix is to re-establish happens-before by awaiting the completion signal; no op-emission change and no timeout hack.

**Cross-ref:** [[H41]] (sibling "the emitter's tests pass but an integration test that exercises the real wiring fails" — both are caught only because a DIFFERENT spec exercises the changed chokepoint; H41 = fixture stages via the removed path, H44 = consumer reads before the async path settles), the base-layer Sequence check (krama — "am I assuming things happen in the order I wrote them?"), [[H43]] (also #90-arc; also found because the live run, not code-reading, surfaced it). Provenance: ORIGIN = #90 PR #104; the gltf unit + e2e specs all passed, only `p1-acceptance` (a spec I did not change) failed in CI because I ran just the gltf e2e locally. WHY = without this entry the next sync→async conversion at a shared chokepoint (drop handler, store writer, importer) ships green-locally and regresses an unrelated integration test in CI, and the failure ("count wrong") misleads toward the op-emission code. HOW = on any async-conversion PR, grep tests for synchronous reads of the changed trigger and run the full e2e for that chokepoint, not just the feature's own specs. REF: `src/app/AssetDropZone.tsx` (the sync→async route), `tests/e2e/p1-acceptance.spec.ts:411` P1#1b (`waitForFunction` fix), `src/core/import/gltfImportChain.ts::buildGltfImportOps` (the now-async emitter), PR #104.

### H45 — Object3D.clone of a glTF scene leaves the cloned SkinnedMesh bound to the ORIGINAL bones — joints animate but the mesh stays in T-pose

**Span:** any renderer that loads a skinned glTF/FBX via three.js and `Object3D.clone()`s the scene before animating it (the common "clone per instance so I can mutate it" pattern). `Object3D.clone(recursive)` deep-clones the graph, but a cloned `SkinnedMesh` keeps `.skeleton` pointing at the SOURCE skeleton's bones — it does NOT rebind to the cloned bone subtree. Animating the cloned joints then updates bones the cloned mesh's matrix-palette never reads, so the surface never deforms. Instantiated at `src/viewport/SceneFromDAG.tsx` GltfAssetR (#88): `gltf.scene.clone(true)` cloned for per-instance TRS mutation; #81's TransformClip moved the cloned joint nodes, but the mesh stayed in bind pose.

**Symptom:** a skinned model plays its animation — the joint nodes visibly transform (gizmo, NPanel, eval-flow all show the joint TRS changing) — but the skin geometry doesn't follow. T-pose with waving invisible bones. No error, no warning; GLTFLoader built a valid SkinnedMesh, the animation evaluates, the joints move. Everything "works" except the pixels.

**Trap:** assert that the joint Object3D TRS changed, or that a `SkinnedMesh` with a bound `.skeleton` is present. BOTH pass against the footgun — the joints DO animate and a skeleton IS present (it's just bound to the source bones). A "skeleton present" validity check and a "joint moved" check green-light a non-fix. The deformation is invisible to every observation except the deformed surface itself.

**Real fix:** clone with `SkeletonUtils.clone` (`three/examples/jsm/utils/SkeletonUtils.js`) instead of `Object3D.clone` — it deep-clones AND rebinds each cloned SkinnedMesh's skeleton to the cloned bones; safe superset (non-skinned subtrees fall through to standard clone). The honest OBSERVATION is a skin-bound VERTEX world-position delta via `SkinnedMesh.getVertexPosition(i, target)` (three ≥0.151) at two render times — the deformed surface point, never the bone transform. It must be driven by ACTUAL render time (`window.__basher_time.getState().setTime` → mounted scene repaints → `skeleton.update()` recomputes the palette), NOT the pure evaluator (`__basher_evaluate` returns DAG output with no mounted SkinnedMesh and no render frame — it cannot observe deformation).

**Detection signal:** grep renderers for `.clone(` on a loaded glTF/FBX `scene` (drei `useGLTF`/`useFBX`, GLTFLoader) where the result can contain skinned meshes — if it's `Object3D.clone`, the deformation is silently broken. Runtime fingerprint: animation plays, joints move in the inspector/gizmo, mesh frozen in bind pose, zero console output.

**Five-limbed argument:**

1. **Claim:** `Object3D.clone` of a glTF scene yields a cloned SkinnedMesh still bound to the source bones, so animating the cloned joints deforms nothing.
2. **Reason:** `SkinnedMesh.clone` copies `.skeleton` by reference (no rebind to the cloned bone instances). The cloned mesh's bone-matrix palette is computed from the SOURCE skeleton's bones; the cloned joints the animation drives are a different set of objects.
3. **Universal principle:** a SkinnedMesh deforms from the bones its `.skeleton` references — not from whichever Object3Ds share the joints' names or tree position. Cloning a skinned graph must rebind the skeleton or the mesh and its driving bones desynchronise.
4. **Application:** GltfAssetR (#88) swapped `gltf.scene.clone(true)` → `SkeletonUtils.clone(gltf.scene)`; #81's per-child TRS override (unchanged) now moves the bones the cloned mesh is actually bound to. Proven by a tip-vertex world-position delta (t=0 vs t=mid) under `__basher_time.setTime`-driven render time; falsified by reverting the clone (delta → 0 while the "skeleton present" gate still passes).
5. **Conclusion:** the bug is a binding-identity bug at clone time, not an animation or import bug. The fix is the skeleton-aware clone; the only honest proof is a deformed vertex, observed on the rendered mesh under real render time.

**Cross-ref:** [[B12]] (glTF loader boundary — this is the render-consumer side; the importer/TransformClip side already worked). [[H40]] family (the "which side of the producer/consumer boundary did I observe?" question — here the EVALUATOR showed joints moving, only the rendered SURFACE showed the skin frozen). [[H44]]/[[H41]] (shared render chokepoint — the clone is on every GltfAsset's path, so the full glTF e2e set is the regression gate). Provenance: ORIGIN = #88; the joints-animate-but-mesh-frozen split is the exact "inference (joints move, looks fixed) vs observation (vertex didn't move)" trap — found because D-02 demanded a vertex delta, not a joint-TRS check. WHY = without this entry the next skinned-asset renderer (FBX skinning, P8 splat rigs, a second glTF clone site) repeats the `Object3D.clone` footgun and "verifies" it with a joint-moved check that passes against the bug. HOW = clone skinned graphs with SkeletonUtils.clone; observe deformation via `getVertexPosition` under real render time, never via joint TRS or the pure evaluator. Scope note: V8 held (the DEV observation seam is read-only — no dispatch in `src/viewport/`); V22 untouched (renderer-only fix, no importer change → determinism preserved). REF: `src/viewport/SceneFromDAG.tsx` GltfAssetR (`cloneSkinned` + the `window.__basher_gltf_skin` seam), `scripts/gen-skinned-fixture.mjs` (the 2-bone fixture), `tests/e2e/p7.6-gltf-skinned.spec.ts` (B2 validity gate + B3 vertex-delta headline + falsification), CONTEXT/PLAN 7.6, issue #88.

**#151 extension (2026-06-04) — clone-before-mutate at the BAKE boundary (geometry AND texture-capture-as-read-only).** Apply-Transform (#151) widens H45 from "clone a skinned graph" to the GENERAL "never mutate a SHARED loaded/cached resource before transforming it." Two #151 instantiations: (1) **Geometry bake — `dispatchApplyTransform` MUST `.clone()` before `applyMatrix4`** for BOTH the box/sphere registry instance (`geometryRegistry.get(ref)` returns a SHARED cached instance — `applyMatrix4` on it corrupts every other Box of the same size) AND the glTF child geometry (`clone.getObjectByName(childName).geometry` is shared across SkeletonUtils clones, the exact H45 share boundary). The isolation gate: `tests/e2e/p151-apply-transform.spec.ts` H45-isolation (two same-size Boxes, bake one → the other's rendered bounds unchanged) + `p151-gltf-child-apply.spec.ts` SC-7 (an OTHER instance/child of the asset is byte-unchanged after a sibling bakes). (2) **Material capture is READ-ONLY (the H45/M9 sibling): `captureBakedMaterial` READS `clone.getObjectByName(childName).material` scalars + COPIES texture bytes, NEVER writes the live clone material** — the clone material is already a per-instance `s.clone()` (#99), so a mutating capture would be the [[V20]]/[[H36]] single-writer landmine at the same clone boundary [[H59]] catalogues. Both stay clone/read-only at the SAME loaded-glTF boundary as the H45 skeleton-rebind and the H59 material-drop — a fourth clone-semantics pattern here would be the clustering signal (see dharana [[B12]] fatality note). REF (#151): `src/app/animate/dispatchApplyTransform.ts` (`.clone()` before `applyMatrix4`, both paths), `src/app/animate/captureBakedMaterial.ts` (read-only scalar + byte copy), `src/app/asset/bakedTextureStore.ts` (`persistTexture` read-only), `tests/e2e/p151-apply-transform.spec.ts` + `p151-gltf-child-apply.spec.ts`, [[H59]] [[H58]] [[V20]] [[V30]] [[H40]]. Issue #151.

### H46 — Verifying a skinned animation by the WRONG channel: a walk-cycle joint ROTATES, its translation is a constant bind offset — asserting position-motion gives an exact-zero false negative

**Span:** any test/observation that checks whether an imported skinned clip "drives" a bone by sampling the bone's resolved POSITION (translation) over time. Most skeletal clips (walk/run/idle) animate joints almost entirely by **rotation** — a knee/elbow rotates in place; its LOCAL translation is the fixed bind-pose offset (the bone length), baked as a constant track (every keyframe identical). So the resolved position is correctly static while the skin visibly deforms from rotation. Instantiated at #91 real-world testing (Khronos CesiumMan walk): a witness assertion measured `leg_joint_L_2` resolved position across two times and got **clipMotion = 0.0000** — while the skin demonstrably deformed and the bone's rotation swung ~252°.

**Symptom:** a skinned-animation test fails on a "the clip is driving this bone" precondition with an **exact** zero delta — not a small/noisy value, a clean 0.0000 — even though the mesh visibly animates and other checks (vertex deform) pass. The exact-zero is the tell: a genuine bug would usually produce noise or a partial value; a constant track produces identical samples.

**Trap:** conclude the resolver/consumer is BROKEN (e.g. "the gizmo/NPanel resolver isn't reading the clip for this bone") and go hunting for a code bug at the producer/consumer boundary. There is no code bug — the renderer and resolver agree; the test simply observed the one channel the clip doesn't vary. Patching the resolver to "fix" a non-bug, or loosening the threshold, are both wrong-frame fixes.

**Detection signal:** before asserting a bone "animates," check the glTF accessor for that node's channels — `animation.channels` target.path per node, and the OUTPUT accessor's `min`/`max`. If `min == max` on the translation accessor (constant track) but the rotation accessor's components span a range, the clip drives that bone by ROTATION. Observe the channel that actually varies.

**Real fix:** measure the resolved quantity the clip actually animates — for a walk-cycle limb, the bone's resolved ROTATION (euler degrees from the gizmo proxy / resolveEvaluatedTransform), not its position. Then the witness moves (CesiumMan: ~252° across the sweep) and the R-4 override-layering proof works on the same channel (override rotation holds at the manual value while the clip would otherwise rotate it). The vertex-deform check (H45 style) remains the channel-agnostic proof that the SKIN moved at all; the per-bone channel check must match the bone's actual animated channel.

**Five-limbed argument:**

1. **Claim:** an exact-zero position delta on an animated skinned bone is (almost always) a constant translation track, not a resolver bug.
2. **Reason:** skeletal clips pose joints by rotation; a joint's local translation is the bind offset, exported as a constant track (min == max), so its resolved position is correctly time-invariant.
3. **Universal principle:** verify a transform by the component the source actually drives — observing a channel the animation holds constant proves nothing about whether the animation "works."
4. **Application:** #91 CesiumMan CM-3 — the position witness read 0.0000; the glTF accessor showed `leg_joint_L_2` translation min==max and rotation spanning ~0.7 in quaternion components; re-pointing the witness/override at rotation made it a valid R-4 proof (witness ~252°, override held at 45°).
5. **Conclusion:** the code was correct; the test premise observed the wrong channel. Exact-zero is the diagnostic tell to check the channel before suspecting the consumer.

**Cross-ref:** [[H40]] (sibling — "which SIDE of the producer/consumer did I observe?"; this is "which CHANNEL did I observe?"). [[H45]] (the skin-deform vertex check is the channel-agnostic companion proof). [[B12]] (glTF render-consumer / resolveEvaluatedTransform boundary). Provenance: ORIGIN = #91 real-world verification on CesiumMan (the CM-3 false-negative), 2026-05-28. WHY = without this entry the next skinned-clip test that samples position on a rotation-driven joint reads 0 and gets "diagnosed" as a resolver/binding bug, sending the next engineer to patch correct code. HOW = read the glTF accessor min/max per channel; assert on the channel that varies; exact-zero → suspect a constant track, not the consumer. REF: `src/app/resolveEvaluatedTransform.ts` (the glTF-child branch), `src/app/resolveGltfChildTransform.ts` (R-4 layering), issue #91; verified live against Khronos CesiumMan.glb (19-joint walk) + Fox.glb (24-joint).

### H47 — Encode/decode mismatch between the IMPORTER and RENDERER halves of a multi-file sibling-resolution boundary: imports cleanly, fails to render

**Span:** any multi-file asset format with external sibling URIs (glTF `buffers[*].uri`, glTF `images[*].uri`, USD layer references, MTL textures, etc.) resolved through TWO INDEPENDENT lookup paths:

- **Importer side** — the parser's `resolveBuffer(uri)` callback reads buffer bytes at parse time (`opfsSiblingPath` at `src/app/asset/opfsGltfResolver.ts:128`, glTF spec §3.9.3.1 requires the URI text be percent-encoded).
- **Renderer side** — `LoadingManager.setURLModifier` resolves textures (and re-resolves buffers) at render time, fed by the URL three.js composes via `LoaderUtils.resolveURL` from the original encoded URI (`resolveBasherOpfsUrl` + `loadMultiFileGltf` `joinOpfs` in `opfsGltfResolver.ts`).

If the two halves disagree on encode/decode (one decodes, the other doesn't), the asset **IMPORTS without error** but **FAILS TO RENDER** with the texture/buffer — a silent-on-one-side, loud-on-the-other failure that masquerades as an incomplete asset rather than a boundary bug. Instantiated at P7.9 Wave E with a spaced-filename fixture (`my texture.png`) and again at Wave F with a nested-folder fixture (`nested/gltf/scene.gltf` → `../buffers/foo.bin`).

**Symptom:** drag-import a multi-file glTF whose sibling URIs contain `%20`/`%XX` (or live in subfolders with `../` traversal). The Library entry appears, the scene populates, no error banner fires. But the rendered surface has the white default material (texture missing) or fails to deform (buffer missing). The producer-side unit tests (`opfsGltfResolver.test.ts` mocking only the importer half) stay green; the renderer-side cache lookup silently misses.

**Trap (wrong fix #1):** force the OPFS write to use the **encoded** filename to match the renderer's raw lookup. WRONG — the glTF spec defines the URI as percent-encoded _text_; on-disk filenames MUST be the decoded form (`my texture.png`, not `my%20texture.png`). Encoding the disk path breaks both halves the moment another consumer is added.

**Trap (wrong fix #2):** decode only on the renderer's URL-modifier _resolution path_ and forget the renderer's _cache lookup key_ (Wave E shipped this incomplete fix; Wave F's e2e on the spaced fixture caught it). The cache key derived from `LoaderUtils.resolveURL` retains the original encoded form; the OPFS lookup must `decodeURIComponent` BEFORE the lookup, not just on `setURLModifier` output.

**Real fix:** treat the boundary as a single **decode-agreement contract**; assert it symmetrically on BOTH the importer-`resolveBuffer` side AND the renderer-cache-lookup side with the same spaced-filename fixture. Apply `decodeURIComponent` at every renderer-side OPFS-key derivation: `joinOpfs(baseDir, decodeURIComponent(uri))` in the parse-time sibling reader AND `decodeURIComponent` on the cache-lookup key in `resolveBasherOpfsUrl`. Codify with unit tests that mock the cache (not just the importer) — see `opfsGltfResolver.test.ts` 4 assertions added Wave F Task 12.

**Five-limbed argument:**

1. **Claim:** a multi-file asset boundary with two independent lookup halves must apply the SAME encode/decode transform on both halves, or one side will silently miss the file.
2. **Reason:** the spec defines the URI as text (percent-encoded); the on-disk name is the bytes (decoded). Whichever half retains the encoded form looks up a key that doesn't exist on disk; the other half succeeds in isolation, so producer-only tests cannot detect the asymmetry.
3. **Universal principle:** when a boundary is crossed by two independent code paths, asymmetric transforms at the crossing produce silent failure on the path the tests don't exercise — observability must span BOTH halves of the boundary, not just the one the producer test mocks.
4. **Application:** P7.9 multi-file glTF — Wave E Task 11 added the renderer-side `decodeURIComponent` on the URL-modifier resolution path; Wave F Task 12 e2e on the `multifile/spaced/` fixture caught the still-encoded **cache-lookup key** and added `decodeURIComponent` there too, then codified with 4 unit tests in `opfsGltfResolver.test.ts` mocking the cache layer.
5. **Conclusion:** the asset now renders end-to-end on flat, nested, and spaced fixtures because both halves of the boundary agree on the decoded form, and the agreement is asserted at the boundary itself, not at the importer alone.

**Cross-ref:** sibling to [[H40]] ("which side of the producer/consumer did I observe?" — H47 is the multi-file-asset-loader instantiation of the same diagnostic). [[H45]] (skinned-glTF Object3D.clone bug — another silent-on-import / wrong-on-render glTF failure mode). [[B12]] (glTF chokepoint — re-confirmed; both fixes live in the single shared `opfsGltfResolver` module, no V20 split required). Provenance: ORIGIN = P7.9 Wave E Task 11 (`7785faf`) + Wave F Task 12 (`26e6f1a`). WHY = without this entry, the next multi-file format added to the importer (USD layers, MTL textures) will repeat the asymmetry — only the importer half gets the encode-aware fix, the renderer cache-lookup retains the encoded key, fails silently. HOW = always pair a producer-side decode with a consumer-side decode test using a spaced-or-traversal fixture; mock the cache layer in unit tests, not just the importer callback. REF: `src/app/asset/opfsGltfResolver.ts` (the two halves — `opfsSiblingPath` line 128 + `resolveBasherOpfsUrl` cache key + `loadMultiFileGltf` `joinOpfs`), `src/app/asset/opfsGltfResolver.test.ts` (4 unit assertions added Task 12 codifying the agreement), `tests/e2e/p7.9-gltf-file-import.spec.ts` sub-case a3 (the rendered-surface gate that converts "imports cleanly" to "renders cleanly"), `public/fixtures/multifile/spaced/` (the canonical spaced-filename fixture: `my texture.png` + `scene.bin`), `public/fixtures/multifile/nested/` (the canonical nested-folder fixture proving symmetric `../`-normalization). Issue #110.

### H48 — Attributing engine slowness to the deterministic-recompute model (the evaluator) when measurement shows eval ≈ 0ms and React reconciliation is the cost

**Detection signal:** "the engine feels slow" + an architectural instinct that the lazy DAG re-evaluation / "recompute everything from a seed" model is inherently expensive, prompting talk of a Rust rewrite or WebGPU. The inference is plausible and WRONG.

**Root cause of the misdiagnosis:** the perf cost and the suspected cause sit on opposite sides of a boundary. The DAG evaluator caches by content hash (`evaluator.ts:120`), and pure nodes exclude time from their cache key (`:119`), so during playback/edit the graph re-walk is almost entirely **cache hits** — measured `eval p95 = 0.00ms` at every scale, 94–100% hit rate. The real cost is **React reconciliation**: `SceneFromDAG` subscribes to `useDagStore(s=>s.state)` AND `useTimeStore(s=>s.seconds)` (`SceneFromDAG.tsx:73,78`), so it re-renders + re-walks the ENTIRE scene subtree on every edit AND every playback frame, regardless of how many nodes actually changed. Cost is linear in node count (~0.011ms/node on M-series), breaking the 16.6ms frame budget at ~1000 nodes.

**Trap (wrong fix):** rewrite the evaluator in Rust/WASM, or swap to WebGPU. Both target budgets that measurement shows are already near-zero (eval) or have huge headroom (GPU holds 60fps to ~4000 draw calls / 4.4M tris). Neither touches the actual bottleneck (React reconciliation, a CPU/render-graph concern), so both would cost months and recover nothing.

**Real fix (the lever, not yet built):** memoize per-node React subtrees so reconciliation touches only changed nodes (React.memo keyed on each child's evaluated-value hash), and decouple time-driven playback from React re-renders by mutating three.js objects imperatively per frame — the same lesson W9 applied to the timeline playhead, now owed to the 3D viewport. GPU draw-call ceiling (instancing) is a separate, later lever.

**The discipline this enforces:** decompose "slow" into independently-attributable budgets (eval / React / GPU) and MEASURE before choosing a fix; never infer the bottleneck from architectural aesthetics. The profiler that produced this — `src/perf/frameProfiler.ts` (`window.__basher_perf`) + `src/perf/PerfProbe.tsx` + `__basher_perf_stress` seam + `tests/e2e/perf-scene-scale.spec.ts` — IS the grounding tool; re-run it before any future perf decision.

**Cross-ref:** [[B13]] (the SceneFromDAG render-reconciliation boundary where the fix clusters). Note the GPU-load metric must come from a scene-graph walk, NOT `gl.info.render`, because PostFx's EffectComposer leaves `gl.info` reflecting only its final fullscreen pass (~handful of triangles) — a measurement trap caught while building the profiler. Provenance: ORIGIN = perf investigation 2026-05-28, issue #114, branch `perf/scene-scale-profiling`. WHY = without this entry the next "engine is slow" prompt re-litigates the Rust/WebGPU rewrite from instinct instead of re-running the profiler and reading eval≈0 / React-linear. HOW = run `__basher_perf` over `__basher_perf_stress` (synthetic) or the Fox-duplication benchmark (skinned/animated) and read the three-budget table before proposing any fix. REF: `src/perf/frameProfiler.ts`, `src/perf/PerfProbe.tsx`, `src/core/dag/evaluator.ts` (the `__setEvalPerfHook` + cache-hit site `:122-128`), `src/viewport/SceneFromDAG.tsx:73,78` (the two per-frame subscriptions that drive the re-walk), `tests/e2e/perf-scene-scale.spec.ts`. Issue #114.

**2nd occurrence (2026-05-28, headed M-series, real GPU) — Fox-duplication skinned+animated playback, 5s of `useTimeStore.play()` per level:**

```
foxes | tris | draws | frame.p95 | react.p95 | reactOnly.p95 | eval.p95 | evalCalls/commit | cacheHit%
    2 | 1294 |     6 |     9.70  |     6.70  |     6.60      |    0.30  |             20.0 |    15.0%
    4 | 2446 |     8 |    13.70  |    12.50  |    12.20      |    0.50  |             34.0 |     8.8%
    6 | 3598 |    10 |    19.60  |    18.40  |    18.10      |    0.70  |             48.0 |     6.3%
    8 | 4750 |    12 |    25.50  |    24.10  |    23.70      |    0.80  |             62.0 |     4.8%
```

The skinned+animated case **predicted** non-zero eval (TimeSource hash flips every frame → TransformClip cache misses every frame, evalCalls/commit ramps 20→62) and **measured** it: eval p95 grows 0.3→0.8ms. But **eval remains 30× smaller than React** at every level — ~0.083ms/fox eval vs ~2.9ms/fox React. The 60fps knee lands between 4 and 6 foxes (`react.p95 = 12.5 → 18.4`), matching B13's synthetic-sphere extrapolation. GPU draws (6→12) and triangles (1.3K→4.7K) are trivial. **Conclusion held: the bottleneck is React reconciliation, not the evaluator, not the GPU.** Reproduce: `PWHEADED=1 npx playwright test tests/e2e/perf-fox-benchmark.spec.ts --headed`. REF (added): `tests/e2e/perf-fox-benchmark.spec.ts`.

**3rd occurrence (2026-05-29, headed M-series, real GPU) — Pass 3 SHIPPED (P7.10), same Fox-duplication benchmark + orbit:**

```
foxes | tris | draws | frame.p95 | react.p95 | reactOnly.p95 | eval.p95 | evalCalls/commit | cacheHit% | commits
    2 | 1294 |     6 |     9.50  |     0.00  |     0.00      |    0.00  |              0.0 |     0.0% |       0
    4 | 2446 |     8 |     9.60  |     0.00  |     0.00      |    0.00  |              0.0 |     0.0% |       0
    6 | 3598 |    10 |     9.60  |     0.00  |     0.00      |    0.00  |              0.0 |     0.0% |       0
    8 | 4750 |    12 |     9.50  |     0.00  |     0.00      |    0.00  |              0.0 |     0.0% |       0
```

**The diagnostic arc closes.** Pass 3 (P7.10): `TransformClipValue.sample(seconds)` lifts time INTO the value-shape (Houdini precedent); TransformClip drops its `time` input socket so its cache key stops flipping per frame; SceneFromDAG drops its `useTimeStore.seconds/frame/normalized` subscriptions and evaluates with frozen `ctx.time={0,0,0}`. Consequence: **React did not re-render at all during 5 seconds of playback** (`commits = 0` at every level, vs ~600 commits pre-Pass-3). `react.p95` collapsed from 24ms → 0.00ms at 8 foxes. `frame.p95` is now FLAT at ~9.5ms across all levels (60fps with headroom) — per-frame work (TRS write inside useFrame) is bounded by GPU/CPU, not React reconciliation. Vertex-deformation validity gate still passes (foxes animate via useFrame). The CHURN/edit regime preserved Pass 1's halved slope (2000 nodes react.p95 = 9.90ms; PR #115 = 10.20). See [[H49]] for the lesson generalized + [[V24]] for the new invariant; the boundary's HOW is updated in [[B13]]. REF: `src/nodes/TransformClip.ts` (no `time` input + closure builder), `src/nodes/types.ts` `TransformClipValue.sample`, `src/viewport/SceneFromDAG.tsx:73` (no time subs + frozen ctx), `src/app/resolveGltfChildTransform.ts` (signature: `tracks` not `clip`).

---

### H49 — Returning a pre-computed value where a function-of-time is needed inflates React's commit budget

**Detection signal:** An impure-rooted node's evaluate signature returns a pre-baked `T` (computed from `ctx.time` at evaluate time) instead of a `(t: number) => T` closure-bearing value. The React.p95 budget then scales with playback fps because every Clock tick mutates a value reference passed as a prop down a React tree; even with React.memo on every consumer, the per-frame new prop ref defeats shallow-compare.

**Root cause:** Time is being expressed as a CACHE-KEY component (the evaluator's `inputHashes` flip per frame via the impure TimeSource ancestor), so the value tree's identity changes every frame even though most of its content is static. React reconciliation walks the tree to discover this. Moving the WRITE loop out of the commit phase (the Pass 2 "useFrame relocation" move) helps marginally — the dominant cost is the tree-walk itself, not the leaf-write.

**Trap (wrong fix that looks right):** "Move the per-frame TRS-write loop from useEffect into useFrame so it runs outside React's commit phase." This is what PR #115 Pass 2 did. The TRS-write loop's body relocated, but the SURROUNDING React tree continued to walk per frame because the value-ref-per-frame chain stayed intact (impure node → new EvalResult → new value prop → memo cache-miss → re-render). Measured: 3-8% improvement on Fox, knee unchanged. Diagnostic, not solution.

**Real fix:** Lift time INTO the value-shape, not the cache key. The impure node returns `{ ..., sample: (seconds) => T }` and the evaluator's local impurity gate goes away (the node becomes `pure: true` with no Time input). Then the cache key is stable across frames, the value ref is stable, React.memo actually short-circuits, and the per-frame work moves to the only place that needs it (consumer-local useFrame, where time-sampling cadence belongs).

**Cross-ref + lineage:** Sibling to [[H48]] (which named the BROAD framing: evaluator-not-bottleneck). H49 names the SPECIFIC architectural lever — "where does time live in the value contract?" The two-pass diagnostic that arrived here:

- Pass 1 (memoize MeshChild/LightNode/CameraNode): halved CHURN slope, didn't help skinned playback because for Fox every child IS time-driven so memo always misses. Correct fix for static scenes; insufficient for animated.
- Pass 2 (move TRS-write to useFrame): tiny win on Fox (3-8%). Diagnostic — proved the loop was NOT the dominant cost.
- Pass 3 (TransformClipValue.sample): solved it. react.p95 24ms → 0.00ms at 8 foxes; commits = 0 across 5s playback.

Provenance: ORIGIN = P7.10 (#114), 2026-05-29. WHY = without this entry, a future impure node (audio sync, physics, procedural animation) would re-discover the cache-key-time-component trap by repeating Pass 2 and walking away with a small win and an unhealed regression. HOW = before adding any new impure node, ask "does this node's output VARY with time?" — if yes, design its VALUE TYPE as a function-of-time first; opt into the impure flag only if no value-shape solution exists. REF: `src/nodes/TransformClip.ts`, `src/nodes/types.ts` `TransformClipValue`, `tests/e2e/perf-fox-benchmark.spec.ts` (the measurement loop that distinguishes Pass 2 from Pass 3), [[H48]], [[B13]], [[V24]]. Issue #114.

### H50 — Conflating glTF's three index spaces: a skin's per-joint datum indexed by NODE index instead of joint-LIST position

**Detection signal:** A captured per-joint array (joint names, bind TRS, parent index, inverse-bind matrices) comes out scrambled or off-by-N when a fixture's `skin.joints[]` is NOT in node order. Symptoms: the projected rig's bones carry the wrong names/parents; the IBM attaches to the wrong bone; deformation goes haywire on a real rig but a small identity-ordered fixture false-passes. The loud-failure fixture is `many-bone-rig.glb` whose `joints = [63, 62, …, 0]` (fully reversed vs node order); `skinned-bar.glb`'s `[1, 0]` is the minimal non-identity case.

**Root cause:** glTF has FOUR distinct index spaces that read as interchangeable integers: (1) glTF **node index** (position in `json.nodes[]`); (2) **joint-list position** (position in `skin.joints[]` — the IBM accessor is indexed by THIS, `GLTFLoader.js:3975` `inverseBindMatrices.array[i*16]`); (3) the post-dedup **GltfChild key**; (4) the projected **BoneSpec array index**. The naive reader slices the IBM accessor by node index, or resolves `parent` in node space, because all four are "just numbers."

**Trap (wrong fix that looks right):** "Iterate `json.nodes` and attach each node's IBM." Passes on any fixture whose `skin.joints[]` happens to equal node order (the identity case) — which is most hand-made 1–2 bone fixtures. The bug only manifests on a rig whose joint list is permuted, and then as subtle wrong deformation, not a crash.

**Real fix:** Make `skin.joints[]` order the SINGLE spine. Capture EVERY per-joint array (`jointKeys`, `bindTRS`, `parentJointIndex`, `inverseBindMatrices`) in that one order at import (`buildSkinMetadata`, iterating `i` over `skin.joints`). Resolve `parentJointIndex` in joints-space at capture (walk childHierarchy up to the nearest JOINT ancestor, map back to its joints-list position; -1 for root). The projector (`projectGltfSkeleton`) then emits BoneSpec[] in that same order, so: BoneSpec index i == `skin.joints[]` position i == IBM index i == parentJointIndex space i == render `SkinnedMesh.skeleton.bones` index i. That last equality makes the [[H40]] render boundary-pair a trivial index-by-index name check (F6a). Detection: `gltfSkinCapture.test.ts` + `projectGltfSkeleton.test.ts` assert ordering + parent on BOTH `[1,0]` and `[63..0]`.

Provenance: ORIGIN = P7.11 (#100), 2026-05-29 — RESEARCH #3/risk #1, the planner's #1-ranked bug site; research-grounded (the index-space distinction proven against both committed fixtures BEFORE the bug could ship). WHY = without this entry, the next glTF skin consumer (DAG-side skinning, FBX node-indexed clips, viewport bone-pick #100/D-06) re-discovers the joint-list-vs-node trap from scratch, and the false-pass on identity-ordered fixtures hides it until a real permuted rig deforms wrong in front of a user. HOW = for any glTF skin datum, name which of the four index spaces it lives in BEFORE indexing it; make `skin.joints[]` order the spine and index everything off it. Cross-ref [[H40]] (the boundary-pair this discipline makes trivial), [[H45]]/[[H46]] (the render-side skin family), [[V25]]. REF: GROUND_TRUTH_GLTF.md DEFERRED (Wave E2) → interim grounding RESEARCH.md §B1 three.js citations (`GLTFLoader.js:3930-3993` loadSkin, IBM at `:3975`, `new Skeleton(bones, boneInverses)` at `:3989`); `src/core/import/gltfImportChain.ts` `buildSkinMetadata`, `src/core/import/projectGltfSkeleton.ts`, `src/core/import/gltfSkinCapture.test.ts`, `src/core/import/projectGltfSkeleton.test.ts`. Issue #100. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H51 — A glTF joint in matrix-form local transform captured as identity TRS — silent on TRS-only fixtures

**Detection signal:** A glTF rig's bind pose is wrong (all joints at the origin / no rotation) ONLY for files exported with matrix-form joint transforms — and ONLY the deformation is wrong; bone NAMES, counts, and the [[H40]] name-equality all still pass (names are matrix-independent). Since the committed fixtures (`skinned-bar`, `many-bone-rig`) are both TRS-form (0 matrix nodes), the e2e gives a FALSE PASS and the gap stays invisible until a Blender-exported rig (Blender's exporter commonly emits `matrix` for JOINT nodes) is dropped.

**Root cause:** glTF 2.0 §3.6 lets a node specify its local transform EITHER as separate `translation`/`rotation`/`scale` OR as a single 4×4 column-major `matrix` (mutually exclusive per node). The importer's `GltfNode` type + `defaultTRS` originally read only T/R/S → a matrix-form node decomposes to nothing → captured bind TRS is silently identity.

**Trap (wrong fix that looks right):** "Our fixtures all import and render correctly, so the capture is right." The TRS-only fixtures structurally cannot exercise the matrix branch; their green is not evidence the matrix path works. This is the classic "the test fixture lacks the shape that triggers the bug" false-pass.

**Real fix:** Add `matrix?: number[]` to `GltfNode`; in `defaultTRS`, WHEN `node.matrix` is present, `new Matrix4().fromArray(node.matrix).decompose(pos, quat, scl)` and convert the quaternion through the SAME quat→euler→deg path used for `node.rotation` (correct-by-construction: a matrix-form joint and the equivalent T/R/S joint yield the same TRS). This also fixes the latent matrix-form gap on the pre-existing GltfChild import path (shared `defaultTRS`). Detection: `gltfSkinCapture.test.ts` "matrix-form decomposition" — author a known TRS, bake it into a `Matrix4`, emit two sibling joints (one T/R/S, one matrix), assert `defaultTRS` yields the SAME position/rotation(deg)/scale for both. `Matrix4.decompose` recovers TRS within float limits (glTF joint matrices are affine TRS — no shear by spec).

Provenance: ORIGIN = P7.11 (#100), 2026-05-29 — PLAN FLAG 1; research-grounded (glTF 2.0 §3.6 + the Blender-exporter observation), caught at plan time as a deform-fidelity false-pass risk on the TRS-only committed fixtures. WHY = without this entry + its synthetic assertion, the matrix-form path stays untested behind green TRS fixtures, and the first Blender-rig drop silently flattens the rig to identity bind pose while every name-based check passes. HOW = whenever a fixture set lacks a representation a spec permits (here matrix-form), add a SYNTHETIC assertion for that representation rather than trusting fixture-green. Cross-ref [[H50]] (the sibling capture-time trap — same `buildSkinMetadata`), [[H46]] (rotation-not-position, the sibling "the fixture can't show the bug" family), [[V25]]. REF: GROUND_TRUTH_GLTF.md DEFERRED → interim RESEARCH.md §B1; `src/core/import/glb.ts` (`GltfNode.matrix?`), `src/core/import/gltfImportChain.ts` `defaultTRS` (the decompose branch), `src/core/import/gltfSkinCapture.test.ts` (the matrix-vs-TRS assertion). Issue #100. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H52 — A value-shape migration updates the product consumer but misses TEST-inlined copies of it

**Detection signal:** After migrating a value's shape (e.g. `.value` → `.sample(t)`, or an AnimationLayer's eager `.target` patched-clone → a `sampleTarget(seconds)` function-of-time), the product behaves correctly at runtime but a band of e2e/unit tests fail reading the OLD shape — typically getting the base/zero value (e.g. `expect(...).toBeGreaterThan(0)` → got 0; `toBeCloseTo(5)` → got 0). The product is migrated; the tests are not.

**Root cause:** Boundary-pair tests (the H40 discipline) deliberately HAND-INLINE a copy of the consumer/resolver walk so they observe the producer side INDEPENDENTLY of the product helper ("calling the helper the inspector consumes would be a tautology"). Those inlined mirrors are a SECOND consumer set of the value shape. A migration that greps only product code (and even most test files) misses them.

**Trap (wrong fix that looks right):** "The product resolver is migrated and unit tests pass, so the phase is done." The inlined test mirrors still read the old shape; the full e2e is the only gate that exercises the real surface and catches it. Worse, under a flaky/phantom tool environment a "green" report may be stale — never trust it without a stable repeated read.

**Real fix:** When migrating a value shape, grep ALL inlined duplicates of the consumer logic in TESTS too (e.g. `grep '\.target' tests/e2e/*.spec.ts` for an AnimationLayer migration), and update each to the new API — preserving the assertion, changing only the read mechanism (NOT a weakening). Run the FULL e2e suite, not just the changed-spec subset.

**Sibling:** [[H49]] (incomplete-consumer-enumeration — the function-of-time type-level fix); this is its TEST-mirror variant. Cross-ref [[H40]] (boundary-pair, why the inlined mirrors exist).

Provenance: ORIGIN = P7.12 Wave A (#108), 2026-05-30 — D-04 migrated KeyframeChannel{Number,Vec3,Quat,Color} to the function-of-time value shape + AnimationLayer to `sampleTarget(seconds)`; the product resolver (`resolveEvaluatedTransform.ts:234`) was correct but 6 hand-inlined mirrors across tests/e2e/{p7.4-npanel-evaluated-display, p7.3-gizmo-evaluated-transform, p3-observe, p7-animation-authoring}.spec.ts read the un-patched `.target` → 0; ~11 e2e failures, ALL this one pattern. WHY = without this entry the next value-shape migration repeats the "product migrated = done" trap and ships a red e2e (or, worse, a green-looking phantom). HOW = grep test-inlined consumer copies during any value-shape migration; full-suite e2e is the catching gate. REF: GROUND_TRUTH_GLTF DEFERRED → interim RESEARCH.md (7.12) + `src/app/resolveEvaluatedTransform.ts`, `src/nodes/AnimationLayer.ts` (sampleTarget), the 4 spec files above. Issue #108. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H53 — A glTF clip track is keyed by childName, not the GltfChild dagId

**Detection signal:** A clearly-animated imported bone shows an EMPTY dopesheet / a dead (never-driven) baked channel. The display projector or bake mutator queried the clip's tracks by the GltfChild's DAG node id and got zero rows.

**Root cause:** `TransformClip.params.keyframes[].targetNodeId` is the sanitised/deduped **childName** (`gltfImportChain` sets `targetNodeId = keyByGltfNodeIndex[targetIndex]`), and `resolveAllChildTrs` keys `tracks` by that same NAME. The GltfChild DAG node id is a DIFFERENT value, `hashId('gltfChild', assetRef, childName)`. The two are bridged BY `childName`, not interchangeable.

**Trap (wrong fix that looks right):** "The selection gives me a GltfChild node id, so I'll look up its clip track by that id." → zero rows / dead channel, diagnosed as "no animation on this bone" when the animation is right there under the name key.

**Real fix:** Key any clip-track read by `childName` (= `GltfChild.params.childName`). When you need the GltfChild dagId from a childName, derive it via `gltfChildDagId(assetRef, childName)` (the single source, `gltfImportChain.ts`); the asset's `nodeNameMap` (childName → dagId) is the bridge. A baked channel stores BOTH (see [[V26]]).

**Sibling:** [[H50]] (joint-list-vs-node-index spine — the OTHER glTF key-space confusion). Cross-ref [[V26]] (dual-key), [[V22]] (deterministic ids).

Provenance: ORIGIN = P7.12 Wave B/D (#108), 2026-05-30 — the display projector (`clipChannelRows`) and the bake mutator both had to query clip tracks; keying by dagId yields empty. WHY = without this entry the next clip-track consumer (FBX editing, a "convert all" bulk action, an agent tool) repeats the empty-timeline symptom. HOW = key by childName; bridge via gltfChildDagId/nodeNameMap. REF: `src/core/import/gltfImportChain.ts` (targetNodeId = name key + `gltfChildDagId`), `src/timeline/clipChannelRows.ts`, `src/agent/mutators/builders/bakeGltfChannel.ts`, `src/app/bakedGltfChannels.ts`. Issue #108. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H54 — An edge-less baked channel must reach the bone via the resolver enumeration, NOT an AnimationLayer edge

**Detection signal:** A baked/edited glTF bone's curve SHOWS in the dopesheet but the bone does NOT move under playback. The channel exists and has keyframes, yet nothing drives the rendered joint.

**Root cause:** A GltfChild is inputless (R-1, [[H45]] architectural lock — three.js owns the skeleton; the DAG node only carries a TRS override). There is NO `animation` edge into it. The copy-on-write bake reaches the bone ONLY because the renderer (and read-side) ENUMERATE baked KeyframeChannel nodes by `params.childName` and feed them into the layering resolver. A reflexive "channel → AnimationLayer.animation" wire (the muscle-memory shape from authored channels) drives nothing — the GltfChild is not the layer's target.

**Trap (wrong fix that looks right):** Bake by reusing the authored-channel path (addChannel-style: emit `connect channel → AnimationLayer.animation`). The dopesheet looks right; the bone is dead. Adding MORE wiring (a second connect) compounds it — the framing is wrong.

**Real fix:** The bake emits ZERO connect ops (R4 edge-less bridge). The channel carries `params.childName` + `params.target` (= GltfChild dagId, [[V26]]); the resolver enumerator (`bakedGltfChannels.ts`) finds it by name and the SOLE useFrame writer applies it (V20/H36). Assert ZERO `connect` ops in the bake unit test; prove the bone visibly moves (vertex delta) in e2e.

**Sibling:** [[H45]] (three.js owns the skeleton — why GltfChild is edge-less). Cross-ref [[V20]]/[[H36]] (single writer), [[V26]].

Provenance: ORIGIN = P7.12 Wave D (#108), 2026-05-30 — the CONTEXT-named trap; bake is a DAG-to-DAG copy with no consumption edge. WHY = without this entry the next "make this importable thing editable" feature wires an edge and ships a silently-dead bone. HOW = zero connects; resolver enumerates by childName. REF: `src/agent/mutators/builders/bakeGltfChannel.ts` (zero connects), `src/app/bakedGltfChannels.ts` (enumeration), `src/viewport/SceneFromDAG.tsx` GltfAssetR useFrame. Issue #108. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H55 — A new precedence band on a multi-caller layering primitive must be threaded into ALL callers

**Detection signal:** A baked-then-edited bone renders the edited value in the viewport, but the gizmo/NPanel evaluated transform shows the OLD value (clip/base) — a displayed-≠-rendered split at a specific param.

**Root cause:** `resolveGltfChildTrs` (the one layering primitive) has TWO callers — the renderer (`SceneFromDAG` useFrame) AND the read-side (`resolveEvaluatedTransform`, the gizmo/NPanel source). A new precedence band (here the baked-channel layer) added to the primitive's signature but PASSED by only one caller makes the surface that omits it diverge. The optional arg (added for compile-staging) silently defaults to `undefined` on the un-updated caller.

**Trap (wrong fix that looks right):** "Only the renderer needs the new band; the resolver is a read-only display, it'll be fine." → the #68/#77 second-surface class returns: the displayed value lies about what renders.

**Real fix:** When adding a band/arg to a primitive consumed by N surfaces, thread it into ALL N in the SAME wave, sampled at the SAME time input; an e2e asserts surface-vs-render parity at multiple t. Prefer a SHARED enumerator both callers import (one source) over per-caller re-implementation.

**Sibling:** This is the [[H40]] displayed-≠-rendered class, instantiated at the `resolveGltfChildTrs` two-caller boundary. Cross-ref [[V20]] (one precedence rule).

Provenance: ORIGIN = P7.12 Wave C (#108), 2026-05-30 — plan-checker BLOCK-1; C1 added the `bakedChannel` band, C2 (renderer) + C3 (read-side) both had to thread it. WHY = without this entry the next band added to the primitive ships a one-surface fix and a parity regression. HOW = shared enumerator (`bakedGltfChannels.ts`) consumed by both callers; e2e parity gate (read-side == render at t=0.5, t=1.5). REF: `src/app/resolveGltfChildTransform.ts` (the two-caller header), `src/viewport/SceneFromDAG.tsx` (C2), `src/app/resolveEvaluatedTransform.ts` (C3), `tests/e2e/p7.12-editable-imported-clips.spec.ts` (b2 parity). Issue #108.

### H56 — DAG node params are stored zod-PARSED, so a key not declared on the schema is silently stripped

**Detection signal:** A mutator writes an extra param (e.g. a cross-reference key the renderer enumerates by), but downstream reads of `node.params.<key>` are always `undefined` — the enumeration finds nothing and the feature is silently dead, even though the addNode op clearly carried the key.

**Root cause:** `applyAddNode`/`applySetParam` (`ops.ts`) store `paramSchema.safeParse(op.params).data` — the zod-PARSED output, not the raw op params. A `z.object()` strips unknown keys by default. So any param key NOT declared on the node's `paramSchema` vanishes at write time. This is invisible at the op-construction site (the key is there) and only surfaces as a missing read much later — a cross-wave silent failure.

**Trap (wrong fix that looks right):** "I'm writing `params.childName` in the bake op, so the renderer can read it." It can't — the schema didn't declare `childName`, so it was stripped on store. Debugging the renderer enumeration (the reader) is the wrong end; the data never persisted.

**Real fix:** Declare EVERY param key a node may carry on its `paramSchema` (optional for variant-only keys). For the P7.12 bake variant, `KeyframeChannelVec3Params` gained optional `childName` + `assetRef`. A round-trip unit test (addNode → read `state.nodes[id].params.<key>`) catches the strip.

**Sibling:** Cross-ref [[V26]] (the dual-key this prerequisite protects). General lesson: any value that round-trips through a zod-parsed store loses undeclared fields — applies to params, op payloads, persisted project JSON.

Provenance: ORIGIN = P7.12 Wave C (#108), 2026-05-30 — caught while wiring C2's enumerator: D1's `childName`/`assetRef` would have been stripped at addNode, making the whole copy-on-write band dead. WHY = without this entry the next mutator storing a computed/cross-ref param ships a silently-stripped key. HOW = declare the keys on paramSchema; round-trip test. REF: `src/core/dag/ops.ts` (applyAddNode stores parsed data), `src/nodes/KeyframeChannelVec3.ts` (the optional childName/assetRef declaration). Issue #108.

### H57 — The V13 closure gate expands against the post-batch fork, so a removeNode's deleted target false-rejects

**Detection signal:** A delete-through-dispatch mutator (revert, cleanup) throws `ClosurePreservationError` for the very node it is deleting, even though that node is squarely within the mutator's declared closure.

**Root cause:** `useDiffStore.propose` expands the closureSpec against the FORK (post-batch state) so closure roots on freshly-added ids resolve. But a `removeNode` deletes its target IN that fork, so the fork-expanded closure cannot contain it → the membership check rejects a legitimate delete.

**Trap (wrong fix that looks right):** Exempt ALL removeNodes of any pre-existing node from the gate. It unblocks the delete but WIDENS the V13 hole — a buggy mutator could then delete an out-of-closure node undetected.

**Real fix:** Expand the SAME closureSpec a SECOND time against the ORIGINAL state (where the node still exists, computed lazily only when the batch removes a node) and exempt a removeNode only when its target is in THAT original closure. A deleteNode mutator roots its closure on the node(s) it deletes → legitimate deletes are contained; an out-of-closure removeNode still throws. V13 preserved, not weakened.

**Sibling:** mirrors the existing `introducedIds` exemption for fresh addNodes (a node not in the prior closure), inverted for removal. Cross-ref the validator from-side blind-spot (gates have asymmetric coverage; widen precisely, never broadly).

Provenance: ORIGIN = P7.12 Wave D (#108), 2026-05-30 — D3 revert deletes edge-less baked channels through the dispatch seam; the fork-expanded gate false-rejected. First fix was the broad exemption; self-review tightened it to the original-closure check. WHY = without this entry the next delete-through-dispatch either re-hits the false-reject or copies the broad relaxation. HOW = lazy original-state closure expansion; exempt only in-original-closure removeNode targets. REF: `src/agent/diff/store.ts` (propose, the `closureContainsInOriginal` lazy check), `src/app/animate/dispatchMutator.ts` (dispatchRevertGltfChannel). Issue #108.

### H58 — An e2e that exercises a capability programmatically (not through the user affordance) goes green while the feature is unreachable by users

**Detection signal:** A dispatch helper / mutator / action has full unit + e2e coverage and all gates are green, yet a user cannot actually reach it — there is no button, menu item, or wired event that calls it in production. The capability is "tested" but dead in the shipped UI.

**Root cause:** The e2e proved the LOGIC by calling the function directly (`page.evaluate(() => dispatchX(...))` / importing the module and invoking it), NOT by driving the user-facing affordance (click the button that should call it). Direct-call e2e is a valid LOGIC proof but it is NOT a WIRING proof — it silently substitutes for the missing production caller, so the suite is green while the affordance doesn't exist.

**Trap (wrong fix that looks right):** "There's a green e2e for revert, so revert ships." The e2e dispatched the helper directly; the button was never built. The goal-backward verifier catches this as "no production caller," but a task-completion check ("tests pass") does not.

**Real fix:** For any user-facing capability, the e2e MUST drive it through the real affordance (locate and click the button/menu item), not a programmatic dispatch. If no affordance exists yet, that IS the gap — build the production caller. Reserve direct-call e2e for capabilities with no UI surface (agent-only tools, headless seams). When a helper has ONLY test callers, treat it as unshipped.

**Sibling:** the goal-backward verify discipline (does the codebase DELIVER, not "did tasks run"). Cross-ref [[H40]]/[[H55]] (observe the real surface, not a proxy).

Provenance: ORIGIN = #121 / P7.12 D3 (#108), 2026-05-30 — `dispatchRevertGltfChannel` shipped with unit + e2e coverage, but the e2e dispatched it directly and no UI button existed; the P7.12 verifier flagged "no production caller." Fixed by `RevertImportedClipConnector` (NPanel button) + the p7.12 (c) e2e now CLICKS the button. WHY = without this entry the next "tested but unwired" capability ships green-and-dead. HOW = e2e drives the real affordance; a helper with only test callers is unshipped. REF: `src/app/animate/RevertImportedClipConnector.tsx`, `src/app/NPanel.tsx`, `src/app/animate/dispatchMutator.ts` (`dispatchRevertGltfChannel`), `tests/e2e/p7.12-editable-imported-clips.spec.ts` (sub-case (c), button-driven). Issue #121. (Restored 2026-05-31 — the original docs commit d26ae8b was authored after PR #122 merged and never reached main.)

### H59 — Wholesale material replacement on a glTF override drops imported maps AND silently downgrades MeshPhysicalMaterial → MeshStandardMaterial (loses KHR extensions)

**Span:** any renderer that applies a flat/preset material onto a loaded glTF/FBX by assigning a brand-new material per mesh (`m.material = new THREE.MeshStandardMaterial({...})`) instead of cloning the imported one. Instantiated at `src/viewport/SceneFromDAG.tsx` GltfAssetR (#99): the `MaterialOverride` effect rebuilt every mesh material from 7 scalars.

**Symptom:** a textured/PBR glTF renders correctly until a `MaterialOverride` (any color) is wired upstream — at which point the asset flattens to a plain blob: all texture maps (`.map`/`.normalMap`/`.roughnessMap`/`.metalnessMap`/`.aoMap`/`.emissiveMap`), vertex colors, and PBR extensions (clearcoat/transmission/sheen — carried by `MeshPhysicalMaterial`) vanish. No error, no warning; the override's color/roughness/metalness DO apply, so the change looks intentional.

**Trap (wrong fix / false green):** assert "the override color landed" — it passes against the bug (the new material's color IS the override color; the textures are just silently gone). A "material present + correct color" check green-lights the texture loss. Also tempting and ALSO wrong: clone the source but then unconditionally apply ALL override scalars — default `roughness 0.5` / `metalness 0` then ATTENUATE the preserved roughnessMap/metalnessMap (those scalars multiply their maps in three.js), so a recolor-only intent still corrupts a metallic PBR asset. A subtler fidelity loss masquerading as the fix.

**Real fix:** clone the imported material (`source.clone()` = `new this.constructor().copy(this)` — preserves the SUBCLASS so MeshPhysicalMaterial stays Physical, and copies every map ref; three.js 0.169 `Material.js:424`, `MeshStandardMaterial.copy` L76-104) and overlay ONLY the map-aware-tint fields: `color`/`emissive`/`opacity` always (color multiplies a preserved `.map` ⇒ a tint), `roughness`/`metalness` ONLY where the source has no corresponding map. Mirrors Blender's shader-socket semantics (a connected texture socket ignores the scalar value widget). Assign a FRESH clone per mesh — never mutate the source material's properties: `Mesh.copy` (three.js 0.169 `Mesh.js:60`) copies `.material` BY REFERENCE, so clones across instances + the drei `useGLTF` cache share one material object; in-place mutation would corrupt every instance and the cache (the [[V20]]/[[H36]]/[[H45]] single-writer landmine). The honest OBSERVATION is the rendered mesh's live `.map` (it stays non-null AFTER the override) plus its `.color` (the tint landed) — read on the cloned three.js tree via `__basher_gltf_meshes`, never inferred from the override node's params.

**Detection signal:** grep renderers for `new THREE.Mesh*Material(` inside an override/recolor path applied to a loaded glTF/FBX scene — if it constructs a fresh material rather than cloning the source, imported maps + PBR extensions are silently dropped. Runtime fingerprint: textured asset turns flat-colored the instant an override connects, zero console output.

**Five-limbed argument:**

1. **Claim:** replacing a glTF mesh's material with a fresh `MeshStandardMaterial` drops its maps + PBR-extension subclass; cloning the source and overlaying only safe fields preserves them.
2. **Reason:** `Material.clone` copies the subclass and all map references; a fresh constructor starts from defaults (null maps, base `MeshStandardMaterial`). The override carries no "which field set" flag, so applying mapped scalars from defaults attenuates the source maps.
3. **Universal principle:** an override field may overwrite source data only where it cannot corrupt richer source data; the presence of a map is the structural signal that the source already owns that channel (the scalar multiplies the map).
4. **Application:** GltfAssetR (#99) now clones the captured original per mesh and sets color/emissive/opacity always, roughness/metalness only where no map; the fresh clone keeps per-instance isolation (never mutates the shared source).
5. **Conclusion:** the bug is a material-construction-vs-clone bug, not an import or override-semantics bug. The fix is clone-preserve + map-aware overlay; the only honest proof is a still-mapped, freshly-tinted rendered surface.

**Sibling:** [[H45]] — the other "clone semantics on a loaded glTF" trap (Object3D.clone leaves SkinnedMesh bound to source bones; both are footguns at the GltfAssetR clone boundary). [[H40]]/[[H55]] family (observe the rendered SURFACE, not a proxy — here the override-node params said "red," only the mesh's `.map` said "textures survived"). [[V20]]/[[H36]] (single writer / no shared-material mutation — the reason we clone-and-reassign rather than mutate in place).

Provenance: ORIGIN = #99 (split from #83 fidelity follow-ups), 2026-05-31 — GltfAssetR's override effect rebuilt materials from scratch. WHY = without this entry the next recolor/override path on a loaded asset repeats the wholesale-replace (or the clone-but-apply-all-scalars half-fix) and "verifies" it with a color check that passes against the texture loss. HOW = clone the source material, overlay only map-aware-tint fields, assign a fresh clone per mesh; observe the surviving `.map` + landed `.color` on the rendered clone. Scope note: D-06 / #124 (an explicit per-field "overridden" set + opt-in flatten toggle — Blender's view-layer-override path) is the open successor for directors who need to force a mapped channel. REF: `src/viewport/materialOverrideMerge.ts` (`resolveMaterialOverrideFields`, the pure map-aware rule) + `.test.ts`, `src/viewport/SceneFromDAG.tsx` GltfAssetR (override effect: lazy original capture + `src.clone()` + restore-on-removal; `__basher_gltf_meshes` color field), `tests/e2e/p7.13-gltf-material-override.spec.ts` (real-affordance wiring + textures-survive + tint-lands + restore guard + falsification), CONTEXT/PLAN 7.13. Issue #99. (Grounded: GROUND_TRUTH_GLTF.md @ three 0.169.0 — materials §STAGE 3, skin/skeleton §STAGE 5, clone/share boundary §STAGE 6, clips §STAGE 7.)

### H60 — No storage move/copy primitive → a rename/delete that deletes-old before new is verified (or leaves the empty dir) orphans a live assetRef / lingers cruft

**Span:** any imported-asset rename or delete built on `StorageCapability` (`src/core/storage/StorageCapability.ts:17-42` — `write/read/exists/delete/list`, NO `move`/`copy`/`rename`/recursive-delete). Instantiated at `src/app/asset/importCommon.ts` (#112): `renameImportedAsset` / `deleteImportedAsset` move/remove a `user-imports/<name>/` tree that a `GltfAsset.params.assetRef` may point inside.

**Symptom (two faces):** (a) ordering — delete the old folder's files before the new copy is fully written+verified (or rewrite `assetRef` to the new path before the new files exist) and a mid-operation crash/quota-fail leaves a live `GltfAsset.assetRef` pointing at a now-missing path → the renderer load-errors with no recovery. (b) residue — `storage.delete` is FILE-only; deleting every file under a folder leaves the now-EMPTY directory (and empty subdirs) behind, so a "renamed"/"deleted" asset's folder handle still resolves (`getDirectoryHandle` succeeds on the empty dir) — the asset looks half-deleted and a later same-name import suffix-collides against the ghost.

**Trap (wrong fix / false green):** assert only `exists(newPath/file) === true` after rename — green while the old folder + old assetRefs still linger. Or test delete with `exists(file)` only (MemoryStorage deletes the file AND has no dir concept, so the unit test passes) while OPFS in the browser leaves an empty dir the unit env never sees (the backend-asymmetry blind spot — observe the REAL backend's dir, not just MemoryStorage's file map).

**Real fix:** the fail-safe lifecycle is **copy-all-new → verify-all-new (`exists` each) → rewrite assetRefs in ONE `dispatchAtomic` (K6, undoable) → delete-old → bump** (see [[K14]]). NEVER delete-old before new is verified: a crash then leaves a recoverable DUPLICATE, never a dangling ref. The assetRef rewrite is a single `dispatchAtomic` so it is all-or-nothing. For residue: a `deleteOpfsTree` helper removes files, THEN every now-empty subdir deepest-first, THEN the root — `removeEntry` removes an EMPTY directory too (`OpfsStorage.ts:83-90`), and the dir-deletes are harmless no-ops on MemoryStorage. Observe BOTH backends: the unit test asserts file-absence (MemoryStorage), the e2e asserts the OPFS _directory handle_ no longer resolves (`getDirectoryHandle` throws). Asymmetry (CONTEXT D-03): glTF persists `assetRef` → rewrite required; BVH/FBX leave NO ref → folder-move only (`nodesReferencingImport` returns []).

**Detection signal:** grep an asset rename/delete for `storage.delete(old…)` reached before an `exists(new…)` verify, or a delete loop that removes files but never the parent dir. Runtime fingerprint: a renamed asset whose old folder still appears in OPFS, or a GltfAsset that load-errors right after a rename.

**Five-limbed argument:**

1. **Claim:** with no move primitive, rename/delete must be copy→verify→rewrite-refs→delete + an explicit empty-dir prune, or it orphans a ref or leaves residue.
2. **Reason:** the capability exposes only per-file delete and no atomic move; the OPFS dir lingers after its files are gone; a half-completed sequence with the wrong order leaves a live ref pointing at deleted bytes.
3. **Universal principle:** when the substrate offers no atomic move, the only crash-safe order writes+verifies the destination fully BEFORE mutating the source, and a "remove" must remove the container, not just its contents.
4. **Application:** `renameImportedAsset`/`deleteImportedAsset` copy→verify→rewrite(1 dispatchAtomic)→`deleteOpfsTree` (files+dirs+root); BVH/FBX skip the ref step.
5. **Conclusion:** the bug is a substrate-capability-gap bug, not an import bug. The fix is the fail-safe order + dir prune; the proof observes BOTH the moved/cleared OPFS dir AND the followed/removed assetRef on BOTH backends.

**Sibling:** [[K6]] (one dispatchAtomic per mutation — the rewrite is one atomic). [[H57]]/[[V13]] (the break-refs removeNode chain roots its closure on the referencing nodes). The backend-asymmetry blind spot is the same shape as [[H40]] (observe the real surface, not the convenient proxy — here MemoryStorage's file map vs OPFS's directory tree).

Provenance: ORIGIN = #112 (P7.14 Wave B), 2026-06-01 — the first e2e of `renameImportedAsset` passed its unit test (file present) but the OPFS old-dir handle still resolved (empty dir left behind), and a naive delete-before-verify would orphan the assetRef. WHY = without this entry the next storage-backed move/delete repeats the delete-before-verify order or the file-only delete, and "verifies" it with a MemoryStorage unit test that can't see the lingering OPFS dir. HOW = copy→verify→rewrite-refs(atomic)→deleteOpfsTree(files+empty-dirs+root); observe the real OPFS directory handle, not just the file map. REF: `src/app/asset/importCommon.ts` (`renameImportedAsset`/`deleteImportedAsset`/`deleteOpfsTree`/`listFilesDeep`), `src/app/asset/importRefs.ts` (`nodesReferencingImport`), `src/core/storage/StorageCapability.ts:17-42` (no move primitive), `tests/e2e/p7.14-my-imports-mgmt.spec.ts` (OPFS-dir-handle observation on the real backend). Issue #112.

### H61 — A fixed-timeout e2e assertion on a CPU-heavy async-completion UI passes locally and fails DETERMINISTICALLY on a ~3× slower CI runner — and reads like a logic bug, not a flake

**Span:** any e2e assertion of the form `await expect(locator).toBeVisible({ timeout: <short> })` (or any single fixed-timeout wait) that gates on the completion of a multi-step, CPU-bound async chain — React re-render + three.js/glTF (re)load + store re-enumeration — not just a single IO op. Instantiated at `tests/e2e/p7.14-my-imports-mgmt.spec.ts:121-123` (#112): the renamed-asset row appears only AFTER copy-all → verify-all → assetRef rewrite → viewport glTF RELOAD → delete-old → bump → React re-enumerate; a 5 s window held locally and missed on CI (e2e job ran ~21 m vs ~6.8 m local — ~3×).

**Symptom:** the test fails ONLY on CI, on EVERY attempt (initial + retry), while green on every local run — so it reads as a deterministic regression, not a timing flake. The failure screenshot/error-context shows the pre-operation state (here: the OLD "flat-asset" row still present, no error banner), which looks exactly like "the operation never happened / silently broke."

**Trap (wrong fix / false diagnosis):** conclude from the snapshot that the feature is BROKEN (the row never renamed → hunt for a logic bug in `renameImportedAsset`, a storage backend-asymmetry, a stale-closure on the rename input, an OPFS consistency lag). All plausible, all wrong — the operation completes correctly given time. Burning the budget proving a non-bug is the real cost. The deeper trap: the fixture is tiny (~3.5 KB), so "the copy is slow" is dismissed — but the latency is CPU-bound (React + three.js reload competing for the main thread), NOT IO-bound, so file size is a red herring in BOTH directions.

**Real fix:** reproduce the slow runner DETERMINISTICALLY with CDP CPU throttling (`client.send('Emulation.setCPUThrottlingRate', { rate: 8 })`) — a throwaway spec that throttles, runs the exact flow, then dumps the REAL post-operation state (OPFS dir listing + the DAG assetRefs). Observation here: under 8× throttle the rename COMPLETES perfectly (`user-imports/` = `[renamed-asset]`, old dir `THREW NotFoundError`, assetRef followed) — it just takes >5 s. That proves "calibration, not logic," so the fix is to widen the ONE heavy assertion's timeout to match the operation's real worst-case latency (here 15 s), consistent with the file's sibling assertions that already use auto-retrying `expect.poll`. Widening a timeout to match a genuinely-completing async op is NOT the [[base-layer]] "setTimeout to paper over ordering" anti-pattern — there is no ordering bug; the order is correct and observed.

**Detection signal:** a test that is green locally + red on CI on every attempt (not 1-in-N), whose failure artifact shows the PRE-operation UI with no error surfaced, and whose gated operation involves a viewport asset (re)load or other CPU-heavy work. Quick discriminator: CDP CPU-throttle the flow locally and inspect the backend's ground truth after a generous wait — if the state is correct, it is calibration; if wrong, it is a real bug.

**Five-limbed argument:**

1. **Claim:** the rename e2e failed on CI because a 5 s `toBeVisible` is shorter than the rename's CPU-bound completion time on a ~3× slower runner, not because the rename is wrong.
2. **Reason:** under 8× CPU throttle the rename's full OPFS + DAG outcome is observably correct, only later than 5 s; the same chain finishes <5 s on fast local hardware.
3. **Universal principle:** a fixed assertion timeout encodes an assumption about hardware speed; an assertion gating on CPU-heavy async completion must budget for the slowest target environment, or it tests the runner's speed, not the feature.
4. **Application:** widen the renamed-row assertion to 15 s (the heaviest mgmt op — it triggers a viewport glTF reload the two delete tests do not); leave the lighter delete assertions (sync banner / BVH delete, no reload) at 5 s, which held on CI.
5. **Conclusion:** the bug is a test-calibration bug, not an import/storage/UI bug; the proof is the throttled run's correct OPFS ground truth, never the un-throttled local pass alone.

**Sibling:** [[H60]] (the rename op this test covers — also a "observe the real backend, not the proxy" entry; here the proxy was the un-throttled local run). [[H58]] (e2e must drive the real affordance) — complementary: H58 says drive the real button, H61 says budget the real latency. The CDP-CPU-throttle technique is the [[base-layer]] Lokāyata gate applied to CI-only failures: reproduce the slow environment, then observe ground truth instead of inferring a logic bug from a pre-operation snapshot.

Provenance: ORIGIN = #126 / P7.14 follow-up, 2026-06-01 — after the #125-vs-#126 catalogue merge resolved CI's long-red `lint`, the e2e job surfaced the NEW `p7.14 (rename)` test failing on CI (both attempts) while green locally; the failure snapshot showed the old row + no banner, inviting a logic-bug hunt. WHY = without this entry the next CI-only e2e failure on a viewport-loading flow gets diagnosed as a feature regression and the budget is spent proving a non-bug; the CDP-throttle repro short-circuits that. HOW = CPU-throttle the flow → dump backend ground truth → if correct, widen the one heavy assertion; reserve the widening for the asset-reload-gated assertion, not blanket every timeout. REF: `tests/e2e/p7.14-my-imports-mgmt.spec.ts:121-123` (the widened assertion + rationale comment), `src/app/asset/importCommon.ts` (`renameImportedAsset` — the correct, completing op), `src/app/AssetsPopover.tsx` (the `tick`-keyed re-enumeration the row waits on), [[feedback-ci-lint-superset]] / [[project-ci-gating-rot]] (the sibling CI-truth lessons). Issue #112 (test), #126 (PR).

---

### H62 — An opaque-only contrast audit composited against the BEST-CASE fixed background silently passes translucent chrome that sits over a VARIABLE backdrop — the green CI gate is a lie for exactly those surfaces

**Span:** any contrast-audit that composites a semi-transparent surface (`bg-*/N`) down to one opaque hex against a single assumed page background, when the surface physically sits over a backdrop the audit does not control — a WebGL canvas, an `<img>`/`<video>`, a user-themed region, a backdrop-filter pane. Instantiated at `src/a11y/contrastMatrix.test.ts` (D-W8-1): the matrix composites every row against `bg #0a0a0a`; R8 (`FloatingViewportToolbar`) and ModeBadge (`bg-2/90`) sit over the GL canvas, whose color is scene-dependent. For them `#0a0a0a` is the BEST case (the backdrop can only get brighter), so their PASS bounded nothing.

**Symptom:** the audit is green and looks total ("every (fg,bg) pair audited"), but a whole class of surfaces was measured against a backdrop they never actually have. No test fails; the gap is invisible until a user loads a bright HDRI/matcap and reports washed-out glyphs (or never reports, and the regression ships).

**Trap (wrong fix / false diagnosis):** (a) trust the green gate and declare contrast "done" — the coverage drift-gate even reinforces the illusion by proving every token class is _enumerated_; (b) when the gap is noticed, over-correct by killing the translucency (make the surface opaque) to force the `#0a0a0a` composite TRUE — sacrificing the aesthetic to fix a problem that may not exist; (c) reach for a per-frame pixel-probe that adapts fg opacity — adding exactly the per-frame readback cost other work fought to remove. All three skip the cheap first move: compute the WORST-case backdrop and observe the real pixels.

**Real fix:** two cheap layers. (1) FORMULA — recomposite the over-canvas surfaces against the worst-case displayable backdrop `#ffffff` (a white blowout) and assert AA there, not only against the best-case page bg. The `/N` alpha does the masking: `bg-2/90` over `#ffffff` composites to `#2d2d2d`, and `fg-dim #a3a3a3` on it holds 5.44:1 ≥ AA. (2) OBSERVATION — drive the real backdrop to the worst case (a DEV-only `__basher_setSceneBackground` seam) and pixel-sample the actually-composited overlay (screenshot → in-page Image→canvas→getImageData; the browser decodes the PNG, no decoder dep), measuring the SURFACE (the only scene-dependent value) and using the opaque fg token (scene-independent, read via getComputedStyle). Formula + observation agreed: predicted 5.44:1, measured 5.47:1. Critically, the e2e carries a FALSIFICATION guard — the bright scene must measurably lighten the surface vs the dark scene — or a no-op seam would make the gate vacuously green (the H62 trap recurring inside its own fix).

**Detection signal:** a surface whose Tailwind bg carries a `/N` alpha AND whose DOM ancestor is a canvas / media element / themed region / backdrop-filter pane, while the contrast row composites it against a fixed token bg. Quick discriminator: ask "what is ACTUALLY painted behind this element, and did the audit composite against that or against an assumption?" If the answer is "an assumption (the page bg)," the PASS is unbounded for that row.

**Five-limbed argument:**

1. **Claim:** R8 + ModeBadge's contrast PASS was an inference, not a bound, because the matrix composited them against `#0a0a0a` while they render over a variable GL canvas.
2. **Reason:** alpha-over compositing means the surface color = `fg.a·token + (1-fg.a)·backdrop`; with the backdrop assumed `#0a0a0a` but actually up to `#ffffff`, the measured ratio differs from the real ratio for any `/N < 100` surface.
3. **Universal principle:** a contrast audit is only valid against the WORST-case backdrop the surface can actually have; compositing against the best case proves nothing about readability.
4. **Application:** recomposite the two over-canvas rows against `#ffffff` (formula) AND pixel-sample them over a real bright scene (observation), with a falsification that the scene change actually moved the surface.
5. **Conclusion:** the surfaces are verified safe (≥5.44:1 over any displayable backdrop) without changing the design — the inferred risk did not survive observation, and a regression now fails CI.

**Sibling:** [[H58]] (e2e must drive the REAL affordance, not a proxy) — H62 extends it to "audit against the REAL backdrop, not an assumed one." Shares the [[base-layer]] Lokāyata gate with [[H61]] (observe ground truth instead of trusting the convenient case: H61 = the fast runner, H62 = the dark scene). The falsification-guard discipline mirrors the `p7.13` material-override falsification test. REF: `src/a11y/contrastMatrix.test.ts` (worst-case-`#ffffff` `it()` block), `tests/e2e/p57-bright-scene-contrast.spec.ts` (real-pixel gate + falsification), `src/viewport/SceneBgTestSeam.tsx` (the DEV-only bright-scene seam), `docs/UI-SPEC.md` §8.4.1 + §1 D-W8-1 (the reworded contract). Issue #57.

---

### H63 — A shared commit chokepoint with asymmetric callers — a later caller wires only PART of the seam's contract — so a feature works through one surface and silently no-ops through its sibling

**Span:** any chokepoint a mutation is _supposed_ to route through, that gains callers at different times. Consolidating the seam guarantees its BODY is shared — NOT that every caller invokes it correctly. Instantiated at the Auto-Key seam (`src/app/animate/autoKeyCommit.ts`): the seam is two functions — `routeAnimatedGrab` (the animated-param GUARD: keys an already-animated param, no-op for an un-animated one) and `autoKeyCommit` (the COMMITTER: also runs `dispatchFirstKeyComposite`, the un-animated "first key"). The NPanel inspector caller invoked BOTH (`setParam` THEN `autoKeyCommit`); the Gizmo caller invoked only `routeAnimatedGrab` + a raw `setParam` — never `autoKeyCommit`. So editing a field recorded an animation; dragging the gizmo recorded nothing.

**Symptom:** a feature has two+ entry surfaces a user reasonably expects to be equivalent (gizmo vs inspector); it works from one and silently does nothing from the other. No error, no failing test (no test drove the broken surface THROUGH the seam). User-visible as "I drag and it snaps right back / nothing records" — the raw write lands but the keyframe the sibling surface would have created never does.

**Trap (wrong fix / false diagnosis):** (a) trust the consolidation — "we lifted it to one chokepoint (D-05), so all callers are covered" — the lift shares the body, not the call sites; (b) diagnose the snap-back as a proxy re-seed / timing bug and add a `setTimeout` or re-seed guard in the gizmo ([[base-layer]] setTimeout-papers-over-ordering anti-pattern — there is no ordering bug); (c) give the broken surface its OWN keyframe path — duplicating the seam, violating the single-path V1/V13 the consolidation existed to enforce.

**Real fix:** make the caller SYMMETRIC — route the broken surface through the SAME chokepoint with the SAME call shape its working sibling uses (inspector = `setParam` THEN `autoKeyCommit` ⇒ gizmo = `setParam` THEN `autoKeyCommit`, one per onObjectChange branch). The new call must be MUTUALLY EXCLUSIVE with the existing animated-path branch so it does not double-fire ([[H36]] anti-double-write): `routeAnimatedGrab` already returned `false`/early-returned on the un-animated fall-through, so the two are disjoint by construction. `autoKeyCommit` self-gates on Auto-Key OFF, so record-off stays byte-identical.

**Detection signal:** a feature has 2+ surfaces that should be equivalent; it works from one and not the other; the working surface's commit handler calls the chokepoint, the broken one calls only a PART of it. Quick discriminator: **grep every caller of the chokepoint and diff their call shape** — a caller that references the GUARD (`routeAnimatedGrab`) but not the COMMITTER (`autoKeyCommit`) is invoking a strict subset = the bug.

**Five-limbed argument:**

1. **Claim:** gizmo drag-to-record created no keyframe because the gizmo caller invoked only `routeAnimatedGrab` (the animated-route guard), never `autoKeyCommit` (the un-animated first-key committer) the inspector caller invokes.
2. **Reason:** `routeAnimatedGrab` returns `false` for an un-animated param and the gizmo stopped at a raw `setParam`; the first-key composite lives in `autoKeyCommit`, which the gizmo never called.
3. **Universal principle:** consolidating a mutation into one chokepoint guarantees the seam's body is shared, NOT that every caller routes through it correctly; a caller invoking a strict subset of the chokepoint's contract is a silent partial wiring.
4. **Application:** add `autoKeyCommit(selectedId, paramPath, value)` after the raw `setParam` in each gizmo onObjectChange branch (translate/rotate/scale, non-GltfChild), mutually exclusive with `routeAnimatedGrab`'s animated early-return.
5. **Conclusion:** drag-to-record now creates the first keyframe exactly like the inspector; the asymmetry is closed and a regression e2e drives the gizmo surface THROUGH the seam.

**Sibling:** [[H36]] (the inverse failure at the SAME seam — double-WRITE; H63 is partial-WRITE; the fix's mutual-exclusivity guard is the proof both concerns coexist at one chokepoint), [[H40]] (boundary-pair: observe both sides → H63 is its mutation-side twin: _wire_ both callers, not just observe both). Shares the consolidation lineage with the `autoKeyCommit` lift (P7.3/D-05, dharana B1.1 line 28). Reinforces dharana **B1.1**.

Provenance: ORIGIN = #141, 2026-06-03 — user reported drag-to-animate with record armed "snaps right back / records nothing"; the inspector path worked, exposing the asymmetry; an e2e (`gizmo-autokey-record.spec.ts`) drove the gizmo through the seam and observed 0 channels (red), then 1 channel / 2 keyframes (green). WHY = without this entry, the next surface added to a shared chokepoint (a future canvas/DAG-editor edit, or the v0.6 unified-mesh-model surfaces that must route every model through the same edit seams) silently wires a subset and the feature works on some surfaces only, invisibly — exactly the failure the unified-model Uniformity gate is meant to prevent. HOW = grep all callers of a chokepoint, diff their call shape vs the canonical caller; a strict-subset caller is the bug; fix by matching the shape + verifying mutual-exclusivity with sibling branches. REF: `src/app/Gizmo.tsx` `onObjectChange` (the three `autoKeyCommit` calls), `src/app/animate/autoKeyCommit.ts` (`routeAnimatedGrab` guard vs `autoKeyCommit` committer), `tests/e2e/gizmo-autokey-record.spec.ts` (the regression gate), [[H36]] [[H40]]. Issue #141, PR #142.

---

### H64 — A capability `isAvailable()` that feature-DETECTS the symbol (not capability-PROBES the call) returns true in a context where the API exists but THROWS, so the fallback chain is never reached and boot dies

**Span:** any `StorageCapability.isAvailable()` (and any capability-selection probe behind `pickStorage` / `core/storage/index.ts`). Instantiated at `src/core/storage/OpfsStorage.ts:isAvailable` (#146): pre-fix it returned `typeof navigator.storage?.getDirectory === 'function'` — a SYMBOL-presence check, never a call.

**Symptom:** boot fails outright with `boot failed: Security error when calling GetDirectory` (surfaced by `App.tsx`). `navigator.storage.getDirectory` EXISTS as a function but CALLING it rejects with a `SecurityError` — opaque origins, sandboxed iframes, blocked site-data, some private-browsing modes. The presence check returns true → `pickStorage` selects `OpfsStorage` → the first real op (`getRoot()` → `getDirectory()`) throws → the IndexedDB→Memory fallback (which would have served) never runs.

**Trap (wrong fix / false green):** "harden" by widening the presence check (also test `navigator.storage`, also test secure-context) — still a presence check, still lies, because presence ≠ permission-to-execute. Or special-case the SecurityError at the call site in `OpfsStorage.getRoot` — patches one op while the WRONG backend stays selected (every other op is still on a dead capability). Or assume localhost is always fine (it is a secure context, yet a sandboxed-iframe/partitioned/private context on localhost STILL throws). The unit env hides it: happy-dom has no `navigator.storage`, so a presence-only check returns false there and "passes" without ever exercising the throwing-but-present shape.

**Real fix:** make the probe test the CAPABILITY, not the symbol — attempt `navigator.storage.getDirectory()` inside try/catch and return the boolean. Keep the presence check ONLY as a fast pre-gate before the call. This mirrors the sibling `IndexedDbStorage.isAvailable` (`src/core/storage/IndexedDbStorage.ts:58-67`), which already opens the DB in try/catch with the comment "private-browsing modes occasionally throw on open" — OPFS had ignored the exact lesson IDB learned. With the real probe, a throwing context reports OPFS unavailable → IDB serves (it survives private/partitioned contexts) → boot succeeds.

**Detection signal:** an `isAvailable()` whose body is a `typeof … === 'function'` / `in` / truthy-property check with NO call into the underlying API; or a capability whose first real method can throw a `SecurityError`/`NotAllowedError`/`QuotaExceededError` that the availability probe cannot have seen. Runtime fingerprint: boot or first-use throws an environment-permission error while a lower-priority fallback capability sits unused.

**Five-limbed argument:**

1. **Claim:** a capability probe at a boundary that can refuse at call time must CALL the operation (try/catch), not just confirm the symbol exists.
2. **Reason:** the symbol's presence is independent of permission to execute it; OPFS `getDirectory` is present-but-throwing in opaque/sandboxed/private contexts, so a presence check mis-selects a dead backend and skips the working fallback.
3. **Universal principle:** feature-detection ≠ capability-detection. When an API can throw on invocation for environmental reasons, only invocation answers "is it available?".
4. **Application:** `OpfsStorage.isAvailable` now `await`s `getDirectory()` in try/catch (presence as pre-gate); `pickStorage` then flows OPFS→IDB→Memory honestly.
5. **Conclusion:** the bug is a probe-semantics bug, not an OPFS bug; the proof is an e2e that overrides `getDirectory` to reject BEFORE boot and observes the app mount anyway (falsified: it fails on the presence-only code, passes on the probe).

**Sibling:** `IndexedDbStorage.isAvailable` is the pre-existing correct instance of this pattern in the SAME module — H64 is a RECURRENCE (OPFS repeated a mistake IDB had already solved), which is exactly the promotion-to-catalogue trigger. Boundary-pair kin of [[H60]] (observe the REAL backend, not the convenient proxy: there MemoryStorage's file map vs OPFS's dir tree; here the unit env's absent `navigator.storage` vs the browser's present-but-throwing one). Shares the [[base-layer]] Grounding check: a presence check is inference ("the symbol is here so it works"); the call is observation.

Provenance: ORIGIN = #146, 2026-06-03 — user opened the dev app and hit `boot failed: Security error when calling GetDirectory`; tracing `pickStorage` showed OPFS selected despite the throwing context because `isAvailable` was presence-only. WHY = without this entry the next capability (Tauri fs in v0.6, or any future storage/permission-gated API) repeats the presence-only probe and "verifies" it in a unit env that can't reproduce the present-but-throwing shape, so the fallback chain silently never engages. HOW = capability-probe (call in try/catch) not feature-detect; falsify with a pre-boot override that makes the call reject. REF: `src/core/storage/OpfsStorage.ts:isAvailable` (the probe), `src/core/storage/IndexedDbStorage.ts:58-67` (the sibling pattern it now mirrors), `src/core/storage/index.ts:pickStorage` (the fallback chain it unblocks), `src/core/storage/storage.test.ts` (#146 probe unit tests: reject/throw/absent→false, resolve→true, pickStorage≠opfs), `tests/e2e/opfs-fallback-boot.spec.ts` (real-symptom: boot survives a rejecting getDirectory — falsified against the old code). Dharana boundary B2. Issue #146.

### H65 — A production code path reaches its data through a DEV-only seam (`import.meta.env.DEV`-gated window getter) → it silently NO-OPS in the production build while every dev test passes

**Span:** any non-React production helper that needs a runtime artifact (a mounted three.js clone, a live render object, a computed scene state) which is currently exposed ONLY through a DEV-gated observation seam (`window.__basher_*` getters guarded by `import.meta.env.DEV`). The seam was built for tests/Lokayata observation, so it is correctly stripped from the production bundle — but if a SHIPPING feature reaches its data through that same getter, the data is `undefined` in prod and the feature silently does nothing. #151 instantiation (the Wave 4 crux): `dispatchApplyTransform`'s glTF-child path needs the mounted SkeletonUtils clone to read the child's resolved geometry + post-override material (`geometryRegistry.get()` returns null for gltf — the bytes live in the loaded asset, not the box/sphere builder). The OBVIOUS reach is `window.__basher_gltf_meshes` / `__basher_gltf_skin` — the existing live-clone accessors. But those are `import.meta.env.DEV`-only: Apply would work in `npm run dev` + every e2e (which run the dev build), then silently no-op for a real director on the production build.

**Symptom:** a feature is green across the entire dev + e2e suite, then does nothing (no error, no toast) in the deployed production build — Apply produces no BakedMesh, the dispatch helper read `undefined.getObjectByName` (optional-chained to null) and returned early. The dev/prod divergence is the tell: e2e cannot catch it because Playwright drives the dev server. A `console.error` would help but the optional-chaining that made the DEV path "safe" is exactly what swallows it.

**Trap (the wrong fix):** reach through the DEV seam anyway "because it already exists and works in my testing" (Chesterton misread — the seam exists for OBSERVATION, its DEV gate is load-bearing, not incidental). A second wrong fix: drop the DEV gate on `__basher_gltf_meshes` so the production path can use it — that ships a debug surface (and its global-window pollution + perf walk) to every user.

**Real fix:** a SEPARATE, production-safe accessor for the production need — `src/app/asset/gltfCloneRegistry.ts`: a module-level `Map<assetRef, Group>` that `GltfAssetR` registers on mount / unregisters on unmount (newest-mount-wins, matching the single-asset-per-ref assumption the DEV seams already make). It MIRRORS the live-clone access pattern of the DEV getters but is ALWAYS ON (not `import.meta.env.DEV`). The capture then reads the RESOLVED, POST-override render state directly off the registered clone (bake-what-renders, no parallel re-resolution — [[H40]]/[[H58]]/[[H59]]).

**Detection signal:** a production (non-test) module imports or references a `window.__basher_*` getter, OR reaches data only available behind one. Ask: "is this seam DEV-gated? Does my feature SHIP? If both, my prod build has `undefined` here." Grep `src/` (excluding tests/`*.test.*`) for `__basher_` references in shipping code paths.

### H66 — A multi-step "create-then-use" composite mints its product with a DETERMINISTIC id and ALWAYS runs the create step — so calling it twice for the same target collides; it silently assumes "first call ever"

**Span:** any dispatch composite that derives a deterministic node/resource id from its target (`${target}_layer`, `${target}_<x>_channel`, `${asset}_group`) and unconditionally runs an `addNode`-style CREATE for that id before the USE step. It works for the FIRST call (the id is free) and breaks on the SECOND call for the SAME target — the create collides (`addNode: id already exists`) OR the underlying Mutator only reuses-vs-rejects on a narrow case (e.g. `addLayer` rejects wrapping-a-wrapper but NEVER reuses an existing wrapper). The bug is latent for as long as the composite is only ever called once per target. #149 instantiation: `dispatchFirstKeyComposite` (`src/app/animate/dispatchMutator.ts`) always ran `addLayer` with `${targetId}_layer`. The single-param diamond / "Animate this" only ever keyed ONE band per target, so it never recurred — until the #149 whole-transform `K` keyed position+rotation+scale in one tick: position (animated → keyframe path, no addLayer) succeeded, rotation (first un-animated → addLayer `n_box_layer`, NEW) succeeded, scale (second un-animated → addLayer `n_box_layer` AGAIN) → collision → scale silently dropped. Observed: `K` keyed `["position","rotation"]`, scale missing.

**Symptom:** the Nth (N≥2) invocation for the same target silently no-ops or drops part of its work, while the 1st invocation and every single-invocation test pass. The composite's own unit suite (which keys ONE param) stays green — the gap only appears when a NEW caller batches multiple invocations against one target, or a user keys a 2nd band on an already-animated object.

**Trap (the wrong fix):** make the new caller key only ONE band (narrow the feature to dodge the collision) — that abandons the locked "whole transform" behavior and leaves the latent bug for the next caller. Second wrong fix: catch-and-ignore the addLayer rejection — the channel then has no layer to attach to.

**Real fix:** the composite DETECTS the existing product and REUSES it instead of always creating. `dispatchFirstKeyComposite` now scans for an `AnimationLayer` already wrapping the target (normalize `inputs.target` like `resolveEvaluatedTransform`); if found, SKIP `addLayer` (empty layer ops/closure/label) and `addChannel` into the existing layer (validated against base); else mint `${target}_layer` as before. One layer per target — the create step becomes create-or-reuse. This fixes the #149 caller AND the latent "key a 2nd band on any object" bug. REF: `src/app/animate/dispatchMutator.ts` (`dispatchFirstKeyComposite` existing-layer detection), `src/app/animate/dispatchMutator.test.ts` (11/11), `tests/e2e/p149-commit.spec.ts` (`K` keys all 3 bands, persists). Cross-ref [[H34]] (the layer-wrap rewire this rides on), [[V31]] (the transient the commit captures). Issue #149.

**Detection signal:** a composite/dispatch helper computes a deterministic id from its target and the FIRST step is an unconditional CREATE. Ask: "what happens if this runs twice for the same target?" If the answer is "collision / silent drop" and a caller exists (or is being added) that batches invocations, it needs create-or-reuse.

**Five-limbed argument:**

1. **Claim:** a shipping feature that reaches its runtime data through a `import.meta.env.DEV`-gated seam silently no-ops in production while passing every dev test.
2. **Reason:** the DEV gate strips the getter from the production bundle (by design — it is an observation seam), so the production code reads `undefined`; optional chaining (added to make the DEV path "safe") converts the missing data into a silent early-return rather than a throw.
3. **Universal principle:** a debug/observation seam and a production data path are different concerns; a production need must be met by a production-safe surface, never by a development-only one.
4. **Application:** `gltfCloneRegistry` is an always-on module-level accessor populated by `GltfAssetR` mount/unmount, mirroring the DEV getters' access pattern without their DEV gate; `dispatchApplyTransform` reads the clone from it.
5. **Conclusion:** the structural defense is one production-safe accessor per production need + a grep gate that no shipping path references a `__basher_*` DEV getter; reaching through the DEV seam is the silent-prod-no-op class.

**Cross-ref:** [[H58]] (the sibling class — an e2e green while the feature is unreachable BY USERS; H65 is the build-time twin: green while unreachable IN PRODUCTION), [[H64]] (capability-probe vs feature-detect — same "the thing exists in my context but not the real one" family), [[H45]]/[[H59]] (the clone boundary the registry serves — read-only, clone-before-mutate), [[V20]] (single-writer — the registry is the one production accessor). Provenance: ORIGIN = #151 Wave 4, 2026-06-04 — the crux brief weighed reaching through `__basher_gltf_meshes` (DEV-only) and recognised it would make Apply a silent prod no-op; the registry was built to avoid it. WHY = without this entry the next production feature needing live three.js data (a future export, a snapshot, a bake variant) reaches through the convenient DEV seam and ships a silent-no-op that no e2e catches. HOW = a production-safe accessor mirroring the DEV seam's access pattern minus the DEV gate; grep that shipping code never references `__basher_*`. REF: `src/app/asset/gltfCloneRegistry.ts` (the production-safe accessor + the comment naming this exact trap), `src/viewport/SceneFromDAG.tsx` GltfAssetR (the populator + the mirrored DEV seams `__basher_gltf_meshes`/`__basher_gltf_skin`), `src/app/animate/dispatchApplyTransform.ts` (the consumer), `tests/e2e/p151-gltf-child-apply.spec.ts` (the real-render proof), dharana boundary `gltfCloneRegistry`. Issue #151.

### H71: Heavy e2e flake at the test-timeout BOUNDARY — undersized budget, not a race

**Symptom:** CI e2e job fails intermittently, always at **~31s** (the 30s test timeout + teardown), with `page.waitForFunction: Test timeout of 30000ms exceeded`. The _failing test varies run-to-run_ — `p151-gltf-child-apply.spec.ts:339` (M8 bake→delete→reload→re-render), `p7.14-my-imports-mgmt.spec.ts:126` (︙rename: copy-all→assetRef-rewrite→glTF-reload→delete-old), `p1-acceptance.spec.ts:411` (drag-drop) — whichever heavy test the loaded runner pushes over the line. Re-running clears it ~half the time (whack-a-mole); it blocks merges.

**Trap:** Read it as a logic race in the specific failing test (it's always the OPFS/reload tests, so "OPFS reload is racy") → add a workaround await, or bump that ONE test's inner `expect` timeout (the rename test already did → 15s) → it still times out at the 30s TEST level because the inner bump wasn't the binding constraint. Whack-a-mole per test never converges because the cause is shared, not local.

**Root cause:** the un-tuned 30s Playwright default (boilerplate since the P0 scaffold `a1083be`, never deliberately chosen) is simply too small for the heaviest three.js+OPFS chains on a constrained CI runner. Local: ~6 cores (`581% cpu`), ~7s/test, **11/11 deterministic, never near 30s** → no race. CI: ~2 vCPU + software-GL (SwiftShader) for three.js → 4-5× slower → ~30s, straddling the limit. A flake that _hovers at the budget boundary_ (rather than failing hard or hanging forever) is the signature of an undersized budget, NOT a logic race (a race fails nondeterministically; a missing-await hangs the full timeout EVERY time on CI).

**Real fix:** raise the budget on CI only, at BOTH timeout layers in `playwright.config.ts` — `timeout: process.env.CI ? 60_000 : 30_000` (test-level: M8/rename, proven to need ~34s) AND `expect: { timeout: process.env.CI ? 15_000 : 5_000 }` (assertion-level: the `expect.poll(opfsDirExists)` after break-refs+deleteOpfsTree in p7.14 delete-referenced — the test-level bump structurally cannot reach it, it has its own 5s poll window). One config covers the whole span (every heavy e2e + every OPFS-mutation poll, present + future); local keeps the tight budgets for fast hang-detection. Calibration, not race-papering: race-papering masks nondeterminism with time; here there is none to mask (proven deterministic — M8/rename pass at 34s, p7.14 delete-referenced completes <5s locally), only budgets mis-sized vs the real work on a software-GL/software-OPFS runner. **The two layers are independent — a test-timeout bump does NOT extend a per-`expect`/`expect.poll` window; calibrate both or the assertion-layer flake surfaces next (it did: fixing the test budget exposed p7.14:190's 5s poll).** **Residual, SEPARATE root cause:** `p1-acceptance.spec.ts:411` drag-drop HANGS the full budget on ~half its first attempts then passes the retry in ~6s — a nondeterministic race (seed/drag), NOT a budget issue (a bigger budget just makes its first-attempt failure slower). Track + fix separately; do not conflate with this entry.

**Detection signal:** failures cap at exactly the test-timeout value (~31s, not an assertion message); the _set_ of failing tests is unstable across runs but always the heaviest ones; the same tests pass deterministically and fast locally (run `--repeat-each=5`, observe none approaches the budget). Distinguisher from a true hang: a hang fails 100% on CI (predicate never true headless) AND would still fail with a bigger budget; a budget-flake passes once given headroom.

**Five-limbed:**

1. **Claim:** raising the CI-only test timeout removes the boundary flake without masking any defect.
2. **Reason:** the tests are proven deterministic and complete in ~7s locally; CI only differs in speed (2 vCPU + software GL), so the predicates DO resolve, just past 30s.
3. **Universal principle:** a test-runner timeout is a budget that must be sized to the work's real wall-clock on the slowest target environment, not left at a boilerplate default.
4. **Application:** the heaviest ingest→bake→reload chains need ~30s on a software-GL 2-vCPU runner; 60s gives ~2× headroom; local keeps 30s for fast hang-detection.
5. **Conclusion:** the boundary flake disappears (budget now exceeds real need) while a genuine hang still fails (it would exceed 60s too) — the fix discriminates, it doesn't blanket-suppress.

**Cross-ref:** [[H16]] — sibling meta-pattern (CI reliability vs wall-clock slack). H16's lesson was "hunt the missing-await, not the speedup"; H71 is the OTHER branch of that fork: once you've PROVEN determinism (no missing await), the remaining boundary flake is budget, and the honest fix is a bigger budget, not another await. The two together: missing-await → fix the await (H16); deterministic-but-slow → fix the budget (H71). Provenance: ORIGIN = #175, 2026-06-05 — investigating the #164/#172 merge-blocking flake; observed 11/11 local determinism + ≥3 different heavy tests straddling 31s across runs → classified as budget, not race. WHY = without this entry the next budget-boundary flake gets mis-diagnosed as a per-test race and whack-a-moled per file (the rename test's 15s inner bump was exactly that dead end). HOW = CI-conditional global timeout; the boundary-cap symptom + cross-run instability + local determinism is the recognition triple. REF: `playwright.config.ts:10` (the CI-conditional timeout), `tests/e2e/p151-gltf-child-apply.spec.ts:339`, `tests/e2e/p7.14-my-imports-mgmt.spec.ts:126`, `tests/e2e/p1-acceptance.spec.ts:411` (the observed heavy tests), CI run `26964301818` (3-test boundary failure evidence). Issue #175.
