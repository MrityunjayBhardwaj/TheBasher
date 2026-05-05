# Basher — Next Session Prompt (P2: Character + Move)

**Copy this entire file into the new session as your first message.**

---

## Mission

You are taking over autonomous execution of **Basher v0.5 — Phase P2 (Character + Move)**. P0 (Foundation + DAG core) shipped on 2026-05-05 via PR #1; P1 (First node types + Asset Library) shipped same day via PR #3. The DAG spine is now exercised by 15 node types, drag-drop asset import, scene-tree projection with sibling drag-reorder, and a TransformControls gizmo. 88 vitest unit tests + 17 Playwright specs all green.

Your job is to build P2 to acceptance, open a draft PR, run goal-backward self-review, fold top fixes inline, and stop. Do not wait for input that isn't required.

## What's already true after P1

1. **Project root:** `/Users/mrityunjaybhardwaj/Documents/projects/basher/`
2. **Repo:** `git@github.com:MrityunjayBhardwaj/TheBasher.git`. Default branch `main`.
3. **Source of truth:** `THESIS.md` — Part VII, §40 defines P2 acceptance.
4. **Catalogues:** `.anvi/{dharana,hetvabhasa,vyapti,krama}.md` — H1-H10, V1/V2/V4/V5/V6/V8/V9 ALIGNED, V3/V7 NOT YET. K1-K6 cataloged.
5. **Memory:** auto-loads at session start. Note `project_p1_shipped.md` if present (write it from this handoff if not).
6. **Dev port:** 5180 (strictPort).
7. **Quality gates locally:** `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run license-audit && npm run format:check` all green at P1 merge. Re-run before starting P2.
8. **Asset bundles:** three glTF primitives ship under `public/assets/`. The seeder copies them to OPFS at first boot. Library reads OPFS via StorageCapability.

## Read order (do this before any code)

1. `THESIS.md` §40 (P2) + §49 (Time as first-class type) + §53 (perf budgets).
2. `.anvi/dharana.md` — boundaries B1-B5 (B6 was a clean specialization of B2 in P1, no new fatality risk).
3. `.anvi/vyapti.md` — V3 (Time as socket) is **about to flip to ALIGNED**: P2 introduces the first node that consumes Time. Watch lint enforcement.
4. `.anvi/hetvabhasa.md` — H1-H10. H10 (zustand snapshot stale) bit me in P1 E2E; same trap applies to any test or hook reading Time.
5. `.anvi/krama.md` — K2 (op dispatch), K6 (asset-drop chain). K6's atomic-undo pattern is the reference for `character.walkTo` (P2 macro).
6. `src/core/dag/store.ts` — `dispatchAtomic` is exercised by P1; reuse for any P2 multi-op user action.
7. `src/nodes/registerAll.ts` — where new node types must register at boot.
8. `src/viewport/SceneFromDAG.tsx` — recursive `MeshChild` dispatcher; new mesh-kinds add a switch case.

## Locked decisions (do NOT relitigate)

- All P0+P1 disciplines bind: V1 (Op-only mutation), V2 (pure node bit-exact + lint), V3 (time as socket — about to be enforced for the first time), V4 (versioned + migration), V5 (permissive licenses), V6 (capability interfaces), V8 (file-rooted: no dispatch in `src/viewport/` files; imports from `src/app/` that dispatch are allowed), V9 (materials = data, not code).
- New node types are `pure: true` unless they CANNOT be (and then declare `pure: false` and document why).
- Animation evaluators read `Time` from a typed input socket only. Never `useFrame`. Never `Date.now`. The lint rule already covers globals; reviewers must reject `useFrame` reads inside evaluators.
- Permissive licenses only — `npm run license-audit` is a CI gate.
- recast-navigation-js is the navmesh implementation (THESIS.md §33). MIT-licensed; verify before adding.
- Multi-character supported from day one; no single-character shortcuts.

## P2 Goal (verbatim from THESIS.md §40)

> Node types: `Character`, `AnimationClip`, `Skeleton`, `PosedSkeleton`, `Navmesh`, `WalkPath`, `LocomotionState`. `Time` input flows through animation evaluation. Click-to-move: Op chain creates `WalkPath` node, connects to character's `LocomotionState`. recast-navigation-js powers `Navmesh` evaluator. Multi-character supported.

## P2 Acceptance Tests (5 — derive from THESIS §40 + the discipline contract)

Suggested derivation (refine during planning):

1. **Time enters as a socket; scrubbing replays animations bit-exact.** Set `t=2.5s`, evaluate the scene; set `t=2.5s` again on a fresh evaluator cache; output is byte-identical. Twice-eval determinism harness extended to time-consuming nodes.
2. **Click-to-move emits a Character → WalkPath chain via `dispatchAtomic`.** Click on the navmesh-occupied ground; `addNode(WalkPath) → connect(WalkPath → LocomotionState)` (inside `character.walkTo` macro). One Cmd+Z reverts.
3. **Navmesh constrains paths.** A WalkPath whose end-point lies inside an obstacle is clamped to the navmesh boundary; the resulting path stays on traversable area at all sample points.
4. **Multi-character isolation.** Two `Character` nodes with separate `LocomotionState` produce two independent paths; setParam on character A's locomotion does not invalidate character B's cache.
5. **Reload restores poses + paths bit-exact.** A scene with a moving character at `t=2s` saves; reload at the same time produces identical PosedSkeleton output through the migration runner (V4).

## Execution Protocol

### Wave A — Character + skeleton + animation nodes (THESIS.md §40, §8)

- `src/nodes/Character.ts` — params: name, navmesh ref, locomotion ref. Output type `Character` (new socket type — extend `SocketTypeName` in `src/core/dag/types.ts`).
- `src/nodes/Skeleton.ts` — params: bone hierarchy spec. Output: `Skeleton`.
- `src/nodes/PosedSkeleton.ts` — input: skeleton, time. Output: `PosedSkeleton`. Pure given inputs.
- `src/nodes/AnimationClip.ts` — params: clip name, duration. Output: `AnimationClip`. Input: time (Time socket, V3 first-use!).
- `src/nodes/Navmesh.ts` — params: source mesh ref. Output: `Navmesh`. Cost: `'expensive'` (recast computes; consider worker offload at THESIS §53 budget).
- `src/nodes/WalkPath.ts` — params: from, to, sample count. Input: navmesh. Output: `WalkPath` (list of vec3).
- `src/nodes/LocomotionState.ts` — input: character, walkpath, time. Output: PosedSkeleton + position. The integrating node; ties everything together.
- All zod schemas, twice-eval determinism for pure nodes (PosedSkeleton, AnimationClip, WalkPath), register in `registerAll.ts`.

### Wave B — Time injection (THESIS.md §49)

- Extend `EvalCtx.time` usage: viewport injects current scrub time. Currently fixed to `{frame:0, seconds:0, normalized:0}` — needs a clock source.
- `src/app/stores/timeStore.ts` — current scrub time, play/pause state. Tick via rAF, dispatched to store, **NEVER inside an evaluator**.
- `SceneFromDAG.tsx` reads timeStore and passes through `evaluate(state, target, { ctx: { time } })`. Cache key already includes time for impure nodes; pure nodes ignore (cache hit unless params change).

### Wave C — Click-to-move + Navmesh integration

- Add `recast-navigation-js` to deps (verify MIT). `npm run license-audit` must pass.
- `src/integrations/recast/` — capability seam (V6) so future Tauri build can swap the bridge if needed. Probably overkill in P2; native binding is fine. Decide during planning.
- Click-on-viewport emits `character.walkTo(characterId, worldPoint)` macro → adds `WalkPath` node + connects to `LocomotionState`. dispatchAtomic.
- Pointer-event-on-Canvas vs gizmo-active: the gizmo grabs pointer events when a Transform is selected. Define precedence (probably gizmo wins; click-to-move active only when no gizmo in flight).

### Wave D — Multi-character coordination

- Two Character nodes evaluate independently. Verify via twice-eval that LocomotionState A's hash doesn't depend on Character B's params (cache-isolation invariant).
- Single-writer queue (THESIS §25): mid-walk agent ops are P2.5; for P2, two characters can have walkTos applied simultaneously without races (each is a separate dispatchAtomic).

### Wave E — Tests + CI

- Vitest twice-eval for every new pure node.
- Vitest determinism for AnimationClip across time samples (same params + same time → same output).
- Playwright E2E for all 5 P2 acceptance tests.
- Update CI workflow if new dirs need lint coverage (`src/integrations/recast/` if added).

### Wave F — Catalogue + close

- Flip V3 (Time-as-socket) to ALIGNED — P2's PosedSkeleton + AnimationClip + LocomotionState exercise it. Add lint rule for `useFrame`/`Date.now`/`performance.now` inside evaluators (extends V2's existing rule).
- Add new boundaries to dharana if any surface (e.g. recast bridge if it's a separate process).
- Catalog any patterns hit during P2 to hetvabhasa.
- README + CHANGELOG entries.
- Open draft PR; run goal-backward self-review; fold 🔴 fixes inline before marking ready.

## Honesty Contract (do NOT violate)

- **Never** mark a `pure: true` node as such if it isn't. AnimationClip is the boundary case: it consumes Time but is otherwise pure (same time + same params → same pose). Per THESIS §49 the cache key includes time for impure nodes; for time-consuming pure nodes, time is part of `inputHashes` via the Time socket producer. Verify this works before marking AnimationClip pure.
- **Never** read `useFrame` or any clock inside an evaluator. Time enters via a Time socket only.
- **Never** copy GPL code under any circumstances.
- **Never** push to main without CI green.
- **Never** ship without running goal-backward self-review (CLAUDE.md AnviDev §5).
- **Always** run twice-eval test for every pure node, including time-aware ones (sample at multiple t and verify per-time bit-exactness).
- **Always** use `dispatchAtomic` when a user-perceived action is multiple ops.
- **Always** record provenance in `.anvi/dharana.md` for every new boundary.
- **Always** generate Linux + macOS Playwright baselines when adding screenshot tests (H8).

## Decision Defaults (when thesis is silent)

- Navmesh worker offload: try in-band first (recast is fast); if the budget blows on a 1k-tri mesh, move to worker. Lokayata.
- Click-to-move precedence vs gizmo: gizmo wins while in flight (it has pointer capture).
- AnimationClip purity: pure if (params + time + skeleton input) → output is deterministic. Keep impure if any animation library you adopt secretly reads a global.
- Bundle size at risk: lazy-load recast WASM before sacrificing a feature.

## Hard-Stop Triggers (escalate to user)

- Security vulnerability discovered.
- License violation discovered (recast deps must all be MIT/Apache/BSD).
- Blocked >1 day on a single problem.
- Need to amend THESIS.md (architectural change).
- Acceptance test failing with no clear path to pass.

## Kill Phrase

If you ever see the user message **"stop, rethink"** — freeze immediately. Do not commit. Do not push. Output: (1) what you were about to do, (2) what's already committed, (3) what's uncommitted/stage-revertable, (4) wait.

## When P2 Is Done

1. All 5 acceptance tests green in CI on both darwin and Linux.
2. Goal-backward self-review run; 🔴 fixes folded inline.
3. Draft PR opened, then marked Ready for Review after self-review pass.
4. End-of-phase summary in conversation:
   - What shipped (mapped to thesis sections).
   - What cut from P2 scope (deferred with justification).
   - What surprised (anything that took >1.5x estimate or revealed a thesis gap).
   - Risk register updates (new B<N> boundaries observed).
   - Confidence for P2.5 (high/med/low and why).
5. Update `NEXT_SESSION.md` for P2.5 (AI Agent on the DAG).
6. **STOP.** Do not start P2.5.

---

**Begin.** Read the thesis. Then build.
