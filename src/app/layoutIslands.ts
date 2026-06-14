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

/** Reserved clear strip along the bottom of the viewport. The side islands'
 *  bottom edge sits this far above the viewport's bottom, leaving room for the
 *  bottom-right orbit gizmo (≈ bottom 40–120px) + Persp/Ortho pill and the
 *  bottom-center agent + timeline stack — none of which the side islands cover. */
export const BOTTOM_BAND = 140;

/** Width a VIEWPORT-CENTERED surface (the toolbar pill, the bottom-center
 *  stack) must subtract from 100% so it stays clear of BOTH side islands.
 *  Centered on the viewport midpoint (not the inter-island midpoint), so it
 *  reserves the WIDER island (inspector) on both sides plus a gap — this gives
 *  a positive clearance regardless of the left/right width asymmetry. Without
 *  this, a full-bleed viewport lets a centered pill slide under a side island
 *  at narrow widths (the H91/V45 floating-overlap trap). */
export const CENTER_SIDE_RESERVED = 2 * (INSPECTOR_WIDTH + ISLAND_GAP * 2);
