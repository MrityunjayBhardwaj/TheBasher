# Spline 3D — UI Reference (target state for Basher's chrome)

> **Status:** This document sets **Spline 3D's editor UI as the reference/target state** for
> Basher's directorial chrome (THESIS §58 item 4 — "Spline-grade Director experience"). It is a
> _design target_, not a copy mandate: borrow the calm-chrome / visual-hierarchy / direct-manipulation
> polish; **keep the lines the thesis refuses to cross** (§196 — the agent stays a co-equal authoring
> surface; the canvas is never the _only_ path to create; the raw DAG stays hidden until Pro).
>
> **Observed:** 2026-06-07, via `docs.spline.design` (read end-to-end through `llms.txt`) + a live
> headless capture of the product (dashboard, editor chrome, sign-in). The editor itself gates on
> login; the annotated editor screenshots below are Spline's own, pulled from their docs CDN.
> Re-observation is not required to act on this doc.

---

## 1. Editor anatomy (what the reference _is_)

Spline's editor is a **calm, light, low-contrast canvas** with five regions:

| Region                              | Contents                                                                                                                                                                                                                                                                        | Calm-chrome characteristic                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **① Tab bar** (top)                 | Open files as tabs + `+`; account chip → dashboard                                                                                                                                                                                                                              | Thin, quiet, recedes                              |
| **② Floating toolbar** (top-center) | _One_ rounded pill: select/move arrow · shape tools · pen · text · camera · light · **Play (▶)** · frame/present · zoom % · **Export** · **Share**                                                                                                                              | A single floating bar, not a full-width band      |
| **③ Left sidebar**                  | `Search` + **Objects \| Assets** tabs. Objects = outliner (Scene › each row = icon + visibility toggle). Bottom: Library · Import · Help                                                                                                                                        | One column, hierarchical, generous row spacing    |
| **④ Right sidebar**                 | **Vertical accordion of collapsible property sections** (Frame, Scene, Play Camera, Light, Simulation, Effects, Fog, Ambient Shadows, Global Settings, Variables). **Selection-driven**: nothing selected → scene props; object selected → its props. Toggles are pill switches | Collapsible sections; only the relevant ones open |
| **Viewport**                        | Soft gradient background; **orbit gizmo widget bottom-center**; **Orthographic \| Perspective** toggle pill                                                                                                                                                                     | Muted, tinted canvas — not pure black             |

**Reference images (Spline docs CDN, live):**

- Editor (annotated): `https://cdn.spline.design/_assets/docs/c78f0487-8330-42ec-81bd-e56f7731f667.png`
- Dashboard / Home (annotated): `https://cdn.spline.design/_assets/docs/7ad35708-74a9-4137-934c-c6a9bd275675.png`
- Source page: <https://docs.spline.design/basics/understanding-splines-ui>

**The overall read:** _quiet_. Generous whitespace, muted/light palette, rounded panels floating over a
tinted canvas, and crucially **one primary toolbar** — not a stack of bands.

---

## 2. The borrow list (§58 item 4) — Spline pattern vs. Basher today

| #   | Borrow target                              | Spline pattern                                                                                                         | Basher today (grounded)                                                                                                                                                              | Gap                                                                                                      |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | **Calm chrome / visual hierarchy**         | _One_ floating toolbar; accordion right panel; tinted viewport; muted palette                                          | **Four** top bands (`MenuBar` text menus / breadcrumb+save+mode / ADD-ASSETS-VIEW + EDIT/RUN/ANIMATE/DIRECTOR + EXPORT/PRESENT) + left `ToolRail` + bottom `FloatingViewportToolbar` | Chrome is desktop-IDE-busy; tool controls **duplicated** (rail + bottom bar). _Consolidation + restyle._ |
| 2   | **Property-panel feel + instant feedback** | Right accordion, selection-driven, edit-asset-updates-all, live                                                        | `NPanel` selection-driven inspector (lobe editor, slot selector, texture placement shipped); zustand = instant                                                                       | Closest to parity. Open Q: collapsible accordion sections?                                               |
| 3   | **Drag / gizmo polish + snapping**         | Gizmo + `L` local/world · `Shift` aspect-lock · `Alt` mirror · `⌘-drag` pivot; Global Settings snap toggle + snap type | Stock three.js `TransformControls`; Q/W/E/R tools; **snapping exists** (`maybeSnapVec3`, `toggleSnapEnabled`); `frameSelected()` (F)                                                 | No local/world toggle, no pivot edit, snapping not surfaced; stock gizmo less polished                   |
| 4   | **Asset-browser ergonomics**               | Left **Assets** tab; reusable assets; edit-updates-all; "remove unused"; drag-drop apply                               | `AssetsPopover` + My-Imports mgmt (#112)                                                                                                                                             | A _popover_, not a first-class panel; no shareable Material edge / library (§58 item 2, deferred)        |
| 5   | **Empty states**                           | "Press and drag to orbit" hints; dashboard tutorials + examples rows                                                   | Thin                                                                                                                                                                                 | Mostly unbuilt                                                                                           |
| 6   | **60-sec onboarding tour**                 | ⚠️ Spline has **no in-editor tour** — only dashboard tutorials/examples                                                | None                                                                                                                                                                                 | A Basher _addition_, not a literal Spline borrow                                                         |
| 7   | **Shipped demo project**                   | Remixable Library examples                                                                                             | None loaded on first run                                                                                                                                                             | Net-new: a curated demo that loads from a clean clone                                                    |

---

## 3. Shortcuts worth mirroring (Spline)

`S` focus · `Shift+S` orient-to-object · `L` local↔world · `Shift` aspect-lock · `Alt` mirror ·
`⌘D` duplicate / `⌘-drag` copy · `M` persp↔ortho · `⌘\` toggle UI · `Space+drag` pan ·
`Alt+drag` orbit · `⌘+wheel` zoom.

> Basher deliberately uses **Blender's Q/W/E/R** for select/move/rotate/scale — a defensible divergence,
> not a thing to "fix" toward Spline. Mirror Spline's _navigation + modifier_ conventions, keep Basher's
> tool keys.

---

## 4. Basher's observed first-run friction → Spline target

Direct observation of Basher (`:5180`, v0.6 #3 tip, 2026-06-07), ordered by leverage against the
`<15-min` first-time-user acceptance gate:

- **F1 — Chrome density (dominant).** 4 top bands + left rail + bottom bar; select/move/rotate/scale
  duplicated. → **Target:** Spline's single floating toolbar (region ②).
- **F2 — Three competing "mode" controls.** `mode: Edit▾` (Simple/Director/Pro) + `EDIT/RUN/ANIMATE/DIRECTOR`
  workspace tabs + agent `read-only/copilot/sandbox`. Two even reuse "Edit"/"Director." → **Target (D-05):**
  **remove the Simple/Director/Pro app-mode system entirely** — replace gating with progressive disclosure
  (see §6). Keep the agent autonomy control (`read-only/copilot/sandbox` — orthogonal). Workspace/advanced
  surfaces become revealable drawers, not modes.
- **F3 — Dark, high-contrast developer-tool aesthetic** vs. Spline's calm light/lavender low-contrast
  canvas. → **Target:** calm palette/contrast/spacing.
- **F4 — ADD is a Blender text submenu (Shift+A)**, not a visual object palette. → **Target:** visual,
  browsable add affordance for first-timers (keep Shift+A for power users).
- **F5 — Empty inspector, no first-run guidance** ("select a node"; no demo richness; click-to-select
  from viewport unconfirmed). → **Target:** empty-state hints + a shipped demo project.
- **F6 — Agent surface is already co-equal and well-placed** (right, prominent). On-thesis — **do not
  demote it** while chasing Spline polish (§196; this phase's D-03 keeps it out of scope as-is).

---

## 5. The line we do not cross (§196)

Spline makes the canvas the primary (often only) creation surface. **Basher does not.** The agent/chat
is a **co-equal primary authoring surface**, every edit is an `Op` (determinism + undo), and the raw DAG
stays **hidden by default** (one reveal away — not behind a mode; see §6). Borrow Spline's _polish_;
never borrow the _canvas-is-the-only-path_ assumption.

---

## 6. No modes — progressive disclosure (D-05)

**Decision:** Remove the Simple / Director / Pro app-mode system. There are **no app modes.** Every
surface exists for every user; the default view is calm, and complexity is **hidden by default and
revealed on demand** — the Spline model (states/events, timeline = panels you open, not a tier you
unlock).

**Replaces:** the mode-gating model in THESIS §12–17, §203 (mode table), §834 (Mode primitive), and the
v0.6/v0.7 "DAG hidden until Pro" gating.

- One editor. All surfaces present for everyone.
- Default = minimal: viewport + outliner + inspector + agent.
- Hidden-by-default, revealable: **timeline** (already a drawer — `TimelineDrawer` + `timelineDockStore`),
  **DAG/graph view**, library, advanced inspector sections, debug/tools.
- The **agent is always co-equal and present** (supersedes §15's per-mode chat behavior; kills §691's
  "Simple was too simple" wall).
- **Keep** the agent autonomy control (`read-only / copilot / sandbox`) — that is agent behavior, not an
  app mode.

**Why it's a net gain (Chesterton):** the mode system's purpose was (a) don't scare newcomers (§674) and
(b) start onboarding simple (§206). Disclosure serves both better — complexity hidden by default (scares
no one) yet available (no wall) — and it _eliminates_ §809's stated failure risk (one pipeline by
construction; no "easy" vs "real" split). The fence comes down; its purpose is preserved.

**Thesis ripple (to reconcile — pending greenlight):** §12 (scene tree "Director+Pro"), §13 (timeline
"Director+Pro"), §14 (library "Director"), §15 (chat-drawer-per-mode), §16 (DAG "Pro, read-only"),
§17 + §834 (the Mode primitive), §203 (mode table), §206 (mode persistence/onboarding), §478 (mode
store scaffold), §520 (Tools "Pro only"), §579, §674 (risk mitigation), §691, §702/§706/§730 ("DAG
hidden until Pro", "Simple→Director defaults"), §59 ("editable DAG editor in Pro mode"). Code ripple:
`ModeSwitcher`, `ModeBadge`, `chromeStore`, `Layout` (surface gating), `TopToolbar` (the mode control).
