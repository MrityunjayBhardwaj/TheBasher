// resolveStudioLightTransform — the 2D Light-Studio panel's ONE pure mapping
// (epic #201, slice #206). The panel is a lat-long (equirectangular) flattening
// of the sphere around the rig target; this maps a controller point on that
// canvas → the world POSITION of a light on the rig sphere, and back.
//
// THE V56/V51 SHAPE: one pure resolver feeds both the panel (where the puck
// draws) and the authoring (where the light moves) → drag-on-panel == 3D-light
// moves (V37 parity). Orientation is NOT this resolver's job — a studio light
// AIMS at the rig target via its Track-To ([[V60]], shipped #205); this owns only
// placement on the sphere. The inverse (`studioLightPanelXY`) lets an EXISTING
// light show as a puck at the right canvas spot (round-trip exact, off the seam).
//
// Convention (consistent forward+inverse; the env-HDRI backdrop pixel-alignment
// is a later refinement, not a correctness condition): u ∈ [0,1] left→right =
// azimuth θ = (u−0.5)·2π (u=0.5 → +Z); v ∈ [0,1] bottom→top = elevation φ =
// (v−0.5)·π (v=0.5 → equator, v=1 → +Y pole). dir = (cosφ·sinθ, sinφ, cosφ·cosθ).
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.3; vyapti V60 (the rig aim it
//      pairs with), V37 (panel==viewport parity), V51/V56 (the one-resolver shape).

type Vec3 = [number, number, number];

export interface StudioLightPlacement {
  /** World position of the light on the rig sphere (the light aims back at the
   *  target via its Track-To — orientation is derived there, not here). */
  readonly position: Vec3;
}

const TWO_PI = Math.PI * 2;

/** Clamp to [-1, 1] before asin (guards float drift past the domain). */
function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/**
 * Panel controller point `(u, v)` ∈ [0,1]² → the world position of a light on a
 * sphere of `radius` around `target`. u = azimuth (left→right), v = elevation
 * (bottom→top). The light then aims at `target` via its Track-To ([[V60]]).
 */
export function resolveStudioLightTransform(
  panelXY: readonly [number, number],
  radius: number,
  target: readonly [number, number, number],
): StudioLightPlacement {
  const az = (panelXY[0] - 0.5) * TWO_PI; // -π..π
  const el = (panelXY[1] - 0.5) * Math.PI; // -π/2..π/2
  const cosEl = Math.cos(el);
  return {
    position: [
      target[0] + radius * cosEl * Math.sin(az),
      target[1] + radius * Math.sin(el),
      target[2] + radius * cosEl * Math.cos(az),
    ],
  };
}

/**
 * Inverse of `resolveStudioLightTransform`: a light's world `position` → its
 * panel `(u, v)` + `radius`, relative to the rig `target`. Lets an existing
 * studio light render as a puck on the canvas. A position AT the target (radius
 * ~0) maps to panel centre (the azimuth/elevation are undefined there).
 */
export function studioLightPanelXY(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
): { panelXY: [number, number]; radius: number } {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz);
  if (radius < 1e-9) return { panelXY: [0.5, 0.5], radius: 0 };
  const el = Math.asin(clampUnit(dy / radius));
  const az = Math.atan2(dx, dz);
  // az ∈ (-π, π] → u ∈ (0, 1]; the seam at ±π wraps to u=0/1 (same column).
  return {
    panelXY: [az / TWO_PI + 0.5, el / Math.PI + 0.5],
    radius,
  };
}
