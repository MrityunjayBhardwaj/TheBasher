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
 * `k = 1` is refused rather than given a third arm, and the reason is that its position rule is
 * genuinely different rather than merely absent: the reference answers it with `offset_in_plane`
 * and `slide_dist` (`bmesh_bevel.cc`), which need a face normal and an edge slide this layout
 * has never had to state. Refusing keeps the render path free of an arm nothing has measured —
 * the stance this module already takes for a boundary edge.
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
  | { readonly kind: 'meet'; readonly point: number; readonly toward: readonly [number, number] };

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
type PointPlan =
  | {
      readonly kind: 'planned';
      readonly count: number;
      readonly gapOf: readonly number[];
      /**
       * For each gap, the two CROSSING INDICES of the chamfered edges that bound it (#841).
       *
       * 🔴 RETURNED FROM WHERE THE RUN IS DEFINED, AND THAT IS THE WHOLE POINT. The caller used
       * to re-derive these as `crossings[i - 1]` and `crossings[i]` at whichever corner its scan
       * met the gap at first — which names the run's bounds only when the run is ONE corner long.
       * Runs wrap cyclically, so the first corner met is generally not the run's start, and the
       * expression then picked up an edge that is not chamfered at all. A box with a chamfered
       * edge LOOP had 4 of its 8 boundary vertices pulled toward an unbeveled edge, which moved
       * them in the wrong DIRECTION rather than merely the wrong distance.
       *
       * Nothing caught it because no gate reads `placement`: the point COUNT was right, and a
       * count is invariant under a wrong direction. The all-edges case was unaffected, since
       * there every run is one corner long — the case the old expression was written against.
       */
      readonly gapBounds: readonly (readonly [number, number])[];
    }
  | { readonly kind: 'refused'; readonly why: string };

function planPoint(
  v: number,
  fan: { readonly crossings: readonly number[] },
  beveled: Uint8Array,
): PointPlan {
  const n = fan.crossings.length;
  const cut: number[] = [];
  for (let i = 0; i < n; i++) if (beveled[fan.crossings[i]] === 1) cut.push(i);
  const k = cut.length;

  if (k === 0)
    return { kind: 'planned', count: 1, gapOf: new Array<number>(n).fill(0), gapBounds: [] };

  if (k === 1)
    return {
      kind: 'refused',
      why: `point ${v} has exactly one chamfered edge of its ${n}, and a bevel with no miter rule has no answer there — that point splits into ${n - 1} and changes the arity of the face opposite the chamfered edge. Chamfer a closed loop of edges, or all of them, until #827's terminal case lands`,
    };

  // `k >= 2`: one boundary vertex per run of corners between two consecutive chamfered edges.
  // Run `j` covers the corners strictly after `cut[j]` up to and including `cut[j + 1]`, walked
  // cyclically — which for an all-edges bevel gives every corner its own run and reproduces the
  // one-point-per-face-corner numbering this module shipped with.
  const gapOf = new Array<number>(n).fill(-1);
  const gapBounds: (readonly [number, number])[] = [];
  for (let j = 0; j < k; j++) {
    const to = cut[(j + 1) % k];
    // The run's bounds are `cut[j]` and `cut[j + 1]` BY DEFINITION of the run — recorded here
    // rather than recovered later from a corner index, which is what #841 was.
    gapBounds.push([cut[j], to] as const);
    for (let i = (cut[j] + 1) % n; ; i = (i + 1) % n) {
      gapOf[i] = j;
      if (i === to) break;
    }
  }
  return { kind: 'planned', count: k, gapOf, gapBounds };
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
  const plans: { readonly count: number; readonly gapOf: readonly number[] }[] = [];
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
    const plan = planPoint(v, fan, beveled);
    if (plan.kind === 'refused') return refused(plan.why);
    fans.push(fan);
    plans.push(plan);
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
  const cornerPointOf = new Array<number>(cornerCount).fill(-1);
  const placement: BoundaryPlacement[] = [];
  const pointOrder: number[] = [];

  const farEnd = (e: number, v: number): number =>
    edges.pairs[2 * e] === v ? edges.pairs[2 * e + 1] : edges.pairs[2 * e];

  for (let v = 0; v < sourcePoints; v++) {
    const { rim, crossings } = fans[v];
    const { gapOf } = plans[v];
    for (let i = 0; i < rim.length; i++) {
      const gap = gapOf[i];
      if (idAt[v][gap] < 0) {
        const id = placement.length;
        idAt[v][gap] = id;
        pointOrder.push(v);
        // A run bounded by two chamfered edges is pulled back between them; a point with no
        // chamfered edge at all does not move. `crossings[i - 1]` and `crossings[i]` are the two
        // edges bounding corner `i`, and on an all-edges bevel they ARE the corner's two rim
        // neighbours — which is the expression the builder used to hold on its own.
        placement.push(
          plans[v].count === 1
            ? { kind: 'vertex', point: v }
            : {
                kind: 'meet',
                point: v,
                toward: [
                  farEnd(crossings[plans[v].gapBounds[gap][0]], v),
                  farEnd(crossings[plans[v].gapBounds[gap][1]], v),
                ] as const,
              },
        );
      }
      const [f, k] = rim[i];
      cornerPointOf[cornerBase[f] + k] = idAt[v][gap];
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
    corners.push(rims[f].length);
    rimsOut.push(rims[f].map((_, k) => cornerPointOf[cornerBase[f] + k]));
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
    rimsOut.push([
      cornerPointOf[cornerBase[ab] + bInAb],
      cornerPointOf[cornerBase[ab] + aInAb],
      cornerPointOf[cornerBase[ba] + aInBa],
      cornerPointOf[cornerBase[ba] + bInBa],
    ]);
  }

  // ── 3. One n-gon per source point THAT GREW ONE — MINTED, arity = its boundary count ─────
  // 🔑 NOT ONE PER POINT ANY MORE. A point contributes a polygon exactly when it has three or
  // more boundary vertices, which an all-edges bevel gives every point (its count is the valence,
  // and `vertexFan` already refuses a valence below 3) and a partial one gives only some. A point
  // with two is the classic chamfered edge LOOP — the two quads meet along it directly, and
  // Blender welds exactly there (`bmesh_bevel.cc:6465`, `selcount == 2 && count == 2`).
  for (let v = 0; v < sourcePoints; v++) {
    const { rim } = fans[v];
    const { gapOf, count } = plans[v];
    if (count < 3) continue;
    // The boundary vertices in ring order, taken as each run is first met walking the corners —
    // a rotation of the run order, which is the same polygon with the same winding, and on an
    // all-edges bevel it is corner order exactly.
    const seen = new Set<number>();
    const ring: number[] = [];
    for (let i = 0; i < rim.length; i++) {
      const gap = gapOf[i];
      if (seen.has(gap)) continue;
      seen.add(gap);
      ring.push(idAt[v][gap]);
    }
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
