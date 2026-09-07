// pathHeadings — the facing a walked path implies (#897).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, MEASURED AGAINST THE LIVE SERVER
// ─────────────────────────────────────────────────────────────────────────────
// A root path constrains WHERE the character goes and says nothing about which
// way it faces. Kimodo canonicalises frame-0 heading to zero, and with no facing
// constraint it keeps that heading for the whole clip — so the character travels
// the path SIDEWAYS. Three generations, identical but for the request's
// `headings`, reading the Hips yaw (the travelling bone; ROOT is identically
// zero on every frame):
//
//     path +X, no headings      yaw mean  -2.5°   ends (1.91, 0.01)   looks fine
//     path +Z, no headings      yaw mean  -1.4°   ends (0.01, 2.07)   STRAFES
//     path +Z, with headings    yaw mean  59.7°   ends (-0.01, 2.02)  walks it
//
// The +X path hides the defect completely, because facing +X IS the canonical
// heading — which is why this survived: the fixture path and the canonical
// direction were the same direction.
//
// #897 reads this as unfixable from our side, on the grounds that the server
// "returns no angle, so there is nothing for the client to re-apply". That is
// true of the OUTPUT and irrelevant to the INPUT: `serve.py` already forwards
// `body["headings"]` into `authoring.root_path`, documented as "facing per
// waypoint as [cos, sin] -- a direction vector, not radians", which it attaches
// to the constraint as `global_root_heading`. The channel exists; we were not
// using it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH COMPONENT IS WHICH — measured, not inferred from the names
// ─────────────────────────────────────────────────────────────────────────────
// `[cos, sin]` does not say which world axis each maps to, and guessing has a
// 50% failure mode that looks like a model quality problem. Measured: `[1, 0]`
// on a +X path holds yaw at ~0 (the canonical facing, i.e. +X), and `[0, 1]`
// turns the character toward +Z on both an +X path and a +Z path. So the pair is
// (x, z) in the same frame and units as the waypoints themselves.
//
// REF: src/core/motiongen/HttpMotionGenerationCapability.ts (the wire, where this
//      is applied); kimodo `authoring/constraints.py` `root_path(headings=…)`;
//      `serve.py` (forwards `headings`); issues #897, #826, #730.

/** A ground-plane point or direction in world XZ, in metres. */
export interface GroundVec {
  readonly x: number;
  readonly z: number;
}

/**
 * Below this, a segment is treated as no movement at all. Waypoints sampled off
 * a curve at fixed arc-length fractions can repeat a point exactly (a curve
 * shorter than its sample count), and normalising that yields NaN — which the
 * server would accept as a heading and the model would honour as garbage.
 */
const MIN_SEGMENT = 1e-6;

/**
 * One facing per waypoint, from the direction of travel.
 *
 * The last waypoint has no following segment, so it repeats the heading of the
 * one before it: a character arriving at the end of a path keeps the facing it
 * arrived with, rather than snapping to some other direction on the final frame.
 *
 * Returns `null` when no segment moves — a path that stands still implies no
 * facing, and inventing one here would be asserting a direction the caller never
 * expressed. The caller then sends no `headings` and gets the server's default,
 * which is the honest outcome for a degenerate path.
 */
export function tangentHeadings(waypoints: readonly GroundVec[]): GroundVec[] | null {
  if (waypoints.length < 2) return null;

  const headings: (GroundVec | null)[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const dx = waypoints[i + 1].x - waypoints[i].x;
    const dz = waypoints[i + 1].z - waypoints[i].z;
    const len = Math.hypot(dx, dz);
    headings.push(len < MIN_SEGMENT ? null : { x: dx / len, z: dz / len });
  }
  // The final waypoint inherits the last real segment.
  headings.push(headings[headings.length - 1] ?? null);

  // A stationary stretch mid-path keeps the facing it had going in, so a pause
  // does not spin the character. Carrying FORWARD rather than interpolating is
  // deliberate: an interpolated facing across a gap is a claim about motion that
  // did not happen.
  let carried: GroundVec | null = null;
  const out: GroundVec[] = [];
  for (const h of headings) {
    if (h) carried = h;
    out.push(carried ?? { x: 0, z: 0 });
  }
  if (!carried) return null;
  // A leading stationary stretch has nothing to carry forward from, so it is
  // filled BACKWARDS from the first real heading — the character stands facing
  // the way it is about to walk, rather than facing nowhere.
  const first = out.find((h) => h.x !== 0 || h.z !== 0);
  if (!first) return null;
  return out.map((h) => (h.x === 0 && h.z === 0 ? first : h));
}
