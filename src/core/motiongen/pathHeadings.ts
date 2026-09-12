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

// (`MotionGenerationCapability.MIN_HEADING_LENGTH` is the same number guarding
// the EXPLICIT road, where a caller states headings this function never sees. It
// is a separate constant on purpose — that one bounds a unitless direction, this
// one a distance in metres.)

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

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER HALF: FRAME 0 IS PINNED, SO A FACING IS REACHED RATHER THAN HELD
// ─────────────────────────────────────────────────────────────────────────────
// Supplying `headings` makes the character walk the path instead of strafing it,
// and it does NOT make the character start out facing the right way. Frame 0 is
// canonicalised to heading zero — that is the model's contract, not a setting —
// so a requested facing is somewhere the body TURNS TO. Reading the Hips yaw
// SERIES on a +Z path with +Z headings, rather than its mean:
//
//     yaw @ 0% / 25% / 50% / 75% / 100%  =  -0.6°  3.0°  91.6°  110.4°  94.1°
//
// The character faces +X for the first HALF of the clip, swings past its target
// to 110°, and settles. A MEAN of 59.7° reads as "walks the path"; the series is
// what says it arrives at the facing rather than holding it.
//
// #897 asks the SERVER for the remedy — "rotate the path to a canonical heading
// on the way in and report the angle it used on the way out". Both halves of
// that are available HERE, because the canonical heading is a known CONSTANT
// (+X, angle 0) rather than something only the server can know. Rotate the
// request into the canonical frame; rotate the result back out. Measured, same
// walk, same seed:
//
//     rotated in (canonical frame)   yaw =  -0.2°  3.5°  0.7°   2.9°  -1.1°
//     rotated back into world        yaw =  89.8° 93.5° 90.7°  92.9°  88.9°
//                                    ends at (0.01, 1.93) for a path to (0, 2)
//
// 🔴 THE OUTPUT ROTATION ALONE IS NOT THE FIX, and it is the tempting half: it
// turns the character to face correctly and walks it down a path rotated off the
// one that was drawn. The pair is what works, and neither half is meaningful
// without the other — which is why the angle is returned as ONE value that the
// same node applies alongside the position offset.

/**
 * The world angle of a ground direction, in radians, with **+X = 0** and
 * **+Z = +π/2** — the frame the waypoints themselves are in.
 *
 * Deliberately NOT "yaw": yaw names a rotation about an axis and carries a
 * handedness with it, and the two conventions differ by a sign. This is an angle
 * in the XZ plane, defined by the waypoints and nothing else. Converting it to a
 * rotation is the placement's job, where the target's convention is known and
 * measured.
 */
export function headingAngle(h: GroundVec): number {
  return Math.atan2(h.z, h.x);
}

/**
 * Rotate a ground vector by `radians` about the origin, in the same frame
 * `headingAngle` reads: `(1, 0)` at `+π/2` becomes `(0, 1)`.
 */
export function rotateGround(v: GroundVec, radians: number): GroundVec {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}
