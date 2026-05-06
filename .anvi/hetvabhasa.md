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

### H8: Playwright pixel-diff snapshots are platform-suffixed by default

**Symptom:** Local CI run on macOS green; GitHub Actions Ubuntu runner fails test #7 with `A snapshot doesn't exist at .../postfx-beauty-chromium-linux.png, writing actual.`
**Trap:** lower the threshold or skip the test in CI — both violate honesty contract.
**Root cause:** Playwright suffixes snapshot filenames by `${browser}-${platform}` to honor real GPU rasterization differences. A snapshot committed only as `chromium-darwin.png` does not match a Linux runner. This is a feature, not a bug.
**Real fix:** commit a Linux baseline alongside the macOS one. Generate it by (a) running Playwright in the official Docker image locally, OR (b) downloading the failed CI run's artifact (Playwright attaches the actual rendered PNG) and committing that as the baseline. Both baselines live in `tests/e2e/acceptance.spec.ts-snapshots/`.
**Detection signal:** "snapshot doesn't exist" error naming a path with a different platform suffix than what's committed.
**REF:** P0 CI fix (2026-05-05); `tests/e2e/acceptance.spec.ts-snapshots/postfx-beauty-chromium-{darwin,linux}.png`.
