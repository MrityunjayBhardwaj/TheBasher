// Viewport canvas chrome colors (v0.6 #4 W3, D-07).
//
// These are PRESENTATION colors for the editor viewport — the GL canvas
// background tint and the floor-grid lines. They are NOT scene DATA: the
// cube/light colors authored into the DAG live in `core/project/default.ts`
// and are never restyled here (V34 — data lives in the DAG, chrome does not).
//
// They are R3F/three.js `<color>`/Grid props, so they are NOT reachable as
// Tailwind tokens. Kept here as named constants (not magic hex scattered in
// Viewport.tsx) so the canvas tint tracks the calm-LIGHT palette deliberately
// rather than drifting. The values are chosen to sit just BELOW the chrome
// surfaces (`bg #ececf2` / `bg-2 #fafafc`) in lightness so the floating pill
// and panels read as "on top of" a soft, tinted stage — Spline's calm,
// muted-not-pure-white canvas (SPLINE-UI-REFERENCE §1: "muted, tinted canvas
// — not pure black"; on a light theme that reads as a soft lavender-gray).

/** The GL canvas background — Spline's dark scene stage (~#1E2025 in the
 *  reference's Scene color readout). A near-black, faintly-cool stage the
 *  floating panels sit on top of. */
export const VIEWPORT_BG = '#1a1b20';

/** Floor-grid minor (cell) lines — subtle, just lighter than the dark canvas. */
export const VIEWPORT_GRID_CELL = '#2b2c34';

/** Floor-grid major (section) lines — a touch stronger, faintly cool. */
export const VIEWPORT_GRID_SECTION = '#3a3b45';
