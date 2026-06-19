// resolveLightBrushPlacement — the Light Brush's pure placement core (epic #201,
// slice #207). The Light Brush (§7.4) lets a director "paint" a light onto the
// subject: click a surface point, and the light jumps to the rig-sphere spot that
// puts its specular highlight (or its straight-on key) exactly there. The modal
// tool is just input — this is the whole geometry, a pure function of the hit.
//
// Two modes:
//  - 'reflect' (paint a HIGHLIGHT): the light sits along reflect(viewDir, normal)
//    from the hit, so the mirror reflection of the light toward the camera lands
//    on the clicked point — the BLS "click where you want the shine" gesture.
//  - 'normal' (paint a straight key): the light sits along the surface normal.
// In both cases the light then aims back at the rig centre via its Track-To
// ([[V60]]) — orientation is not this resolver's job (the V62/§7.3 split).
//
// The placement is the ray (hit → direction) intersected with the rig SPHERE
// (centre, radius) — the same shell the 2D panel drags on, so a brushed light and
// a dragged light live in ONE coordinate system (`studioLightPanelXY` projects
// either back to the same puck). Returns null when the ray misses the sphere
// (the caller falls back, e.g. to centre + radius·direction).
//
// REF: docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.4; src/app/resolveStudioLightTransform.ts
//      (the sphere the brush lands on); vyapti V60 (the aim), V37 (render parity).

type Vec3 = [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-9) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** The reflection of incident direction `i` about surface normal `n` (n assumed
 *  unit): r = i − 2(i·n)n. Pure, the standard mirror reflection. */
export function reflect(i: Vec3, n: Vec3): Vec3 {
  const d = 2 * dot(i, n);
  return [i[0] - d * n[0], i[1] - d * n[1], i[2] - d * n[2]];
}

export interface LightBrushPlacement {
  readonly position: Vec3;
}

/**
 * The rig-sphere position a brushed light should take. `hit` is the clicked world
 * point, `normalWorld` the surface normal there (world space), `viewDir` the
 * camera→hit ray direction. The light is placed where the ray from `hit` along the
 * brush direction (reflect or normal) exits the sphere (`centre`, `radius`).
 * Returns null when the ray misses (discriminant < 0) — caller falls back.
 */
export function resolveLightBrushPlacement(
  hit: Vec3,
  normalWorld: Vec3,
  viewDir: Vec3,
  centre: Vec3,
  radius: number,
  mode: 'reflect' | 'normal',
): LightBrushPlacement | null {
  const n = normalize(normalWorld);
  const dir = mode === 'reflect' ? normalize(reflect(normalize(viewDir), n)) : n;
  if (dir[0] === 0 && dir[1] === 0 && dir[2] === 0) return null;

  // Ray (hit + t·dir) ∩ sphere(centre, radius): |hit − centre + t·dir|² = r².
  // dir is unit, so the t² coefficient is 1.
  const m: Vec3 = [hit[0] - centre[0], hit[1] - centre[1], hit[2] - centre[2]];
  const b = dot(m, dir);
  const c = dot(m, m) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;

  const sq = Math.sqrt(disc);
  // Roots straddle 0 when the hit is inside the sphere (c < 0); pick the smallest
  // POSITIVE t (the exit in the brush direction). Both non-positive → null.
  const t1 = -b - sq;
  const t2 = -b + sq;
  const t = t1 > 1e-9 ? t1 : t2 > 1e-9 ? t2 : NaN;
  if (Number.isNaN(t)) return null;

  return { position: [hit[0] + t * dir[0], hit[1] + t * dir[1], hit[2] + t * dir[2]] };
}
