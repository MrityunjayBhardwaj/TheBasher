// #825 slice 2 — what a MINTED corner's value is worth, as weights rather than as an index.
//
// ── WHY THIS IS A MODULE AND NOT A BRANCH IN THE CARRIAGE TABLE ────────────────────────
//
// Every attribute road in this repo is an INDEX GATHER: `order[i]` names one source element
// and the value is copied. `carriageForDomain`'s corner arm says so in its own refusal — a
// minted corner *"cannot be gathered through an order at all"*. What the reference does
// instead is blend N source values with N weights, and a weight is not an index. So the
// mechanism arrives as its own leaf rather than as a wider `TiledLayout`, and the gather
// stays exactly the thing it says it is.
//
// ── WHY IT IMPORTS NOTHING ─────────────────────────────────────────────────────────────
//
// Its one consumer is `geometryRegistry.ts`, whose import set is PINNED by
// `faceCountLeaf.gate.test.ts` — *"widening it is a deliberate one-line edit here, with a
// reason"*. Every widening that gate has accepted was justified by the addition being a leaf
// (`materialGroups` imports nothing, `scopeQuery` imports nothing). This one holds to the same
// bar by construction: it is arithmetic over numbers, it names no geometry type, and it cannot
// grow a graph without that edit becoming visible in the gate.
//
// ── GROUNDED, FUNCTION BY FUNCTION ─────────────────────────────────────────────────────
//
// This is a port, not an invention. Blender interpolates a loop's data from a face with
// `BM_loop_interp_from_face` (`bmesh_interp.cc:688-737`), which does exactly three things:
// build a 2D basis from the source face's normal (`axis_dominant_v3_to_m3`,
// `math_geom.cc:3686`, itself `ortho_basis_v3v3_v3`, `math_vector.cc:568`), project the source
// corners and the destination point into it, and take generalised barycentric weights there
// (`interp_weights_poly_v2`, `math_geom.cc:4334`). Each is ported below beside its citation.
//
// 🔴 THE TWO ESCAPE HATCHES ARE THE PART THAT MATTERS, AND A NAIVE MEAN-VALUE PORT OMITS THEM.
// `interp_weights_poly_v2` does not always compute mean-value coordinates. It first tests
// whether the destination sits ON a source corner (`IS_POINT_IX`) or ON a source edge
// (`IS_SEGMENT_IX`) and, in those two cases, abandons the barycentric formula for a copy and a
// linear blend respectively. Its own comment says why: *"Mark Mayer et al algorithm that is
// used here does not operate well if vertex is close to borders of face."*
//
// That is not a rare guard here — it is the COMMON CASE for a bevel. A chamfer's new points
// slide along the source's edges, so a minted corner is on a source edge far more often than
// it is in a face's interior, and the reference leans on this hard enough to snap a
// destination onto its edge before interpolating (`closest_to_line_segment_v3` in
// `bev_create_ngon`, `bmesh_bevel.cc:1274-1277`) precisely so the segment hatch fires exactly
// rather than nearly. A port without the hatches would answer the bevel's most frequent
// question with its least reliable branch.
//
// ── WHERE THIS DIVERGES FROM THE REFERENCE, STATED RATHER THAN DISCOVERED ──────────────
//
// Blender carries the projected corners as `float` and the direction vectors as `double`
// (`Double2_Len`, and its comment explains that a distant destination loses the sign of
// "inside" in single precision). JS has one number type, so everything here is double. The
// consequence is one-directional: the hatch thresholds are SCALE-RELATIVE
// (`eps = 16 * FLT_EPSILON * max_value`), so they fire on the same geometry, while the
// interior weights are computed at least as accurately as the reference's. `FLT_EPSILON` is
// kept at the C value rather than swapped for `Number.EPSILON` — the constant is part of the
// ported threshold, not an artefact of the language it was written in.
//
// REF: ref/sources/blender-mesh/bmesh_interp.cc (`BM_loop_interp_from_face`:688);
//      ref/sources/blender-mesh/bmesh_bevel.cc (`bev_create_ngon`:1236 — the caller, the
//      per-corner `face_arr` and the edge snap); Blender `math_geom.cc`
//      (`interp_weights_poly_v2`:4334, `axis_dominant_v3_to_m3`:3686),
//      `math_vector.cc` (`ortho_basis_v3v3_v3`:568); src/app/edgeAngle.ts (the other reader of
//      {@link newellNormal}); src/nodes/meshAttributes.ts (`carriageForDomain`'s corner arm —
//      the refusal this exists to answer); issues #825, #814.

/**
 * `FLT_EPSILON` from `<cfloat>`, not `Number.EPSILON`.
 *
 * The reference's threshold is `16.0f * FLT_EPSILON * max_value`, and its author picked the 16
 * empirically (*"derived by empirically testing different values that works for the test files
 * in D7772"*). Substituting the double epsilon would keep the shape of the expression and
 * silently narrow the hatch by a factor of ~2e9, which is the kind of change that looks like a
 * modernisation and behaves like a removal.
 */
const FLT_EPSILON = 1.1920928955078125e-7;

/** Below this a rim's Newell sum is noise rather than a direction — shared with `edgeAngle`. */
export const DEGENERATE_NORMAL = 1e-12;

/**
 * The area-weighted normal of a polygon given its corner positions packed `xyz`, written into
 * `out` as a UNIT vector. `false` when the rim has no area, in which case `out` is untouched.
 *
 * ── WHY NEWELL AND NOT ONE CROSS PRODUCT ───────────────────────────────────────────────
 *
 * A face is an n-gon since #770 and a built quad is not guaranteed planar — a sphere's are not.
 * A cross product of two rim edges answers for one corner and silently picks a diagonal;
 * Newell's sum is the whole rim's, degrades gracefully on a non-planar face, and reduces to the
 * same answer on a planar one.
 *
 * 🔴 THIS IS THE ONE SPELLING. `edgeAngle.builtFaceNormals` used to carry its own copy of this
 * loop; it now gathers into a scratch buffer and calls this. Two spellings of a normal would be
 * free to drift, and the drift would be invisible: both would return a plausible unit vector,
 * and the interpolation basis and the edge angle would quietly disagree about which way a face
 * points. That is the same failure `reversedCornerAt` was extracted to prevent one domain over
 * (#785 is what the missing second spelling cost there).
 */
export function newellNormal(coords: Float64Array, n: number, out: Float64Array): boolean {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    const ax = coords[a];
    const ay = coords[a + 1];
    const az = coords[a + 2];
    const bx = coords[b];
    const by = coords[b + 1];
    const bz = coords[b + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length < DEGENERATE_NORMAL) return false;
  out[0] = nx / length;
  out[1] = ny / length;
  out[2] = nz / length;
  return true;
}

/**
 * Two orthonormal axes spanning the plane perpendicular to `normal`, written into `out` as
 * `[u0,u1,u2, v0,v1,v2]`.
 *
 * A port of `ortho_basis_v3v3_v3` (`math_vector.cc:568`), which is the whole of what
 * `axis_dominant_v3_to_m3` does before transposing — and the transpose is only there so that
 * `mul_v2_m3v3` reads the two axes out as rows. Projecting is then `dot(u, p)` and `dot(v, p)`,
 * which is what {@link planarWeights} does directly.
 *
 * ⚠️ THE PARTICULAR BASIS DOES NOT CHANGE THE ANSWER, AND IT IS STILL PORTED EXACTLY. Mean-value
 * weights are invariant under a rotation of the plane, and under a reflection they negate as a
 * set and are restored by the normalisation — so any consistent orthonormal basis would do. It
 * is ported anyway because "any basis works" is a claim about the weights, not about the two
 * HATCHES, whose thresholds are computed from projected coordinates; keeping the reference's
 * axes keeps `max_value` — and therefore the hatch boundary — identical to the reference's on
 * the same input.
 */
export function planarBasis(nx: number, ny: number, nz: number, out: Float64Array): void {
  const f = nx * nx + ny * ny;
  if (f > FLT_EPSILON) {
    const d = 1 / Math.sqrt(f);
    const u0 = ny * d;
    const u1 = -nx * d;
    out[0] = u0;
    out[1] = u1;
    out[2] = 0;
    out[3] = -nz * u1;
    out[4] = nz * u0;
    out[5] = nx * u1 - ny * u0;
  } else {
    // The degenerate case in the reference: the normal is parallel to Z, so the first two
    // components carry no direction and the basis is chosen outright.
    out[0] = nz < 0 ? -1 : 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 1;
    out[5] = 0;
  }
}

/** Squared distance from `p` to the segment `a`-`b`, in 2D — `dist_squared_to_line_segment_v2`. */
function distanceSquaredToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const lengthSquared = ux * ux + uy * uy;
  // `closest_to_line_segment_v2` answers `a` for a zero-length segment; the factor below would
  // be 0/0 without this, and the reference reaches the same answer through its own zero check.
  if (lengthSquared <= 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  let t = ((px - ax) * ux + (py - ay) * uy) / lengthSquared;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * ux;
  const cy = ay + t * uy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Where `p` falls along `a`→`b`, unclamped — `line_point_factor_v2`, whose fallback for a
 * zero-length segment is `0`.
 */
function linePointFactor(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ux = bx - ax;
  const uy = by - ay;
  const lengthSquared = ux * ux + uy * uy;
  if (!(lengthSquared > 0)) return 0;
  return ((px - ax) * ux + (py - ay) * uy) / lengthSquared;
}

/**
 * Half the tangent of the angle at `p` between two directions — `mean_value_half_tan_v2_db`.
 *
 * `(|a||b| - a·b) / (a x b)`, which is `tan(theta/2)` written so it stays finite. The reference
 * compares the cross product against ZERO rather than an epsilon, with its own citation
 * (*"Compare against zero since 'FLT_EPSILON' can be too large, see: #73348"*), and returns 0
 * for a non-finite result rather than propagating a NaN into the weight sum.
 */
function meanValueHalfTan(
  ax: number,
  ay: number,
  aLength: number,
  bx: number,
  by: number,
  bLength: number,
): number {
  const area = ax * by - ay * bx;
  if (area !== 0) {
    const result = (aLength * bLength - (ax * bx + ay * by)) / area;
    if (Number.isFinite(result)) return result;
  }
  return 0;
}

/**
 * Generalised barycentric weights for `n` polygon corners at a destination point, all in 2D —
 * a port of `interp_weights_poly_v2` (`math_geom.cc:4334`).
 *
 * `polygon` holds `n` corners packed `xy`; `out` receives `n` weights that sum to 1 (or to 0,
 * for the degenerate polygon the reference also leaves unnormalised).
 *
 * Exported for its own gate: the three branches — interior mean-value, on-a-corner, on-an-edge —
 * are separately checkable here and are NOT separately reachable through {@link planarWeights},
 * where which one fires is decided by geometry the caller does not choose.
 */
export function meanValueWeights2D(
  polygon: Float64Array,
  n: number,
  cx: number,
  cy: number,
  out: Float64Array,
): void {
  // The precision the supplied data can carry, as the reference computes it: the largest
  // component-wise distance from the destination to any corner. A fixed epsilon would be wrong
  // at both ends of the scale range a procedural mesh spans.
  let maxValue = 0;
  for (let i = 0; i < n; i++) {
    const dx = Math.abs(polygon[i * 2] - cx);
    const dy = Math.abs(polygon[i * 2 + 1] - cy);
    if (dx > maxValue) maxValue = dx;
    if (dy > maxValue) maxValue = dy;
  }
  const eps = 16 * FLT_EPSILON * maxValue;
  const epsSquared = eps * eps;

  let iCurr = n - 1;
  let iNext = 0;

  // `d_curr` starts at v[n-2] and `d_next` at v[n-1], so the first half-tangent spans the
  // corner BEFORE the one the loop is about to weight. The invariant the loop maintains is
  // that `d_next` always points from `v[iCurr]` to the destination.
  const prevIndex = (n + n - 2) % n;
  let dCurrX = polygon[prevIndex * 2] - cx;
  let dCurrY = polygon[prevIndex * 2 + 1] - cy;
  let dCurrLength = Math.hypot(dCurrX, dCurrY);
  let dNextX = polygon[iCurr * 2] - cx;
  let dNextY = polygon[iCurr * 2 + 1] - cy;
  let dNextLength = Math.hypot(dNextX, dNextY);
  let htPrev = meanValueHalfTan(dCurrX, dCurrY, dCurrLength, dNextX, dNextY, dNextLength);

  let totalWeight = 0;
  let onPoint = false;
  let onSegment = false;

  while (iNext < n) {
    const currX = polygon[iCurr * 2];
    const currY = polygon[iCurr * 2 + 1];
    const nextX = polygon[iNext * 2];
    const nextY = polygon[iNext * 2 + 1];

    // `d_next.len` is in fact the distance to `v[iCurr]` — see the invariant above.
    if (dNextLength < eps) {
      onPoint = true;
      break;
    }
    if (distanceSquaredToSegment(cx, cy, currX, currY, nextX, nextY) < epsSquared) {
      onSegment = true;
      break;
    }

    dCurrX = dNextX;
    dCurrY = dNextY;
    dCurrLength = dNextLength;
    dNextX = nextX - cx;
    dNextY = nextY - cy;
    dNextLength = Math.hypot(dNextX, dNextY);

    const ht = meanValueHalfTan(dCurrX, dCurrY, dCurrLength, dNextX, dNextY, dNextLength);
    out[iCurr] = dCurrLength === 0 ? 0 : (htPrev + ht) / dCurrLength;
    totalWeight += out[iCurr];

    iCurr = iNext++;
    htPrev = ht;
  }

  if (onPoint || onSegment) {
    // Every weight written before the break is discarded: the hatch is not a correction to a
    // partial mean-value result, it is a different answer to the same question.
    out.fill(0, 0, n);
    if (onPoint) {
      out[iCurr] = 1;
    } else {
      let fac = linePointFactor(
        cx,
        cy,
        polygon[iCurr * 2],
        polygon[iCurr * 2 + 1],
        polygon[iNext * 2],
        polygon[iNext * 2 + 1],
      );
      if (fac < 0) fac = 0;
      else if (fac > 1) fac = 1;
      out[iCurr] = 1 - fac;
      out[iNext] = fac;
    }
    return;
  }

  // 🔴 A ZERO TOTAL IS LEFT UNNORMALISED, WHICH IS THE REFERENCE'S BEHAVIOUR AND NOT AN
  // OVERSIGHT. It means the polygon carried no usable angle at all (every corner collinear with
  // the destination), and dividing would turn a set of zeros into NaNs that would then be
  // written into an attribute buffer and drawn. Zeros are a wrong-but-bounded answer; NaNs in a
  // vertex buffer are a mesh that vanishes.
  if (totalWeight !== 0) {
    for (let i = 0; i < n; i++) out[i] /= totalWeight;
  }
}

/**
 * The weights that blend a source polygon's per-corner values into ONE destination corner —
 * the whole of `BM_loop_interp_from_face`'s arithmetic, minus the blend itself.
 *
 * `polygon` holds the source face's `n` corner positions packed `xyz`; `normal` is that face's
 * unit normal; `dx/dy/dz` is the destination corner's position; `out` receives `n` weights.
 * `scratch2D` is a caller-owned buffer of at least `n * 2` — passed in rather than allocated
 * because this runs once per output corner, and a bevelled sphere has 704 of them.
 *
 * Returns `false` when the normal is unusable, in which case `out` is untouched: the reference's
 * fallback for a zero normal reaches for the face's tangent
 * (`BM_face_calc_tangent_auto`, `bmesh_interp.cc:714-719`), and a caller here has a better
 * answer available than a guessed axis — it can decline to write the attribute for that face
 * and say so, which is the substrate's standing preference for a plausible wrong value.
 */
export function planarWeights(
  polygon: Float64Array,
  n: number,
  normal: Float64Array,
  dx: number,
  dy: number,
  dz: number,
  out: Float64Array,
  scratch2D: Float64Array,
): boolean {
  const nx = normal[0];
  const ny = normal[1];
  const nz = normal[2];
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return false;
  if (nx === 0 && ny === 0 && nz === 0) return false;

  const basis = BASIS_SCRATCH;
  planarBasis(nx, ny, nz, basis);
  const u0 = basis[0];
  const u1 = basis[1];
  const u2 = basis[2];
  const v0 = basis[3];
  const v1 = basis[4];
  const v2 = basis[5];

  for (let i = 0; i < n; i++) {
    const px = polygon[i * 3];
    const py = polygon[i * 3 + 1];
    const pz = polygon[i * 3 + 2];
    scratch2D[i * 2] = u0 * px + u1 * py + u2 * pz;
    scratch2D[i * 2 + 1] = v0 * px + v1 * py + v2 * pz;
  }

  meanValueWeights2D(scratch2D, n, u0 * dx + u1 * dy + u2 * dz, v0 * dx + v1 * dy + v2 * dz, out);
  return true;
}

/**
 * Module-scoped because {@link planarWeights} is called once per output corner and the basis is
 * six numbers that never outlive the call. Safe for the same reason the rest of this module is
 * reentrant-free: it is synchronous arithmetic with no awaits, so no second caller can be inside
 * `planarWeights` while the first is.
 */
const BASIS_SCRATCH = new Float64Array(6);
