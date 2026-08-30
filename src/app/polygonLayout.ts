// #769 — a POLYGON layout, derived from a descriptor and checkable against the built buffer.
//
// ── WHAT THIS IS FOR, AND WHY IT HAS NO CONSUMER ──────────────────────────────────────
//
// A face in this substrate is a TRIANGLE (`faceCount.ts`, a `CORNERS_PER_FACE` of 3 at the
// time of writing; the constant is gone since #776). #770 makes
// it a polygon, and that flip is atomic: `faceCountOf` is the single source of "how many
// faces", and the instant it answers 6 for a box, a twelve-entry `material_index` misfits its
// own source AND `scope: "0-5"` starts selecting six whole sides. Material assignment and
// scope addressing move in the same instant as the count.
//
// So this module deliberately changes NOTHING. It derives the structure the flip will need and
// proves it against the geometry three.js actually builds, while every meaning stays where it
// is. Nothing in production calls it yet — a derivation with a live consumer IS the flip.
// Same shape the point work used: #716 built the stable element, #717 rode on it.
//
// ── THE ARITY RULE IS THREE.JS'S OWN, NOT A MODEL IMPOSED ON IT ───────────────────────
//
// three already emits geometry cell by cell, two triangles per cell, and its sphere skips one
// of the two at each pole (`node_modules/three/src/geometries/SphereGeometry.js`):
//
//     if ( iy !== 0 || thetaStart > 0 )                     indices.push( a, b, d );
//     if ( iy !== heightSegments - 1 || thetaEnd < Math.PI ) indices.push( b, c, d );
//
// Those two conditionals ARE the arity rule: a cell keeping both triangles is a quad, a cell at
// a pole keeps one and is a triangle. `BoxGeometry` pushes the identical `(a,b,d),(b,c,d)` pair
// with no skips. One rule covers both generators, and neither needed a special case invented
// for it — which is what the "what would prove this wrong" check on #736 was really asking.
//
// REF: node_modules/three/src/geometries/{Sphere,Box}Geometry.js; src/app/faceCount.ts (the
//      counts this must not contradict); issues #769, #770, #736, #718.

import type { GeometryDescriptor } from '../nodes/types';

/** One polygon's rim: source vertex indices, in the winding order the fan must follow. */
export type PolygonRim = readonly number[];

/**
 * What a descriptor can say about its polygons — three answers, not two.
 *
 * 🔴 A REFUSAL IS NOT AN ABSENCE, and the two are kept apart for the reason the attribute
 * carriage table keeps a drop apart from a refusal: they answer different questions and a
 * caller can act on only one of them. `outside-the-descriptor` says the buffers live somewhere
 * this module cannot reach and no issue will change that. `not-yet` says the layout is
 * derivable in principle and names what it is waiting on.
 */
export type PolygonLayoutVerdict =
  | { readonly kind: 'laid-out'; readonly polygons: readonly PolygonRim[] }
  | { readonly kind: 'not-yet'; readonly why: string; readonly until: string }
  | { readonly kind: 'outside-the-descriptor'; readonly why: string };

/**
 * Triangulate a polygon rim by fanning from corner 0 — exact here, and cheap, because no
 * constructible face is non-convex. `GeometryDescriptor` is a closed union whose only
 * generators are three.js's box and sphere: planar convex quads, plus triangles at the poles.
 * A future arm that could produce a concave face has to be added to that union, where the
 * `never` below forces this assumption to be re-examined rather than silently outlived.
 *
 * ⚠️ TRIANGLE-EXACT, NEVER BYTE-EXACT, AND THAT IS A PROPERTY OF FANS RATHER THAN A DEFECT.
 * three pushes `(a,b,d)` then `(b,c,d)`. A fan from one corner yields both as ROTATIONS of
 * those triples, and no starting corner makes both literal — the first triangle forces
 * corner 0 = `a`, the second forces corner 0 = `b`, and they cannot both hold. Same triangles,
 * same windings, same order, so pixels and group ranges are untouched; the flat index array is
 * not identical, and the gate therefore compares triples up to rotation rather than by `===`.
 */
/**
 * How many triangles each polygon fans to, in the same order — the projection of a rim layout
 * that every consumer of the flip actually wants (#770).
 *
 * ── WHY THE ARITY AND NOT THE RIM IS WHAT TRAVELS ─────────────────────────────────────
 *
 * Not one consumer of a face count wants a rim. What they want is the number that turns a
 * polygon index into an INDEX RANGE: `faceCountMismatch` needs how many index entries a
 * descriptor should materialise to, `materialGroups` needs where a run of polygons starts and
 * ends in the index buffer, `faceSubset` needs which triangles a kept polygon owns, and
 * `tiledCornerOrder` needs how many corners a face carries. All four are arithmetic over one
 * number per polygon.
 *
 * 🔴 AND THE ARITY SURVIVES THE GATHER THAT A RIM DOES NOT, which is why the derived kinds'
 * refusal above does not block the flip. A rim is stated in the SOURCE's vertex numbering, so
 * expressing a copy's rim in a merged geometry needs each copy offset by the source's split
 * vertex count — the number that does not exist descriptor-side, and the reason `array` and
 * `mirror` answer `not-yet`. An arity is a plain count with no vertex numbering in it at all,
 * so `arity[i] = sourceArity[order[i]]` through the face order a per-face attribute already
 * gathers through. `faceCount.ts` composes it that way; this function answers for the two
 * kinds that GENERATE geometry, which is where the claim has to be grounded.
 *
 * `rim.length - 2` is {@link fanToTriangles}'s own loop count rather than a second statement
 * of it: that loop runs `i` from 1 while `i + 1 < rim.length`, which is exactly this many
 * times. A quad fans to 2, a triangle to 1.
 */
const arityCache = new WeakMap<readonly PolygonRim[], readonly number[]>();

export function polygonArityOf(descriptor: GeometryDescriptor): readonly number[] | null {
  const verdict = polygonLayoutOf(descriptor);
  if (verdict.kind !== 'laid-out') return null;
  // Memoised on the LAYOUT's identity, so this cache cannot outlive the layout it projects
  // and needs no ceiling of its own — the same discipline `faceCount.ts`'s corner cache keeps
  // against its face order.
  const hit = arityCache.get(verdict.polygons);
  if (hit !== undefined) return hit;
  const arity = verdict.polygons.map((rim) => rim.length - 2);
  arityCache.set(verdict.polygons, arity);
  return arity;
}

/**
 * How many CORNERS each polygon has, in the same order — Blender's loop count per face (#776).
 *
 * ── WHY THIS READS THE RIM RATHER THAN ADDING TWO TO THE ARITY ────────────────────────
 *
 * `corners = arity + 2` is true and it is the fan rule read backwards. {@link polygonArityOf}
 * above already states that rule once, in the direction {@link fanToTriangles} implements it;
 * writing the inverse here would make this module the SECOND place that decides how a rim and
 * a triangle count relate, free to drift from the first the day a polygon is triangulated by
 * anything other than a fan from corner 0. A rim's length restates nothing at all.
 *
 * The two are still checked against each other — `cornerCount.gate.test.ts` asserts
 * `corners[i] === arity[i] + 2` at every sync-buildable descriptor — but as an agreement
 * between two independent derivations rather than as one derived from the other.
 *
 * 🔴 A CORNER IS A POLYGON CORNER SINCE #776, NOT A TRIANGLE CORNER. A box has 24 of them and
 * not 36, which is what `MeshElementCounts` has declared for a box since ns-1 and what
 * `tiledCornerOrder` disagreed with until #776. A sphere separates the two readings from a
 * third that also gets called "corner": 176 loops, 240 triangle corners, and 63 split render
 * vertices, all of one 8x6 sphere. A box makes all three look like 24/36/24 and cannot tell
 * the first from the last, which is why nothing here is checked on a box alone.
 */
const cornerCache = new WeakMap<readonly PolygonRim[], readonly number[]>();

export function polygonCornersOf(descriptor: GeometryDescriptor): readonly number[] | null {
  const verdict = polygonLayoutOf(descriptor);
  if (verdict.kind !== 'laid-out') return null;
  // Keyed on the LAYOUT's identity for the reason the arity cache above states, and held in a
  // second map rather than as a pair in one: a consumer wants exactly one of these two numbers.
  const hit = cornerCache.get(verdict.polygons);
  if (hit !== undefined) return hit;
  const corners = verdict.polygons.map((rim) => rim.length);
  cornerCache.set(verdict.polygons, corners);
  return corners;
}

export function fanToTriangles(polygons: readonly PolygonRim[]): number[] {
  const out: number[] = [];
  for (const rim of polygons)
    for (let i = 1; i + 1 < rim.length; i++) out.push(rim[0], rim[i], rim[i + 1]);
  return out;
}

/**
 * Which corner of a REFLECTED copy sits where corner `k` of the source did (#785, #776).
 *
 * `buildMirror` runs `reverseWinding` over its reflected half, so a copied face traverses its
 * corners the other way round. Corner 0 is held fixed and the rest run backwards, which makes
 * this an involution — applying it twice is the identity — and lets one statement serve both
 * readers: {@link reverseRim} turns a rim around with it, and `tiledCornerOrder` gathers a
 * corner attribute through it. Two spellings of one reversal is exactly the drift this area
 * names by name everywhere else.
 *
 * 🔴 THE FIXED CORNER IS NOT A FREE CHOICE, AND THE FIRST DRAFT OF THIS COMMENT SAID IT WAS.
 * It claimed every rotation of a reversed rim fans to the same wound triangles, so which corner
 * kept the name 0 was ours to pick. Falsified by substituting the rotation-free `corners - 1 -
 * k` and re-running: `cornerCount.gate.test.ts` row 6 reds. A fan from corner 0 over `[r0, r3,
 * r2, r1]` splits a quad along `r0-r2`; a fan over `[r3, r2, r1, r0]` splits it along `r3-r1`.
 * Same corners, same direction, DIFFERENT DIAGONAL — and the built index buffer has exactly one
 * of them. Only a triangle is rotation-blind, which is why a sphere's pole rows cannot pin this
 * and its quad rows can.
 *
 * So this is grounded, and it is additionally an INVOLUTION — applied twice it is the identity,
 * which is what makes a mirror of a mirror come back in source order. That property is checked
 * on its own because it is the one thing an unbuilt permutation can still get wrong.
 */
export function reversedCornerAt(k: number, corners: number): number {
  return k === 0 ? 0 : corners - k;
}

/** A rim traversed the other way round — {@link reversedCornerAt} applied to a whole face. */
export function reverseRim(rim: PolygonRim): PolygonRim {
  return rim.map((_, k) => rim[reversedCornerAt(k, rim.length)]);
}

/**
 * A grid cell's rim, in the order that makes a fan from corner 0 reproduce three's two
 * triangles — `[d, a, b, c]`, and the order is the whole content of this function.
 *
 * 🔴 DERIVED, THEN MEASURED, BECAUSE THREE PLAUSIBLE ORDERS PRODUCE THE SAME COUNT. three
 * splits the cell along the `b–d` diagonal; a fan from `a` over `[a,b,c,d]` splits along `a–c`
 * instead, giving two triangles that are the right SHAPE, the right NUMBER, and the wrong
 * pair. Starting at `d` reproduces `(d,a,b)` and `(d,b,c)`, which are rotations of `(a,b,d)`
 * and `(b,c,d)` in that order — the same triangles, the same windings, and the same sequence.
 * Checked against the real index buffer at five sizes rather than reasoned about here alone.
 */
function cellRim(a: number, b: number, c: number, d: number): PolygonRim {
  return [d, a, b, c];
}

/** Keyed on the two numbers a layout depends on; `faceCount.ts` bounds its orders the same way. */
const layoutCache = new Map<string, PolygonLayoutVerdict>();
const LAYOUT_CACHE_LIMIT = 8;

function remember(key: string, verdict: PolygonLayoutVerdict): PolygonLayoutVerdict {
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) layoutCache.clear();
  layoutCache.set(key, verdict);
  return verdict;
}

/**
 * A box's six quads, one per plane.
 *
 * `BoxGeometry` builds six planes of `gridX × gridY` cells and numbers each plane's vertices
 * from a running `numberOfVertices`. This descriptor carries no segment counts, so every plane
 * is a single cell of four vertices and plane `p` occupies `[4p, 4p + 4)`. Within it, three's
 * own naming is `a = nv + ix + gridX1*iy`, `b = nv + ix + gridX1*(iy+1)`, `c = nv + (ix+1) +
 * gridX1*(iy+1)`, `d = nv + (ix+1) + gridX1*iy` — which at `ix = iy = 0`, `gridX1 = 2` is
 * `a = nv`, `b = nv + 2`, `c = nv + 3`, `d = nv + 1`.
 */
function boxPolygons(): readonly PolygonRim[] {
  const polygons: PolygonRim[] = [];
  for (let plane = 0; plane < 6; plane++) {
    const nv = plane * 4;
    polygons.push(cellRim(nv, nv + 2, nv + 3, nv + 1));
  }
  return polygons;
}

/**
 * A sphere's `w × h` cells — quads in the middle, triangles in the two pole rows.
 *
 * ⚠️ `w × h`, AND #736 SAID `w × (h − 1)`. Measured: every grid cell yields exactly one
 * polygon, and a pole row's cells yield TRIANGLES rather than nothing, so the pole rows are
 * counted rather than subtracted. At w=8 h=6 that is 48 polygons — 16 triangles and 32 quads —
 * where the subtraction gives 40. The TRIANGLE total is unaffected and still agrees with
 * `faceCountOf`'s `2 * w * (h - 1)`, which is why the wrong figure survived being written down.
 *
 * The clamps are three's, applied before anything else and quoted from its constructor:
 * `widthSegments = Math.max( 3, Math.floor( widthSegments ) )` and
 * `heightSegments = Math.max( 2, Math.floor( heightSegments ) )`. `faceCountOf` and
 * `pointCountOf` clamp identically, for the same reason all three must: a second spelling that
 * skipped the clamp would disagree exactly at the edges nobody checks by hand.
 *
 * The pole conditions read `iy !== 0` and `iy !== h - 1` with no `thetaStart`/`thetaEnd` term,
 * because the registry constructs `new SphereGeometry(radius, widthSegments, heightSegments)`
 * and takes three's defaults — `thetaStart = 0`, `thetaLength = Math.PI` — so both of three's
 * `||` branches are constantly false here. Reading the descriptor for a theta it does not
 * carry would be inventing a parameter this substrate cannot set.
 */
function spherePolygons(widthSegments: number, heightSegments: number): readonly PolygonRim[] {
  const w = Math.max(3, Math.floor(widthSegments));
  const h = Math.max(2, Math.floor(heightSegments));

  // three's `grid`: row `iy` holds `w + 1` vertex indices, counted in the same order.
  const rowStart = (iy: number) => iy * (w + 1);

  const polygons: PolygonRim[] = [];
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const a = rowStart(iy) + ix + 1;
      const b = rowStart(iy) + ix;
      const c = rowStart(iy + 1) + ix;
      const d = rowStart(iy + 1) + ix + 1;
      const keepsFirst = iy !== 0;
      const keepsSecond = iy !== h - 1;
      if (keepsFirst && keepsSecond) polygons.push(cellRim(a, b, c, d));
      // A pole cell keeps ONE of the two triangles, so its rim IS that triangle, taken
      // verbatim in the order three pushes it rather than re-derived from the quad.
      else if (keepsFirst) polygons.push([a, b, d]);
      else polygons.push([b, c, d]);
    }
  }
  return polygons;
}

/**
 * The polygons a descriptor tessellates to, or a named refusal.
 *
 * ── WHY THE DERIVED KINDS REFUSE, AND WHY THAT IS NOT A GAP ───────────────────────────
 *
 * **All three wait on one thing, and it used to be two.** Expressing a copy's rim in the MERGED
 * index space needs each copy's vertices offset by the source's SPLIT vertex count — 24 for a
 * box, not the 8 topological points `pointCountOf` answers with. The only thing that knows that
 * number is `weldByPosition(geometry: BufferGeometry)`, which reads a BUILT geometry. A
 * descriptor-side spelling of three's vertex layout would be a fresh grounded claim, not a
 * propagation of this one, so it is named rather than guessed at. That is #777.
 *
 * 🔴 THE SECOND REASON IS GONE AT #770, AND IT WENT BY BEING SOLVED. #769 also refused anything
 * carrying a scope, because a scope addressed TRIANGLES and a range routinely kept half a
 * polygon — measured over `scopeSelection`, on a box `"2-8"` kept 7 triangles across 4 polygons
 * with 1 partial and `"0"` kept half of polygon 0. #770 made a scope address polygons, so a
 * subset keeps whole polygons by construction. #769 predicted exactly that dissolution, and the
 * prediction is recorded here because a refusal whose stated reason has quietly gone false is
 * the thing a reader trusts instead of checking.
 *
 * ⚠️ AND THE REMAINING REFUSAL BLOCKS NO CONSUMER. Every one of #770's four wanted an ARITY
 * rather than a rim — see {@link polygonArityOf} — and an arity carries no vertex numbering, so
 * it composes through these kinds by gather while a rim cannot.
 */
export function polygonLayoutOf(descriptor: GeometryDescriptor): PolygonLayoutVerdict {
  switch (descriptor.kind) {
    case 'box': {
      const hit = layoutCache.get('box');
      if (hit !== undefined) return hit;
      return remember('box', { kind: 'laid-out', polygons: boxPolygons() });
    }
    case 'sphere': {
      // Keyed on the CLAMPED segments, not the raw ones: three clamps before tessellating, so
      // `(8.9, 6.9)` and `(8, 6)` are the same geometry and must not be two entries in a cache
      // that holds eight.
      const key = `sphere|${Math.max(3, Math.floor(descriptor.widthSegments))}|${Math.max(2, Math.floor(descriptor.heightSegments))}`;
      const hit = layoutCache.get(key);
      if (hit !== undefined) return hit;
      return remember(key, {
        kind: 'laid-out',
        polygons: spherePolygons(descriptor.widthSegments, descriptor.heightSegments),
      });
    }
    case 'array':
    case 'mirror':
    case 'subset': {
      // 🔴 ONE REASON NOW, AND IT WAS TWO UNTIL #770 — the branch is gone because the condition
      // it split on is gone, not because it was tidied away.
      //
      // The retired half read: *"a scope addresses TRIANGLES, so it keeps half a polygon —
      // measured on a box, '2-8' keeps 7 triangles across 4 polygons with 1 of them partial,
      // and '0' keeps half of polygon 0 and nothing else"*. That was true and it is now false:
      // #770 made a scope address POLYGONS, so a subset keeps whole polygons by construction
      // and the obstruction dissolved rather than being worked around — which is exactly what
      // #769 said would happen, so it is recorded as a prediction that held rather than deleted.
      //
      // What survives applies to every one of these kinds equally, scoped or not, which is why
      // there is no longer a branch: a RIM is stated in vertex indices, so a copy's rim needs
      // the source's SPLIT vertex count, and nothing descriptor-side has it.
      //
      // ⚠️ AND THIS DOES NOT BLOCK A CONSUMER, WHICH IS WHY THE REFUSAL CAN STAND. #770's four
      // consumers all wanted an ARITY — a count per polygon with no vertex numbering in it —
      // which composes through these kinds by gather. See {@link polygonArityOf}.
      return {
        kind: 'not-yet',
        why:
          `a '${descriptor.kind}' rim needs each copy's vertices offset by the source's SPLIT ` +
          `vertex count (24 for a box, not the 8 topological points 'pointCountOf' answers ` +
          `with), and the only thing that knows it reads a BUILT geometry`,
        until: '#777',
      };
    }
    case 'gltf':
      return {
        kind: 'outside-the-descriptor',
        why: "a 'gltf' descriptor's buffers live in a loaded asset clone, so nothing on it says what its polygons are",
      };
    case 'baked':
      return {
        kind: 'outside-the-descriptor',
        why: "a 'baked' descriptor carries a vertex count and its authoritative bytes are in OPFS, so its polygons are not derivable here",
      };
    // #814 — refused for the same reason the derived kinds above are, and it is worth being
    // precise about which reason. This function states rims in a BUILT geometry's SPLIT vertex
    // numbering; a bevel's split numbering is the builder's own and is not derivable here. Its
    // WELDED rims are a different question with an answer — `weldedPolygonsOf` has the arm — and
    // that is the same projection-composes-where-the-structure-cannot split #770 already found.
    case 'bevel':
      return {
        kind: 'outside-the-descriptor',
        why: "a 'bevel' mints faces, so its rims exist only in the split numbering the builder lays out; its WELDED rims are stated by 'weldedPolygonsOf'",
      };
    default: {
      const unreachable: never = descriptor;
      throw new Error(`polygonLayoutOf: undeclared descriptor ${JSON.stringify(unreachable)}`);
    }
  }
}
