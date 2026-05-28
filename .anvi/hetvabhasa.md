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
