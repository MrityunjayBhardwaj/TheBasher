// #769 — a POLYGON layout, derived from a descriptor and checkable against the built buffer.
//
// ── WHAT THIS IS FOR, AND WHY IT HAS NO CONSUMER ──────────────────────────────────────
//
// A face in this substrate is a TRIANGLE (`faceCount.ts`, `CORNERS_PER_FACE = 3`). #770 makes
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
export function fanToTriangles(polygons: readonly PolygonRim[]): number[] {
  const out: number[] = [];
  for (const rim of polygons)
    for (let i = 1; i + 1 < rim.length; i++) out.push(rim[0], rim[i], rim[i + 1]);
  return out;
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
 * **Anything carrying a scope** — every `subset`, and the scoped arms of `array` and `mirror` —
 * waits on #770. Not because the derivation is impure: a subset's surviving triangles follow
 * from the scope string and the source face count with nothing read off a built geometry. The
 * obstruction is that the RESULT is not a polygon set. A scope addresses TRIANGLES, so a range
 * routinely keeps half a polygon — measured over `scopeSelection`, the one door the real code
 * uses: on a box, `"2-8"` keeps 7 triangles across 4 polygons with 1 of them partial, `"1-6"`
 * leaves 2 partial, and `"0"` keeps half of polygon 0 and nothing else. `tiledFaceOrder`
 * resolves a scoped generator through that identical call, so its copies inherit the same
 * halves. #770 makes a scope address polygons, and the problem dissolves rather than needing a
 * special case here.
 *
 * **The unscoped `array` and `mirror`** wait on something that does not exist yet. Expressing a
 * copy's rim in the MERGED index space needs each copy's vertices offset by the source's SPLIT
 * vertex count — 24 for a box, not the 8 topological points `pointCountOf` answers with. The
 * only thing that knows that number is `weldByPosition(geometry: BufferGeometry)`, which reads
 * a BUILT geometry. A descriptor-side spelling of three's vertex layout would be a fresh
 * grounded claim, not a propagation of this one, so it is named rather than guessed at.
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
      // 🔴 ONE REASON PER CASE, NOT BOTH EVERY TIME. These kinds are blocked for two different
      // reasons and only one applies to any given descriptor — an unscoped Array has no scope
      // to keep half a polygon, and telling its author about one sends them to look at a field
      // that is not there. A message naming a reason the check did not apply is the same defect
      // the attribute misfit warning carried until #717, one field over.
      const scoped = descriptor.kind === 'subset' || descriptor.scope !== undefined;
      return {
        kind: 'not-yet',
        why: scoped
          ? `a '${descriptor.kind}' scope addresses TRIANGLES, so it keeps half a polygon — ` +
            `measured on a box, '2-8' keeps 7 triangles across 4 polygons with 1 of them ` +
            `partial, and '0' keeps half of polygon 0 and nothing else`
          : `an unscoped '${descriptor.kind}' needs each copy's vertices offset by the source's ` +
            `SPLIT vertex count (24 for a box, not the 8 topological points 'pointCountOf' ` +
            `answers with), and the only thing that knows it reads a BUILT geometry`,
        until: '#770',
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
    default: {
      const unreachable: never = descriptor;
      throw new Error(`polygonLayoutOf: undeclared descriptor ${JSON.stringify(unreachable)}`);
    }
  }
}
