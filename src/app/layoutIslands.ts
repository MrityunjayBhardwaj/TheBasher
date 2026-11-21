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

/** #1709 — the draggable divider between the two sides of the fixed split (board 11a). */
export const SPLIT_DIVIDER_WIDTH = 6;

/** #1709 — a collapsed 3D side: a slim strip holding the expand button (board 11b). */
export const SPLIT_COLLAPSED_STRIP = 34;

/** A horizontal span inside <main>, as CSS `left` + `width`. */
export interface HSpan {
  left: string;
  width: string;
}

/** #1709 — a length that is linear in <main>'s width W: `px + of * W`. Every split edge is one of
 *  these, so the same numbers give both the CSS (calc against 100%, which follows a resize without
 *  a re-render) and a px value at a known W (for a surface that must decide in px — the live
 *  preview inside the 3D side). */
export interface Lin {
  px: number;
  of: number;
}
interface LinSpan {
  left: Lin;
  width: Lin;
}

const lin = (px: number, of = 0): Lin => ({ px, of });
const linCss = (l: Lin): string => (l.of === 0 ? `${l.px}px` : `calc(${l.px}px + ${l.of} * 100%)`);
const spanCss = (s: LinSpan): HSpan => ({ left: linCss(s.left), width: linCss(s.width) });
/** A Lin's value at a <main> width of `mainWidth` px. */
export const linPx = (l: Lin, mainWidth: number): number => l.px + l.of * mainWidth;

interface SplitOpts {
  insets: { left: number; right: number };
  twoDShare: number;
  collapsed: boolean;
  swapped: boolean;
}

/** #1709 — the split's spans as linear lengths: THE one place the split geometry is decided. */
export function splitPaneSpans(opts: SplitOpts): {
  twoD: LinSpan;
  view3d: LinSpan | null;
  divider: LinSpan | null;
  strip: LinSpan | null;
} {
  const L = opts.insets.left;
  const R = opts.insets.right;
  if (opts.collapsed) {
    // band − strip = W − (L + R + strip)
    const twoDWidth = lin(-(L + R + SPLIT_COLLAPSED_STRIP), 1);
    const stripW = lin(SPLIT_COLLAPSED_STRIP);
    return opts.swapped
      ? {
          twoD: { left: lin(L + SPLIT_COLLAPSED_STRIP), width: twoDWidth },
          view3d: null,
          divider: null,
          strip: { left: lin(L), width: stripW },
        }
      : {
          twoD: { left: lin(L), width: twoDWidth },
          view3d: null,
          divider: null,
          strip: { left: lin(-(R + SPLIT_COLLAPSED_STRIP), 1), width: stripW },
        };
  }
  // room = band − divider = W − (L + R + divider); a side of share s is s · room.
  const roomPx = -(L + R + SPLIT_DIVIDER_WIDTH);
  const f = opts.swapped ? 1 - opts.twoDShare : opts.twoDShare;
  const first: LinSpan = { left: lin(L), width: lin(roomPx * f, f) };
  const divider: LinSpan = {
    left: lin(L + roomPx * f, f),
    width: lin(SPLIT_DIVIDER_WIDTH),
  };
  const second: LinSpan = {
    left: lin(L + SPLIT_DIVIDER_WIDTH + roomPx * f, f),
    width: lin(roomPx * (1 - f), 1 - f),
  };
  return opts.swapped
    ? { twoD: second, view3d: first, divider, strip: null }
    : { twoD: first, view3d: second, divider, strip: null };
}

/** #1709 — where each part of the fixed 2D | 3D split sits across the clear band (the same band
 *  a lone 2D View fills, `centerBandInsets` 'top', so the split never runs under a side island).
 *
 *  Not collapsed: [first side][divider][second side], the 2D side taking `twoDShare` of the room
 *  left after the divider. Collapsed: the 2D side fills the band but for the 3D strip on the 3D
 *  side's edge, and there is no divider. `swapped` puts the 3D side on the left.
 *
 *  Spelled as calc() against <main>'s width so it follows a window or chat-column resize without
 *  a re-render. The CSS form of splitPaneSpans. */
export function splitPaneBoxes(opts: SplitOpts): {
  twoD: HSpan;
  view3d: HSpan | null;
  divider: HSpan | null;
  strip: HSpan | null;
} {
  const s = splitPaneSpans(opts);
  return {
    twoD: spanCss(s.twoD),
    view3d: s.view3d && spanCss(s.view3d),
    divider: s.divider && spanCss(s.divider),
    strip: s.strip && spanCss(s.strip),
  };
}

/** #1708/#1709 — the live shot preview's natural width (16:9, so 162 px tall). */
export const LIVE_PREVIEW_WIDTH = 288;
/** #1709 — narrower than this (picture 160 × 90) the preview reads as a smudge: it hides. */
export const LIVE_PREVIEW_MIN_WIDTH = 160;

/** #1708/#1709 — the live preview's box, in px from the bottom-right of the surface it sits in,
 *  or null when it should not show.
 *
 *  Alone, the 3D view is full-bleed: the preview sits at the bottom-right of the clear band (beside
 *  the inspector island, `bandRight`), above the floating playback bar, or down to the island gap
 *  when the drawer holds the playback. Split, the 3D side is its own box: the preview sits at that
 *  box's bottom-right, above the orbit gizmo and the Persp/Ortho pill (GIZMO_BAND), scaled down to
 *  the side's width when it must be, and hidden when even LIVE_PREVIEW_MIN_WIDTH does not fit. The
 *  side's width comes from splitPaneSpans — the same numbers that place the 3D slot. */
export function livePreviewBox(opts: {
  drawerOpen: boolean;
  bandRight: number;
  /** The 3D side's width in px when the split shows, else null. */
  splitSideWidth: number | null;
}): { right: number; bottom: number; width: number } | null {
  if (opts.splitSideWidth === null) {
    return {
      right: opts.bandRight,
      bottom: opts.drawerOpen ? ISLAND_GAP : PLAYBACK_BAND,
      width: LIVE_PREVIEW_WIDTH,
    };
  }
  const room = opts.splitSideWidth - 2 * ISLAND_GAP;
  if (room < LIVE_PREVIEW_MIN_WIDTH) return null;
  return { right: ISLAND_GAP, bottom: GIZMO_BAND, width: Math.min(LIVE_PREVIEW_WIDTH, room) };
}

/** #1709 — the 2D side's share for a divider dragged to `pointerX`, from the band's left edge
 *  and width in px (the inverse of splitPaneBoxes). Unclamped: the store clamps. */
export function twoDShareAt(opts: {
  pointerX: number;
  bandLeft: number;
  bandWidth: number;
  swapped: boolean;
}): number {
  const room = opts.bandWidth - SPLIT_DIVIDER_WIDTH;
  if (room <= 0) return 0.5;
  // The pointer holds the divider's middle.
  const firstShare = (opts.pointerX - opts.bandLeft - SPLIT_DIVIDER_WIDTH / 2) / room;
  return opts.swapped ? 1 - firstShare : firstShare;
}
