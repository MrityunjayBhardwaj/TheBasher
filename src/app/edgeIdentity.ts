// edgeIdentity — edges as countable, addressable elements (#718, P4).
//
// The edge domain has been declared since ns-2 and empty ever since: no buffer, no order, and
// `MeshElementCounts.edges` with no producer. #607 named why — *"edges are implied by the index
// buffer; there is no element to attach membership to"* — and #718 named what unblocks it: a
// topological point identity, because two faces sharing an edge do NOT share point indices on a
// split buffer. A box's six quads carry their own four corners each, so an edge set read off the
// index gives 24 where the mesh has 12.
//
// ── WHY THIS IS A LEAF BESIDE `pointIdentity`, NOT A SECTION INSIDE IT ────────────────────
//
// An edge is a PAIR OF POINT IDS, so everything here is downstream of that module and nothing
// here is needed by it. Keeping it separate is what lets `pointIdentity` stay the statement of
// what a point IS, with this module the statement of what joins two of them.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────────
//
// 🔴 NO EDGE ATTRIBUTES. #718's §6 re-scope is taken: P4 ships edges countable and addressable,
// and storage ships with the first operator that reads one — together with the promotion rule
// that operator needs, since a fragment shader has no edge input. A domain that can store what
// nothing writes and nothing reads is a table awaiting its first consumer. `ScopeDomain` stays
// `['face']`, so this lands edges in exactly the posture `point` holds today: resolvable from a
// descriptor, reachable from a test and from #667, and from nothing else.
//
// REF: src/app/pointIdentity.ts (`weldByPosition` — the topological ids these pairs name);
//      src/app/polygonLayout.ts (`polygonLayoutOf` — the rims, in SPLIT numbering);
//      node_modules/three/src/geometries/BoxGeometry.js (the plane table quoted below);
//      issues #718, #607, #716, #777.

import type { CountVerdict, GeometryDescriptor } from '../nodes/types';
import { type PolygonRim, polygonLayoutOf, reverseRim } from './polygonLayout';
import { tiledFaceOrder } from './faceCount';
import { pointCountOf } from './pointIdentity';

/**
 * A geometry's edges, as pairs of TOPOLOGICAL point ids.
 *
 * Flat rather than an array of pairs for the reason `PointWeld.map` is a `Uint32Array`: the set
 * is read by index and never reshaped, and a 32x16 sphere is 992 edges — 1,984 numbers in one
 * buffer against 992 two-element arrays.
 */
export interface EdgeSet {
  /** `pairs[2i]` and `pairs[2i + 1]` are edge `i`'s two points, LOWER ID FIRST. */
  readonly pairs: Uint32Array;
  /** How many edges — `pairs.length / 2`, carried so a caller never restates the halving. */
  readonly count: number;
}

function counted(count: number): CountVerdict {
  return { kind: 'counted', count };
}

// ---------------------------------------------------------------------------
// The split -> topological map, closed form
// ---------------------------------------------------------------------------

/**
 * three's six `buildPlane` calls, quoted from `BoxGeometry.js` in the order it makes them.
 *
 * 🔴 THIS IS A FRESH GROUNDED CLAIM ABOUT three, WHICH IS EXACTLY WHAT `polygonLayoutOf` DECLINED
 * TO MAKE AND FILED AS #777. It is made here rather than deferred because #718 needs the map and
 * the claim is bounded: a `box` descriptor carries no segment counts, so every plane is a single
 * cell of four vertices and the whole map is 24 entries. It is not left as an assertion either —
 * `edgeIdentity.gate.test.ts` compares this against `weldByPosition` of the geometry the registry
 * actually builds, at every sync-buildable descriptor.
 *
 * Each call is `buildPlane(u, v, w, udir, vdir, width, height, depth, ...)`, and the vertex loop
 * writes `vector[u] = x * udir`, `vector[v] = y * vdir`, `vector[w] = depthHalf` — so a corner's
 * sign along `w` is the sign of that call's `depth` argument, and its signs along `u` and `v` are
 * the cell corner's own, turned by `udir` and `vdir`.
 */
const BOX_PLANES: readonly {
  readonly u: 0 | 1 | 2;
  readonly v: 0 | 1 | 2;
  readonly w: 0 | 1 | 2;
  readonly udir: 1 | -1;
  readonly vdir: 1 | -1;
  readonly wsign: 1 | -1;
}[] = [
  // buildPlane( 'z', 'y', 'x', -1, -1, depth, height,  width, ... ) // px
  { u: 2, v: 1, w: 0, udir: -1, vdir: -1, wsign: 1 },
  // buildPlane( 'z', 'y', 'x',  1, -1, depth, height, -width, ... ) // nx
  { u: 2, v: 1, w: 0, udir: 1, vdir: -1, wsign: -1 },
  // buildPlane( 'x', 'z', 'y',  1,  1, width, depth,  height, ... ) // py
  { u: 0, v: 2, w: 1, udir: 1, vdir: 1, wsign: 1 },
  // buildPlane( 'x', 'z', 'y',  1, -1, width, depth, -height, ... ) // ny
  { u: 0, v: 2, w: 1, udir: 1, vdir: -1, wsign: -1 },
  // buildPlane( 'x', 'y', 'z',  1, -1, width, height,  depth, ... ) // pz
  { u: 0, v: 1, w: 2, udir: 1, vdir: -1, wsign: 1 },
  // buildPlane( 'x', 'y', 'z', -1, -1, width, height, -depth, ... ) // nz
  { u: 0, v: 1, w: 2, udir: -1, vdir: -1, wsign: -1 },
];

/**
 * A box's 24 split positions to its 8 corners.
 *
 * ⚠️ IDS ARE ASSIGNED BY FIRST ENCOUNTER, BECAUSE THAT IS WHAT `weldByPosition` DOES — it walks
 * the position buffer and hands out `id = next++` the first time a quantised key appears. Any
 * other numbering here would be a second, disagreeing name for the same eight points, and every
 * count would still come out right.
 *
 * Only the SIGNS matter, never the extents: welding compares positions, and scaling a box moves
 * all eight corners without merging any two of them. So this map is the same for every box, which
 * is why it is computed once rather than per descriptor.
 */
function boxSplitToWelded(): Uint32Array {
  const map = new Uint32Array(24);
  const seen = new Map<string, number>();
  let next = 0;
  for (let plane = 0; plane < BOX_PLANES.length; plane++) {
    const spec = BOX_PLANES[plane];
    // three's vertex loop is `iy` outer, `ix` inner, over `gridY1 = gridX1 = 2`.
    for (let iy = 0; iy < 2; iy++) {
      for (let ix = 0; ix < 2; ix++) {
        // `x = ix * segmentWidth - widthHalf` is negative at ix=0 and positive at ix=1; the
        // same for `y` in `iy`. The magnitudes are the box's, and they cancel out of a sign.
        const signs = [0, 0, 0];
        signs[spec.u] = (ix === 0 ? -1 : 1) * spec.udir;
        signs[spec.v] = (iy === 0 ? -1 : 1) * spec.vdir;
        signs[spec.w] = spec.wsign;
        const key = `${signs[0]},${signs[1]},${signs[2]}`;
        let id = seen.get(key);
        if (id === undefined) {
          id = next++;
          seen.set(key, id);
        }
        map[plane * 4 + iy * 2 + ix] = id;
      }
    }
  }
  return map;
}

const BOX_SPLIT_TO_WELDED = boxSplitToWelded();

/**
 * A sphere's `(w + 1) x (h + 1)` split grid to its `w(h - 1) + 2` points.
 *
 * Two duplications collapse and they are the only two, which is why this is arithmetic rather
 * than a hash: an entire pole ROW sits on one point (three emits `w + 1` vertices there, all at
 * the same position, differing only in `u`), and the seam column `ix = w` repeats `ix = 0`.
 *
 * The numbering that falls out is the first-encounter one `weldByPosition` produces — north pole
 * `0`, then each interior ring in row order, then the south pole last — because three emits the
 * rows in exactly that order. Observed on a 4x3 sphere as `[0 | 1..4 | 5..8 | 9]` before it was
 * written down here.
 *
 * The clamps are three's own, applied before anything else, and they are the reason this cannot
 * be derived from the raw descriptor fields — `faceCountOf`, `pointCountOf` and `polygonLayoutOf`
 * all clamp identically, and a fourth spelling that skipped it would disagree exactly at the
 * segment counts nobody checks by hand.
 */
function sphereSplitToWelded(widthSegments: number, heightSegments: number): Uint32Array {
  const w = Math.max(3, Math.floor(widthSegments));
  const h = Math.max(2, Math.floor(heightSegments));
  const south = w * (h - 1) + 1;
  const map = new Uint32Array((w + 1) * (h + 1));
  for (let iy = 0; iy <= h; iy++) {
    for (let ix = 0; ix <= w; ix++) {
      const split = iy * (w + 1) + ix;
      map[split] = iy === 0 ? 0 : iy === h ? south : 1 + (iy - 1) * w + (ix % w);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Welded rims
// ---------------------------------------------------------------------------

/**
 * Each polygon's rim in TOPOLOGICAL point ids, or `null` when the descriptor cannot say.
 *
 * 🔑 THIS IS WHY THE DERIVED KINDS ARE NOT BLOCKED BY #777, AND THE DISTINCTION IS THE WHOLE
 * POINT. {@link polygonLayoutOf} refuses `array` / `mirror` / `subset` because expressing a
 * copy's rim in the merged index space needs the source's SPLIT vertex count — 24 for a box —
 * which only a built geometry knows. A WELDED rim needs the source's TOPOLOGICAL point count,
 * which `pointCountOf` derives closed-form. So the offset that a split rim cannot state, a
 * welded rim can, and the composition is a plain gather.
 *
 * That is the same shape #770 found one domain over: a projection composes where the structure
 * cannot. It is recorded twice on purpose — a refusal is about a representation, and the right
 * question is always what the consumer actually reads.
 */
export function weldedPolygonsOf(descriptor: GeometryDescriptor): readonly PolygonRim[] | null {
  switch (descriptor.kind) {
    case 'box':
    case 'sphere': {
      const layout = polygonLayoutOf(descriptor);
      // Unreachable: `polygonLayoutOf` lays out exactly these two kinds. Written as a value
      // rather than a `!` so a third primitive added to one switch and not the other is a
      // named wrong answer instead of a crash.
      if (layout.kind !== 'laid-out') return null;
      const split =
        descriptor.kind === 'box'
          ? BOX_SPLIT_TO_WELDED
          : sphereSplitToWelded(descriptor.widthSegments, descriptor.heightSegments);
      return layout.polygons.map((rim) => rim.map((v) => split[v]));
    }
    case 'gltf':
    case 'baked':
      // The same escape hatch `faceCountOf` and `pointCountOf` declare, and censused with them:
      // these buffers live outside the descriptor, so nothing here can say what joins what.
      return null;
    case 'array':
    case 'mirror':
    case 'subset': {
      const sourceRims = weldedPolygonsOf(descriptor.source.descriptor);
      if (sourceRims === null) return null;
      const sourcePoints = pointCountOf(descriptor.source.descriptor);
      if (sourcePoints.kind !== 'counted') return null;
      const merged = pointCountOf(descriptor);
      if (merged.kind !== 'counted') return null;
      const tiled = tiledFaceOrder(descriptor);
      if (tiled === null) return null;

      // Copies are UNIFORM at the point domain even when they are not at the face domain: a
      // scoped generator repeats only the subset's faces, but `pointCountOf` is
      // `source x copies` regardless, because a subset filters the INDEX and never the position
      // buffer. Measured: `subset(box, "0")` keeps ONE face and still reports 8 points, four of
      // which no surviving face touches. So copy `c` owns `[c * sourcePoints, (c + 1) *
      // sourcePoints)` and the offset below is exact.
      const copies = merged.count / sourcePoints.count;
      const { sourceFaces, order } = tiled;

      // `tiledFaceOrder` lays the whole input down FIRST and then appends `repeats` copies of the
      // subset, so copy 0 is the leading `sourceFaces` entries and the remainder divides evenly
      // into the rest. A subset descriptor has no repeats at all and falls out as copy 0.
      const blocks = copies - 1;
      const blockSize = blocks > 0 ? (order.length - sourceFaces) / blocks : 0;
      // 🔴 A FRACTIONAL BLOCK IS A WRONG ANSWER, NOT A ROUNDING QUESTION. The repeats divide the
      // order evenly by construction — measured at six scoped generators — so a fraction here
      // means the layout has stopped being "the whole input, then N copies of the subset" and the
      // copy attribution below would silently offset some faces into the wrong copy's point
      // range. Every edge would still be a plausible pair of real ids, which is precisely why
      // this refuses instead of flooring: a named absence is recoverable, a wrong edge set is not.
      if (!Number.isInteger(blockSize)) return null;

      // 🔴 #785 — A REFLECTED COPY IS WOUND THE OTHER WAY, AND COPYING THE RIM VERBATIM SAID
      // OTHERWISE. `buildMirror` runs `reverseWinding` over its reflected half, so the copied
      // faces in the built geometry traverse their corners in the opposite cyclic direction
      // from the faces they came from. Measured, per face, against the built index buffer in
      // composed-topological ids: `mirror(box)` is 6 faces wound as the source and 6 wound
      // OPPOSITE, `mirror(sphere 8x6)` is 48 and 48, and every Array and Subset row is 0.
      //
      // This was invisible until #776 because the only consumer was `edgeSetOf`, and an edge
      // is an UNORDERED pair — reversing a rim leaves the edge set identical, so the gate's
      // count and containment checks were both blind to it by construction. A claim with no
      // reader can be wrong and green at the same time.
      //
      // Corner 0 is held fixed rather than reversing the whole array, so the permutation is
      // `k -> (k === 0 ? 0 : rim.length - k)` and a corner order can state the same reversal
      // as an index map. `tiledCornerOrder` reverses on this same `sourceFaces` boundary, for
      // this same reason, and the two agree because they name one fact rather than two.
      const reversesCopies = descriptor.kind === 'mirror';

      const rims: PolygonRim[] = [];
      for (let face = 0; face < order.length; face++) {
        const copy =
          face < sourceFaces || blockSize <= 0
            ? 0
            : 1 + Math.floor((face - sourceFaces) / blockSize);
        const offset = copy * sourcePoints.count;
        const rim = sourceRims[order[face]].map((p) => p + offset);
        rims.push(reversesCopies && copy > 0 ? reverseRim(rim) : rim);
      }
      return rims;
    }
    default: {
      const unreachable: never = descriptor;
      throw new Error(`weldedPolygonsOf: undeclared descriptor ${JSON.stringify(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The edge set
// ---------------------------------------------------------------------------

/**
 * A descriptor's edges, deterministically ordered, or `null` when it cannot say.
 *
 * ── THE ORDER IS A CONTRACT, AND IT IS OURS ──────────────────────────────────────────────
 *
 * A per-edge attribute will index against this order, so it is stated rather than left to fall
 * out. **First encounter, walking faces in build order and each rim in winding order.**
 *
 * ⚠️ NOT CLAIMED TO FOLLOW BLENDER. The bundled API reference documents that `Mesh.edge_keys`
 * and `MeshPolygon.edge_keys` exist and says nothing about their order, and no live instance was
 * available to observe one, so borrowing would have been inventing. The reason for this order is
 * ours: it derives the edge domain from the face order, which every other domain here already
 * gathers over, and it makes the derived kinds a plain concatenation — copy `c`'s point ids are
 * all at least `c x sourcePoints`, so walking the tiled face order emits copy 0's edges, then
 * copy 1's, with no re-sort. A canonical `(min, max)` sort would be equally deterministic and
 * would agree on the derived kinds, but it relates this domain to nothing else. Worth
 * re-checking against a live Blender before edge attributes ship, when indices become visible.
 *
 * ── COST, AND WHY THERE IS NO MEMO ───────────────────────────────────────────────────────
 *
 * Measured: 0.004 ms for a box, 0.089 ms at a 32x16 sphere (992 edges), 0.397 ms at 64x32
 * (4,032), and 2.94 ms for an Array x8 of that sphere (32,256). Linear in edges, as the walk is.
 *
 * NOT memoised, deliberately, and the last figure is why that needs saying rather than assuming:
 * 2.94 ms would be unaffordable per operator per evaluate, and affordable once per build. Today
 * the only caller is `componentCountOf`'s `edge` arm, which no operator can reach because
 * `ScopeDomain` is `['face']` — so the access pattern is not yet observable, and a cache
 * installed now would be sized for a guess. #667 is the first caller that will know whether it
 * wants this per build or per gather; `tiledFaceOrder` records the same reasoning and the same
 * outcome, having measured its own road before adding its cache.
 */
export function edgeSetOf(descriptor: GeometryDescriptor): EdgeSet | null {
  const rims = weldedPolygonsOf(descriptor);
  if (rims === null) return null;
  const points = pointCountOf(descriptor);
  if (points.kind !== 'counted') return null;

  // ⚠️ THE RADIX IS THE POINT COUNT, NOT 2^32, AND THAT IS A CORRECTNESS FIX RATHER THAN A
  // TIGHTENING. Both ids are strictly below `points`, so `lo * points + hi` is injective and the
  // largest key is `points ** 2` — safe as a float until ~94 million points. Pairing on 2^32
  // instead is injective too, but its largest key passes `Number.MAX_SAFE_INTEGER` at only ~2.1
  // million, and past that two DIFFERENT edges round to one key and the set silently loses one.
  // A count that high is reachable by array-copying a dense sphere, and nothing would have said.
  const radix = points.count;
  const seen = new Set<number>();
  const pairs: number[] = [];
  for (const rim of rims) {
    for (let i = 0; i < rim.length; i++) {
      const p = rim[i];
      const q = rim[(i + 1) % rim.length];
      const lo = p < q ? p : q;
      const hi = p < q ? q : p;
      // A numeric key rather than a string: a pairing is one multiply against the hash of a
      // template literal. `weldByPosition` pays the string cost because it keys on three rounded
      // floats; this keys on two integers already bounded by the mesh.
      const key = lo * radix + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(lo, hi);
    }
  }
  return { pairs: Uint32Array.from(pairs), count: pairs.length / 2 };
}

/**
 * How many edges a descriptor has — the `edge` answer `componentCountOf` used to refuse.
 *
 * Shaped as a {@link CountVerdict} like `pointCountOf` rather than as `number | null`, because
 * the absence has a REASON a caller should be able to quote: a `gltf` or `baked` anywhere up the
 * source chain, propagated verbatim so the verdict still names the link that could not answer.
 */
export function edgeCountOf(descriptor: GeometryDescriptor): CountVerdict {
  const points = pointCountOf(descriptor);
  // Propagated rather than re-minted: an edge is a pair of points, so a descriptor whose points
  // are outside it has its edges outside it too, for exactly the same reason and at the same
  // link. Re-wording it here would make a caller read a second sentence about one absence.
  if (points.kind !== 'counted') return points;
  const edges = edgeSetOf(descriptor);
  if (edges === null)
    return {
      kind: 'outside-the-descriptor',
      why: `'${descriptor.kind}' has ${points.count} points but no derivable polygon rims, so what joins them is not stated`,
    };
  return counted(edges.count);
}
