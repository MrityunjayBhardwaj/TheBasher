// uvLayout — pure UV-coordinate generators for the v1 UV editor.
//
// v1 (P2.6) only synthesizes UVs for BoxMesh, since glTF UV access
// requires the geometry registry (a follow-up phase). Each polygon is a
// quad in 0..1 UV space; the editor draws them as line strips with a
// closing edge.
//
// THREE.BoxGeometry's canonical layout splits the UV square into 6 face
// quads. We don't try to match THREE's exact texture-atlas layout in v1
// — instead we render the canonical "cross" unfold so the user can see
// which face is which. This is read-only; nothing flows back to the
// DAG.

export type UVPoint = readonly [number, number];
export type UVPolygon = readonly UVPoint[];

/**
 * Canonical box UV unfold (cross layout):
 *
 *           +---+
 *           | T |
 *   +---+---+---+---+
 *   | L | F | R | B |
 *   +---+---+---+---+
 *           | D |
 *           +---+
 *
 * 4 columns × 3 rows; the 6 face quads occupy positions:
 *   T (top)    : col=1, row=0   (U: 0.25..0.50, V: 0.66..1.00)
 *   L (left)   : col=0, row=1   (U: 0.00..0.25, V: 0.33..0.66)
 *   F (front)  : col=1, row=1   (U: 0.25..0.50, V: 0.33..0.66)
 *   R (right)  : col=2, row=1   (U: 0.50..0.75, V: 0.33..0.66)
 *   B (back)   : col=3, row=1   (U: 0.75..1.00, V: 0.33..0.66)
 *   D (down)   : col=1, row=2   (U: 0.25..0.50, V: 0.00..0.33)
 *
 * V grows upward (matches glTF / Blender); the canvas drawer flips Y to
 * match screen coordinates.
 */
export function generateBoxUVs(): UVPolygon[] {
  const W = 0.25; // each face is 1/4 wide
  const H = 1 / 3; // each face is 1/3 tall
  function quad(col: number, row: number): UVPolygon {
    const u0 = col * W;
    const v0 = (2 - row) * H; // row 0 is the TOP visually, but V=1 is up
    const u1 = u0 + W;
    const v1 = v0 + H;
    return [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
  }
  return [
    quad(1, 0), // top
    quad(0, 1), // left
    quad(1, 1), // front
    quad(2, 1), // right
    quad(3, 1), // back
    quad(1, 2), // down
  ];
}

/**
 * Equirectangular UV grid for a UV sphere — matches THREE.SphereGeometry's
 * built-in unwrap: each meridian is a vertical line at u = i/widthSegments,
 * each parallel is a horizontal line at v = j/heightSegments. Top edge is
 * the north pole (degenerate in the geometry but full-width in UV space);
 * bottom edge is the south pole. The unwrap stretches at the poles — this
 * is honest THREE behavior, not a flaw in the visualization.
 *
 * Each polyline is a 2-point degenerate "polygon" — the canvas drawer's
 * closePath creates a no-op closing edge for 2-point lists, so the
 * visible result is a clean stroke.
 */
export function generateSphereUVs(widthSegments: number, heightSegments: number): UVPolygon[] {
  const polys: UVPolygon[] = [];
  // Vertical meridians.
  for (let i = 0; i <= widthSegments; i++) {
    const u = i / widthSegments;
    polys.push([
      [u, 0],
      [u, 1],
    ]);
  }
  // Horizontal parallels.
  for (let j = 0; j <= heightSegments; j++) {
    const v = j / heightSegments;
    polys.push([
      [0, v],
      [1, v],
    ]);
  }
  return polys;
}
