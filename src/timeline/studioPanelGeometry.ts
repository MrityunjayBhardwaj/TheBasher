// studioPanelGeometry — the ONE place the Light-Studio panel and its e2e agree on
// how a panel coordinate maps to a position on the canvas, and back (epic #201,
// slice #206). Per [[H95]]: a canvas/drag e2e MIRRORS the component's geometry; if
// the mapping lives in two places they silently drift and the spec targets the
// wrong pixel. So the panel renders pucks through `panelXYToFraction` and a drag
// reads the pointer through `fractionToPanelXY` — both import from here, and the
// spec imports the same.
//
// The panel is a lat-long (equirectangular) rectangle: u ∈ [0,1] left→right is
// azimuth, v ∈ [0,1] bottom→top is elevation (the convention of
// resolveStudioLightTransform). Screen space runs top→down, so v is FLIPPED:
// v=1 (the +Y pole) is the TOP of the canvas. u maps straight across.
//
// REF: src/app/resolveStudioLightTransform.ts (the panelXY convention this mirrors);
//      vyapti V37 (panel==viewport parity); hetvabhasa H95 (one geometry source).

type PanelXY = readonly [number, number];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** A panel coordinate `(u, v)` → its fractional position within the canvas rect
 *  (0..1 from the left / top edge). The v-flip lives here and only here. */
export function panelXYToFraction(panelXY: PanelXY): { leftFrac: number; topFrac: number } {
  return { leftFrac: panelXY[0], topFrac: 1 - panelXY[1] };
}

/** A pointer's fractional position within the canvas rect → the panel coordinate
 *  `(u, v)`. The inverse of `panelXYToFraction`, clamped to the panel (a drag that
 *  leaves the rect parks the puck at the edge rather than wrapping). */
export function fractionToPanelXY(leftFrac: number, topFrac: number): [number, number] {
  return [clamp01(leftFrac), clamp01(1 - topFrac)];
}
