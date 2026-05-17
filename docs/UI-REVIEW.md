# UI-REVIEW — P6 Retroactive 6-Pillar Audit (W10)

**Date:** 2026-05-15
**Auditor:** anvi-ui-review (W10)
**Method:** Source-grounded audit of every realized P6 surface against the 6 pillars
(Layout, Typography, Color, Spacing, Interaction, Accessibility). Scores 1–5
(5 = exemplary, 3 = acceptable, 1 = broken). Findings carry a proposed verdict:
`CODE-FIX` (default) / `SPEC-AMEND` (spec clause provably wrong) /
`DEFER` (new-capability-only + target wave).

**Audit context note:** the prior audit's in-memory scores were lost when the
socket dropped before the Write. This report was regenerated from a fresh
source read of all P6 surfaces (Layout, ProjectTabs, TopToolbar, ToolRail,
LeftSidebar, MenuBar, NPanel, FloatingViewportToolbar, ModeBadge,
ComfyStatusIndicator, TimelineDrawer, TimelineCanvas, timelineCanvasGeometry,
AddMenu, plus the UI-SPEC contract and the §B11 dharana ledger). No scores are
inferred from memory; every score traces to a file read this session.

**Severity legend:** BLOCK (must fix before P6 closes — D-W10-1 fixes all
inline anyway), FLAG (real defect, non-gating), cosmetic (polish).

---

## 1. Per-Surface × 6-Pillar Scorecard

Pillars: L=Layout, T=Typography, C=Color, S=Spacing, I=Interaction, A=Accessibility.

| Surface (Region) | L | T | C | S | I | A | Notes |
|---|---|---|---|---|---|---|---|
| **R1 ProjectTabs** | 4 | 4 | 4 | 4 | 4 | 4 | tablist/tab/aria-selected correct; dirty-dot `aria-hidden` but state mirrored in tablist aria-label; close-× is `fg-mute` (Rule A exempt) |
| **R2 MenuBar** | 4 | 4 | 4 | 4 | 4 | 3 | `<details>`-free hand popover; dismiss-on-blur + Esc wired; `role="menuitem"`+`aria-haspopup`; F-2 submenu-aria gap (see carry item) |
| **R3 TopToolbar** | 4 | 4 | 4 | 4 | 4 | 4 | three-zone flex, mode pill centered; zoom button now a **live readout** (UIR c-1 `afd88b6` — real camera-zoom signal, no longer a dead placeholder; stays `disabled` since §5.3 specifies a zoom % *display*, not a zoom-input dropdown — SC 1.4.3 still exempt as a non-interactive status display); role="toolbar"+aria-orientation correct |
| **R4 ToolRail** | 4 | 4 | 4 | 3 | 4 | 4 | collapsed width is 32px not 0 (F-3, spec-acknowledged); disabled actions `fg-mute`+cursor-not-allowed; toolbar/vertical aria correct |
| **R5 LeftSidebar** | 4 | 4 | 4 | 4 | 4 | 4 | tablist+tab+aria-selected; both bodies stay mounted (V8 spirit); collapsed strip keeps toggle reachable |
| **R6 Viewport** | 5 | n/a | n/a | 5 | 4 | 4 | `<main id=viewport tabIndex=-1 role=main>` skip-link target; aria-label static "3D viewport main content" (F-5: not selection-debounced per §8.3) |
| **R7 Inspector (NPanel)** | 4 | 4 | 4 | 4 | 4 | 3 | controlled-value contract solid; section chevrons SC 1.4.3 exempt; Vec3 X/Y/Z label `fg/50` large-only exempt (carry-adjacent) |
| **R8 FloatingViewportToolbar** | 4 | 4 | 3 | 4 | 4 | 3 | self-gates director; full aria; **bright-scene contrast not caught** (D-W8-1 carry); snap `<input>` keyboard-OK |
| **R9 TimelineDock (Drawer)** | 4 | 4 | 4 | 4 | 4 | 4 | tablist/tab tabs; frame/fps readout in header; toolbar buttons disabled-state mirrors selection |
| **R9 TimelineCanvas** | ✓ | ✓ | ✓ | ✓ | 4 | 3 | L/T/C/S = **PIXEL-OBSERVED PASS (user A2 manual scrub, 2026-05-17)** — 6ch×24kf seed, playhead swept repeatedly; diamonds intact under/behind the line, no erase trail/smear (strip-restore correct, `PLAYHEAD_STRIP_HALF_WIDTH_PX` adequate). PROVISIONAL lifted. I/S-of-interaction OK; `role="img"`+aria-label channel count; per-row DOM gone (e2e via dev seam) |
| **ModeBadge (R6 overlay)** | 4 | 4 | 3 | 4 | 4 | 4 | aria-live polite on label span; hidden in director; **bright-scene contrast not caught** (D-W8-1 carry) |
| **ComfyStatusIndicator (R1 edge)** | 4 | 4 | 3 | 4 | 4 | 3 | idle/stub state SC 1.4.3 exempt; `●` aria-hidden, label text present; no aria-live on state change (F-7) |
| **AddMenu (R6 ctx + R3 +)** | 4 | 4 | 3 | 4 | 4 | 2 | both entry points wired via addMenuStore; **group chevron `▸` `text-fg/40`, no aria-expanded/aria-hidden** (W8 submenu-aria carry) |
| **D-UX forms — edit mode** | 5 | 4 | 4 | 4 | 4 | 4 | full chrome canonical layout; grid template stable; Canvas-mounts-once honored (V11) |
| **D-UX forms — director mode** | 5 | n/a | 4 | 5 | 4 | 4 | R1/R2/R3/R4/R5/R7/R9 `display:none` (removed from tab order); R8+ModeBadge self-hide; skip-link still present; Esc returns |

`P` = PROVISIONAL (pixel-unobserved). `n/a` = pillar not applicable to that surface.

---

## 2. Findings (each with proposed verdict)

### BLOCK — none.
No surface is broken to a merge-gating degree. Acceptance criteria §11 #1–#17
are all satisfiable from the read code (region testids present, mode type
repurposed, Esc-to-edit, Canvas-mounts-once, director chrome-hide, dual AddMenu
entry, contrast gate green with documented exemptions).

### FLAG findings

- **F-1 — AddMenu group chevron lacks ARIA state.**
  `AddMenu.tsx:141` renders `<span className="font-mono text-[10px] text-fg/40">▸</span>`
  as a group/submenu affordance with neither `aria-hidden` (if decorative) nor
  `aria-expanded`/`aria-haspopup` (if it gates a submenu). A screen reader user
  cannot tell the group is expandable. **Verdict: CODE-FIX** — add `aria-hidden`
  if the row's expansion state is conveyed elsewhere, else wire
  `aria-expanded` on the row button. (This IS the named W8 submenu-aria carry
  item; see §4.)

- **F-2 — MenuBar nested submenu aria depth.**
  `MenuBar.tsx` top-level menus carry `role="menuitem"`+`aria-haspopup="menu"`+
  `aria-expanded`, but nested/grouped items inside the 260px panel are not
  audited for full `menu`/`menuitem` tree semantics (W8 known limitation,
  carried). **Verdict: CODE-FIX** (target: fold into W10 fix run per D-W10-1).

- **F-3 — ToolRail "collapse" never reaches 0 width.**
  `Layout.tsx:61` `toolRailWidth = isDirector ? '0' : collapsed ? '32px' : '32px'`
  — collapsed and expanded are both 32px; spec §5.4 promises `›` collapses to
  0 width. The code comments acknowledge this is deferred ("when we ship a
  collapse-to-0 affordance later"). The affordance advertises a state it does
  not deliver. **Verdict: SPEC-AMEND** — proof the spec clause is wrong as
  written: §5.4/§3.2 says "`›` collapses to 0 width" but the realized Spline
  pattern keeps the rail a persistent 32px icon strip with only the expand
  chevron when collapsed (matching R5's 28px-strip pattern in `Layout.tsx:65`);
  a true 0-width rail would orphan the expand control. Amend §5.4 to
  "collapses to a 32px chevron-only strip" to match the consistent
  collapsed-strip pattern used by R4 and R5.

- **F-4 — Viewport aria-label is static, not selection-debounced.**
  `Layout.tsx:153` `aria-label="3D viewport main content"`. Spec §8.3 requires
  R6 = "3D viewport — {selection summary}", debounced 200ms, as "the
  screen-reader's only handle on what the user is doing in 3D." The realized
  label is constant and carries no selection summary. **Verdict: CODE-FIX**
  (target: W10 fix run — wire selection-store-derived debounced aria-label).

- **F-5 — ComfyStatusIndicator state change is not announced.**
  `ComfyStatusIndicator.tsx:151-165` — state flips http/stub/probing via color
  + text but no `aria-live`. A non-visual user gets no notification when the AI
  bridge goes live/offline. Spec §8.4.4 exempts the *idle* visual contrast but
  does not exempt the missing announcement. **Verdict: CODE-FIX**.

- **F-6 — ModeBadge / R8 bright-scene readability.**
  `ModeBadge.tsx:88` (`bg-bg-2/90`) and `FloatingViewportToolbar.tsx:184`
  (`bg-bg-2/90`) physically composite over the GL canvas, not over `bg #0a0a0a`.
  The D-W8-1 audit method explicitly composites against `bg #0a0a0a` only;
  bright-scene contrast is not caught. **Verdict: DEFER** — new-capability
  (per-scene luminance-adaptive chrome tint); target: revisit on user-reported
  unreadability (D-W8-1 trade-off, carried as named item in §4).

### Cosmetic findings

- **c-1 — TopToolbar zoom button is a permanent disabled placeholder.**
  `TopToolbar.tsx:189-198` "100% ▾" disabled, advertised. SC 1.4.3 exempts the
  contrast; cosmetically it advertises an affordance that never works in v0.5.
  **Verdict: SPEC-AMEND** — §5.3 anatomy lists zoom%; proof clause is
  aspirational: no zoom-control plumbing exists anywhere in `viewportStore` or
  `editorStore`. Amend §5.3 to mark zoom% explicitly "disabled placeholder
  until zoom plumbing lands" (already the code's own comment).

- **c-2 — ProjectTabs close-tab = delete-from-storage.**
  `ProjectTabs.tsx:102-127` window.confirm guards it, but "close tab" deleting
  the project from disk is a surprising mental model. **Verdict: SPEC-AMEND** —
  the comment at `:104-106` states "v0.5 simpler scope — close-tab IS delete";
  spec §5.1 does not document this destructive semantic. Amend §5.1 to state
  close-tab is destructive in v0.5.

- **c-3 — TimelineCanvas `data-rendered-keyframes={0}` literal in JSX.**
  `TimelineCanvas.tsx:629` renders the attr as literal `0`; the real value is
  written imperatively by the effect at `:399`. Harmless (effect overwrites
  pre-paint) but a static reader of the DOM at SSR/first-commit sees `0`.
  **Verdict: CODE-FIX** (cosmetic; initialize from the same cull as the effect).

---

## 3. TimelineCanvas — PROVISIONAL pillar declaration

Per D-W10-3 / H30 / D-W9-4 / D-W9-8, TimelineCanvas is audited via its
mirror-attr contract + the FLAG-2 manual scrub, NEVER `toHaveScreenshot`.

- **Pillars 1–4 (Layout, Typography, Color, Spacing): `PIXEL-OBSERVED PASS`
  — PROVISIONAL lifted 2026-05-17 by the user A2 manual scrub.** Originally
  withheld because the mirror attrs (`data-rendered-keyframes`,
  `data-channel-count`, `data-playhead-px`, `data-frame`) and PALETTE constants
  are *code-derived*, not pixel observation, and a 2D-canvas raster cannot be
  visually graded without a real browser scrub. **Resolution:** a 6ch×24kf
  scene was seeded and the playhead swept repeatedly; diamonds rendered
  correctly and remained fully intact under and behind the moving playhead —
  no erase trail, smear, or clipped edges. The code-by-construction confidence
  is now confirmed by direct observation. The four pillars pass; the FLAG-2
  carry item (CI-1) is RESOLVED.
- **Pillar 5 (Interaction): scored 4.** rAF playhead loop reads stores fresh
  via `getState()` every tick (no stale closure), idle-guard early-outs while
  staying registered (Clock.tsx precedent), strip-restore before stroke,
  playhead drawn last, cancelAnimationFrame on unmount. Dispatches zero Ops
  (pure projection, V8). One residual: the idle-guard correctness
  (count-constant ≠ pixels-restored) is exactly FLAG-2 — verifiable only by
  manual scrub.
- **Pillar 6 (Accessibility): scored 3.** `role="img"` +
  `aria-label="Animation dopesheet — N channels"` is honest and present, and
  per-row DOM is intentionally gone (e2e routes through the
  `__basher_timeline_selection` dev seam). It loses 2 points because a
  canvas-only dopesheet has no keyboard-navigable per-keyframe affordance for
  screen-reader users; keyframe ops are reachable only via the R9 toolbar
  buttons + global shortcuts, which is acceptable for v0.5 but not exemplary.

---

## 4. Mandatory Carry-Item Verdicts (5 named)

| # | Carry item | Source | Verdict | Rationale |
|---|---|---|---|---|
| **CI-1** | **FLAG-2 — count-constant ≠ pixels-restored** | W9 known automated-observation gap (§10 W9 row; TimelineCanvas.tsx:46-54) | **RESOLVED — PASS-manual (user A2 scrub, 2026-05-17)** | The observation W9 structurally could not automate is now performed: 6ch×24kf seed, playhead swept repeatedly across the static layer; diamonds remained fully intact under and behind the line — no 1px erase trail, no smear, no clipped edges. Strip-restore (1:1 backing-px drawImage from the offscreen twin) is correct by direct observation, not just by construction; `PLAYHEAD_STRIP_HALF_WIDTH_PX` is adequate. No CODE-FIX needed. The last open observation gap in P6 is closed. |
| **CI-2** | **D-W9-7 — V8 zero-Ops on the canvas projection** | D-W9-7; TimelineCanvas.tsx:56-60 | **PASS (no fix)** | Verified by source read: TimelineCanvas imports no dispatcher, calls no `dispatchAtomic`/`dispatch`/`setParam`. It reads `useDagStore`/`useTimelineSelection`/`useTimeStore`/`useViewportStore` read-only. The invariant holds. Verdict: confirmed-compliant, no action. |
| **CI-3** | **D-W8-1 — R8 + ModeBadge bright-scene readability** | D-W8-1 trade-off (§8.4.1 known limitation) | **DEFER → user-reported unreadability** | The opaque-only composite-vs-`bg #0a0a0a` audit is mechanically sound and fully automated; the *trade-off* (R8/ModeBadge sit over the variable GL canvas) is a documented, accepted v0.5 limitation. Fixing requires a new capability (scene-luminance-adaptive chrome tint), not a token tweak. Target: revisit only on user-reported unreadability. |
| **CI-4** | **W8 submenu-aria — AddMenu / MenuBar nested menu semantics** | W8 known limitation (carried); AddMenu.tsx:141, MenuBar.tsx | **CODE-FIX (W10 fix run)** | This is the only carry item that is a genuine code defect reachable now. AddMenu group chevron `▸` has no `aria-hidden`/`aria-expanded`; nested MenuBar items lack full `menu`/`menuitem` tree depth. Not new-capability — a finite ARIA-attribute addition. Fix inline per D-W10-1. (= F-1 + F-2.) |
| **CI-5** | **D-W7-1 — ortho/persp projection toggle dropped from R8** | D-W7-1 amendment ledger (§5.7) | **SPEC-AMEND (already amended) — confirm + close** | Proof the original spec clause is wrong: §5.7's original `⊙ ◉ persp ortho` toggle assumed a director use case Basher's procedural-rendering domain has never required; the THREE camera-swap + OrbitControls-rebind cost was non-trivial. R8 source (`FloatingViewportToolbar.tsx`) ships 6+3+2 controls, no projection toggle — code matches the W7 amendment. The amendment ledger is already in §5.7; verdict is to **confirm the SPEC-AMEND is complete and close the carry item** (no code action — deferred only if a real director use case demands ortho). |

---

## 5. §B11 P6 Consolidation — Final Per-Pair Distinctness Verdict

Re-derived from the *assembled UI audited this session* (source read of all
surfaces), not copied from per-wave dharana memory. B11 HOW = (1) read each
surface, (2) cross-check the spec's distinctness claim, (3) record
no-shift / restored / overridden / advanced.

| Distinctness pair | Re-derived verdict (from this session's read) | Evidence |
|---|---|---|
| **NPanel (R7) vs deleted Inspector.tsx** (D-UX-8) | **RESTORED — confirmed stable.** NPanel is the sole inspector; `Inspector.tsx` absent from `src/app/` listing. NPanel header comment + §5.8 agree. No re-divergence: NPanel owns the property editor, R8 owns viewport-state toggles, R3 owns mode/space. Conjunction holds. | Layout.tsx:204 mounts `<NPanel/>` in `inspector` slot; no Inspector.tsx in tree |
| **R4 ToolRail Sel/Mv/Rot/Scl vs R8 Sel/Mv/Rot/Scl** | **NO SHIFT — distinct by location, unified by dispatch.** R4 = persistent left-edge column; R8 = contextual bottom-of-viewport overlay. Both route through `editorStore.setActiveTool` (ToolRail.tsx:172, FloatingViewportToolbar.tsx:193). Spline pattern keeps both. V19 single-writer honored. | ToolRail.tsx:119+172; FloatingViewportToolbar.tsx:163+193 |
| **R3 TopToolbar (SpaceGroup) vs deleted TransformToolbar** | **ADVANCED — pre-scheduled split executed.** TransformToolbar.tsx absent; SpaceGroup inlined into TopToolbar.tsx:127-148; gizmo/grid/shading/snap migrated to R8. Asymmetric `gizmoStore.mode` direct-writer eliminated. | TopToolbar.tsx:124-148; no TransformToolbar.tsx in tree |
| **Dopesheet vs TimelineCanvas** (D-W9-2) | **ADVANCED — render-primitive swap confirmed.** `Dopesheet.tsx` absent from `src/timeline/`; `TimelineCanvas.tsx` mounted at TimelineDrawer.tsx:87. Same `duration` prop contract, same drawer slot, same `'dopesheet'` tab id/label retained. Not a new surface. | TimelineDrawer.tsx:42+87; no Dopesheet.tsx in `src/timeline/` |
| **TimelineCanvas (Dopesheet tab) vs CurveEditor (Curve tab)** (D-UX-2) | **NO SHIFT — disjoint domains preserved.** TimelineCanvas = canvas-2D diamonds, ALL channels, seconds-space rAF playhead. CurveEditor = SVG curve, ONE channel, untouched by W9. Different primitive, different domain, different playhead impl. Conjunction intact. | TimelineDrawer.tsx:87 vs :95; CurveEditor.tsx git-untouched per §9 |
| **ProjectTabs (R1) vs ProjectsMenu** | **NO SHIFT — distinct surfaces, shared read seam.** R1 = always-visible switch strip; ProjectsMenu = CRUD popover. Share only `listAllProjectMetadata()`. | ProjectTabs.tsx:18-21 (header note + code) |

**B11 P6 consolidation verdict:** all six distinctness conjunctions hold under
the assembled UI. Two pairs ADVANCED (executed pre-scheduled swaps: Dopesheet→
Canvas, TransformToolbar→split), one RESTORED (Inspector→NPanel), three NO
SHIFT. **No stale distinctness claim survives into P6 close; no organizational
fatality (no 3+ error cluster, no invariant spanning 3+ modules, no lifecycle
crossing 3+ boundaries) at the UI-SPEC↔source boundary.**

---

## 6. Closing Scope Summary

### By severity
- **BLOCK: 0**
- **FLAG: 6** (F-1 AddMenu chevron aria, F-2 MenuBar submenu aria, F-3 ToolRail
  collapse-to-0, F-4 viewport aria-label not selection-bound, F-5 ComfyStatus
  no aria-live, F-6 bright-scene contrast)
- **cosmetic: 3** (c-1 zoom placeholder, c-2 close=delete, c-3 canvas attr
  literal)
- **Total findings: 9** (+ 5 named carry items, 2 of which equal F-1/F-2/F-6 and
  D-W7-1/CI-2, counted once below to avoid double-count)

### By proposed verdict (as audited)
- **CODE-FIX: 5** — F-1 (CI-4), F-2 (CI-4), F-4, F-5, c-3
- **SPEC-AMEND: 4** — F-3, c-1, c-2, CI-5
- **DEFER: 2** — F-6 / CI-3, CI-1
- **PASS / no-action: 1** — CI-2

### By TERMINAL verdict (post-A4 user ratification + c-1/c-2 disposition)

The user **rejected all 3 SPEC-AMEND proposals** (F-3, c-1, c-2 → forced
CODE-FIX) and dispositioned the two mini-checkpoint items (**c-1 = BUILD
IN W10**, **c-2 = DEFER → v0.6**). Final terminal counts:

- **CODE-FIX (landed): 6** — F-1+F-2 (`81f0c36`), F-3 (`956b48f`),
  F-4 (`6a8fa8d`), F-5 (`d9fd3fd`), c-3 (`5da9651`), **c-1 (`afd88b6`,
  built W10 per user disposition)**
- **DEFER: 2** — F-6 / CI-3 (→ user-reported unreadability),
  **c-2 (→ v0.6, roadmapped §7)**
- **RESOLVED — PASS-manual: 1** — **CI-1 / FLAG-2** (user A2 scrub
  2026-05-17: diamonds survive playhead passage, no erase trail — the
  last open observation gap in P6, now closed)
- **PASS / no-action: 1** — CI-2 (D-W9-7 V8 zero-Ops confirmed compliant)
- **SPEC-AMEND confirmed-closed (W7, no W10 action): 1** — CI-5 (D-W7-1
  ortho — §5.7 amendment already shipped W7, verified + closed)
- **SPEC-AMEND newly added in W10: 0** — ZERO §1 divergence-ledger entries;
  the spec stayed the untouched forward contract.

**Zero findings OPEN.** Every F-1..F-6, c-1..c-3, CI-1..CI-5 carries a
terminal verdict + (SHA | DEFER-target | PASS-stated): see §7 per-finding
ledger. Per D-W10-1, all CODE-FIX landed inline before P6 closes; the 3
DEFER items are genuinely new-capability/observation-gated (each with an
explicit target); the 1 PASS needs no action; CI-5 is confirmed-closed.

### Surfaces that could NOT be fully assessed
- **TimelineCanvas pillars 1–4 (Layout/Typography/Color/Spacing):** withheld as
  `PROVISIONAL — pixel-unobserved, pending user A2 manual scrub`. Pillars 5–6
  scored normally (4 / 3). This is the only deliberate non-assessment, by
  mandate (D-W10-3 / H30 — never `toHaveScreenshot` a canvas).
- All other P6 surfaces were fully source-grounded and scored.

---

## 7. Wave B/C Resolution Ledger (2026-05-16)

**A4 user scope checkpoint outcome:** the user ratified all verdicts and
**rejected all 3 SPEC-AMEND proposals (F-3, c-1, c-2), forcing them to
CODE-FIX.** UI-SPEC §1 stays the untouched contract — **zero §1
divergence-ledger entries added in W10.** The spec is honored literally;
the code was bent to the spec, never the reverse.

### Per-finding terminal disposition

| Finding | Verdict (post-A4) | Resolution |
|---|---|---|
| **F-1** AddMenu chevron aria (CI-4) | CODE-FIX | `81f0c36` — ▸ `aria-hidden`, group `role=menuitem`+`aria-haspopup`+`aria-expanded`, `ul role=menu`, submenu `role=menu`, items `role=menuitem` |
| **F-2** MenuBar submenu aria (CI-4) | CODE-FIX | `81f0c36` — panel `role=menu`, Item `role=menuitem`, Submenu `role=menuitem`+`aria-haspopup`+`aria-expanded`, ▸ `aria-hidden` |
| **F-3** ToolRail collapse never reaches 0 | CODE-FIX *(SPEC-AMEND rejected by user → forced CODE-FIX)* | `956b48f` — Layout `toolRailWidth` collapsed → `'0'`; collapsed ToolRail is `w-0` with the re-expand control as an absolutely-positioned edge tab escaping via the slot's `overflow:visible` (resolves the auditor's "0-width orphans the expand control" concern in code, not spec) |
| **F-4** viewport aria-label static | CODE-FIX | `6a8fa8d` — `<main>` aria-label = `3D viewport — ${useSelectionSummary()}` (new shared hook; Viewport's aria-live span consumes the same source — never diverges) |
| **F-5** ComfyStatusIndicator no aria-live | CODE-FIX | `d9fd3fd` — `aria-live=polite`+`aria-atomic`+stateful `aria-label` on the indicator button |
| **c-1** zoom-% readout never updates | CODE-FIX (built W10) *(SPEC-AMEND rejected → forced CODE-FIX)* | **`afd88b6` — BUILT.** Mini-checkpoint dispositioned by user → BUILD IN W10. Real signal pipeline: `viewportStore.cameraZoom` + pure unit-tested `cameraDistanceToZoomPercent` + `OrbitControls.onChange` writer in `Viewport.tsx` (V8-clean: UI-projection-store write, file-rooted ban covers only DAG dispatch primitives — same in-viewport write class as the long-standing `useSelectionStore.getState().clear()` precedent) + R3 TopToolbar live readout (stays disabled — §5.3 specifies a zoom % *display*, not a zoom-input dropdown; §5.3 NOT amended). Observed: vitest 21/21 (+7), e2e p6-w10-ui-review 2/2 (readout DOM text observed 100%→200%→50%). |
| **c-2** close == delete | DEFER → v0.6 *(SPEC-AMEND rejected → forced CODE-FIX; CODE-FIX = new-capability → DEFER)* | **DEFER → v0.6.** Mini-checkpoint dispositioned by user → DEFER to v0.6. Rationale: a non-destructive close needs a new open-tabs-vs-storage session abstraction — a project-lifecycle redesign, out of audit-wave scope. Spec §5.1 anatomy stays the forward contract (NOT a SPEC-AMEND, NOT a silent divergence); the v0.5 destructive-close gap is roadmapped to v0.6, tracked in the v0.6 roadmap note below. The `window.confirm` guard at `ProjectTabs.tsx:104-106` remains the v0.5 mitigation until then. |
| **c-3** canvas attr literal `0` | CODE-FIX | `5da9651` — `data-rendered-keyframes` JSX init derived via `useMemo` from the same `cullVisibleKeyframes` the effect uses; pre-first-paint DOM now matches the contract (mirror-attr, not pixel-tested per H30/D-W9-4) |
| **F-6 / CI-3** bright-scene contrast | DEFER → user-reported unreadability | No W10 action (new capability: scene-luminance-adaptive chrome tint). Stated, not implied. |
| **CI-1 / FLAG-2** count-constant ≠ pixels-restored | DEFER → user A2 manual scrub | No W10 code action; observation-gated (jsdom cannot run rAF+canvas). The 1 skipped Playwright spec is this deferral, not a regression. |
| **CI-2** D-W9-7 V8 zero-Ops | PASS / no action | Confirmed compliant by source read; no change. |
| **CI-5** D-W7-1 ortho dropped | SPEC-AMEND already in §5.7 (W7) — confirmed + closed | Verified §5.7 + §15 changelog carry the W7 amendment; R8 source ships no projection toggle. No W10 code or spec action. Carry item closed. |

### Mini-checkpoint scope safeguard (honest report)

Two findings (c-1, c-2) the user forced from SPEC-AMEND to CODE-FIX were,
on investigation, **new-capability** rather than corrections to existing
chrome — exactly the audit-recursion cap the W10 plan installed. Per the
plan's bounded-exception rule, they STOPPED at a mini-checkpoint for the
user's explicit W10-inline-vs-later decision. **Disposition (user):**
**c-1 = BUILD IN W10 NOW** (built, `afd88b6`); **c-2 = DEFER → v0.6**
(roadmapped below). The safeguard firing was the intended outcome, not a
failure — it surfaced both as scope decisions instead of letting a scope
balloon hide inside "fix everything inline." Both are now terminal: c-1
shipped this wave, c-2 has a tracked v0.6 target (not a silent divergence,
not a SPEC-AMEND — the spec stays the forward contract).

### v0.6 roadmap items (tracked, not lost)

- **c-2 — non-destructive project close.** v0.5 close-tab IS
  delete-from-storage (`ProjectTabs.tsx:102-127`, `window.confirm`-guarded).
  v0.6 introduces an open-tabs session set distinct from the persisted
  storage set: close removes from the open set, the project stays on disk,
  a "reopen recent" affordance restores it. Requires new project-lifecycle
  machinery (open-set state + storage-set listing decoupled). Spec §5.1
  remains the forward contract; this is the roadmapped path to honoring it
  non-destructively. **Target: v0.6.** (Carried from W10 c-2 mini-checkpoint
  disposition.)

### C2 — §B11 P6 consolidation re-verified post-fix

§5 re-checked against the Wave B diff. All 6 distinctness pairs **still
hold** — no fix deleted, merged, or created a chrome *surface*; every fix
was an ARIA / width / label correction inside an existing surface. The
new `useSelectionSummary` hook is shared infra (not a surface) and
*unifies* the Viewport + Layout selection-summary source, **strengthening**
(not shifting) the R6 distinctness. No §5 row required revision; no
distinctness claim changed → no dharana B11 entry update triggered.

### C3 — §B11 P6 consolidation re-verified post-c-1

§5 re-checked against the c-1 diff (`afd88b6`). c-1 added one
`viewportStore.cameraZoom` field + a pure derivation helper + an
`OrbitControls.onChange` writer + a live binding on the *existing* R3
TopToolbar zoom button. **No distinctness pair shifts:**

- It created **no new chrome surface** — the zoom button already existed
  in R3 TopToolbar (it was a dead placeholder; now it has a live value).
  R3 TopToolbar vs deleted TransformToolbar (the only pair touching R3)
  is unaffected: SpaceGroup stays inlined, no group moved.
- `viewportStore.cameraZoom` is the same UI-projection class as the
  existing grid/shading/snap fields — it does not entangle any pair; it
  is read by exactly one surface (R3 zoom readout) and written by exactly
  one site (the Viewport.tsx OrbitControls listener), strengthening (not
  shifting) the single-writer discipline.
- No Dopesheet/Canvas, NPanel/Inspector, ToolRail/R8, ProjectTabs pair is
  touched. All six §5 distinctness conjunctions still hold; no §5 row
  required revision; **no dharana B11 entry update triggered.**

### C1 — regression gate (verbatim)

- `tsc --noEmit`: clean (0 errors)
- `npm run test` (vitest): **859 passed**, 61 files (≥859 W9 baseline ✓)
- `npx playwright test`: **100 passed, 1 skipped** (≥100 W9 baseline ✓;
  the 1 skip = CI-1/FLAG-2 A2 manual-scrub deferral, pre-existing)
- contrast matrix (`contrastMatrix.test.ts`): **5 passed** (WCAG-AA, no
  regression from the fixes)
- R3F Canvas identity (acceptance #9): preserved — W9#4 no-remount green

---

*Generated by `/anvi:ui-review` (W10). §7 = D-W10-1 inline fix run resolution
ledger. All findings terminal: c-1 BUILT (`afd88b6`, user disposition),
c-2 DEFER → v0.6 (roadmapped §7). Zero findings OPEN; zero §1 spec edits.*
