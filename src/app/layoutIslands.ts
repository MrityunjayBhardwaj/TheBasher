// Floating-island geometry — UX-BACKLOG #2.
//
// The chrome panels (outliner, inspector, agent chat, timeline) are detached
// rounded islands floating OVER a full-bleed viewport (Spline-style), not
// docked grid bands. These constants are the ONE source of truth for their
// footprint so the panels, the viewport's own bottom-right widgets (the orbit
// axis gizmo + Persp/Ortho pill), and the e2e gates all agree on where the
// islands sit.
//
// Why a reserved BOTTOM_BAND: the side islands are TOP-anchored and stop short
// of the bottom so the bottom strip stays clear for (a) the bottom-right orbit
// gizmo + ProjectionToggle (already floating, untouched) and (b) the
// bottom-center agent + timeline stack. Full-height side islands would cover
// the bottom-right gizmo (it lives within ~120px of the bottom edge) — the
// H91/V45 family of "a relocated chrome surface silently overlaps another
// floating surface". Keeping the band clear is the lowest-coupling fix: no
// viewport widget needs to dodge the inspector.
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

/** Reserved clear strip along the bottom of the viewport. The side islands'
 *  bottom edge sits this far above the viewport's bottom, leaving room for the
 *  bottom-right orbit gizmo (≈ bottom 40–120px) + Persp/Ortho pill and the
 *  bottom-center agent + timeline stack — none of which the side islands cover. */
export const BOTTOM_BAND = 140;

/** Below this CSS width the island layout switches to its NARROW variant
 *  (UX-BACKLOG #2 follow-up 2): the side panels become off-canvas overlay
 *  drawers (closed by default), and the centered surfaces (toolbar pill +
 *  bottom stack) go full-width instead of reserving columns for the islands.
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

/** Width a VIEWPORT-CENTERED surface (the toolbar pill, the bottom-center
 *  stack) must subtract from 100% so it stays clear of BOTH side islands.
 *  Centered on the viewport midpoint (not the inter-island midpoint), so it
 *  reserves the WIDER island on both sides plus a gap each side — this gives a
 *  positive clearance regardless of the left/right width asymmetry. Without
 *  this, a full-bleed viewport lets a centered pill slide under a side island
 *  (the H91/V45 floating-overlap trap).
 *
 *  RESPONDS to the live collapse flags (V46: ONE geometry source, no stale
 *  reserve): when a panel is folded to its 28px strip the centered surface
 *  reclaims that width instead of reserving for the expanded footprint it no
 *  longer has. Both expanded → 2*(12 + 300 + 12) = 648, identical to the old
 *  static constant, so the default geometry is unchanged. */
export function centerSideReserved(leftCollapsed: boolean, inspectorCollapsed: boolean): number {
  const leftW = sideIslandWidth(leftCollapsed, OUTLINER_WIDTH);
  const rightW = sideIslandWidth(inspectorCollapsed, INSPECTOR_WIDTH);
  return 2 * (ISLAND_GAP + Math.max(leftW, rightW) + ISLAND_GAP);
}

/** Width cap for a centered surface that should not stretch the full clear band
 *  (the toolbar pill and the bottom agent/timeline stack). The 2D View and the
 *  DiffBar are bars/editors — they fill the band and pass no cap. */
export const CENTER_SURFACE_MAX_WIDTH = 960;

/** The CSS width a VIEWPORT-CENTERED surface must take to stay in the clear band
 *  between the side islands — the ONE place that decision is spelled, so a new
 *  centered surface CANNOT be born un-reserved.
 *
 *  Every centered surface had been hand-copying this same ternary (toolbar,
 *  2D View, bottom stack — three copies). The DiffBar was never given a copy,
 *  and so its right-aligned Apply/Reject sat UNDER the inspector island: the
 *  agent proposed and the director could not accept (#327 — the button was
 *  visible and unreachable, which is why a `toBeVisible()` suite never saw it).
 *  A hand-copied geometry rule drifts exactly like a hand-copied vocabulary
 *  does (V101); the reserve is now DERIVED by every centered surface from this
 *  one function instead of re-stated by each.
 *
 *  Narrow: the side panels are off-canvas drawers that OVERLAY rather than
 *  reserve, so a centered surface takes the full width minus the edge gaps. */
export function centerSurfaceWidthCss(opts: {
  isNarrow: boolean;
  leftCollapsed: boolean;
  inspectorCollapsed: boolean;
  /** Optional px cap; omit to fill the whole clear band. */
  capPx?: number;
}): string {
  if (opts.isNarrow) return `calc(100% - ${2 * ISLAND_GAP}px)`;
  const band = `calc(100% - ${centerSideReserved(opts.leftCollapsed, opts.inspectorCollapsed)}px)`;
  return opts.capPx === undefined ? band : `min(${opts.capPx}px, ${band})`;
}
