# UI Review — Basher editor chrome vs. Spline calm-chrome target

> **Milestone:** v0.6 #4 — "Spline-grade Director UX" · **Branch:** `feat/v06.4-director-ux`
> **Date:** 2026-06-08 · supersedes the 2026-05-15 P6 W10 audit.
> **Method:** retroactive, code-grounded 6-pillar audit. Every claim cites `file:line`.
> **Target state:** `docs/SPLINE-UI-REFERENCE.md` (Spline = calm/light/low-contrast, ONE floating
> toolbar, accordion right panel, tinted viewport). **Lines we don't cross (§196):** agent stays
> co-equal; canvas is never the only create path; raw DAG hidden-not-deleted.

---

## Output 1 — 6-pillar scored audit

Scores are 1–5 (5 = at the Spline target). The audit measures the **current implemented chrome**
against the calm-chrome target, NOT against "is it a working editor" (it is).

| Pillar | Score |
|--------|-------|
| 1. Layout | **2 / 5** |
| 2. Typography | **2 / 5** |
| 3. Color | **2 / 5** |
| 4. Spacing | **3 / 5** |
| 5. Interaction | **4 / 5** |
| 6. Accessibility | **4 / 5** |

---

### Pillar 1 — Layout · **2 / 5** · (maps to F1, dominant)

**Evidence (grounded):**

- The grid is a **6-row desktop-IDE stack**: `Layout.tsx:94-102` declares rows
  `projectTabs / menu / chrome / toolbar / viewport / timeline`. **Four** of those are chrome bands
  stacked above the viewport:
  - R1 `ProjectTabs` (`Layout.tsx:118`)
  - R2 `MenuBar` — File/Add/Edit/Object/Select/View text menus (`Layout.tsx:121`, `MenuBar.tsx:442-702`)
  - R3 `Chrome` — `basher / {project}` breadcrumb + save + ProjectsMenu + **ModeSwitcher** (`Layout.tsx:124`, `Chrome.tsx:26-57`)
  - R4 `TopToolbar` — Add+Assets+Space group / **mode pill** / zoom+Export+Present (`Layout.tsx:127`, `TopToolbar.tsx:235-258`)
- Plus a **left `ToolRail`** column (`Layout.tsx:142`, `ToolRail.tsx:150-197`) and a **bottom
  `FloatingViewportToolbar`** overlay (`FloatingViewportToolbar.tsx:174-251`).
- **Tool duplication is real and exact.** Select/Translate/Rotate/Scale exist in BOTH surfaces with
  identical icons and the same `editorStore.setActiveTool` dispatch:
  - `ToolRail.tsx:39-44` — `{select ↖, translate ✥, rotate ⟲, scale ⤢}`
  - `FloatingViewportToolbar.tsx:51-56` — `{select ↖, translate ✥, rotate ⟲, scale ⤢}` (same glyphs)
  Both route through `setActiveTool` (`ToolRail.tsx:177`, `FloatingViewportToolbar.tsx:189`). A
  first-timer sees the same four tools twice, on opposite edges of the screen.
- **Three competing "mode" controls** are layout-level, not just visual (F2): the mode pill
  (`TopToolbar.tsx:151-178`), the `ModeSwitcher` `<select>` (`ModeSwitcher.tsx:13-29`, mounted in
  `Chrome.tsx:54`), and the `View ▸ Set Mode` submenu (`MenuBar.tsx:691-700`) — **three writers to
  the same `useModeStore.setMode`**. Two of them ("Edit", "Director") collide vocabulary-wise with
  the agent autonomy control and with Director Cut.

**Gap vs Spline:** Spline is **one floating pill** over a tinted canvas (`SPLINE-UI-REFERENCE.md:23`).
Basher stacks four full-width bands + a rail + a bottom bar, with tools duplicated and mode triplicated.
This is the chrome-density friction F1 in its most literal form.

---

### Pillar 2 — Typography · **2 / 5** · (supports F3)

**Evidence:**

- **Monospace everywhere.** The single font family is JetBrains/Geist Mono (`tailwind.config.ts:34-36`)
  and chrome surfaces hard-set `font-mono`: `Chrome.tsx:29`, `TopToolbar.tsx:241`, `MenuBar.tsx:447`,
  `ToolRail.tsx:91`, `FloatingViewportToolbar.tsx:180`, `ModeBadge.tsx:88`. A mono-only UI reads as a
  developer tool, not a calm authoring canvas.
- **Tiny, uppercase, tracking-wide labels** dominate — the IDE/terminal idiom, the opposite of
  Spline's quiet sentence-case: `text-[11px] uppercase tracking-wide` (`MenuBar.tsx:86`,
  `TopToolbar.tsx:85/113`, `LeftSidebar.tsx:102`), and a clutter of `text-[10px]`
  (`TopToolbar.tsx:140/200`, `FloatingViewportToolbar.tsx:135`, `Chrome.tsx:49`).
- The brand chip itself is lowercase mono `basher` (`Chrome.tsx:32`).

**Gap vs Spline:** Spline uses a soft sans, sentence case, larger touch targets. No proportional/sans
family is even defined in the theme, so there is currently no token to switch to.

---

### Pillar 3 — Color · **2 / 5** · (maps to F3)

**Evidence (the palette is the friction):**

- The theme is **near-black, high-contrast dark**: `bg #0a0a0a`, `bg-1 #111`, `bg-2 #161616`,
  `fg #e5e5e5` (`tailwind.config.ts:13-21`). `darkMode: 'class'` with no light variant
  (`tailwind.config.ts:9`).
- The accent is a **saturated terminal green** `#5af07a` (`tailwind.config.ts:22-24`), used for active
  tools and focus rings throughout (`ToolRail.tsx:96`, `FloatingViewportToolbar.tsx:103`,
  `TopToolbar.tsx:169`). This is the "hacker terminal" signature, not Spline's calm lavender.
- Borders are dark-on-dark (`border #262626`, `border-strong #3a3a3a`, `tailwind.config.ts:20-21`),
  giving the busy "every panel is boxed" look across all bands (e.g. `Chrome.tsx:29`,
  `TopToolbar.tsx:241`, `MenuBar.tsx:447`, `RightDrawer.tsx:13`).

**Gap vs Spline:** Spline is light, muted, low-contrast with a tinted (non-black) viewport
(`SPLINE-UI-REFERENCE.md:18,26,34`). Basher is the exact inverse on every axis: dark, saturated-accent,
high-contrast. This is the single largest aesthetic distance and is **purely token-level** — fixable in
`tailwind.config.ts` without touching structure.

---

### Pillar 4 — Spacing · **3 / 5**

**Evidence:**

- Internal control spacing is actually reasonable and consistent — `gap-1`/`gap-2`/`gap-3` with
  `px-2/py-1` rhythm (`TopToolbar.tsx:241/244`, `ToolRail.tsx:157`, `FloatingViewportToolbar.tsx:180`).
  The floating toolbar in particular is well-proportioned (`bottom-4 left-1/2 -translate-x-1/2`,
  rounded, backdrop-blur — `FloatingViewportToolbar.tsx:180`).
- The cost is **vertical**: four stacked bands consume rows `32px auto auto auto` before the viewport
  ever starts (`Layout.tsx:94`). The bands are individually tight but collectively eat a large band of
  the screen, squeezing the canvas — the opposite of Spline's generous-whitespace-around-canvas read.
- Right column is a fixed `280px 280px` pair (inspector + drawer, `Layout.tsx:91`), reasonable but
  rigid.

**Gap vs Spline:** Per-control spacing is fine; the spacing *problem* is band stacking, which is really
a layout problem (Pillar 1). Whitespace generosity around the canvas is low because chrome crowds it.

---

### Pillar 5 — Interaction · **4 / 5**

**Evidence (this is genuinely strong):**

- Consistent hover/active/focus states with transitions on every control: `transition-colors` +
  `hover:` + `focus-visible:ring-1 focus-visible:ring-accent` (`ToolRail.tsx:91/98`,
  `FloatingViewportToolbar.tsx:102-103`, `TopToolbar.tsx:168`, `MenuBar.tsx:86`, `LeftSidebar.tsx:102`).
- Active-tool state is **synchronized across both tool surfaces** via the single `editorStore`
  dispatcher (`FloatingViewportToolbar.tsx:20-22` comment + `:189`; `ToolRail.tsx:177`), so the
  duplication at least never desyncs.
- Per-panel collapse is wired and persisted (`chromeStore.ts:89-118`) with always-visible re-expand
  affordances even at 0 width (`ToolRail.tsx:127-147` edge tab; `LeftSidebar.tsx:49-71`).
- Live feedback: zoom % is a real derived value (`TopToolbar.tsx:191-202`), snap step is a live input
  (`FloatingViewportToolbar.tsx:236-249`).

**Gap vs Spline:** Missing the polish layer — no local/world gizmo toggle, no pivot edit, snapping not
surfaced as a Spline-style Global-Settings affordance (`SPLINE-UI-REFERENCE.md:45`). Stock three.js
`TransformControls` is less refined than Spline's gizmo. The `Present`/zoom `▾` are decorative-disabled
(`TopToolbar.tsx:196-204/216`), a small honesty gap.

---

### Pillar 6 — Accessibility · **4 / 5**

**Evidence (strong — the W8 a11y gate shows):**

- Skip-link present in **every** mode as the first focusable element (`Layout.tsx:111-117`); viewport
  is a labelled `role="main"` landmark with a live selection summary (`Layout.tsx:163-167`).
- Toolbars carry `role="toolbar"` + `aria-orientation` + `aria-label` (`TopToolbar.tsx:238-240`,
  `ToolRail.tsx:131-133/154-156`, `FloatingViewportToolbar.tsx:177-179`); menus carry
  `role="menubar"/"menu"/"menuitem"` + `aria-haspopup`/`aria-expanded` (`MenuBar.tsx:444-446,80-83`);
  tabs carry `role="tablist"/"tab"` + `aria-selected` (`LeftSidebar.tsx:86-97`).
- Every interactive control has `aria-label`; icon glyphs are `aria-hidden`
  (`TopToolbar.tsx:87/119/172`). ModeBadge announces via `aria-live="polite"` with a separate SR-label
  formatter (`ModeBadge.tsx:55-73,94`).

**Gap vs Spline:** Contrast risk in the calm-repaint ahead — the muted/low-contrast target can violate
WCAG AA if not measured (the project already has a contrast gate; keep it active through the repaint).
`text-fg-mute #525252` on `bg #0a0a0a` is borderline already (`tailwind.config.ts:18`). The
disabled-but-focusable `Present`/zoom buttons announce affordances that do nothing.

---

## Output 2 — MODE-GATING MAP (D-05: remove Simple/Director/Pro app modes)

**Critical correction up front.** `useModeStore` (`modeStore.ts:23`) has already been repurposed away
from density tiers — its enum is **`'edit' | 'run' | 'animate' | 'director'`** (operational modes), NOT
Simple/Director/Pro. The legacy density values (`simple`/`pro`/old-`director`) are dead and coerce to
`edit` on read (`modeStore.ts:55-59`). So D-05's "remove Simple/Director/Pro" is **already done at the
store level**; what remains is the operational-mode system (`edit`/`run`/`animate`/`director`) that now
plays the gating role and must be reconciled with progressive disclosure.

**Agent autonomy is a SEPARATE store — KEEP IT.** `read-only/copilot/sandbox` lives in
`useAgentSessionStore` (`AgentMode` type, `AgentChat.tsx:14,23`; consumed at `orchestrator.ts:159,547,581`).
It is NOT `useModeStore` and is NOT listed below. It is agent behavior, not an app mode. Do not touch it.

### Every surface gated by `useModeStore` (the complete reader set, grepped)

| # | Gated surface | Where gated (file:line) | Current rule (which mode shows it) | D-05 disposition |
|---|---------------|-------------------------|-------------------------------------|------------------|
| 1 | `ProjectTabs` (R1) | `Layout.tsx:94,118` | hidden when `director` | **ALWAYS-PRESENT** — tabs are not a mode; director-cut hide becomes a UI-toggle (`⌘\`), not a mode |
| 2 | `MenuBar` (R2) | `Layout.tsx:94,121` | hidden when `director` | **ALWAYS-PRESENT** (hidden only by the chrome-off/present toggle) |
| 3 | `Chrome` band (R3) | `Layout.tsx:94,124` | hidden when `director` | **DELETED-CONTROL** — band's only unique content is `ModeSwitcher` (row 9) + save; fold save into surviving chrome, drop the band |
| 4 | `TopToolbar` (R4) | `Layout.tsx:94,127` | hidden when `director` | **ALWAYS-PRESENT** (consolidation target; chrome-off toggle hides it) |
| 5 | `ToolRail` (R4 col) | `Layout.tsx:70,134,142` | width 0 when `director` OR collapsed | **ALWAYS-PRESENT** (collapse stays user-controlled via chromeStore, not mode) |
| 6 | `LeftSidebar`/tree col | `Layout.tsx:74,152` | hidden when `director` | **ALWAYS-PRESENT** (collapse user-controlled) |
| 7 | `NPanel` inspector | `Layout.tsx:216` | hidden when `director` | **ALWAYS-PRESENT** (collapse user-controlled) |
| 8 | `RightDrawer` (agent) | `Layout.tsx:225` | hidden when `director` | **ALWAYS-PRESENT** — §196: agent is co-equal, must never vanish behind a mode |
| 9 | `ModeSwitcher` `<select>` | `Chrome.tsx:54`, `ModeSwitcher.tsx:13-29` | always rendered (writes mode) | **DELETED-CONTROL** — redundant 3rd mode writer (F2) |
| 10 | Mode pill (4 buttons) | `TopToolbar.tsx:151-178,250` | always rendered (writes mode) | **DELETED-CONTROL** — the central F2 offender; Run/Animate/Director become disclosure actions, not a tier pill |
| 11 | `View ▸ Set Mode` submenu | `MenuBar.tsx:691-700` | always rendered (writes mode) | **DELETED-CONTROL** — redundant menu mode writer |
| 12 | `TimelineDrawer` mount | `Layout.tsx:237` (`mode === 'animate'`) | visible only in `animate` | **REVEALABLE-DRAWER** — timeline is already a drawer (`timelineDockStore`); reveal it on demand, not by entering a mode |
| 13 | `ModeBadge` overlay | `ModeBadge.tsx:75-98` | label per mode; null in `director` | **DELETED-CONTROL** — surfaces the mode concept; with no modes, no badge (frame/fps readout can move to timeline/viewport HUD) |
| 14 | `FloatingViewportToolbar` | `FloatingViewportToolbar.tsx:172` | `null` when `director` | **ALWAYS-PRESENT** (chrome-off toggle hides it; see consolidation) |
| 15 | `ComfyStatusIndicator` probe | `ComfyStatusIndicator.tsx:144` (`mode !== 'run'`) | probes ComfyUI only in `run` | ⚠️ **AMBIGUOUS** — see flags below |
| 16 | Tool keys Q/W/E/R gate | `KeyboardShortcuts.tsx:302-304` (`edit`/`animate`) | tool keys only in edit/animate | ⚠️ **AMBIGUOUS** — see flags below |
| 17 | Mode keys 1/2/3/4 | `KeyboardShortcuts.tsx:171-176,289-292` | sets mode | **DELETED-CONTROL** — no modes → no 1/2/3/4; free the keys (or repurpose to disclosure toggles) |
| 18 | Esc → `setMode('edit')` | `KeyboardShortcuts.tsx:230,476` | universal Esc returns to edit | ⚠️ **AMBIGUOUS** — see flags below |
| 19 | `Present` button | `TopToolbar.tsx:215-224` (`setMode('director')`) | enters director | **REVEALABLE-DRAWER** (re-point) — keep the *affordance* ("Present"/chrome-off) but back it with a `chromeStore.presentMode` boolean, not `modeStore` |

### Surfaces flagged AMBIGUOUS (must be resolved before the removal is planned)

- **#15 `ComfyStatusIndicator` (`ComfyStatusIndicator.tsx:144`)** — the ComfyUI health probe runs *only*
  in `run` mode. With no `run` mode, when should it probe? It is real behavior (render-backend
  liveness), not chrome. **Resolve:** bind the probe to the actual condition (a render/run is requested
  or in progress), not to a mode. Needs an explicit trigger decision, else the indicator either never
  probes (silent — matches the catalogued "decision locked → surface stops firing" trap) or probes
  always (wasteful).
- **#16 Tool-key gate (`KeyboardShortcuts.tsx:302-304`)** — Q/W/E/R are allowed only in `edit`/`animate`
  today. With no modes, the gate's purpose (don't fire transform tools while "running") loses its
  variable. **Resolve:** either always-allow Q/W/E/R, or gate on the new disclosure/playback state.
  Silently dropping the gate could let tool keys fire during playback.
- **#18 Esc semantics (`KeyboardShortcuts.tsx:230,476`)** — Esc currently means "return to edit mode."
  Post-removal it has no mode to return to. **Resolve:** redefine Esc precedence (exit present →
  clear selection) explicitly; leaving the dead `setMode('edit')` call is harmless but the *intended*
  Esc behavior must be re-specified or first-timers lose the universal escape.

> **No surface silently vanishes** if dispositions 1–14 are honored: every panel becomes
> ALWAYS-PRESENT or a REVEALABLE-DRAWER. The only DELETED items are the mode *controls* themselves
> (#3 band, #9/#10/#11 the three mode writers, #13 badge, #17 mode keys) — surfaces, not content.
> Director-cut "chrome off" survives as a `chromeStore` boolean (#19), not a mode.

---

## W1 recommendation — **CONSOLIDATE** (not restyle-only)

**Decision: consolidate the 4 bands + 2 tool surfaces toward Spline region ②, AND restyle the palette
in the same wave.** Restyle-only is insufficient; consolidation is the higher-leverage move and the
evidence is structural, not aesthetic.

**Deciding evidence:**

1. **The duplication is exact and load-bearing.** Select/Move/Rotate/Scale ship twice with identical
   glyphs in `ToolRail.tsx:39-44` and `FloatingViewportToolbar.tsx:51-56`, both dispatching the same
   `setActiveTool`. A restyle paints the same control twice in a calmer color — it does not remove the
   "why are there two of these?" friction. Only consolidation deletes the redundancy.

2. **The bands are mostly thin or redundant once mode dies.** Of the four bands:
   - R3 `Chrome` (`Chrome.tsx`) contributes only a breadcrumb + save + the *ModeSwitcher* — and the
     ModeSwitcher is dead under D-05. After D-05, R3 has almost no unique content; fold it, do not
     restyle it.
   - R4 `TopToolbar`'s center third is the **mode pill** (`TopToolbar.tsx:151-178,250`) — also dead
     under D-05. That frees the natural center slot for Spline's single pill.
   - R2 `MenuBar` and R1 `ProjectTabs` are legitimately keepable, but stacking them as separate
     full-width bands above R3+R4 is what produces the "four bands" read (`Layout.tsx:94-102`).
   So a large fraction of band content is **mode-gated noise that D-05 removes anyway** — consolidation
   rides the same wave that removes the modes rather than fighting it.

3. **The structure is the bug, not the skin.** Per the project's own organizational-fatality test:
   tool controls duplicated across two surfaces + three writers to one `setMode` is a boundary drawn
   wrong (one concern — "primary tools" / "mode" — split across many surfaces). Restyling leaves the
   wrong boundary in place; consolidation fixes it. The cheap-to-fix part (dark→calm palette) is
   genuinely restyle-only and should happen *in the same wave* — a `tailwind.config.ts:12-33` token
   swap plus dropping the mono-only/uppercase idiom (Pillars 2/3), with the contrast gate kept on.

**Recommended W1 shape (within §196):**
- Collapse R3 `Chrome` + R4 mode pill into **one floating/top pill** (Spline ②): tools (once), Add,
  Assets, space toggle, zoom %, Export, Present-as-`chromeStore`-toggle.
- Delete the second tool surface — keep the *floating* one near the canvas (it is the Spline pattern)
  and retire `ToolRail`'s duplicate tools, or vice-versa; pick one home for Q/W/E/R.
- Keep R1 tabs and R2 menu as quiet, thin surfaces (Spline ① tab bar; menus recede).
- Retire the three mode writers (#9/#10/#11) and the mode badge (#13); back Director-cut with a
  chrome-off boolean (#19).
- Repaint to a calm/light low-contrast palette in the same wave; resolve the three AMBIGUOUS gates
  (#15/#16/#18) explicitly before coding.
- **Untouched (§196):** the agent `RightDrawer` stays co-equal and always-present (#8); the raw DAG
  stays hidden-not-deleted; the canvas is not made the only create path (Add/Assets/agent all remain).
