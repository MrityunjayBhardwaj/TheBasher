/**
 * THE BEVEL'S OUTPUT TOPOLOGY, DERIVED FROM ITS SOURCE'S AND FROM NOTHING ELSE (#814).
 *
 * Every derived kind before this one MAPS — each output face came from exactly one source face,
 * which is why `TiledFaceOrder.order` could be `readonly number[]` for as long as it was. A bevel
 * MINTS: it replaces each source edge with a quad and each source point with an n-gon, and those
 * faces came from no source face at all. #812 widened the order to admit that hole; this module
 * is the first thing that puts one there.
 *
 * ── ONE LAYOUT, READ BY EVERY DOMAIN AND BY THE BUILDER ───────────────────────────────────
 *
 * The face count, the arities, the face order, the point count, the point order, the output rims
 * and the geometry the registry builds are all one fact. They live here together rather than
 * being derived five times, because the invariant that matters is that they AGREE — and an
 * invariant enforced in five places is enforced in none. The arms in `faceCount.ts`,
 * `pointIdentity.ts`, `edgeIdentity.ts` and `geometryRegistry.ts` are thin readers of this.
 *
 * ── 🔴 THIS MODULE SITS IN AN IMPORT CYCLE, AND THE CYCLE CANNOT BE MOVED AWAY ────────────
 *
 * `faceCount -> bevelLayout -> edgeIdentity -> faceCount`. It closes at `faceCountOf(bevel)`: a
 * bevel's face count is `F + E + V`, the `E` term is the source's EDGE count, and edges only
 * exist in `edgeIdentity` — which needs the face order to compose a derived kind's welded rims.
 * Moving code between the three modules relocates the ring without breaking it.
 *
 * Measured on this toolchain rather than assumed: a CALL-TIME cycle resolves correctly, and a
 * MODULE-INITIALISATION-TIME read across one silently evaluates to `undefined` — no throw, no
 * warning, and no `import/no-cycle` rule configured to catch it.
 *
 * ⚠️ SO THE RULE IS: NOTHING IN THIS RING MAY READ AN IMPORT AT MODULE LEVEL. Every use must be
 * inside a function body, which is where a cycle is already resolved. The rule is held by
 * `bevelCycle.gate.test.ts` rather than by this paragraph, because a comment is not a check.
 *
 * ── WHAT IT REFUSES, AND WHY REFUSING IS THE ANSWER RATHER THAN GUESSING ──────────────────
 *
 * A bevel at segments = 1 with no miter rule needs every edge to have exactly TWO incident faces.
 * A boundary edge — which every `subset` produces — would need a half-quad and an open fan, and a
 * non-manifold edge has no defined answer at all. Both are refused BY NAME, the same stance
 * `elementSubset` already takes for a non-indexed source: shipping an untested arm on the render
 * path is worse than a stated absence.
 */

import type { GeometryDescriptor } from '../nodes/types';
import type { PolygonRim } from './polygonLayout';
import type { SourceFace } from './faceCount';
import { edgeFaceAdjacencyOf, edgeSetOf, weldedPolygonsOf } from './edgeIdentity';
import { pointCountOf } from './pointIdentity';
import { scopeSelection } from '../nodes/scopeQuery';

/**
 * Everything a bevel's output topology is, in one record.
 *
 * ⚠️ NOTHING HERE READS `amount`. That is the property that makes the whole layout a pure
 * function of the source's topology — an `amount` drag moves positions and moves nothing about
 * what is connected to what, which is why {@link bevelLayoutOf}'s cache can key on the source
 * alone and a drag costs one lookup.
 */
/**
 * Where one output point sits, said as a RULE over the source rather than as a position.
 *
 * ── WHY A RULE AND NOT A `Vec3` ───────────────────────────────────────────────────────────
 *
 * The layout is a pure function of the source's TOPOLOGY and is cached on the source handle, so
 * it cannot hold positions: `amount` is not in its cache key, and neither is the source's built
 * geometry. Naming the rule keeps that property — the builder, which does have positions, reads
 * these and evaluates them, and an `amount` drag re-evaluates without re-deriving anything.
 *
 * ── THE TWO ARMS ARE THE TWO ANSWERS A PARTIAL BEVEL HAS ──────────────────────────────────
 *
 * Measured in Blender 5.1.1 across 15 selections (#827): at a source point with `k` chamfered
 * edges out of `n`, the point contributes ONE output point when `k = 0` and `k` of them when
 * `k >= 2`. Those are exactly these two arms — an untouched point, and a point pulled back
 * between the two chamfered edges that bound it.
 *
 * ── THE THIRD ARM IS THE TERMINAL CASE, AND IT IS ONE RULE RATHER THAN TWO (#830) ─────────
 *
 * At `k = 1` the point contributes `n - 1` boundary vertices, one per UNCHAMFERED incident edge,
 * and each sits ON that edge. Measured in Blender 5.1.1 across valence 3, 4, 5, 6, 8 and 12 on two
 * independent fixture families, and derived independently from the reference, which builds
 * `1 + 1 + (n - 3)` of them in `build_boundary_terminal_edge`'s `edgecount > 2` branch.
 *
 * The distance splits by FACE ADJACENCY, not by angle: the two edges sharing a face with the
 * chamfered edge slide by `amount / sin θ` (the reference meets two offset lines, and the
 * unchamfered edge's own offset being zero puts the meet on that edge); the other `n - 3` slide
 * by a flat `amount`. Confirmed by a prediction the fixtures had not exercised — the reference
 * multiplies the flat distance by √2 when `profile < 0.25`, and the measured threshold sits
 * between 0.24 and 0.26 with the flanking distances unmoved, which is what `d` feeding only the
 * non-flanking loop predicts.
 *
 * 🔴 THE ISSUE THAT FILED THIS DESCRIBED THE WRONG BRANCH. `offset_in_plane` — and with it the
 * face normal — lives in `build_boundary_terminal_edge`'s `edgecount == 2` case, which `vertexFan`
 * makes unreachable by refusing a point with fewer than three incident corners. Reading it as the
 * general rule is what made this look like it needed two placement arms and a normal.
 *
 * ⚠️ WHAT IS STILL REFUSED, AND BY THE BUILDER RATHER THAN HERE. `offset_meet` has branches that
 * DO need a face normal when the two edges are near-parallel or near-anti-parallel, and the
 * reference carries its own `TODO` for a reflex angle between them. Those need positions to
 * detect, so the refusal lives where the positions are.
 */
export type BoundaryPlacement =
  /** Untouched: no chamfered edge meets this source point, so it stays where the source put it. */
  | { readonly kind: 'vertex'; readonly point: number }
  /**
   * Pulled back from `point` toward BOTH of `toward`, by `amount`, along unit directions.
   *
   * `toward` names the far endpoints of the two chamfered edges that bound this point's gap.
   * On a bevel that chamfers everything they are exactly the corner's two rim neighbours, which
   * is what the builder used to read off the rim directly — so this arm reproduces the previous
   * behaviour rather than approximating it, and the all-edges case comes out byte-identical.
   */
  | { readonly kind: 'meet'; readonly point: number; readonly toward: readonly [number, number] }
  /**
   * THE TERMINAL CASE (#830): slid from `point` along ONE unchamfered edge, toward `toward`.
   *
   * The distance is `amount` when `against` is `null`, and `amount / sin θ` when it is not, where
   * θ is the angle at `point` between this edge and `against` — the chamfered edge. Both are
   * measured; see the header. `against` is set on exactly the two edges that share a face with the
   * chamfered edge, and null on the other `n - 3`.
   *
   * 🔑 STILL A RULE AND NOT A `Vec3`, WHICH IS WHY θ IS NOT PRECOMPUTED HERE. The layout is a
   * pure function of topology cached on the source handle; an angle needs positions. Naming the
   * two edges lets the builder — which has them — evaluate θ, and keeps an `amount` drag free of
   * a re-derivation, exactly as `meet` does.
   */
  | {
      readonly kind: 'slide';
      readonly point: number;
      readonly toward: number;
      readonly against: number | null;
    }
  /**
   * #891 — ON the single unchamfered edge lying between this run's two chamfered bounds.
   *
   * `toward` is that edge's far end; `against` names the far ends of the two chamfered edges.
   * The distance is the MEAN of `amount / sin θ` over the two, where each θ is the angle at
   * `point` between the unchamfered edge and that chamfered one — the reference meets the offset
   * line with each bound separately and takes the midpoint (`offset_on_edge_between`,
   * `bmesh_bevel.cc:2149`, `mid_v3_v3v3(meetco, meet1, meet2)`). Both meets are along the SAME
   * edge, so their midpoint is that edge's direction at the mean distance.
   *
   * 🔑 IT IS A `meet` THAT KNOWS WHICH SIDE IT IS ON. A `meet` is symmetric in its two bounds and
   * therefore cannot distinguish the two runs at a point with exactly two chamfered edges; this
   * arm is chosen precisely when one unchamfered edge lies between them, which is the asymmetry.
   */
  | {
      readonly kind: 'onEdge';
      readonly point: number;
      readonly toward: number;
      readonly against: readonly [number, number];
    };

export interface BevelLayout {
  /** Faces in the SOURCE — what a per-face attribute being gathered from would have to carry. */
  readonly sourceFaces: number;
  /** Topological points in the SOURCE. Each becomes one output n-gon. */
  readonly sourcePoints: number;
  /** Edges in the SOURCE. Each becomes one output quad. */
  readonly sourceEdges: number;
  /**
   * How each OUTPUT POINT's position is found from the source. Index-aligned with the point ids.
   *
   * 🔴 IT REPLACED A PREFIX SUM, AND THE REPLACEMENT IS WHAT #827 ACTUALLY COST. This was
   * `cornerStart[]`, and the builder read `cornerStart[f] + k` as "source face `f`'s corner `k`".
   * That works only while every face-corner gets its OWN output point, which is true of a bevel
   * that chamfers every edge and false of one that chamfers some: at a point with no chamfered
   * edge all of its corners collapse onto one output point. So the map from corner to point
   * stopped being a bijection, and a prefix sum can only describe a bijection.
   *
   * Stating the RULE rather than the index also moves the one thing the builder was deriving on
   * its own back into the layout, which is this module's whole premise — the builder used to know
   * that a corner is pulled in along its two rim edges, and under a partial bevel that is no
   * longer the right sentence for every point.
   */
  readonly placement: readonly BoundaryPlacement[];
  /**
   * `order[i]` is the source face output face `i` came from, or `null` when it was minted.
   *
   * Laid out as `[0 … F-1, null x E, null x V]` — the whole input first, which is the same rule
   * `tiledFaceOrder` already follows for a generator, then everything that came from nowhere.
   */
  readonly faceOrder: readonly SourceFace[];
  /**
   * How many CORNERS each output face has, index-aligned with {@link faceOrder}.
   *
   * 🔴 NOT `arity` — IN THIS CODEBASE `faceArityOf` ANSWERS HOW MANY TRIANGLES A FACE FANS TO,
   * which for a quad is 2 and not 4. The two are one subtraction apart and both are plausible
   * per-face integers, so a mix-up produces a well-formed index buffer of the wrong length. It
   * cost this module one round: a bevelled cube reported 96 triangles where it builds 44.
   * `faceCountOf`'s consumers read triangles, `tiledCornerOrder`'s read corners; the arms in
   * `faceCount.ts` do the subtraction at the boundary so this field has one meaning.
   */
  readonly corners: readonly number[];
  /** Each OUTPUT face's rim, in OUTPUT topological point ids. Index-aligned with {@link arity}. */
  readonly rims: readonly PolygonRim[];
  /**
   * The SOURCE's welded rims — its faces in its own topological point ids.
   *
   * Carried because {@link placement} names source points and the builder holds a SPLIT buffer,
   * so something has to bridge the two numberings. Pairing these with `alignedSplitRims`
   * positionally is that bridge, and it is exact by construction: both are the same faces in the
   * same corner order, one welded and one split, which is the alignment that function is named
   * for. Handing them over rather than letting the builder call `weldedPolygonsOf` again keeps
   * the derivation single — and this module has already paid for it, since the layout cannot be
   * derived without them.
   */
  readonly sourceRims: readonly PolygonRim[];
  /**
   * `pointOrder[p]` is the SOURCE point that output point `p` came from.
   *
   * 🔑 NO HOLES, AND THE ASYMMETRY WITH {@link faceOrder} IS THE POINT. A minted FACE came from
   * no source face; a minted POINT is always one source point pulled along a face, so every
   * output point has an honest origin. This is `number[]` rather than `SourceFace[]` to say so
   * in the type rather than in a comment.
   */
  readonly pointOrder: readonly number[];
  /** Output topological points — one per source face-corner, so `= sum(source arities)`. */
  readonly points: number;
  /**
   * `representative[i]` is the source face output face `i` INHERITS its attributes from (#825).
   *
   * 🔑 THE SECOND MAP, AND ITS WHOLE POINT IS THAT IT IS A DIFFERENT ANSWER FROM {@link faceOrder}.
   * That one says where a face CAME FROM and is honestly holed — a minted face came from no
   * source face, and #812 widened the type so it could say so. This one says which face a minted
   * face BORROWS from, and it is total. #814 predicted exactly this shape: *"the day they should
   * survive, the answer is a second map, not a looser first one."* Collapsing the two would make
   * provenance unaskable, which is the thing #812 was built to make askable.
   *
   * ── THE TIE-BREAK IS LOWEST CANDIDATE FACE INDEX, AND IT IS A DECISION ─────────────────
   *
   * A mapped face is its own representative. An edge quad has TWO candidates (the edge's incident
   * faces, which this layout already requires to be exactly two) and a corner n-gon has as many as
   * the point's valence, so a choice is forced and it decides which material a chamfer wears on a
   * two-material box. Lowest index, always.
   *
   * ⚠️ DELIBERATELY SIMPLER THAN THE REFERENCE, AND THE REASON IS STRUCTURAL RATHER THAN LAZY.
   * Blender's `choose_rep_face` (`bmesh_bevel.cc`) ranks candidates on a six-term vector: math-layer
   * connected component, then selected-beats-unselected, then LOWER MATERIAL INDEX, then the face
   * centre's z, x and y. Its first three terms read ATTRIBUTES and its last three read POSITIONS —
   * and this layout is a closed form over the source's topology alone, which is exactly why
   * `bevelLayoutOf` can cache it on the source handle and an amount drag costs one map lookup.
   * Ranking on a material index here would make the layout depend on the attribute set and destroy
   * that. So the candidates are the part that is topology, and they are what a richer rule would
   * need: the day one is wanted, it ranks the candidates where the attributes are in hand.
   */
  readonly representative: readonly number[];
}

/**
 * A laid-out bevel, or a refusal that says which edge could not be answered for.
 *
 * `polygonLayoutOf`'s shape, for the reason it has one: a caller that needs the layout narrows
 * on `kind`, and a caller reporting to a human quotes `why`. A bare `null` would have made the
 * two indistinguishable, which is the collapse [[H512]] describes one domain over.
 */
export type BevelVerdict =
  | { readonly kind: 'laid-out'; readonly layout: BevelLayout }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * Typed as the REFUSAL arm alone, not as {@link BevelVerdict}. {@link vertexFan} returns its own
 * union and shares this constructor, so widening the return here would make every refusal it
 * forwards look like it might carry a layout.
 */
function refused(why: string): { readonly kind: 'refused'; readonly why: string } {
  return { kind: 'refused', why };
}

/**
 * Keyed on the SOURCE HANDLE alone, because that is the whole of what the layout depends on.
 *
 * `amount` is deliberately absent — see {@link BevelLayout}. So dragging a bevel's amount across
 * 120 frames derives the layout once and looks it up 119 times, which is the same property
 * `orderCache` in `faceCount.ts` has for an offset drag and is bounded the same way: cleared
 * wholesale at a small ceiling rather than evicted one at a time, so the bound is a single
 * multiplication instead of a second policy to reason about.
 */
const layoutCache = new Map<string, BevelVerdict>();
const LAYOUT_CACHE_LIMIT = 8;

/**
 * The bevel's output topology, or a named refusal.
 *
 * The closed form, and it was predicted BEFORE it was written and then observed in a running
 * Blender 5.1.1 at two shapes — a cube and a uv sphere at 8x6 — matching on the vertex, edge and
 * face counts AND on the output arity MULTISET. The multiset is the half that bites: a
 * count-only comparison passes on a wrong rule, while `{3:16, 4:160, 8:2}` for the sphere pins
 * each of the three terms separately, since its two valence-8 pole n-gons and its 16 pole
 * triangles come from different ones.
 */
export function bevelLayoutOf(descriptor: GeometryDescriptor): BevelVerdict {
  if (descriptor.kind !== 'bevel')
    return refused(`'${descriptor.kind}' is not a bevel, so it has no bevel layout`);

  const source = descriptor.source.descriptor;
  // 🔴 THE SCOPE JOINS THE KEY, AND ITS ABSENCE FROM IT WOULD HAVE BEEN SILENT (#827). The
  // layout used to depend on the source alone, so the source handle WAS the whole of what it
  // depended on. It now also depends on which edges are chamfered — two scopes over one source
  // are two different topologies — and a cache still keyed on the source alone would hand the
  // first one's layout to the second. Both would build, both would draw, and the second would
  // be a mesh nobody asked for: the same silent false-share `arrayGeometryRef` folds its scope
  // into the geometry key to prevent, one layer down.
  //
  // The empty string for "unscoped" is safe rather than merely convenient: `scopeField` turns a
  // blank query into an ABSENT field, so no scoped descriptor can carry `scope: ''` and collide
  // with an unscoped one.
  const cacheKey = `${descriptor.source.key}|${descriptor.scope ?? ''}`;
  const hit = layoutCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const resolved = deriveLayout(source, descriptor.scope);
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) layoutCache.clear();
  layoutCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * How many boundary vertices one source point contributes, and which one each of its corners
 * collapses onto — the whole of the miter rule, at one point (#827).
 *
 * ── THE RULE, MEASURED RATHER THAN READ ───────────────────────────────────────────────────
 *
 * At a point of valence `n` with `k` incident chamfered edges, the chamfered edges cut the ring
 * of corners into `k` runs, and every corner in one run collapses onto ONE boundary vertex —
 * `bmesh_bevel.cc:3554-3556` says it in a sentence: *"we make BoundVerts to connect the sides of
 * the beveled edges. Non-beveled edges in between will just join to the appropriate juncture
 * point."* So the count is `k` when `k >= 2` and 1 when `k = 0`, and a point grows a polygon
 * exactly when that count reaches 3.
 *
 * Confirmed live in Blender 5.1.1 over 15 selections spanning valence 3, 4, 5 and 8 — including
 * two randomised ones where four different `k` values sit side by side on one torus, which is
 * the case a rule that were right only on uniform selections would come apart on.
 *
 * 🔴 `k = 1` IS REFUSED, AND IT IS THE ONE ROW THAT BREAKS EVERY PATTERN HERE. It contributes
 * `n - 1` boundary vertices rather than 1 or `k`, and it is the only case where a face's ARITY
 * changes: the corner opposite the chamfered edge splits across two of them. Measured — a
 * cylinder with only its vertical edges chamfered comes back with both 8-gon caps turned into
 * 16-gons. Its positions need `offset_in_plane` and `slide_dist`, two rules this layout has
 * never had to state, so it is refused by name rather than guessed at. The first draft of this
 * rule said "2 boundary vertices", which is true at valence 3 and false at 4 — a cube and a
 * cylinder both agreed with it, and a sphere falsified it.
 */
/**
 * How ONE boundary vertex is placed, in the point's own fan vocabulary.
 *
 * Crossing INDICES rather than edge ids, because everything the arms need — which edges bound a
 * run, which edge a vertex slides along, which edge it is measured against — is a position in the
 * ring, and the ring is what `vertexFan` returns. The caller turns an index into a far endpoint
 * once, in one place.
 */
type GapPlacement =
  /** The point does not move: no chamfered edge meets it. */
  | { readonly kind: 'vertex' }
  /**
   * Pulled back between the two chamfered edges bounding this run (#841 records why these are
   * carried rather than re-derived).
   */
  | {
      readonly kind: 'meet';
      readonly bounds: readonly [number, number];
      /**
       * The UNCHAMFERED crossings lying strictly between `bounds`, walking this run's own way
       * round the point (#891). Fan-local crossing indices, like `bounds`.
       *
       * 🔑 THE INPUT THAT TELLS TWO RUNS APART, AND WITHOUT IT THEY ARE THE SAME ANSWER. The
       * builder places a meet as `amount * (unit(toward[0]) + unit(toward[1]))`, which is
       * SYMMETRIC in the pair — so at a point with exactly two chamfered edges, where both runs
       * are bounded by that same pair in opposite orders, both vertices landed on one position
       * and welded. Measured on a cube with a chamfered edge loop: 4 of 12 derived points
       * collapsed, and the two faces beside each corner were pulled onto the chamfered face's
       * corner.
       *
       * Grounded: `build_boundary` walks from each beveled edge to the next COUNTING the
       * unbeveled edges between them (`bmesh_bevel.cc:3571-3607`) and branches on that count —
       * none is the plain meet, exactly one is `offset_on_edge_between`, which puts the vertex ON
       * that middle edge. Carried from here rather than re-derived at the numbering loop, for the
       * reason `bounds` is: only this function knows the run.
       */
      readonly between: readonly number[];
    }
  /**
   * THE TERMINAL CASE (#830). Slid along ONE unchamfered edge, away from the point.
   *
   * `against` is the chamfered edge when this vertex sits on one of the two edges that share a
   * face with it — the reference meets the two offset lines there, and because the unchamfered
   * edge's own offset is zero the meet lands ON that edge, at `amount / sin θ`. It is `null` on
   * every other incident edge, which slides by a flat `amount`. Both are measured; see the
   * header.
   */
  | { readonly kind: 'slide'; readonly along: number; readonly against: number | null };

/**
 * 🔑 THERE IS NO `refused` ARM, AND ITS ABSENCE IS THE STATEMENT #830 CAME TO MAKE. Every `k`
 * from 0 to `n` now has an answer, so "this point could not be planned" is no longer a state the
 * type can hold — the terminal case was the last value of `k` that could produce one. The
 * refusals that remain are about the SOURCE (a boundary edge, a non-manifold edge, a pinched fan)
 * and are raised before any point is planned.
 */
type PointPlan = {
  readonly count: number;
  /**
   * The boundary vertices each CORNER uses, in that face's own rim order. One or TWO.
   *
   * 🔴 A LIST, AND #830 IS WHY. This was `gapOf: number[]` — one gap per corner — which says
   * that a corner becomes exactly one output point. That held while every point had either
   * one boundary vertex (`k = 0`) or one per run (`k >= 2`). The terminal case breaks it: at
   * `k = 1` the boundary vertices belong to the point's UNCHAMFERED EDGES, and a corner
   * bounded by two of them uses BOTH. So the map from corner to point stopped being a
   * function, and its face gains an arity.
   *
   * That is the same break #827 made one step earlier, and the module's own history is the
   * clearest statement of it: corner -> point was a BIJECTION until #827 made it MANY-TO-ONE,
   * and is ONE-TO-MANY from here. `corners[f] = rims[f].length` was the last line still
   * written as if it were a function.
   */
  readonly cornerGaps: readonly (readonly number[])[];
  /** The gap ids in the vertex polygon's ring order, when the point grows one. */
  readonly ring: readonly number[];
  /** How each gap is positioned, index-aligned with the gap ids used above. */
  readonly gaps: readonly GapPlacement[];
};

function planPoint(fan: { readonly crossings: readonly number[] }, beveled: Uint8Array): PointPlan {
  const n = fan.crossings.length;
  const cut: number[] = [];
  for (let i = 0; i < n; i++) if (beveled[fan.crossings[i]] === 1) cut.push(i);
  const k = cut.length;

  if (k === 0)
    return {
      count: 1,
      cornerGaps: Array.from({ length: n }, () => [0]),
      ring: [0],
      gaps: [{ kind: 'vertex' }],
    };

  if (k === 1) {
    // ── THE TERMINAL CASE (#830) ──────────────────────────────────────────────────────────
    //
    // One boundary vertex per UNCHAMFERED incident edge, so `n - 1` of them — not 1 and not `k`.
    // The reference builds exactly these: `build_boundary_terminal_edge`'s `edgecount > 2` branch
    // makes two bound verts from the edges flanking the chamfered one and then one per remaining
    // edge, which is `1 + 1 + (n - 3)`.
    //
    // 🔴 THE `edgecount == 2` BRANCH IS A DIFFERENT RULE AND IS NOT THIS ONE. It uses
    // `offset_in_plane` and needs a face normal; it is also unreachable here, because `vertexFan`
    // refuses a point with fewer than three incident corners. #830 was filed describing that
    // branch, which is real code but not the code a valence-3-or-more point runs.
    const c = cut[0];
    const gapOfEdge = new Array<number>(n).fill(-1);
    const gaps: GapPlacement[] = [];
    const ring: number[] = [];
    // Numbered walking away from the chamfered edge, so the ring comes out in fan order. Edge `i`
    // sits between corner `i` and corner `i + 1`, so increasing edge index runs the same way
    // round the point as increasing corner index — the order the `k >= 2` arm's ring also follows.
    for (let step = 1; step < n; step++) {
      const e = (c + step) % n;
      const flanking = e === (c + 1) % n || e === (c - 1 + n) % n;
      gapOfEdge[e] = gaps.length;
      ring.push(gaps.length);
      gaps.push({ kind: 'slide', along: e, against: flanking ? c : null });
    }
    // Corner `i` is bounded by `crossings[i - 1]` (entered through) and `crossings[i]` (left
    // through), and `crossings[i]` is the edge toward the face's PREVIOUS rim vertex. So in that
    // face's rim order the corner reads `[on crossings[i], on crossings[i - 1]]` — and one of the
    // two is missing exactly when it is the chamfered edge, which is what leaves the two flanking
    // faces at their original arity while every other face at this point gains one.
    const cornerGaps: number[][] = [];
    for (let i = 0; i < n; i++) {
      const here = gapOfEdge[i];
      const back = gapOfEdge[(i - 1 + n) % n];
      const slots: number[] = [];
      if (here >= 0) slots.push(here);
      if (back >= 0) slots.push(back);
      cornerGaps.push(slots);
    }
    return { count: n - 1, cornerGaps, ring, gaps };
  }

  // `k >= 2`: one boundary vertex per run of corners between two consecutive chamfered edges.
  // Run `j` covers the corners strictly after `cut[j]` up to and including `cut[j + 1]`, walked
  // cyclically — which for an all-edges bevel gives every corner its own run and reproduces the
  // one-point-per-face-corner numbering this module shipped with.
  const gapOf = new Array<number>(n).fill(-1);
  const gaps: GapPlacement[] = [];
  for (let j = 0; j < k; j++) {
    const to = cut[(j + 1) % k];
    // The run's bounds are `cut[j]` and `cut[j + 1]` BY DEFINITION of the run — recorded here
    // rather than recovered later from a corner index, which is what #841 was.
    // The unchamfered crossings strictly between this run's two chamfered bounds, in the run's
    // own direction. On an all-edges bevel this is always empty, which is what keeps that case
    // byte-identical.
    const between: number[] = [];
    for (let i = (cut[j] + 1) % n; i !== to; i = (i + 1) % n) between.push(i);
    gaps.push({ kind: 'meet', bounds: [cut[j], to] as const, between });
    for (let i = (cut[j] + 1) % n; ; i = (i + 1) % n) {
      gapOf[i] = j;
      if (i === to) break;
    }
  }
  // A rotation of the run order, taken as each run is first met walking the corners — the same
  // polygon with the same winding, and on an all-edges bevel it is corner order exactly. Derived
  // here rather than at the polygon, so both arms hand back a ring in one vocabulary.
  const seen = new Set<number>();
  const ring: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen.has(gapOf[i])) continue;
    seen.add(gapOf[i]);
    ring.push(gapOf[i]);
  }
  return { count: k, cornerGaps: gapOf.map((g) => [g]), ring, gaps };
}

/** {@link bevelLayoutOf}'s body, split out so the cache above is the whole of the caching. */
function deriveLayout(source: GeometryDescriptor, scope: string | undefined): BevelVerdict {
  const rims = weldedPolygonsOf(source);
  if (rims === null)
    return refused(
      `a bevel needs its source's welded rims and '${source.kind}' has none — its topology is not derivable from the descriptor`,
    );

  const edges = edgeSetOf(source);
  const adjacency = edgeFaceAdjacencyOf(source);
  const sourcePointCount = pointCountOf(source);
  if (edges === null || adjacency === null)
    return refused(`a bevel needs its source's edge set and '${source.kind}' has none`);
  if (sourcePointCount.kind !== 'counted')
    return refused(
      `a bevel needs its source's point count and '${source.kind}' cannot state one: ${sourcePointCount.why}`,
    );

  const sourceFaces = rims.length;
  const sourcePoints = sourcePointCount.count;
  const sourceEdges = edges.count;

  // 🔴 THE MANIFOLDNESS GATE, AND IT IS CHECKED BEFORE ANY LAYOUT IS BUILT rather than
  // discovered halfway through one. A boundary edge has one incident face and would need a
  // half-quad; three or more is non-manifold and has no chamfer at all without a miter rule.
  // Named with the offending edge so a director reading the console learns which edge, not
  // merely that something was wrong.
  //
  // ⚠️ STILL EVERY EDGE AND NOT ONLY THE CHAMFERED ONES, THOUGH #827 MAKES THAT LOOK LOOSE.
  // The fan walk below closes a ring around EVERY point, chamfered or not, and it crosses
  // unchamfered edges to do it — so an unchamfered boundary edge breaks the walk just as surely
  // as a chamfered one would break the quad. Narrowing this to the selection would move the
  // refusal from a named gate into `vertexFan`'s harder-to-read one.
  for (let e = 0; e < sourceEdges; e++) {
    const incident = adjacency.faces[e].length;
    if (incident !== 2)
      return refused(
        `a bevel at segments = 1 needs every edge to have exactly 2 incident faces, and edge ${e} (points ${edges.pairs[2 * e]}-${edges.pairs[2 * e + 1]}) of '${source.kind}' has ${incident}. An open or non-manifold mesh needs a miter rule, which is out of scope here`,
      );
  }

  // ── Which edges are chamfered ────────────────────────────────────────────────────────────
  // Absent means all of them, which is what a bevel meant before there was a choice. Resolved
  // against the SOURCE's edge count, because that is the domain the query indexes.
  const beveled = new Uint8Array(sourceEdges);
  if (scope === undefined) beveled.fill(1);
  else {
    const selected = scopeSelection(scope, sourceEdges);
    beveled.set(selected.mask);
    if (selected.count === 0)
      return refused(
        `the scope '${scope}' selects none of '${source.kind}'s ${sourceEdges} edges, so this bevel would chamfer nothing`,
      );
  }

  // The unique index of a `(face, corner)` pair — a prefix sum over the source's arities. It is
  // NOT an output point id any more (see `placement`): a partial bevel collapses several corners
  // onto one point, so this numbers the CORNERS and the allocation below numbers the points.
  const cornerBase: number[] = [];
  let cornerCount = 0;
  for (let f = 0; f < sourceFaces; f++) {
    cornerBase.push(cornerCount);
    cornerCount += rims[f].length;
  }

  // Where each source point's corners live, so the fan walk below does not rescan the rims once
  // per point — that walk is O(corners) here against O(points x corners) there.
  const cornersAtPoint: number[][] = Array.from({ length: sourcePoints }, () => []);
  for (let f = 0; f < sourceFaces; f++) {
    for (let k = 0; k < rims[f].length; k++) {
      const point = rims[f][k];
      // A rim naming a point outside the source's own count is a disagreement between two
      // derivations, not an authoring state — refused rather than allowed to index `undefined`.
      if (point < 0 || point >= sourcePoints)
        return refused(
          `source face ${f} corner ${k} names point ${point}, which is outside the source's ${sourcePoints} points`,
        );
      cornersAtPoint[point].push(f, k);
    }
  }

  // Built ONCE, in one pass over the edge list, and handed to every fan below. Rebuilding it
  // per point would make the layout O(points x edges) — 478 k steps for a 32x16 sphere — for a
  // lookup each fan uses `valence` times.
  const edgesAtPoint: number[][] = Array.from({ length: sourcePoints }, () => []);
  for (let e = 0; e < sourceEdges; e++) {
    edgesAtPoint[edges.pairs[2 * e]].push(e);
    edgesAtPoint[edges.pairs[2 * e + 1]].push(e);
  }

  // ── Every point's ring, and its plan, BEFORE any numbering ───────────────────────────────
  // The point count is now a sum over the plans rather than the source's corner count, so
  // nothing can be numbered until every point has answered.
  const fans: {
    readonly rim: readonly (readonly [number, number])[];
    readonly crossings: readonly number[];
  }[] = [];
  const plans: {
    readonly count: number;
    readonly cornerGaps: readonly (readonly number[])[];
    readonly ring: readonly number[];
    readonly gaps: readonly GapPlacement[];
  }[] = [];
  for (let v = 0; v < sourcePoints; v++) {
    const fan = vertexFan(
      v,
      cornersAtPoint[v],
      rims,
      edges,
      adjacency,
      edgesAtPoint[v],
      cornerBase,
    );
    if (fan.kind === 'refused') return fan;
    fans.push(fan);
    plans.push(planPoint(fan, beveled));
  }

  // ── The output point numbering ───────────────────────────────────────────────────────────
  //
  // 🔴 ONE CONTIGUOUS BLOCK PER SOURCE POINT, AND IT RENUMBERS WHAT THIS MODULE SHIPPED WITH.
  // Before #827 an output point WAS a face-corner, so `cornerBase[f] + k` numbered them and
  // `pointOrder` came out in whatever order the corners did. A partial bevel breaks that — a run
  // of corners shares one point — so the numbering has to be anchored somewhere else, and the
  // source point is the only thing every output point has exactly one of.
  //
  // 🔑 THE RENUMBERING IS SAFE AND THE REASON IS WORTH STATING, because "the ids changed" sounds
  // like it should be visible and is not. Point ids are never a buffer index: the builder writes
  // positions by walking `rims` and dereferencing, so the BUILT vertex order is a function of the
  // rim order alone and is unchanged. Ids are consistent within one layout, and every consumer —
  // `tiledPointOrder`, `weldedPolygonsOf`, `edgeSetOf` — reads them as a map rather than as an
  // order. Verified against an independent reimplementation of the previous position rule: the
  // all-edges case agrees to 0 at every corner of a box and of an 8x6 sphere.
  //
  // It also buys a property the old numbering did not have: `pointOrder` is now NON-DECREASING,
  // since block `v` is entirely below block `v + 1`. That is what makes "every output point has
  // an honest origin" checkable by a scan rather than by a set comparison.
  const idAt: number[][] = plans.map((plan) => new Array<number>(plan.count).fill(-1));
  // 🔴 A LIST PER CORNER, NOT A POINT — see `PointPlan.cornerGaps`. The terminal case gives a
  // corner two output points, so this stopped being a function and `corners[f]` stopped being
  // `rims[f].length`.
  const cornerPointsOf: number[][] = Array.from({ length: cornerCount }, () => []);
  const placement: BoundaryPlacement[] = [];
  const pointOrder: number[] = [];

  const farEnd = (e: number, v: number): number =>
    edges.pairs[2 * e] === v ? edges.pairs[2 * e + 1] : edges.pairs[2 * e];

  for (let v = 0; v < sourcePoints; v++) {
    const { rim, crossings } = fans[v];
    const plan = plans[v];
    for (let i = 0; i < rim.length; i++) {
      const [f, k] = rim[i];
      const slots: number[] = [];
      for (const gap of plan.cornerGaps[i]) {
        if (idAt[v][gap] < 0) {
          idAt[v][gap] = placement.length;
          pointOrder.push(v);
          // The rule, translated out of the fan's vocabulary into the source's exactly once.
          const rule = plan.gaps[gap];
          placement.push(
            rule.kind === 'vertex'
              ? { kind: 'vertex', point: v }
              : rule.kind === 'meet'
                ? // 🔴 EXACTLY ONE UNCHAMFERED EDGE BETWEEN THE BOUNDS TAKES THE OTHER ARM (#891),
                  // mirroring the reference's own branch on that count. Zero keeps the plain meet,
                  // which is every run of an all-edges bevel. More than one also keeps it: the
                  // reference has a third rule there (`offset_meet` with its `edges_between` flag)
                  // and porting it needs a case that can be built, which no scope reaches today —
                  // so this is the shipped behaviour left alone rather than a guess.
                  rule.between.length === 1
                  ? {
                      kind: 'onEdge',
                      point: v,
                      toward: farEnd(crossings[rule.between[0]], v),
                      against: [
                        farEnd(crossings[rule.bounds[0]], v),
                        farEnd(crossings[rule.bounds[1]], v),
                      ] as const,
                    }
                  : {
                      kind: 'meet',
                      point: v,
                      toward: [
                        farEnd(crossings[rule.bounds[0]], v),
                        farEnd(crossings[rule.bounds[1]], v),
                      ] as const,
                    }
                : {
                    kind: 'slide',
                    point: v,
                    toward: farEnd(crossings[rule.along], v),
                    against: rule.against === null ? null : farEnd(crossings[rule.against], v),
                  },
          );
        }
        slots.push(idAt[v][gap]);
      }
      cornerPointsOf[cornerBase[f] + k] = slots;
    }
  }
  const points = placement.length;

  const faceOrder: SourceFace[] = [];
  // #825 — index-aligned with `faceOrder` and TOTAL where that one is holed. See the field's doc.
  const representative: number[] = [];
  const corners: number[] = [];
  const rimsOut: PolygonRim[] = [];

  // ── 1. The shrunk source faces, in source order, each carrying its own provenance ────────
  // The whole input first — `tiledFaceOrder`'s rule for a generator, kept here so "the leading
  // `sourceFaces` entries are the input" stays one statement across every derived kind.
  for (let f = 0; f < sourceFaces; f++) {
    faceOrder.push(f);
    // A face that came from somewhere inherits from there. The two maps agree on this stretch and
    // diverge only over the minted tail, which is what makes the divergence readable.
    representative.push(f);
    // 🔴 NOT `rims[f].length` ANY MORE (#830). A corner at a terminal point contributes TWO
    // output points, so a source face's arity is the SUM over its corners rather than its own
    // corner count. The two agree on every face that touches no terminal point, which is every
    // face that existed before this arm.
    const rimOut: number[] = [];
    for (let k = 0; k < rims[f].length; k++) rimOut.push(...cornerPointsOf[cornerBase[f] + k]);
    corners.push(rimOut.length);
    rimsOut.push(rimOut);
  }

  // ── 2. One quad per CHAMFERED edge — MINTED, so its provenance is a hole ─────────────────
  for (let e = 0; e < sourceEdges; e++) {
    if (beveled[e] !== 1) continue;
    const a = edges.pairs[2 * e];
    const b = edges.pairs[2 * e + 1];
    const [x, y] = adjacency.faces[e];

    // Which of the two faces traverses the edge a->b: the other must traverse b->a, or the
    // surface is not consistently oriented and every quad below it would be wound at random.
    const forward = cornerOfDirectedEdge(rims[x], a, b);
    const backward = cornerOfDirectedEdge(rims[y], a, b);
    const ab = forward !== null ? x : y;
    const ba = forward !== null ? y : x;
    const atA = forward !== null ? forward : backward;
    if ((forward === null) === (backward === null) || atA === null)
      return refused(
        `faces ${x} and ${y} share edge ${e} (points ${a}-${b}) but do not traverse it in opposite directions, so the source is not consistently wound and a bevel quad across it has no orientation`,
      );
    const atB = cornerOfDirectedEdge(rims[ba], b, a);
    if (atB === null)
      return refused(
        `face ${ba} is recorded as incident to edge ${e} (points ${a}-${b}) but its rim does not contain that edge`,
      );

    // The quad fills the gap between the two shrunk faces. It traverses the shared edge of each
    // in the OPPOSITE direction to that face, which is what makes its normal agree with theirs:
    // `ab` runs a->b, so the quad runs b->a on its side, crosses to `ba` at a, runs a->b there,
    // and crosses back at b.
    const aInAb = atA;
    const bInAb = (atA + 1) % rims[ab].length;
    const bInBa = atB;
    const aInBa = (atB + 1) % rims[ba].length;
    faceOrder.push(null);
    // Two candidates, and `ab` / `ba` are already the two incident faces named by winding. Lowest
    // index rather than `ab`: the winding-derived choice would make the answer depend on which way
    // the source happens to traverse the edge, which is a property of the mesh's authoring and not
    // of the operator.
    representative.push(Math.min(ab, ba));
    corners.push(4);
    // 🔴 A QUAD CORNER MUST BE EXACTLY ONE POINT, AND THAT IS A CLAIM, NOT A SHAPE. The faces
    // either side of a chamfered edge are that edge's FLANKING faces at both its endpoints, and a
    // flanking face is the one case the terminal arm leaves at a single boundary vertex — so this
    // holds for every arm. Checked rather than indexed blindly: taking `[0]` of a two-element slot
    // would silently drop a vertex and draw a quad through the wrong corner.
    const sole: number[] = [];
    for (const [face, corner] of [
      [ab, bInAb],
      [ab, aInAb],
      [ba, aInBa],
      [ba, bInBa],
    ] as const) {
      const slot = cornerPointsOf[cornerBase[face] + corner];
      if (slot.length !== 1)
        return refused(
          `edge ${e}'s quad reads face ${face} corner ${corner}, which resolves to ${slot.length} boundary vertices rather than 1 — a face beside a chamfered edge should be flanking at both its endpoints`,
        );
      sole.push(slot[0]);
    }
    rimsOut.push(sole);
  }

  // ── 3. One n-gon per source point THAT GREW ONE — MINTED, arity = its boundary count ─────
  // 🔑 NOT ONE PER POINT ANY MORE. A point contributes a polygon exactly when it has three or
  // more boundary vertices, which an all-edges bevel gives every point (its count is the valence,
  // and `vertexFan` already refuses a valence below 3) and a partial one gives only some. A point
  // with two is the classic chamfered edge LOOP — the two quads meet along it directly, and
  // Blender welds exactly there (`bmesh_bevel.cc:6465`, `selcount == 2 && count == 2`).
  for (let v = 0; v < sourcePoints; v++) {
    const { rim } = fans[v];
    const plan = plans[v];
    if (plan.count < 3) continue;
    // The ring order is the plan's, because the two arms order it differently and only the plan
    // knows which it is: `k >= 2` takes the runs as the corner walk first meets them, the terminal
    // case walks the unchamfered edges away from the chamfered one. Both run the same way round
    // the point, which is what makes them one field.
    const ring = plan.ring.map((g) => idAt[v][g]);
    faceOrder.push(null);
    // Every face in the closed ring around this point is a candidate, whether or not its corner
    // survived as its own boundary vertex — the run that swallowed it is still that face's.
    representative.push(rim.reduce((lowest, [f]) => (f < lowest ? f : lowest), rim[0][0]));
    corners.push(ring.length);
    rimsOut.push(ring);
  }

  return {
    kind: 'laid-out',
    layout: {
      sourceFaces,
      sourcePoints,
      sourceEdges,
      placement,
      sourceRims: rims,
      faceOrder,
      corners,
      rims: rimsOut,
      pointOrder,
      points,
      representative,
    },
  };
}

/**
 * The corner index `k` where `rim` runs `from -> to`, or `null` if it never does.
 *
 * Directed on purpose. An undirected containment test would answer for both faces of every edge
 * and the quad above would have no way to tell which side it was on — the same blindness [[H481]]
 * names, where a value carried a DIRECTION that no reader distinguished.
 */
function cornerOfDirectedEdge(rim: PolygonRim, from: number, to: number): number | null {
  for (let k = 0; k < rim.length; k++) {
    if (rim[k] === from && rim[(k + 1) % rim.length] === to) return k;
  }
  return null;
}

type VertexFan =
  | {
      readonly kind: 'fan';
      readonly rim: readonly (readonly [number, number])[];
      /**
       * `crossings[i]` is the source EDGE the walk left corner `i` through, so the ring around
       * the point reads `rim[0]`, `crossings[0]`, `rim[1]`, `crossings[1]`, … and closes.
       *
       * 🔑 RETURNED RATHER THAN RE-DERIVED BY THE CALLER, and that is the whole reason this walk
       * grew a second output (#827). A partial bevel's answer at a point is a function of WHICH of
       * its incident edges are beveled, and "which" only means anything in the ring order — a set
       * of edge ids cannot say that two beveled edges are adjacent, and adjacency is exactly what
       * decides how many boundary vertices the point gets. The walk already crosses every one of
       * these edges to find the next face; discarding them here and rediscovering them in the
       * caller would be a second traversal that has to agree with this one about orientation.
       */
      readonly crossings: readonly number[];
    }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * The corners around source point `v`, in surface order, as `(face, corner)` pairs.
 *
 * ── WHY IT WALKS THE `prev` EDGE AND NOT THE `next` ONE ──────────────────────────────────
 *
 * Both directions produce the same SET of corners and opposite windings, and only one of them
 * gives the n-gon a normal that agrees with the surface around it. Crossing the edge
 * `(v, prev)` is the one that does. Derived on a cube corner and then held by the gate against
 * the BUILT geometry's normals rather than left as an argument, because a reversed rim bounds
 * the same face, fans to the same triangles and renders inside-out — a wrong answer that every
 * count-shaped check passes.
 *
 * ── AND THE FAN MUST VISIT EVERY INCIDENT CORNER EXACTLY ONCE ────────────────────────────
 *
 * A mesh can be edge-manifold and still pinch at a point — two cones meeting at a single vertex.
 * Every edge there has two faces, so the manifoldness gate passes, and the walk closes early
 * having visited one cone. That would emit an n-gon of the wrong arity and silently leave the
 * other cone's corners in no face at all.
 *
 * 🔴 CHECKING ONLY THAT THE WALK RETURNS TO ITS START DOES NOT CATCH THAT, and the first draft
 * of this function made exactly that mistake. A cone of length 2 walked for 4 steps returns to
 * its start on step 4 and passes, having emitted each corner twice. So the walk records what it
 * has VISITED and refuses on the repeat, which is the step the early close actually shows up at.
 */
function vertexFan(
  v: number,
  corners: readonly number[],
  rims: readonly PolygonRim[],
  edges: { readonly pairs: Uint32Array; readonly count: number },
  adjacency: { readonly faces: readonly (readonly number[])[] },
  // The edges incident to `v`, resolved once by the caller — see the note at its construction.
  incidentEdges: readonly number[],
  // The prefix sum over the source's arities, so the visit key below can be a CORNER INDEX —
  // see the note at its use.
  cornerBase: readonly number[],
): VertexFan {
  const incident = corners.length / 2;
  if (incident < 3)
    return refused(
      `point ${v} has ${incident} incident face-corners; a bevel's vertex n-gon needs at least 3`,
    );

  const rim: (readonly [number, number])[] = [];
  const crossings: number[] = [];
  const seen = new Set<number>();
  let face = corners[0];
  let corner = corners[1];
  for (let step = 0; step < incident; step++) {
    // 🔴 KEYED ON THE CORNER INDEX, WHICH IS UNIQUE PER `(face, corner)` BY CONSTRUCTION —
    // and the first draft of this line packed the pair by hand as `face * (arity + 1) + corner`,
    // which COLLIDES because the stride varies per face. Measured on a uv sphere at 8x6: face 32
    // corner 0 and face 40 corner 0 both hash to 160, so a correct fan around point 34 refused
    // itself on step 1. A content-keyed collision, which is the failure mode `builtPolygonRims`
    // warns about eight files away — a hand-packed key with a non-constant stride is not a key.
    //
    // Keying on the pair rather than on the face alone still matters: one face can meet `v` at
    // two corners on a pinched rim, and keying on the face would call that a repeat when it is
    // not. `cornerBase[face] + corner` is that pair, in a numbering that already exists.
    //
    // ⚠️ THIS SAID "THE OUTPUT POINT ID" UNTIL #827, AND THAT SENTENCE WENT FALSE WITH THE
    // RENUMBERING. A corner index and an output point id were the same number while every corner
    // got its own point; a partial bevel collapses a run of them onto one, so they are now
    // different quantities that agree on the all-edges case. The KEY still has to be the corner
    // index — the point id would collide for exactly the corners this walk must tell apart, and
    // it is not even allocated yet at this stage. Renamed rather than re-worded, because the
    // parameter's old name was the claim.
    const key = cornerBase[face] + corner;
    if (seen.has(key))
      return refused(
        `point ${v}: the fan around it revisited face ${face} corner ${corner} after ${step} of ${incident} incident corners, so the source pinches at that point and the vertex n-gon would drop the rest`,
      );
    seen.add(key);
    rim.push([face, corner]);

    const shape = rims[face];
    const prev = shape[(corner - 1 + shape.length) % shape.length];
    // `valence` entries, scanned for the one whose other endpoint is `prev`.
    let pair: readonly number[] | null = null;
    let crossed = -1;
    for (const e of incidentEdges) {
      const a = edges.pairs[2 * e];
      const b = edges.pairs[2 * e + 1];
      if ((a === v && b === prev) || (b === v && a === prev)) {
        pair = adjacency.faces[e];
        crossed = e;
        break;
      }
    }
    if (pair === null || pair.length !== 2)
      return refused(
        `point ${v}: edge {${v}, ${prev}} is not a two-faced edge of the source, so the fan around ${v} cannot be closed`,
      );
    crossings.push(crossed);
    const next = pair[0] === face ? pair[1] : pair[0];
    const at = rims[next].indexOf(v);
    if (at < 0)
      return refused(
        `point ${v}: face ${next} is across edge {${v}, ${prev}} but its rim does not contain ${v}`,
      );
    face = next;
    corner = at;
  }

  if (face !== corners[0] || corner !== corners[1])
    return refused(
      `point ${v}: the fan around it visited ${rim.length} corners without returning to its start, so the source's faces do not form one closed ring at that point`,
    );
  return { kind: 'fan', rim, crossings };
}
