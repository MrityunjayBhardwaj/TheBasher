# UI-SPEC — Basher Design System

**Version:** v0.5-draft-1
**Status:** Pre-implementation contract. To be validated by `/anvi:ui-checker` before Wave A code lands.
**Phase:** P6 — Design System (inserted ahead of Splats; Splats becomes P7).
**Authors:** captured 2026-05-10 from session establishing locked decisions D-UX-1…D-UX-4.

This document is the **design contract** for Basher's UI. Any UI code shipped after this date must match the contract or amend it explicitly. The contract is enforceable: it lists tokens, region names, mode states, keyboard model, and accessibility targets that downstream code is checked against.

---

## 1. Locked decisions

| ID | Decision | Source |
|---|---|---|
| **D-UX-1** | Animation timeline is **mode-gated** (visible only in Animate mode), not always-visible | Director feedback 2026-05-10; Spline pattern |
| **D-UX-2** | Curve editor is a **tab next to Dopesheet** in the timeline dock, not a side panel | Reze Studio pattern |
| **D-UX-3** | Timeline hot-path (imperative `currentFrameRef`, drag-redraw) is **rolled out in Wave 2**, after the visual port lands in Wave 1 | Reduces Wave 1 scope |
| **D-UX-4** | **Theatre.js NOT adopted.** `@theatre/studio` is AGPL-3.0; Basher's permissive-only posture blocks it. Reze patterns ported onto existing P3 substrate (`src/timeline/`). | License audit 2026-05-10 |
| **D-UX-5** | **Density axis dropped.** Spline pattern: one canonical layout, all panels always visible, per-panel collapse via small chrome buttons. Existing `useModeStore` keeps its name; `Mode` type becomes operational-only (`edit`/`run`/`animate`/`director`). | "follow exact Spline pattern for base UI" — director directive 2026-05-10 |
| **D-UX-6** | **Operational mode** is the only mode axis: `edit` / `run` / `animate` / `director` | Spline 4-mode model (Vector→Animate domain substitution) |
| **D-UX-7** | **Base UI shell follows Spline structurally.** Domain extensions (Agent tab, Animate-as-Reze, Render section) only where THESIS demands. | Director directive 2026-05-10 |
| **D-UX-8** | **NPanel canonical Inspector; `Inspector.tsx` deleted.** Original O-1 direction (locked 2026-05-10), reversed mid-W1 to "delete NPanel keep Inspector" after observing the two surfaces had no overlap, then **re-reversed in W2.6** after W2's TopToolbar absorbed NPanel's mode + snap groups (leaving NPanel with nothing unique). NPanel now owns the right-column property editor with all `inspector-*` testids preserved; the viewport-overlay mount is gone. Grid/axis toggles (NPanel's last unique sections) moved to W7's FloatingViewportToolbar where they belong (Spline pattern: viewport-state toggles live near the viewport). | Resolved O-1 → mid-W1 inverted → W2.6 restored (lokayata: spec swung once because NPanel had unique surface area; restored once that area was naturally absorbed elsewhere) |
| **D-UX-9** | **Director Cut = chrome-hidden viewport.** All panels hide; viewport takes full window; minimal shot title + transport overlay. Full review tool (comments, shot list) deferred. | Resolved O-2 |
| **D-UX-10** | **Add menu has both entry points** (right-click in viewport + top-toolbar `+`), driven by single `addMenuStore`. | Resolved O-3 |
| **D-UX-11** | **No shadcn for v0.5.** Plain Tailwind primitives. Revisit at v0.6 if Dialog/Popover proliferate beyond 4–5 instances. | Resolved O-4 |
| **D-UX-12** | **Project-tab unsaved indicator** = warn-colored dot + "last saved Nm ago" tooltip on hover. | Resolved O-5 |
| **D-UX-13** | **ComfyUI status indicator** = capability-flag read at boot + lazy probe every 30s when `mode === 'run'` OR on hover. No constant polling. | Resolved O-6 |

---

## 2. Reference targets (study, not copy)

These are the tools whose **structural patterns** Basher is porting. None of their assets, icons, brand visuals, or code are reproduced. Patterns are functional and not protected; this document describes Basher's UI in Basher's own terms.

| Tool | What we port | What we don't |
|---|---|---|
| Spline | Three-rail shell + top-toolbar mode toggle + selection-adaptive Inspector + floating bottom toolbar + tab-based file management | Vector mode (no analog), event graph (different mental model in Basher), brand visuals, exact spacing, icons |
| Reze Studio | Dopesheet/curve-editor architecture, `currentFrameRef` escape hatch, slice-subscribed `useSyncExternalStore` pattern, imperative TimelineCanvas, per-channel Bézier handles, track ops (Simplify/Clear), keyboard model, status footer | MMD/PMX/VMD/morphs (out of domain), bone-anatomy categorization, mirrored paste, IK, Bullet physics, WebGPU engine |

---

## 3. Pillar 1 — Layout & Hierarchy

### 3.1 Region inventory

The editor uses a CSS-grid layout with named regions. Regions are show/hide controlled by data attributes; **no region's React tree is unmounted by mode change** (V11 / K1 step 6 — Canvas mounts once). Per D-UX-5, there is one canonical layout: all panels visible by default, per-panel collapse via small chrome buttons (Spline pattern).

```
┌──────────────────────────────────────────────────────────────────────────┐
│  R1 PROJECT-TABS                                              [● live]   │  height 32px
├──────────────────────────────────────────────────────────────────────────┤
│  R2 MENU-BAR (File / Edit / View / Object / Add / Render / Animate / Help)│ height 28px
├──────────────────────────────────────────────────────────────────────────┤
│  R3 TOP-TOOLBAR  [+ Add  ↖ Sel  ✥ Tx]  [◐ Edit ▶ Run ⏱ Anim ⛶ Dir]  [⬇ ⛚]│  height 40px
├────┬──────────────┬──────────────────────────────────────────┬───────────┤
│    │              │                                          │           │
│ R4 │ R5           │  R6 VIEWPORT (Canvas, mounts once)        │ R7        │
│ TL-│ LEFT-SIDE-   │                                           │ INSPECTOR │
│ RAIL │ BAR        │  ╔══════════════════════════════════════╗ │ (NPanel,  │
│    │ Scene/Lib/   │  ║                                      ║ │  canonical│
│    │ Agent tabs   │  ║         ◆                            ║ │  per O-1) │
│ ↖  │              │  ║       ╱│╲                            ║ │           │
│ ✥  │ tree …       │  ║       ╲│╱                            ║ │ Transform │
│ +  │              │  ║                                      ║ │ Mesh      │
│ ◯  │              │  ║       grid · · · ·                   ║ │ Material  │
│ □  │              │  ║                                      ║ │ Render    │
│ ✦  │              │  ╚══════════════════════════════════════╝ │ Animate   │
│ T  │              │                                           │           │
│ ⌖  │              │       ┌───────────────────────────┐      │           │
│ ⛓  │              │       │ ↖ ✥ ⟲ ⤢ │ ⌂ ⊞ │ ⊙ ◉   │      │           │
│    │              │       └───────────────────────────┘      │           │
│    │              │       R8 FLOATING-VIEWPORT-TOOLBAR        │           │
├────┴──────────────┴──────────────────────────────────────────┴───────────┤
│  R9 TIMELINE-DOCK (visible only when mode === 'animate')                 │  height 280px when shown
└──────────────────────────────────────────────────────────────────────────┘
```

**Director mode** (D-UX-9) hides R1 R2 R4 R5 R7 R9; R3 collapses to a minimal title overlay; R6 takes the full viewport.

**Region IDs** (canonical names; data-testids and gridArea names use them verbatim):

| ID | Name | Visibility | Owner store |
|---|---|---|---|
| R1 | `project-tabs` | always (hidden in `director`) | projectStore |
| R2 | `menu-bar` | always (hidden in `director`) | — |
| R3 | `top-toolbar` | always (collapsed in `director`) | modeStore + selectionStore |
| R4 | `tool-rail` | always (hidden in `director`); user-collapsible to icon-only | editorStore.activeTool |
| R5 | `left-sidebar` | always (hidden in `director`); user-collapsible | leftSidebarStore.activeTab |
| R6 | `viewport` | always | (R3F) |
| R7 | `inspector` | always (hidden in `director`); user-collapsible | NPanel reads selectionStore + dagStore |
| R8 | `floating-viewport-toolbar` | always (overlaid) | editorStore + viewportStore |
| R9 | `timeline-dock` | `mode === 'animate'` | timeStore + timelineSelection |

**Status info** (formerly R10) is folded into R1 (right edge: `[● live]` ComfyUI indicator + last-save timestamp on tab hover) and R9 (frame counter / fps inside timeline header). No dedicated status footer — Spline pattern.

### 3.2 Per-panel collapse (Spline pattern, replaces the dropped density axis)

Per D-UX-5, there is no density axis. Each panel region carries its own collapse button on its inside edge:

- **R4 ToolRail** — collapse button at top: `›` collapses to 0 width; expanded shows full 32px column. Persisted to `localStorage`.
- **R5 LeftSidebar** — collapse button on right edge: `‹` collapses; expanded default 220px. Persisted.
- **R7 Inspector (NPanel)** — collapse button on left edge: `›` collapses; expanded default 280px. Persisted.

Collapse is a chrome action, never a per-element control. Mode `director` (D-UX-9) overrides — it forces R4/R5/R7 hidden regardless of user collapse state.

The **existing `useModeStore`** (currently `simple`/`director`/`pro`) is repurposed: `Mode` type changes to `'edit' | 'run' | 'animate' | 'director'`. Any persisted localStorage value not in the new set coerces to `'edit'` on first read.

### 3.3 Operational mode

| Mode | What changes | Persists across reload |
|---|---|---|
| `edit` (default) | Standard editing: viewport accepts transforms, gizmos visible, tool rail active | yes |
| `run` | Render workflow currently submitted; viewport shows progress overlay; transform tools disabled while in-flight | no — resets to last persisted on reload (job state lives in renderJobsStore) |
| `animate` | R9 timeline dock visible; transforms record keyframes (auto-key); time is scrubable; gizmo color shifts to `record` accent | yes |
| `director` | D-UX-9 chrome-hidden viewport: R1 R2 R4 R5 R7 R9 hide; R3 minimal; R6 full window | no — exits to last persisted on reload |

### 3.4 Mode state machine

```
       ┌─────────────────────────────────────────┐
       ▼                                         │
  ┌────────┐    ▶ Run         ┌────────┐         │
  │  edit  │ ───────────────▶ │  run   │ ────────┤
  │        │                  │        │         │ ◀ stop / job-done
  │        │ ◀──────────────  │        │         │
  └────────┘    ◀ stop        └────────┘         │
       │                                         │
       │ ⏱ Animate                               │
       ▼                                         │
  ┌────────┐    ⛶ Director    ┌────────┐         │
  │ animate│ ───────────────▶ │director│         │
  │        │                  │        │         │
  │        │ ◀──────────────  │        │         │
  └────────┘    Esc / ⏱       └────────┘         │
       │                          │              │
       └──────────────────────────┴──────────────┘
                  ⏱ / ⛶ / Esc
```

**Transition rules:**
- `Esc` always returns to `edit` (universal escape).
- `Run` is non-modal-ish: while in `run`, you can navigate the viewport but cannot edit. Submitting a new render from `edit` enters `run`; job completion auto-returns to `edit` unless user intercepts.
- `Animate` ↔ `Edit` is a soft toggle (timeline dock slides in/out).
- `Director` is reachable from any mode; exiting always lands in `edit`.

### 3.5 The Canvas-mounts-once invariant (CRITICAL)

**V11 / K1 step 6:** the Three.js Canvas DOM node MUST stay mounted across all mode changes and panel-collapse toggles. This is the load-bearing structural rule for all R6 region work.

**Mechanism:** mode toggling and panel-collapse changes `display`, `grid-template-columns`, `pointer-events`, and `data-mode` attributes only. Never `display: none` on the Canvas's parent in a way that detaches the WebGL context. Never conditionally render the Canvas in JSX — it lives inside `<div style={{ gridArea: 'viewport' }}>` permanently.

If a developer is ever tempted to write `{mode !== 'director' && <Viewport />}` — that is a bug. The correct pattern is `<div style={{ gridArea: 'viewport' }}><Viewport /></div>` and the parent grid hides chrome regions around it.

---

## 4. Pillar 2 — Visual System (Tokens)

### 4.1 Color palette (extend existing `tailwind.config.ts`)

Existing tokens stay; new tokens fill gaps for state, depth, and channel-color semantics.

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0a0a0a` | Application background |
| `bg-1` (NEW) | `#111111` | Panel surface (one step above bg) |
| `bg-2` (NEW) | `#161616` | Raised surface (toolbar, floating bar) |
| `muted` | `#1a1a1a` | Inputs, button background, hover surfaces |
| `border` | `#262626` | All 1px dividers and panel edges |
| `border-strong` (NEW) | `#3a3a3a` | Hover/focus ring on interactive elements |
| `fg` | `#e5e5e5` | Primary text |
| `fg-dim` (NEW) | `#a3a3a3` | Secondary labels, captions |
| `fg-mute` (NEW) | `#525252` | Tertiary / disabled / placeholder |
| `accent` | `#5af07a` | Primary accent — selection, focus, active state |
| `accent-dim` | `#3fa055` | Hover variant |
| `warn` (NEW) | `#f0b85a` | Caution (e.g. unsaved changes, dryRun cost preview) |
| `error` (NEW) | `#f05a5a` | Destructive actions, error state |
| `record` (NEW) | `#f04a4a` | Animate-mode auto-key indicator (red record dot) |

**Channel colors** (Animate mode dopesheet — per-axis identity):

| Token | Hex | Channel |
|---|---|---|
| `ch-x` (NEW) | `#f06464` | X axis — keyframes on rotX, posX |
| `ch-y` (NEW) | `#64f08c` | Y axis |
| `ch-z` (NEW) | `#6496f0` | Z axis |
| `ch-w` (NEW) | `#c896f0` | W (quat) / scalar / value |

These mirror the gizmo's RGB convention (industry standard) so eye stays trained on one color language.

### 4.2 Typography

Single typeface: **JetBrains Mono** with Geist Mono / system mono fallback. Already configured in tailwind. No additional fonts.

Type scale (rem; root font-size 14px):

| Token | rem | px | Use |
|---|---|---|---|
| `text-[10px]` | 0.625 | 10 | Status footer, fine print |
| `text-xs` | 0.75 | ~10.5 | **Default body** — labels, lists, inspector |
| `text-sm` | 0.875 | ~12 | Section headers in inspector |
| `text-base` | 1 | 14 | Modal titles, empty-state hints |
| `text-lg` | 1.125 | ~16 | Top-level panel titles (Director Cut header) |

Mono-only is intentional: Basher is a director's tool; the typographic register is "console", not "consumer app". Per existing decision in `src/index.css`.

### 4.3 Spacing scale

4px grid. Tailwind defaults work directly:

| Token | px | Use |
|---|---|---|
| `gap-1` / `p-1` | 4 | Tight icon-button group |
| `gap-2` / `p-2` | 8 | Default inline spacing |
| `gap-3` / `p-3` | 12 | Inspector section internal padding |
| `gap-4` / `p-4` | 16 | Section outer padding |
| `gap-6` / `p-6` | 24 | Modal padding |

Region heights:
| Region | px |
|---|---|
| R1 project-tabs | 32 |
| R2 menu-bar | 28 |
| R3 top-toolbar | 40 |
| R10 status-footer | 22 |
| R9 timeline-dock | 280 (resizable 200–480) |

### 4.4 Border radius

| Token | px | Use |
|---|---|---|
| `rounded-sm` | 2 | Inputs, small buttons |
| `rounded` | 4 | **Default** — most components |
| `rounded-md` | 6 | Floating viewport toolbar, modals |
| `rounded-lg` | 8 | Reserved for primary CTAs (Render, Submit) |

No fully-rounded buttons. Pill shapes are reserved for status badges only.

### 4.5 Elevation / shadow

The aesthetic is **flat with 1px borders**. Panels distinguish via `bg-1`/`bg-2` step changes, not shadows. Three exceptions:

| Token | Use |
|---|---|
| `shadow-sm` | Floating viewport toolbar (R8) lifts ~2px off viewport |
| `shadow-md` | Add menu (R6 right-click context) |
| `shadow-lg` | Modal dialogs |

### 4.6 Motion

Every transition is short and linear; no ease-out bouncing.

| Token | Duration | Use |
|---|---|---|
| `duration-75` | 75ms | Hover states, button press |
| `duration-150` | 150ms | Panel show/hide, mode switch |
| `duration-300` | 300ms | Timeline dock slide-in/out, panel collapse/expand |

Reduced-motion: when `prefers-reduced-motion: reduce`, all durations clamp to 0. Implementation: a Tailwind variant `motion-reduce:duration-0` applied to every `transition-` class on regions.

---

## 5. Pillar 3 — Component Inventory

For each component: location, anatomy, states, behavior, what's already shipped vs. new.

### 5.1 R1 ProjectTabs (NEW)

**Location:** new component at `src/app/ProjectTabs.tsx`. Owns top region.

**Anatomy:**
```
[ ⌂ MyShortFilm  × ] [ ⌃ Splat-Test  × ] [ + ]                        [ ⊙ Me ]
   ^ active            ^ inactive          ^ new      flex spacer        ^ profile
```

**States:** active (accent underline + bg-1), inactive (fg-dim + transparent), hover-inactive (fg + border-strong underline 2px), pressed-x (warn-tinted), unsaved-dot (D-UX-12 — warn-colored 6px dot before name).

**Unsaved indicator (D-UX-12):**
- Dot appears when `projectStore.current.dirty === true`
- Hover anywhere on the tab → tooltip after 600ms: `"unsaved changes · last saved Nm ago"` if a prior save exists, else `"unsaved changes · never saved"`
- Tooltip text uses `lastSavedAt` from project meta; renders relative time (Nm/Nh/Nd ago)
- Right edge of R1 also shows `[● live]` ComfyUI indicator (D-UX-13)

**Behavior:**
- Click name → switch project (calls `useProjectStore.setCurrent`)
- Click `×` → confirm if unsaved, then close
- Click `+` → opens ProjectsMenu with "New project" focused
- Drag-reorder tabs (out of scope for v0.5; spec reserves the affordance)

**Existing substrate:** `ProjectsMenu.tsx` 194 LOC. ProjectTabs is new but reads from same store. `lastSavedAt` already exists on `projectStore.current` (Chrome.tsx uses it).

### 5.2 R2 MenuBar (EXTEND)

**Location:** `src/app/MenuBar.tsx` (548 LOC, exists).

**Anatomy:** standard top menu — `File / Edit / View / Object / Add / Render / Animate / Help`.

**Changes for v0.5:**
- Add `Animate` menu (Add Keyframe, Toggle Auto-key, Simplify Channel, Clear Channel)
- Add `Render` menu (Run Workflow, Cancel, Open Render Folder)
- Existing entries unchanged

### 5.3 R3 TopToolbar (NEW container, REUSE TransformToolbar internals)

**Location:** new wrapper at `src/app/TopToolbar.tsx`. Mounts existing `TransformToolbar` in its left segment.

**Anatomy (left → right):**
```
[+ Add▾]  [↖ Select  ✥ Tx]  │  [◐ Edit │▶ Run│⏱ Anim│⛶ Dir]  │  [100% ▾]  [⬇ Export]  [⛚ Present]
└── primary-actions ────────┘  └── operational-mode ─────┘  └── viewport ──┘  └── output ───┘
```

**State:** Mode segment uses 4-button pill group; active mode = `bg-accent`/`text-bg`, inactive = `bg-muted`/`text-fg-dim`. Click = setMode. Keyboard: `1` `2` `3` `4` cycle modes when not in an input.

**Existing substrate:** `TransformToolbar.tsx` already does the transform tool affordance; folds into left segment.

### 5.4 R4 ToolRail (NEW)

**Location:** new component at `src/app/ToolRail.tsx`.

**Anatomy:** vertical icon column, ~32px wide. User-collapsible to 0 via small `›` button at top of column; persisted to `localStorage`. Hidden in `mode === 'director'`.

| Icon | Tool | Shortcut |
|---|---|---|
| ↖ | Select | `Q` |
| ✥ | Translate | `W` |
| ⟲ | Rotate | `E` |
| ⤢ | Scale | `R` |
| + | Add primitive | `A` |
| T | Text | (defer) |
| ✦ | Light | `L` |
| ⌖ | Camera | `C` |
| ⛓ | Link / Group | `G` |

**State:** active tool = `text-accent + bg-1`, hover = `text-fg + bg-1`, default = `text-fg-dim`.

**Behavior:** click sets `editorStore.activeTool`. Tooltips appear on hover after 600ms (Tailwind + `delay-[600ms]`).

### 5.5 R5 LeftSidebar (EXTEND, add Agent tab)

**Location:** new wrapper at `src/app/LeftSidebar.tsx` (W3) mounts existing `SceneTree` and `AgentChat` as tab contents. Library tab dropped per W2.5 — see §5.5.2.

**Anatomy:**
```
┌──────────────────────────────────┐
│ [Scene]   Agent                   │  <-- tab strip, height 28 (2 tabs)
├──────────────────────────────────┤
│  Filters: ◉ All Rot ◉ All Trans   │  <-- only in Animate mode + Scene tab
├──────────────────────────────────┤
│  ▾ MyShortFilm                    │
│    ▾ Shot01                       │
│      · Camera                     │
│      · KeyLight                   │
│  …                                │
└──────────────────────────────────┘
```

**Tab list (P6 W2.5 — 2 tabs, not 3):**
- **Scene** — DAG tree, edge-kind aware (see 5.5.1). In Animate mode, each row shows keyframe count badge.
- **Agent** — LLM director chat. Existing `AgentChat.tsx` 209 LOC.

**State:** active tab = `text-accent + border-bottom-2 border-accent`. Persist active tab to `localStorage` so it survives reload.

#### 5.5.2 Bundled-asset access (P6 W2.5 — replaces Library tab)

The Library tab was dropped because its sole content was a 3-tile palette of bundled glTF samples (cube/sphere/cone). Three tiles do not justify a permanent left-sidebar tab; AddMenu's procedural primitives (BoxMesh / SphereMesh) cover the same intent more flexibly.

**Replacement surface — AssetsPopover** (`src/app/AssetsPopover.tsx`):
- Triggered by an "Assets" button in TopToolbar's left zone (next to Add)
- Click opens a fixed-position popover anchored below the trigger
- Renders the 3 bundled glTF tiles with HTML5 drag (drag onto viewport → AssetDropZone fires the same drop chain as P1 Wave B; no contract change)
- Closes on outside-click, Esc, or drag-end
- e2e tests target `library-popover` (root) + `library-popover-item-{path}` (tile)

**Why this is preferred over a dedicated panel:**
- Reclaims 180px of permanent screen real estate for SceneTree / viewport
- One-click reach preserved (AddMenu pattern)
- HTML5 drag-with-cursor-positional-control preserved (the affordance the panel provided that AddMenu's click-spawn doesn't)

**What's NOT in Library / AssetsPopover:**
- Mutators — surface in DiffBar (when an Op chain is pending) and (W4 onward) in NPanel sections relevant to selection
- Strategies — agent-side; no chrome surface in v0.5
- Presets — render-side; surface in NPanel's Render section (CostPreview, P5 W C5)
- User-imported assets — appear as nodes in SceneTree after AssetDropZone fires; not surfaced in the bundled-glTF popover

#### 5.5.1 Edge-kind visualization in Scene tree

Basher's DAG has 7 edge kinds: `parent`, `children`, `camera`, `lights`, `time`, `animation`, `pass-input`. Tree should make edge kind legible:

| Edge kind | Glyph | Color |
|---|---|---|
| `parent` / `children` | (no glyph; standard tree indent) | — |
| `camera` | ⌖ | `ch-z` |
| `lights` | ✦ | `warn` |
| `time` | ⏱ | `accent-dim` |
| `animation` | ⟿ | `accent` |
| `pass-input` | ↪ | `ch-y` |

Glyph appears as a small badge on the row's relationship icon — never in the row's primary label area (which is reserved for the node name).

### 5.6 R6 Viewport (UNCHANGED contract; minor overlay additions)

**Location:** `src/viewport/Viewport.tsx` (existing).

**Invariant:** mounts once; never unmounted by mode/density change. See §3.5.

**Overlays (DOM, on top of Canvas):**
- `<DiffBar />` — top-left, last Mutator metadata (existing)
- `<NPanel />` — right-edge selection-adaptive (existing) — see 5.8 for sections
- `<AddMenu />` — right-click context (existing)
- Mode badge — top-right corner: `EDIT` / `RUN N/240` / `ANIMATE 24fps` / `DIRECTOR`. Hidden in `director` mode.

### 5.7 R8 FloatingViewportToolbar (EXTEND existing TransformToolbar concept)

**Location:** new component at `src/app/FloatingViewportToolbar.tsx`. Lives as overlay inside R6.

**Anatomy (already drafted in earlier sketch):**
```
┌───────────────────────────────────────┐
│  ↖  ✥  ⟲  ⤢  │  ⌂  ⊞  │  ⊙  ◉   │
│ sel mv rot scl  home grid  persp ortho │
└───────────────────────────────────────┘
```

**Position:** absolute, `bottom-4 left-1/2 -translate-x-1/2`. `bg-bg-2/90 backdrop-blur-sm` + `border-strong` + `rounded-md` + `shadow-sm`.

**Behavior:** click move/rot/scale → setActiveTool (mirrors R4). Click home → orbitControls.target = scene center, distance = bounding box. Click grid → toggle grid in viewportStore. Click persp/ortho → camera projection toggle.

### 5.8 R7 Inspector — NPanel canonical (D-UX-8 merge)

**Location:** `src/app/NPanel.tsx` is **the canonical Inspector**. The grid `inspector` slot mounts the same `<NPanel />` component (no longer a separate `Inspector.tsx`). `Inspector.tsx` was **deleted in W2.6** (the original D-UX-8 plan said W1, but the mid-W1 correction kept Inspector around because NPanel still had unique viewport-toggle content; W2's TopToolbar absorbed those toggles, leaving NPanel with nothing unique → merge unblocked).

**Why merge (D-UX-8):** two stores of inspector truth was a V13 closure violation risk — drift between the docked Inspector and the overlay NPanel was bound to happen as sections grew. One canonical surface, one section registry, one selection-adaptive engine.

**Layout role:** NPanel is a docked panel in R7 (right column). The viewport-overlay NPanel mount is dropped (W2.6); if a future floating-inspector affordance is needed, it'll be a single re-mount of the same component into a different layout slot, not a parallel implementation. The viewport-toggle sections (grid / axis show-hide) that NPanel previously hosted move to W7's FloatingViewportToolbar — the natural home per Spline pattern.

**testid contract:** the merged NPanel preserves all `inspector-*` testids verbatim (`inspector` root, `inspector-vec-*`, `inspector-input-*`, `inspector-scrub-*`) so the existing P0/P2/P3/P5 e2e suite passes through the merge without migration.

**Section convention:** each Inspector section is a collapsible card.

**Section anatomy:**
```
┌────────────────────────────┐
│ ▾ Transform               │  <-- header: chevron + label, click to collapse
├────────────────────────────┤
│   X       0.00            │
│   Y       0.00            │  <-- body: rows of (label) (input + scrubber)
│   Z       0.00            │
└────────────────────────────┘
```

**Section ordering rule (defines what appears first per node type):**
1. Domain-of-selection sections first (Mesh for SphereMesh, Render for ComfyUIWorkflow, Animate for KeyframeChannel)
2. Common sections (Transform, Material) — middle
3. Foundational sections (Layout, Metadata) — bottom

**Default-collapsed convention:** sections that aren't the *primary* domain of the selected node type are collapsed by default. Persisted per-node-type in `localStorage` so the user's collapse choice sticks.

**Section catalog (v0.5):**

| Section | Appears when selection includes | Owner |
|---|---|---|
| Transform | any node with x/y/z params | core |
| Mesh | mesh-bearing node | meshes |
| Material | material-bearing node | materials |
| Render | RenderJob, ComfyUIWorkflow, *Pass | render — **CostPreview lives here** (P5 shipped) |
| Animate | KeyframeChannel*, AnimationLayer, Curve | animation — Record/AddKey/Simplify/Clear |
| Channel | KeyframeChannel* (deeper detail when Animate active) | timeline |
| Layout | always last; positioning hints | core |

**CostPreview** (already shipped Wave C5) lives in the `Render` section. No re-port needed; the spec just records its home.

### 5.9 R9 TimelineDock (EXTEND existing TimelineDrawer + add tab structure)

**Location:** existing `src/timeline/TimelineDrawer.tsx` 58 LOC. Spec rewrites this file to host tab structure; underlying `Dopesheet.tsx` and `CurveEditor.tsx` are reused.

**Anatomy:**
```
┌─────────────────────────────────────────────────────────────────────────┐
│ Tabs: [Dopesheet] Curve Editor                       Range: 1 — 240 fr │  height 28
├─────────────────────────────────────────────────────────────────────────┤
│ Track filters: ◉ All Rot · ◉ All Trans · ○ Selected only                │  height 28
├──────────────────────────────────┬──────────────────────────────────────┤
│ Channel rows (sticky)            │ Time × Value canvas (imperative)     │
│  width 240px, scroll-sync        │  width fluid                          │
│                                  │                                      │
│ ▾ Cube                           │  ◇  ◇    ◇        ◇                  │
│   · pos.x   3 keys               │  ◇    ◇                              │
│   · rot.z   5 keys               │  ◇    ◇    ◇    ◇                    │
│ …                                │  ↕ playhead (imperative)             │
├──────────────────────────────────┴──────────────────────────────────────┤
│  Key Insert Delete │ Simplify Clear │ Cut Copy Paste │ ◀◀ ◀ ▶ ▶▶  24/240│  height 28
└─────────────────────────────────────────────────────────────────────────┘
```

**Visibility:** rendered into grid `timeline` slot at all times; `display: mode === 'animate' ? 'flex' : 'none'`. Component tree stays mounted (V8 + V11 — store subscriptions don't tear down).

**Resize:** top edge is a drag handle; clamps 200–480px; persists to `localStorage`.

**Tab semantics (D-UX-2):**
- **Dopesheet tab:** rows = channels grouped by AnimationLayer; columns = time. Diamonds = keyframes. Click diamond = select keyframe (sets `timelineSelection.activeKeyframeId`). Drag diamond = move time (Wave 2 imperative).
- **Curve Editor tab:** when entered, reads `timelineSelection.activeChannelId`. Renders per-axis curve (rotX rotY rotZ separately for Quat channels). Drag handles to reshape Bézier easing.

**Track filters:** `All Rot` toggles visibility of rotX/Y/Z/W rows; `All Trans` toggles posX/Y/Z; `Selected only` filters to currently-selected node's channels.

**Bottom toolbar — track ops (D-UX-2 + Reze patterns):**
- `Key` — insert keyframe at current frame on selected channels
- `Insert` — insert blank frame (push subsequent keys forward)
- `Delete` — delete selected keyframe(s)
- `Simplify` — tolerance-based reduction (modal asks for tolerance ε); fires `mutator.anim.simplifyChannel`
- `Clear` — wipe all keyframes from selected channel; fires `mutator.anim.clearChannel`
- `Cut/Copy/Paste` — keyframe clipboard scoped to channel-type compatibility

### 5.10 Status info distribution (D-UX-5: no dedicated footer)

Per Spline pattern, there is no dedicated status footer. Status info is distributed across existing chrome:

| What | Where | When |
|---|---|---|
| Active project + last-saved relative time | R1 ProjectTabs (tooltip on hover, D-UX-12) | Always |
| ComfyUI live indicator `[● live]` | R1 right edge | Always; states: green=Http, gray=Stub, yellow=probing (D-UX-13) |
| Frame N / total | R9 TimelineDock header (right side) | Animate mode only |
| FPS | R9 TimelineDock header | Animate mode only |
| Render progress `rendering N/M` | R6 viewport overlay (top-right corner) | Run mode only — overlay, not footer |
| Selection summary | R7 Inspector header `"Cube"` or `"3 selected"` | Always |
| Build version | R3 TopToolbar right edge (small mute text) | Always |

This eliminates the need for a 22px-tall status row, saves vertical space, and matches Spline's chrome density.

---

## 6. Pillar 4 — Interaction Patterns

### 6.1 Selection model

Single-primary, multi-secondary. Existing `selectionStore` already implements this. Spec records the visual semantics:

- Primary selection (for inspector): `outline-accent` 2px on viewport gizmo; `bg-accent/10 + border-l-2 border-accent` on tree row
- Secondary: `outline-accent-dim` 1px; `bg-fg-dim/5` on tree row
- Hover (no selection): `bg-muted` on tree row; gizmo unchanged

**Selection clearing:** click on viewport empty space → clear; `Esc` → clear AND return to mode `edit`.

### 6.2 Keyboard model

**Always-available shortcuts** (active even when input focused → `Cmd/Ctrl` prefix):

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+S` | Save project |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` / `Cmd/Ctrl+Y` | Redo |
| `Cmd/Ctrl+P` | Command palette (out of scope for v0.5; reserved) |
| `Esc` | Clear selection + return to mode `edit` |

**Mode-switch shortcuts** (active when not in input):

| Shortcut | Action |
|---|---|
| `1` | Mode = edit |
| `2` | Mode = run (no-op if no active workflow) |
| `3` | Mode = animate |
| `4` | Mode = director |

**Tool shortcuts** (active when not in input, mode ∈ {edit, animate}):

| Shortcut | Action |
|---|---|
| `Q` | Tool = select |
| `W` | Tool = translate |
| `E` | Tool = rotate |
| `R` | Tool = scale |
| `A` | Open Add menu at cursor |
| `G` | Group selection |

**Animate-mode shortcuts** (active when mode=animate, not in input):

| Shortcut | Action | Source |
|---|---|---|
| `Space` | Play / pause | Reze pattern |
| `←` / `→` | Frame step −1 / +1 | Reze |
| `Shift+←/→` | 10-frame step | extension |
| `Home` / `End` | Jump to first / last frame | Reze |
| `K` | Insert keyframe at current frame on selected channels | extension |
| `Shift+scroll` (over timeline) | Zoom Y-axis (value range) | Reze |
| `Cmd/Ctrl+scroll` (over timeline) | Zoom X-axis (time range) | Reze |

**Viewport-camera shortcuts** (active in viewport):

| Shortcut | Action |
|---|---|
| `Numpad 1/3/7` | Front / Side / Top view |
| `Numpad 5` | Toggle persp/ortho |
| `F` | Frame selection |
| `Home` (in viewport) | Frame all |

**Keyboard discipline:** all key handlers are wired through a single `KeyboardShortcuts.tsx` (exists, 0 LOC unknown — verify) with `if (e.target.tagName === 'INPUT' || ... 'TEXTAREA')` guard. No `addEventListener` calls in individual components.

### 6.3 Drag/drop

**Asset drop:** AssetDropZone exists (P2.1). FBX/BVH/glTF/PMX dropped on viewport → import flow. Drop overlay: `bg-accent/10 + border-2 border-dashed border-accent + text-accent-dim "Drop to import"`.

**Tree drag-reparent:** Out of scope v0.5. Spec reserves the affordance.

**Timeline keyframe drag:** Wave 2 (D-UX-3). Wave 1 lays the visuals; drag is keyboard-only via Cut/Paste at first.

### 6.4 Mode-switching ergonomics

Mode switch is a chrome action — never a per-element control. Trigger paths:

1. Top-toolbar mode segment (R3 — primary)
2. Keyboard `1`/`2`/`3`/`4`
3. Menu Bar `View → Mode → …`
4. Auto: render-job submission triggers `mode=run`; job-done triggers `mode=edit`

Mode switches cause: timeline dock slide-in/out (300ms); top-bar mode-segment active-state shift (75ms); R6 mode-badge update; gizmo color (Animate uses `record` accent, Edit uses `accent`); in `director`, R1/R2/R4/R5/R7 hide and R3 collapses to a minimal title overlay (300ms).

### 6.5 Agent turn UX

Agent tab in R5 has a chat shape:
```
┌──────────────────────────────────┐
│ Scene  [Agent]                    │
├──────────────────────────────────┤
│ ▾ history                        │
│   you:    add a key light       │
│   agent:  ⚙ addLight(...) ✓     │
│           ⚙ orbitTo(...) ✓      │
│   you:    make it warmer        │
│   agent:  ⚙ setLightColor ✓     │
├──────────────────────────────────┤
│ [type a directive…]         [↵] │
└──────────────────────────────────┘
```

**Tool-call rows:** when the agent calls a Mutator, render `⚙ {mutatorName}({args}) {✓|✗}` with the args truncated to one line. Click row to expand args + see DAG diff.

**During agent turn:** disable input; show typing indicator. After turn: show `❑ N changes` summary with "Undo turn" affordance (existing `mutator.lifecycle.commitTurn` per H22).

---

## 7. Pillar 5 — Information Architecture

### 7.1 What lives where

| Concept | Lives in | Read by |
|---|---|---|
| DAG nodes & edges | `dagStore` | Scene tree, NPanel, Inspector, Viewport, all execution layers |
| Selection | `selectionStore` | Scene tree highlight, NPanel filter, gizmo |
| Operational mode | `modeStore` (existing — type signature changes per D-UX-5) | Layout grid, top toolbar, gizmo color, R6 mode badge |
| Panel collapse state | `chromeStore` (NEW) | R4/R5/R7 visibility (independent toggles, not a density axis) |
| Active tool | `editorStore.activeTool` | Tool rail, floating toolbar, viewport pointer behavior |
| Time / playback | `timeStore` | Timeline playhead, viewport per-frame scrub |
| Timeline UI selection | `timelineSelection` (existing) | Dopesheet highlight, Curve Editor focus |
| Viewport state | `viewportStore` | Camera projection, grid, dragScrub, `currentFrameRef` (NEW Wave 2) |
| Render jobs | `renderJobsStore` | NPanel Render section, status footer, Run-mode overlay |
| Agent session | `useAgentSessionStore` (existing) | Agent tab transcript |

### 7.2 Selection-adaptive Inspector rules

When selection changes, Inspector recomputes which sections appear:

```
section.appearsWhen(selection):
  if selection.empty:                  return ['Project']                     // future: project-level metadata
  if selection.size > 1:               return ['Transform', 'Metadata']       // common-only
  node = selection.primary
  base = ['Transform', 'Layout']
  domain = sectionsByNodeType[node.type] // declared in node-type registry
  return interleave(domain, base)
```

`sectionsByNodeType` lives in node registration (each node type declares which Inspector sections apply). Adding a new node type = adding its row to this table; Inspector picks up automatically. This means the Inspector's behavior is owned by node registration (V14 alignment), not the Inspector component itself.

### 7.3 Persistent vs ephemeral state

**Persisted to localStorage:**
- mode (except `run` and `director` — neither persists; resets to last persisted on reload)
- chromeStore (R4/R5/R7 collapsed states, independent)
- left-sidebar active tab
- inspector section collapsed state (per node type)
- timeline dock height
- agent transcript visibility

**Persisted to project save (IDB):**
- DAG state (dagStore)
- Selection — at session checkpoint only
- Time — at session checkpoint only

**Pure-ephemeral (lost on reload):**
- Hover state
- Tooltips
- Modal dialogs
- Drag operations in flight
- Mode = `run`

---

## 8. Pillar 6 — Accessibility & Responsive

### 8.1 Focus order

Tab order through the editor (when keyboard navigation engaged):

```
R1 ProjectTabs → R2 MenuBar → R3 TopToolbar → R4 ToolRail → R5 LeftSidebar
  → R6 Viewport (focusable but no tab-cycle of contents) → R7 Inspector (NPanel)
  → R9 TimelineDock (when visible)
```

In `mode === 'director'`, R1 R2 R4 R5 R7 are hidden and removed from focus order; tab cycles only R3 (collapsed) → R6 → R9 (if Animate) and Esc returns to `edit`.

Within each region: left-to-right, top-to-bottom. Viewport is a single tab stop; once focused, arrow keys nudge selection (not tab).

### 8.2 Keyboard-only operability

Every control reachable by keyboard. Floating toolbar (R8) tab-reachable from viewport via `Tab` (then arrow-keys within). Tool rail buttons reachable both via tab AND via the global Q/W/E/R shortcuts.

**Skip-link:** first focusable element on page is a visually-hidden "Skip to viewport" link. Press `Tab` immediately after page load → focus jumps to R6.

### 8.3 Screen-reader semantics

Every region has `role="region"` + `aria-label`. Regions:
- R1 = "Project tabs — {active project}, {save state}"
- R2 = "Menu bar"
- R3 = "Toolbar — mode {currentMode}"
- R4 = "Tool rail — {activeTool}"
- R5 = "Sidebar — {activeTab}"
- R6 = "3D viewport — {selection summary}"
- R7 = "Inspector — {node name or 'no selection'}"
- R9 = "Timeline — {mode and current frame}"

The viewport's aria-label updates on selection change (debounced 200ms). This is the screen-reader's only handle on what the user is doing in 3D.

### 8.4 WCAG contrast

All text/background pairs in normal use must meet **WCAG AA** (4.5:1 small text, 3:1 large/UI). Check against current tokens:

| Foreground | Background | Ratio | Verdict |
|---|---|---|---|
| `fg #e5e5e5` | `bg #0a0a0a` | 16.4 | ✓ AAA |
| `fg-dim #a3a3a3` | `bg #0a0a0a` | 9.3 | ✓ AAA |
| `fg-mute #525252` | `bg #0a0a0a` | 3.5 | ✓ AA-large only — **must not be used for body text** |
| `accent #5af07a` | `bg #0a0a0a` | 11.6 | ✓ AAA |
| `fg-mute` | `muted #1a1a1a` | 2.8 | ✗ — not allowed |

**Rule:** `fg-mute` only on `bg`/`bg-1` and only at `text-base` (14px) or larger. Never on `muted` background.

### 8.5 Responsive breakpoints

Three breakpoints, density-aware:

| Min width | Behavior |
|---|---|
| `< 1024` | R4/R5/R7 force-collapsed (chromeStore overrides locked open); user can expand individually but layout warns at < 900px |
| `1024–1439` | All panels available; chromeStore controls collapse; default = R4/R5/R7 expanded |
| `≥ 1440` | All panels available; default same as 1024–1439 |

Below 900 we ship a **viewport-only banner** ("Basher needs ≥ 1024 width to edit; viewport-only at this size") in v0.5. Full mobile read-only mode out of scope.

### 8.6 Reduced motion

Already covered in 4.6. Add: dragScrub continues to work (gesture is the user's input, not animated motion). Mode-transition slide is the only meaningful affected animation.

---

## 9. Component dependency map

What each new/extended component depends on:

```
ProjectTabs (NEW)         -> projectStore (uses lastSavedAt for tooltip, dirty for dot)
MenuBar (EXTEND)          -> mutator dispatch, modeStore (type-changed)
TopToolbar (NEW wrapper)  -> editorStore, modeStore, TransformToolbar (existing)
ToolRail (NEW)            -> editorStore.activeTool, chromeStore (NEW for collapse)
LeftSidebar (NEW wrapper) -> leftSidebarStore (NEW), chromeStore (NEW), Library (existing), SceneTree (extend), AgentChat (existing)
SceneTree (EXTEND)        -> dagStore, selectionStore, modeStore (Animate badges)
NPanel canonical (EXTEND) -> selectionStore, dagStore, sectionsByNodeType (NEW registry table), chromeStore (collapse)
FloatingViewportToolbar (NEW) -> editorStore, viewportStore
TimelineDock (REWRITE)    -> timeStore, timelineSelection (existing), modeStore
Dopesheet (REWRITE W9)    -> dagStore, currentFrameRef (NEW W9 in viewportStore)
CurveEditor (EXTEND)      -> timelineSelection, dagStore (channel param read)
ComfyStatusIndicator (NEW)-> comfyCapability (boot result + 30s probe + hover-probe), modeStore (probe gating)
KeyboardShortcuts (EXTEND) -> all stores via dispatch
```

`Inspector.tsx` is **deleted** (D-UX-8 merge). `StatusFooter.tsx` is **not created** (D-UX-5 distributes status info into existing chrome).

No new external deps. Tailwind extensions only. shadcn deferred to v0.6 per D-UX-11.

---

## 10. Rollout phases (P6 implementation)

| Wave | Scope | Files | Tests |
|---|---|---|---|
| **W1** | Tokens + Layout + Mode type repurpose + chromeStore. Inspector + NPanel both retained in W1 (NPanel removal moves to W7 per D-UX-8 correction) | `tailwind.config.ts`, `src/app/Layout.tsx`, `src/app/stores/modeStore.ts` (Mode type-change), `src/app/stores/chromeStore.ts` (NEW), `src/app/ModeSwitcher.tsx` (option-set update), `src/app/MenuBar.tsx` (any density references) | Unit: mode store coercion of legacy values, chromeStore collapse persistence. e2e: mode-switch, Esc-to-edit, panel collapse, Canvas address stable across all transitions |
| **W2** | TopToolbar + ToolRail + ComfyStatusIndicator | `src/app/TopToolbar.tsx`, `src/app/ToolRail.tsx`, `src/app/ComfyStatusIndicator.tsx` | e2e: keyboard 1/2/3/4 mode-switch, Q/W/E/R tool-switch, indicator state changes |
| **W3** | LeftSidebar tabs + ProjectTabs + Agent tab home + AddMenu shared store | `src/app/LeftSidebar.tsx`, `src/app/ProjectTabs.tsx`, `src/app/stores/addMenuStore.ts` (extend) | e2e: tab persists across reload, Agent transcript still works, AddMenu reachable from both right-click + toolbar `+` |
| **W4** | NPanel section convention + sectionsByNodeType registry + section catalog (Transform / Mesh / Material / Render / Animate / Channel / Layout) | `src/app/NPanel.tsx`, node-type registrations | Unit: section ordering rule per node type. e2e: collapsed-state persists per node type |
| **W5** | TimelineDock tab structure (Dopesheet + Curve Editor as tabs) | `src/timeline/TimelineDrawer.tsx` rewrite | e2e: tab switch, Animate-mode gating, dock resize-persist |
| **W6** | Animate-mode keyboard model + track ops Mutators (Simplify/Clear) | `src/app/KeyboardShortcuts.tsx`, 2 new Mutators | Unit: track ops as Mutators (V14 alignment). e2e: Space play, K insert, Shift/Ctrl-scroll zoom |
| **W7** | Floating viewport toolbar + viewport overlays + R6 mode badge + Director mode (chrome-hidden) | `src/app/FloatingViewportToolbar.tsx`, `src/app/Layout.tsx` (mode-director gating), R6 mode badge | e2e: floating toolbar reachable via tab, Director-mode hides R1/R2/R4/R5/R7 and Esc returns to edit |
| **W8** | Accessibility pass — focus order, aria-labels, skip-link, contrast audit | global | Playwright a11y snapshot + manual NVDA pass |
| **W9** *(Wave 2 of D-UX-3)* | Imperative `currentFrameRef` + TimelineCanvas hot-path rewrite | `src/timeline/TimelineCanvas.tsx` (NEW), `viewportStore` extension | Perf: 240-frame scrub holds 60fps on M1 baseline |
| **W10** | UI-REVIEW retroactive audit + spec refinement | `/anvi:ui-review` | UI-REVIEW.md updates this doc |

W1–W8 = visual port (Wave 1 of D-UX-3). W9 = hot-path (Wave 2). W10 = audit pass.

Estimated wall-time: 7–9 working days for W1–W8 (slightly less than original 8–10 estimate after dropping density refactor); W9 standalone 2–3 days; W10 0.5 day.

---

## 11. Acceptance criteria (gating merge)

Before P6 PR can merge:

1. **All region IDs render** (R1–R9) and are reachable via `data-testid`. R10 not implemented (D-UX-5).
2. **Mode type repurposed** — `useModeStore`'s `Mode` is `'edit' | 'run' | 'animate' | 'director'`; legacy `'simple' | 'director' | 'pro'` values coerce to `'edit'` on first read. No density store exists.
3. **Mode persistence** — `edit` and `animate` persist across reload; `run` and `director` reset to last persisted on reload.
4. **`Esc`** universally returns mode → `edit` and clears selection.
5. **Canvas stays mounted** across all mode transitions and panel-collapse toggles — automated check: WebGL context address stable across all 4 modes + 8 panel-collapse combinations in Playwright.
6. **Timeline dock** shows iff `mode === 'animate'`.
7. **Curve editor is a tab** in the timeline dock, not a side panel (D-UX-2).
8. **NPanel is canonical Inspector** (D-UX-8) — `Inspector.tsx` deleted; grid `inspector` slot mounts `<NPanel />`; section ordering matches §5.8 rule for ≥ 4 sample node types (Cube, Light, ComfyUIWorkflow, KeyframeChannelNumber).
9. **Director mode hides chrome** — R1 R2 R4 R5 R7 R9 hidden; R3 collapsed; R6 full-window; Esc returns (D-UX-9).
10. **AddMenu has both entry points** — right-click in viewport AND top-toolbar `+`, both wired through `addMenuStore` (D-UX-10).
11. **ProjectTabs unsaved indicator** — dot when `dirty`, tooltip with relative `lastSavedAt` on hover (D-UX-12).
12. **ComfyStatusIndicator** — capability-flag read at boot + 30s probe gated on `mode === 'run'` + hover-probe; never constant polling (D-UX-13).
13. **Keyboard shortcuts** §6.2 all wired through single `KeyboardShortcuts.tsx`; ESLint guard against duplicate `addEventListener('keydown')`.
14. **Contrast audit** passes WCAG AA on all token pairs in production use.
15. **No new external deps** in `package.json` — Tailwind tokens extended in-place; no shadcn / Radix / class-variance-authority (D-UX-11).
16. **vitest** ≥ 646 maintained; new components add ≥ 25 tests.
17. **Playwright e2e** ≥ 49 maintained; new specs cover mode-switch, tab-switch, panel collapse, AddMenu both-paths, Animate keyboard, Director-mode chrome-hide.

---

## 12. Open questions

All six original open questions resolved 2026-05-10. None block W1.

| ID | Resolution | Decision ID |
|---|---|---|
| **O-1** | Merge — NPanel canonical, `Inspector.tsx` deleted | D-UX-8 |
| **O-2** | Director Cut = chrome-hidden viewport; full review tool deferred to v0.6+ | D-UX-9 |
| **O-3** | Both entry points (viewport right-click + top-toolbar `+`) sharing single `addMenuStore` | D-UX-10 |
| **O-4** | Plain Tailwind for v0.5; no shadcn / Radix; revisit v0.6 | D-UX-11 |
| **O-5** | Dot indicator + "last saved Nm ago" tooltip on hover | D-UX-12 |
| **O-6** | Capability-flag boot read + 30s probe (gated on `mode === 'run'`) + hover-probe; no constant polling | D-UX-13 |

**New open questions (post-resolution):**

| ID | Question | When to resolve |
|---|---|---|
| **O-7** | Should panel-collapse buttons live on the panel's inside edge (Spline pattern) or as a top-strip Hamburger / dot menu (mobile-friendlier)? | W2 visual polish |
| **O-8** | Tooltip primitive — roll a 60-LOC `<Tooltip />` component, or use native `title` attr + `aria-describedby`? | W1 implementation choice |

---

## 13. Glossary

- **Mode** — Operational state. `edit` / `run` / `animate` / `director`. Single axis (no density).
- **Region** — Top-level layout area (R1–R9).
- **Section** — NPanel subdivision (Transform, Mesh, Material, Render, Animate, Channel, Layout).
- **Channel** — Single-axis animation track (`KeyframeChannelNumber/Vec3/Quat/Color` node types).
- **Track** — Synonym for channel in dopesheet context.
- **CostPreview** — P5-shipped Render-section component for dryRun frame estimate.
- **DiffBar** — P5.x-shipped Mutator metadata indicator.
- **NPanel** — The canonical Inspector (D-UX-8). Mounts in R7. Section-based selection-adaptive surface.
- **chromeStore** — NEW W1 store. Tracks per-panel collapse states (R4/R5/R7) independently. Replaces dropped density axis.
- **Director mode** — Operational mode that hides chrome (D-UX-9). Not to be confused with the now-dropped legacy `density='director'` value.

---

## 14. References

- Existing code: `src/app/Layout.tsx`, `src/app/Chrome.tsx`, `src/app/MenuBar.tsx`, `src/app/Inspector.tsx`, `src/app/NPanel.tsx`, `src/app/SceneTree.tsx`, `src/app/Library.tsx`, `src/app/AgentChat.tsx`, `src/app/ProjectsMenu.tsx`, `src/app/ModeSwitcher.tsx`, `src/app/stores/modeStore.ts`, `src/app/stores/editorStore.ts`, `src/app/stores/selectionStore.ts`, `src/app/stores/timeStore.ts`, `src/app/stores/viewportStore.ts`, `src/timeline/Dopesheet.tsx`, `src/timeline/CurveEditor.tsx`, `src/timeline/TimelineDrawer.tsx`, `src/timeline/timelineSelection.ts`
- THESIS.md §11 (mode), §13 (timeline), §17 (persistence), §20 (Cuts), §28 (AI), §32–33 (capabilities), §42 (animation), §43 (passes), §44 (AI render), §45 (Splats deferral)
- Anvi catalogues: `vyapti.md` V8 (file-rooted dispatch), V11 (Canvas-mounts-once), V13 (closure), V14 (Mutator alignment); `krama.md` K1 (boot), K10 (AI render); `hetvabhasa.md` H14 (light-helper invariance), H19/H20/H21 (agent integration), H22 (live-edge `animation` socket), H24 (Identify-v2)
- Reference targets: [Spline UI docs](https://docs.spline.design/basics/understanding-splines-ui), [Spline Timeline](https://docs.spline.design/designing-in-3-d/timeline-animation), [Reze Studio (live)](https://reze.studio/), [Reze Studio (GitHub)](https://github.com/AmyangXYZ/reze-studio)
- Theatre.js evaluation: [@theatre/studio license](https://www.npmjs.com/package/@theatre/studio) (AGPL-3.0-only — blocked per Basher's permissive-only posture)

---

## 15. Change log

| Date | Author | Change |
|---|---|---|
| 2026-05-10 | session capture | Initial draft. D-UX-1…D-UX-6 locked. Reference targets confirmed. Acceptance criteria + rollout waves laid down. Open questions O-1…O-6 captured. |
| 2026-05-10 (rev 2) | session capture | Director directive: "follow exact Spline pattern for base UI". **Density axis dropped** (D-UX-5 redefined). R10 StatusFooter dropped; status info distributed into R1/R3/R6/R9. Spec re-numbered: 9 regions instead of 10. **All 6 open questions resolved** as D-UX-8 through D-UX-13: NPanel canonical (Inspector merge), Director = chrome-hidden, AddMenu both-paths, plain Tailwind, dot+timestamp tooltip, capability-flag + lazy probe. New open questions O-7/O-8 deferred to W1/W2. Rollout W1 simplified (no density refactor). Acceptance criteria expanded from 13 → 17 to cover all locked decisions. |
