// #1353 — skin weights by proximity: each point is bound to the bones nearest it.
//
// ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
//
// A bone is the segment from its head to its tail, in the mesh's space. A point's raw weight for a
// bone falls with its distance `d` to that segment as `d^-dropoff`; the `maxInfluences` nearest
// bones keep their weights and the rest get none; the kept weights are scaled to add up to one.
// A point lying ON a bone belongs to that bone alone (shared evenly when it lies on several, as a
// point at a joint does).
//
// Only RATIOS of distances enter (`(nearest / d)^dropoff`), so the result does not change with the
// size of the scene, and no characteristic length has to be chosen.
//
// ── WHERE THE RULE COMES FROM ─────────────────────────────────────────────────────────────────
//
// Maya's Closest Distance bind: "joint influence is based only on proximity to the skin points",
// the influence "extends along the entire bone, from the center of the joint to the end of the
// bone", Max Influences caps the joints per point, and Dropoff Rate says "how sharply the influence
// of each joint on skin points decreases with the distance" — default 4, "1 for linear, 2 for
// quadratic" (`maya-docs/guide/bind-skin-options.txt:41-45`, `:158-161`, `:221-241`;
// `maya-docs/nodes/skinCluster.txt:312-327`). Houdini's Joint Capture Proximity states the same
// shape — "a stronger weight is assigned to rest geometry points that are closer to the line
// between joints", Drop Off, Max. Influences, Normalize Weights — and recommends it "for geometry
// that is not fully closed" and as "a starting point for further painting"
// (`houdini-kinefx-docs/kinefx--jointcaptureproximity.txt`). Neither publishes its exact falloff:
// the power law here is this project's reading of "1 for linear, 2 for quadratic", not a copy.
//
// Blender's envelope weights were NOT followed: they need a radius and a falloff distance per bone
// (`armature_deform.cc:53-104`), which a bone here does not have, and a point outside every
// envelope gets no weight at all (`armature_skinning.cc:251-260`) and silently stays at rest.
//
// ── A POINT NO BONE HOLDS IS COUNTED, NEVER ASSUMED AWAY ──────────────────────────────────────
//
// A point with no weight stays at rest while its neighbours move (`armatureDeform.ts`,
// `CONTRIB_THRESHOLD`), and nothing downstream says so. Under this rule every point with a finite
// position is held by at least one bone, so the count is zero unless a position is not a number —
// and it is still measured and returned, because the methods that follow this one (voxel geodesic,
// surface heat) do leave points unheld and the reader of `unbound` must not have to know which
// method ran.
//
// REF: src/nodes/skinInfluences.ts (the lanes written); src/nodes/armatureDeform.ts (the reader);
//      ref/GROUND_TRUTH_AUTO_SKIN_WEIGHTS.md §10.2; issue #1353.

import { SKIN_SET_WIDTH, type SkinLanes } from './skinInfluences';

/** One bone a capture measures against: its rest segment, in the mesh's space. */
export interface CaptureBone {
  readonly name: string;
  readonly head: readonly [number, number, number];
  readonly tail: readonly [number, number, number];
}

export interface CaptureOptions {
  /** The most bones one point is bound to. At least 1. */
  readonly maxInfluences: number;
  /** How sharply a bone's hold falls with distance: 1 linear, 2 quadratic, …. Above 0. */
  readonly dropoff: number;
}

export interface CapturedWeights {
  /** Every point's influences; a joint number indexes {@link vertexGroups}. */
  readonly lanes: SkinLanes;
  /** One group per bone, in the order given — Blender makes one per deforming bone too. */
  readonly vertexGroups: readonly string[];
  /** How many points no bone holds. They stay at rest when the others move. */
  readonly unbound: number;
  /**
   * How many points no bone reached by the method's own measure, and were bound by straight-line
   * distance instead. Always 0 by proximity, which has no other measure.
   */
  readonly unreached: number;
  /** The bones the method could not measure from at all, by name. None by proximity. */
  readonly outside: readonly string[];
}

/** The distance from `(px, py, pz)` to the segment `head → tail`. */
export function distanceToSegment(px: number, py: number, pz: number, bone: CaptureBone): number {
  const [hx, hy, hz] = bone.head;
  const ax = bone.tail[0] - hx;
  const ay = bone.tail[1] - hy;
  const az = bone.tail[2] - hz;
  const bx = px - hx;
  const by = py - hy;
  const bz = pz - hz;
  const length2 = ax * ax + ay * ay + az * az;
  // A bone with no length is its head.
  const along = length2 > 0 ? Math.min(1, Math.max(0, (ax * bx + ay * by + az * bz) / length2)) : 0;
  return Math.hypot(bx - ax * along, by - ay * along, bz - az * along);
}

/**
 * Bind every point of `points` (xyz per point) to the nearest of `bones`.
 *
 * The lanes are as wide as `maxInfluences` needs in whole sets of {@link SKIN_SET_WIDTH}; a point's
 * influences fill its lanes nearest first, and an unused lane holds joint 0 with weight 0.
 */
export function captureByProximity(
  points: Float32Array,
  bones: readonly CaptureBone[],
  options: CaptureOptions,
): CapturedWeights {
  const count = points.length / 3;
  const kept = Math.max(1, Math.min(Math.floor(options.maxInfluences), bones.length));
  const width = Math.max(1, Math.ceil(kept / SKIN_SET_WIDTH)) * SKIN_SET_WIDTH;
  const joints = new Int32Array(count * width);
  const weights = new Float32Array(count * width);
  const vertexGroups = bones.map((b) => b.name);
  let unbound = 0;

  // The `kept` nearest bones of the point in hand, nearest first. Kept by insertion rather than by
  // sorting every bone: on 50,000 points and 72 bones a full sort per point took 302 ms and this
  // takes 80 (vitest on this machine, 2026-10-07).
  const nearBone = new Int32Array(kept);
  const nearDistance = new Float64Array(kept);
  for (let p = 0; p < count; p++) {
    const px = points[p * 3];
    const py = points[p * 3 + 1];
    const pz = points[p * 3 + 2];
    let found = 0;
    for (let b = 0; b < bones.length; b++) {
      const d = distanceToSegment(px, py, pz, bones[b]);
      if (!Number.isFinite(d)) continue;
      // Strictly nearer moves ahead, so equally near bones stay in bone order.
      let at = found;
      while (at > 0 && d < nearDistance[at - 1]) at--;
      if (at >= kept) continue;
      for (let k = Math.min(found, kept - 1); k > at; k--) {
        nearBone[k] = nearBone[k - 1];
        nearDistance[k] = nearDistance[k - 1];
      }
      nearBone[at] = b;
      nearDistance[at] = d;
      if (found < kept) found++;
    }
    if (found === 0) {
      unbound++;
      continue;
    }
    const nearest = nearDistance[0];
    let total = 0;
    let used = 0;
    for (; used < found; used++) {
      const d = nearDistance[used];
      // On a bone, only the bones the point lies on hold it.
      const raw = nearest === 0 ? (d === 0 ? 1 : 0) : Math.pow(nearest / d, options.dropoff);
      if (raw === 0) break;
      joints[p * width + used] = nearBone[used];
      weights[p * width + used] = raw;
      total += raw;
    }
    for (let lane = 0; lane < used; lane++) weights[p * width + lane] /= total;
  }
  return { lanes: { width, joints, weights }, vertexGroups, unbound, unreached: 0, outside: [] };
}
