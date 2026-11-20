// Floating-island geometry — UX-BACKLOG #2.
//
// The chrome panels (outliner, inspector, playback bar) are detached
// rounded islands floating OVER a full-bleed viewport (Spline-style), not
// docked grid bands. These constants are the ONE source of truth for their
// footprint so the panels, the viewport's own bottom-right widgets (the orbit
// axis gizmo + Persp/Ortho pill), and the e2e gates all agree on where the
// islands sit.
//
// Why the INSPECTOR stops short of the bottom (GIZMO_BAND): the bottom-right
// orbit gizmo + ProjectionToggle float under it (the gizmo lives within ~125px
// of the bottom edge). A full-height inspector would cover them — the H91/V45
// family of "a relocated chrome surface silently overlaps another floating
// surface". Keeping that corner clear is the lowest-coupling fix: no viewport
// widget needs to dodge the inspector.
//
// #1704 — the agent chat left the bottom-centre stack for its own full-height
// column at the window's right (CHAT_COLUMN_WIDTH, a grid column — not an
// island). The bottom-centre island is the playback bar alone, and it sits in
// the bottom band, which the side islands stop above (sideIslandBottom); it
// reserves only the gizmo corner on its right (centerBandInsets).
//
// The surface tokens (rounded-2xl border bg-bg-2/95 shadow-xl backdrop-blur-md)
// are NOT here — they live as Tailwind classes on the island wrappers, matching
// the FloatingViewportToolbar precedent (V39 over-stage chrome, B20 dark chrome)
// so the contrast-matrix gate keeps covering them.
//
// REF: docs/UX-BACKLOG.md #2; docs/SPLINE-UI-REFERENCE.md §1 (③ left / ④ right
// sidebars float over the canvas); vyapti V35 (reveal reachable), V40 (bounded
// internal scroll), V45 / hetvabhasa H91 (floating-surface placement).

/** Gap between an island and the viewport edge (matches Tailwind `*-3` = 12px). */
export const ISLAND_GAP = 12;

/** Outliner (left) island width when expanded. Mirrors the old 260px column. */
export const OUTLINER_WIDTH = 260;

/** Inspector (right) island width when expanded. Mirrors the old 300px column. */
export const INSPECTOR_WIDTH = 300;

/** Width of a collapsed side island — a chevron-only strip (V35: the reveal
 *  affordance stays reachable). Mirrors the old 28px collapsed column. */
export const COLLAPSED_STRIP = 28;

/** Top inset for a CENTER-anchored bounded surface (the 2D View editor) so it
 *  starts BELOW the floating toolbar pill (which sits at top-4 ≈ 16px and is
 *  ~40px tall). The side islands don't need this — they hug the left/right
 *  edges, clear of the centered toolbar — but a centered surface shares the
 *  toolbar's horizontal band and must drop below it (the H91/V45 floating-
 *  overlap family). */
export const CENTER_SURFACE_TOP = 60;

/** How far above the viewport's bottom the INSPECTOR (right island) stops, so
 *  the bottom-right orbit gizmo (drei GizmoHelper, centre 80px from the corner;
 *  measured top ≈ 125px above the bottom at 1440×900) and the Persp/Ortho pill
 *  stay uncovered. */
export const GIZMO_BAND = 140;

/** Clear strip a bottom-anchored CENTRED surface (the 2D View, the Spreadsheet)
 *  leaves for the floating playback bar: the bar (34px measured) plus the island
 *  gap below and above it. With the drawer open the bar moves into its own grid
 *  row and nothing floats there. */
export const PLAYBACK_BAND = 60;

/** #1704 — a side island's bottom inset on the desktop layout. The inspector
 *  clears the gizmo corner. The outliner stops above the floating playback bar
 *  (so the bar can use the whole bottom band, centerBandInsets 'bottom'), and
 *  runs down to the island gap when the drawer is open and nothing floats there. */
export function sideIslandBottom(side: 'left' | 'right', drawerOpen: boolean): number {
  if (side === 'right') return GIZMO_BAND;
  return drawerOpen ? ISLAND_GAP : PLAYBACK_BAND;
}

/** #1704 — the chat column's width when open (the design's ~360px column). */
export const CHAT_COLUMN_WIDTH = 360;

/** #1704 — the folded chat column: a slim rail with the chat icon + ⌘L hint. */
export const CHAT_RAIL_WIDTH = 36;

/** #1704 — at or below this window width, opening chat folds the inspector and unfolding the
 *  inspector folds chat (chatInspectorFold.ts): both open leave too little centre band. */
export const CHAT_INSPECTOR_FOLD_MAX = 1440;

/** #1704 — the width of the chat's grid column. Narrow: 0 — the chat is an
 *  overlay drawer, so the viewport keeps its width. Present: 0 — every chrome
 *  region collapses. Otherwise the open column or the folded rail. */
export function chatColumnWidth(opts: {
  isNarrow: boolean;
  isPresent: boolean;
  open: boolean;
}): number {
  if (opts.isNarrow || opts.isPresent) return 0;
  return opts.open ? CHAT_COLUMN_WIDTH : CHAT_RAIL_WIDTH;
}

/** Below this CSS width the island layout switches to its NARROW variant
 *  (UX-BACKLOG #2 follow-up 2): the side panels and the chat column (#1704)
 *  become off-canvas overlay drawers (closed by default), and the centered
 *  surfaces (toolbar pill + playback bar) go full-width instead of reserving
 *  columns for the islands.
 *  At or above it, the desktop side-by-side island layout applies. Spline and
 *  Blender are desktop tools; rather than let three columns of chrome overlap
 *  when the window is dragged narrow, the editor re-docks to a single column
 *  with the panels on demand. The breakpoint lives HERE only (V46: one geometry
 *  source) — the hook, Layout, and the toolbar all read it from this module. */
export const LAYOUT_NARROW_MAX = 1024;

/** The matchMedia query the narrow-layout hook subscribes to — derived from
 *  LAYOUT_NARROW_MAX so the breakpoint is never duplicated as a literal. */
export const NARROW_LAYOUT_QUERY = `(max-width: ${LAYOUT_NARROW_MAX - 1}px)`;

/** Live width of a side island given its collapse flag: a folded panel is the
 *  28px chevron strip (V35), an open one is its full column width. The ONE
 *  place "how wide is this island right now" is decided, so the islands and the
 *  centered-surface reserve below never disagree. */
export function sideIslandWidth(collapsed: boolean, expandedWidth: number): number {
  return collapsed ? COLLAPSED_STRIP : expandedWidth;
}

/** Width cap for a centered surface that should not stretch the full clear band
 *  (the toolbar pill and the bottom playback bar). The 2D View and the
 *  DiffBar are bars/editors — they fill the band and pass no cap. */
export const CENTER_SURFACE_MAX_WIDTH = 960;

/** #1704 — the bottom-right viewport widgets' footprint, from the viewport's
 *  right edge: the Persp/Ortho pill (≈102px wide, 16px in — measured 1440×900)
 *  and the orbit gizmo's column (centre 80px in, ≈40px radius), plus the gap. A
 *  bottom-band surface never runs under them. */
export const BOTTOM_RIGHT_WIDGETS = 132;

/** Which horizontal band a centred surface lives in. `top`: beside the side
 *  islands (toolbar pill, DiffBar, 2D View / Spreadsheet, which spans down
 *  beside them). `bottom`: the floating playback bar's strip, which the side
 *  islands stop above (sideIslandBottom) — only the gizmo corner is reserved. */
export type CenterBand = 'top' | 'bottom';

/** The px a centred surface keeps clear of the viewport's left and right edges.
 *  #1704 — each side reserves ITS OWN island (plus a gap each side of it), so
 *  folding a panel to its 28px strip frees that panel's whole width. (Before,
 *  surfaces centred on the viewport midpoint and so reserved the WIDER island on
 *  both sides: with chat open at 1440 px a folded inspector freed nothing.)
 *  Narrow: the panels are overlay drawers and the gizmo is hidden, so only the
 *  edge gaps come off. */
export function centerBandInsets(opts: {
  isNarrow: boolean;
  leftCollapsed: boolean;
  inspectorCollapsed: boolean;
  band: CenterBand;
}): { left: number; right: number } {
  if (opts.isNarrow) return { left: ISLAND_GAP, right: ISLAND_GAP };
  if (opts.band === 'bottom') return { left: ISLAND_GAP, right: BOTTOM_RIGHT_WIDGETS };
  return {
    left: 2 * ISLAND_GAP + sideIslandWidth(opts.leftCollapsed, OUTLINER_WIDTH),
    right: 2 * ISLAND_GAP + sideIslandWidth(opts.inspectorCollapsed, INSPECTOR_WIDTH),
  };
}

/** The box of a CENTRED surface — the ONE place that decision is spelled, so a
 *  new centred surface CANNOT be born un-reserved (every one had been
 *  hand-copying the rule; the DiffBar never got a copy and its Apply/Reject sat
 *  under the inspector, #327 — a hand-copied geometry rule drifts like a
 *  hand-copied vocabulary does, V101).
 *
 *  Use as `left` + `transform` + `width` (or `maxWidth` for a shrink-to-fit
 *  pill): the surface is centred on the middle of the clear band and is at most
 *  the band wide (capped at `capPx` when given). */
export function centerSurfaceBox(opts: {
  isNarrow: boolean;
  leftCollapsed: boolean;
  inspectorCollapsed: boolean;
  band: CenterBand;
  /** Optional px cap; omit to fill the whole clear band. */
  capPx?: number;
}): { left: string; width: string; transform: string } {
  const { left, right } = centerBandInsets(opts);
  const band = `calc(100% - ${left + right}px)`;
  return {
    left: `calc(${left}px + (100% - ${left + right}px) / 2)`,
    // Narrow: no cap — a full-width bar is the point of the narrow layout.
    width: opts.capPx === undefined || opts.isNarrow ? band : `min(${opts.capPx}px, ${band})`,
    transform: 'translateX(-50%)',
  };
}
