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

/**
 * Everything a bevel's output topology is, in one record.
 *
 * ⚠️ NOTHING HERE READS `amount`. That is the property that makes the whole layout a pure
 * function of the source's topology — an `amount` drag moves positions and moves nothing about
 * what is connected to what, which is why {@link bevelLayoutOf}'s cache can key on the source
 * alone and a drag costs one lookup.
 */
export interface BevelLayout {
  /** Faces in the SOURCE — what a per-face attribute being gathered from would have to carry. */
  readonly sourceFaces: number;
  /** Topological points in the SOURCE. Each becomes one output n-gon. */
  readonly sourcePoints: number;
  /** Edges in the SOURCE. Each becomes one output quad. */
  readonly sourceEdges: number;
  /**
   * Where source face `f`'s corners begin in the OUTPUT point numbering.
   *
   * Output point `cornerStart[f] + k` is source face `f`'s corner `k`, pulled in along the two
   * rim edges that meet there. Exposed rather than left implicit because the builder has to walk
   * the same numbering to place positions, and a second prefix sum written there would be a
   * second spelling of this one — the exact drift this module exists to prevent.
   */
  readonly cornerStart: readonly number[];
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
  const cacheKey = descriptor.source.key;
  const hit = layoutCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const resolved = deriveLayout(source);
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) layoutCache.clear();
  layoutCache.set(cacheKey, resolved);
  return resolved;
}

/** {@link bevelLayoutOf}'s body, split out so the cache above is the whole of the caching. */
function deriveLayout(source: GeometryDescriptor): BevelVerdict {
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
  for (let e = 0; e < sourceEdges; e++) {
    const incident = adjacency.faces[e].length;
    if (incident !== 2)
      return refused(
        `a bevel at segments = 1 needs every edge to have exactly 2 incident faces, and edge ${e} (points ${edges.pairs[2 * e]}-${edges.pairs[2 * e + 1]}) of '${source.kind}' has ${incident}. An open or non-manifold mesh needs a miter rule, which is out of scope here`,
      );
  }

  // ── The output point numbering: one point per SOURCE FACE-CORNER ────────────────────────
  // Source face `f`'s corner `k` becomes output point `cornerStart[f] + k`. Every output point
  // came from exactly one source point, so `pointOrder` has no holes.
  const cornerStart: number[] = [];
  const pointOrder: number[] = [];
  for (let f = 0; f < sourceFaces; f++) {
    cornerStart.push(pointOrder.length);
    for (const point of rims[f]) pointOrder.push(point);
  }
  const points = pointOrder.length;

  // Where each source point's corners live, so the vertex fan below does not rescan the rims
  // once per point — that walk is O(corners) here against O(points x corners) there.
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
    rimsOut.push(rims[f].map((_, k) => cornerStart[f] + k));
  }

  // ── 2. One quad per source edge — MINTED, so its provenance is a hole ────────────────────
  for (let e = 0; e < sourceEdges; e++) {
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
      cornerStart[ab] + bInAb,
      cornerStart[ab] + aInAb,
      cornerStart[ba] + aInBa,
      cornerStart[ba] + bInBa,
    ]);
  }

  // Built ONCE, in one pass over the edge list, and handed to every fan below. Rebuilding it
  // per point would make the layout O(points x edges) — 478 k steps for a 32x16 sphere — for a
  // lookup each fan uses `valence` times.
  const edgesAtPoint: number[][] = Array.from({ length: sourcePoints }, () => []);
  for (let e = 0; e < sourceEdges; e++) {
    edgesAtPoint[edges.pairs[2 * e]].push(e);
    edgesAtPoint[edges.pairs[2 * e + 1]].push(e);
  }

  // ── 3. One n-gon per source point — MINTED, and its arity is that point's valence ────────
  for (let v = 0; v < sourcePoints; v++) {
    const fan = vertexFan(
      v,
      cornersAtPoint[v],
      rims,
      edges,
      adjacency,
      edgesAtPoint[v],
      cornerStart,
    );
    if (fan.kind === 'refused') return fan;
    faceOrder.push(null);
    // `valence` candidates — every face in the closed ring around this point.
    representative.push(fan.rim.reduce((lowest, [f]) => (f < lowest ? f : lowest), fan.rim[0][0]));
    corners.push(fan.rim.length);
    rimsOut.push(fan.rim.map(([f, k]) => cornerStart[f] + k));
  }

  return {
    kind: 'laid-out',
    layout: {
      sourceFaces,
      sourcePoints,
      sourceEdges,
      cornerStart,
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
  | { readonly kind: 'fan'; readonly rim: readonly (readonly [number, number])[] }
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
  // Passed in purely so the visit key below can be the OUTPUT POINT id, which is already unique
  // per `(face, corner)` — see the note at its use.
  cornerStart: readonly number[],
): VertexFan {
  const incident = corners.length / 2;
  if (incident < 3)
    return refused(
      `point ${v} has ${incident} incident face-corners; a bevel's vertex n-gon needs at least 3`,
    );

  const rim: (readonly [number, number])[] = [];
  const seen = new Set<number>();
  let face = corners[0];
  let corner = corners[1];
  for (let step = 0; step < incident; step++) {
    // 🔴 KEYED ON THE OUTPUT POINT ID, WHICH IS UNIQUE PER `(face, corner)` BY CONSTRUCTION —
    // and the first draft of this line packed the pair by hand as `face * (arity + 1) + corner`,
    // which COLLIDES because the stride varies per face. Measured on a uv sphere at 8x6: face 32
    // corner 0 and face 40 corner 0 both hash to 160, so a correct fan around point 34 refused
    // itself on step 1. A content-keyed collision, which is the failure mode `builtPolygonRims`
    // warns about eight files away — a hand-packed key with a non-constant stride is not a key.
    //
    // Keying on the pair rather than on the face alone still matters: one face can meet `v` at
    // two corners on a pinched rim, and keying on the face would call that a repeat when it is
    // not. `cornerStart[face] + corner` is that pair, in a numbering that already exists.
    const key = cornerStart[face] + corner;
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
    for (const e of incidentEdges) {
      const a = edges.pairs[2 * e];
      const b = edges.pairs[2 * e + 1];
      if ((a === v && b === prev) || (b === v && a === prev)) {
        pair = adjacency.faces[e];
        break;
      }
    }
    if (pair === null || pair.length !== 2)
      return refused(
        `point ${v}: edge {${v}, ${prev}} is not a two-faced edge of the source, so the fan around ${v} cannot be closed`,
      );
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
  return { kind: 'fan', rim };
}
