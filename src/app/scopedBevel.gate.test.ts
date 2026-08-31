// #827 — THE MITER RULE: what a bevel does when it chamfers only SOME of its source's edges.
//
// ── WHY THIS FILE EXISTS BESIDE `mintedBevel.gate.test.ts` ────────────────────────────────
//
// That file pins the ALL-EDGES bevel, whose layout is a closed form: `F + E + V` faces and one
// output point per source face-corner. A partial bevel has no such form — the answer at a point
// depends on how many of ITS edges were chosen — so the two need different instruments. This one
// holds the rule; that one holds the case the rule degenerates to.
//
// ── THE RULE, AND WHERE IT CAME FROM ──────────────────────────────────────────────────────
//
// At a source point of valence `n` with `k` incident chamfered edges, the point contributes `m`
// boundary vertices:
//
//     m = 1      when k = 0        the point does not move, and all its corners collapse onto it
//     m = n - 1  when k = 1        the TERMINAL case (#830) — one per UNCHAMFERED incident edge
//     m = k      when k >= 2       one per run of corners between two consecutive chamfered edges
//
// and a point grows a POLYGON exactly when `m >= 3`, with `m` corners.
//
// Measured live in Blender 5.1.1 over 15 selections spanning valence 3, 4, 5 and 8 and `k` from
// 0 to 8, including two randomised ones where four different `k` values sit on one torus. The
// source's own sentence is `bmesh_bevel.cc:3554-3556`: *"we make BoundVerts to connect the sides
// of the beveled edges. Non-beveled edges in between will just join to the appropriate juncture
// point."*
//
// 🔑 THE TERMINAL ARM ALSO CHANGES A FACE'S ARITY, WHICH IS THE HALF A COUNT CANNOT SEE. At a
// `k = 1` point the boundary vertices belong to the UNCHAMFERED edges, so a face bounded by two
// of them takes BOTH and gains a corner; only the two faces touching the chamfered edge keep
// their count. A rule with `n - 1` right and that map wrong produces identical point and face
// counts, so the rows below assert arity multisets and not only totals.
//
// 🔴 THE FIRST VERSION OF THIS RULE SAID `m = 2` AT `k = 1`, AND A CUBE AND A CYLINDER BOTH
// AGREED WITH IT. They agree because their valence is 3, where `n - 1` and `2` are the same
// number — a fixture on which two candidate rules coincide cannot separate them. A sphere's
// valence-4 point falsified it. That is why the rows below sweep SHAPES rather than scopes.
//
// ── WHY THE ORACLE IS REBUILT HERE RATHER THAN READ OFF THE LAYOUT ────────────────────────
//
// `bevelLayoutOf` computes the point count and the face count TOGETHER, from one walk. Checking
// one against the other would be checking a value against itself. So this file derives both from
// the substrate's OWN independent answers about the SOURCE — `edgeSetOf` for the incidences and
// `edgeFaceAdjacencyOf` for the valence — with no reference to the layout's internals. When the
// two agree, two separate derivations agree; when they disagree, the row names which.
//
// REF: src/app/bevelLayout.ts (`planPoint` — the rule; `BoundaryPlacement` — the position half);
//      src/app/mintedBevel.gate.test.ts (the all-edges case this degenerates to);
//      ref/sources/blender-mesh/bmesh_bevel.cc (`build_boundary`, `build_boundary_terminal_edge`);
//      issues #827, #818, #814, #783.

import { describe, expect, it } from 'vitest';
import { bevelLayoutOf } from './bevelLayout';
import { alignedSplitRims } from './builtRims';
import { getForRead } from './geometryRegistry';
import { edgeSetOf } from './edgeIdentity';
import { bevelGeometryRef, boxGeometryRef, sphereGeometryRef } from './modifierGeometry';
import type { GeometryRef } from '../nodes/types';

const box = () => boxGeometryRef([1, 1, 1], null);
const sphere = (w: number, h: number) => sphereGeometryRef(1, w, h, null);

/**
 * The measured rule, over the substrate's own answers about the SOURCE and nothing else.
 *
 * Returns `null` when any point sits at `k = 1`, which is the case the layout refuses — so a row
 * can assert "the oracle says this is unanswerable" and "the layout refuses it" separately.
 */
function oracle(
  source: GeometryRef,
  chosen: (edge: number) => boolean,
): { points: number; faces: number; chamfered: number } {
  const d = source.descriptor;
  // The edge SET alone — valence is how many edges name a point, which this already says. An
  // adjacency lookup stood here and guarded nothing the set does not, and leaving it would have
  // implied the oracle depends on face incidence when it does not.
  const edges = edgeSetOf(d);
  if (edges === null) throw new Error('oracle: source has no edge set');

  const valence = new Map<number, number>();
  const chamfered = new Map<number, number>();
  let chamferedEdges = 0;
  for (let e = 0; e < edges.count; e++) {
    const picked = chosen(e);
    if (picked) chamferedEdges++;
    for (const v of [edges.pairs[2 * e], edges.pairs[2 * e + 1]]) {
      valence.set(v, (valence.get(v) ?? 0) + 1);
      if (picked) chamfered.set(v, (chamfered.get(v) ?? 0) + 1);
    }
  }

  let points = 0;
  let polygons = 0;
  for (const v of valence.keys()) {
    const k = chamfered.get(v) ?? 0;
    const n = valence.get(v) ?? 0;
    // #830 — the terminal arm. `n - 1`, which is neither 1 nor `k`, and is the row that falsified
    // the first version of this rule: at valence 3 it equals 2, so a box and a cylinder both
    // agreed with a constant and a sphere did not.
    const m = k === 0 ? 1 : k === 1 ? n - 1 : k;
    points += m;
    if (m >= 3) polygons++;
  }
  // The source's faces survive with their arity, one quad per chamfered edge is minted, and a
  // point contributes a polygon only when it reached three boundary vertices. `faces` is that
  // last term ALONE — the caller adds the other two, so this function never has to know the
  // source's face count and cannot accidentally agree with the layout by borrowing it.
  return { points, faces: polygons, chamfered: chamferedEdges };
}

/** `0-n` over a source's edges, and the predicate that means the same thing. */
function range(from: number, to: number): { query: string; test: (e: number) => boolean } {
  return { query: `${from}-${to}`, test: (e) => e >= from && e <= to };
}

describe('#827 — a partial bevel agrees with the rule measured in the reference', () => {
  // Edges are numbered by first encounter over the face order, so a source's face 0 owns edges
  // `0 .. arity-1` — a CLOSED LOOP, which is the shape the rule answers and the one a director
  // reaches for ("chamfer this rim"). A box's face 0 is a quad; a uv sphere's is a pole triangle.
  const CASES: { label: string; source: () => GeometryRef; query: string }[] = [
    { label: 'box — face 0 loop', source: box, query: '0-3' },
    { label: 'box — all edges', source: box, query: '0-11' },
    { label: 'sphere 8x6 — pole triangle loop', source: () => sphere(8, 6), query: '0-2' },
    { label: 'sphere 8x6 — all edges', source: () => sphere(8, 6), query: '0-87' },
    { label: 'sphere 16x8 — pole triangle loop', source: () => sphere(16, 8), query: '0-2' },
    // #830 — the two shapes the terminal case is what unlocks. Both were refused before it.
    { label: 'box — a LONE edge, terminal at both ends', source: box, query: '0-0' },
    { label: 'box — an OPEN CHAIN of two edges', source: box, query: '0-1' },
    {
      label: 'sphere 8x6 — a lone edge into a valence-8 pole',
      source: () => sphere(8, 6),
      query: '0-0',
    },
    { label: 'sphere 8x6 — an open chain at a pole', source: () => sphere(8, 6), query: '0-1' },
  ];

  it.each(CASES)('$label — points and faces match the independent oracle', ({ source, query }) => {
    const src = source();
    const [from, to] = query.split('-').map(Number);
    const expected = oracle(src, range(from, to).test);

    const verdict = bevelLayoutOf(bevelGeometryRef(src, 0.05, query).descriptor);
    expect(verdict.kind === 'refused' ? verdict.why : verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;

    expect({
      points: verdict.layout.points,
      faces: verdict.layout.faceOrder.length,
    }).toEqual({
      points: expected.points,
      faces: verdict.layout.sourceFaces + expected.chamfered + expected.faces,
    });
  });

  it('🔑 THE REFERENCE ROW — a cube rim, against the number Blender itself returned', () => {
    // Blender 5.1.1, cube, Bevel modifier at `segments = 1` with `limit_method = 'WEIGHT'` and
    // the four edges of one face weighted 1.0: **12 points, 10 faces, arity {4:10}**. Asserted as
    // literals rather than through the oracle, because the oracle encodes the rule and this row
    // is what says the rule was right — an oracle checked only against itself proves nothing.
    const verdict = bevelLayoutOf(bevelGeometryRef(box(), 0.1, '0-3').descriptor);
    expect(verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;

    expect(verdict.layout.points).toBe(12);
    expect(verdict.layout.faceOrder.length).toBe(10);
    // 6 shrunk quads + 4 edge quads, and NO vertex polygon: every chosen point has exactly two
    // chamfered edges, which welds rather than growing a face. That is the half a count misses.
    const arity: Record<number, number> = {};
    for (const c of verdict.layout.corners) arity[c] = (arity[c] ?? 0) + 1;
    expect(arity).toEqual({ 4: 10 });
    // The minted tail is the four edge quads alone — `faceOrder` holed, `representative` total.
    expect(verdict.layout.faceOrder.filter((f) => f === null).length).toBe(4);
    expect(verdict.layout.representative.length).toBe(10);
  });

  it('🔑 #830 THE TERMINAL CASE — a LONE chamfered edge, against the numbers Blender returned', () => {
    // Blender 5.1.1, default cube, Bevel at `segments = 1`, `limit_method = 'WEIGHT'`, ONE edge
    // weighted 1.0: **10 points, 7 faces, arity {4:5, 5:2}**. Literals rather than the oracle,
    // because the oracle encodes the rule and this row is what says the rule was right.
    //
    // 🔴 THE ARITY IS THE HALF A COUNT CANNOT SEE, and it is the whole content of this case. Both
    // endpoints of the chamfered edge sit at `k = 1`, and at each of them the face OPPOSITE the
    // chamfered edge — the one bounded by two unchamfered edges — takes two boundary vertices and
    // becomes a pentagon. A rule that got the corner map wrong while getting `n - 1` right would
    // produce 10 points and 7 faces exactly as here, and `{4:7}` instead of `{4:5, 5:2}`.
    const verdict = bevelLayoutOf(bevelGeometryRef(box(), 0.1, '0').descriptor);
    expect(verdict.kind === 'refused' ? verdict.why : verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;

    expect(verdict.layout.points).toBe(10);
    expect(verdict.layout.faceOrder.length).toBe(7);
    const arity: Record<number, number> = {};
    for (const c of verdict.layout.corners) arity[c] = (arity[c] ?? 0) + 1;
    expect(arity).toEqual({ 4: 5, 5: 2 });
    // No vertex polygon: `n - 1 = 2` at valence 3, and a point grows one only at three or more.
    expect(verdict.layout.faceOrder.filter((f) => f === null).length).toBe(1);
  });

  it('🔑 #830 AT A VALENCE-8 POLE — where `n - 1` and 2 are different numbers', () => {
    // The fixture that separates the rule from the constant it was first written as. A lone edge
    // into a uv sphere's pole puts `k = 1` on a valence-8 point: 7 boundary vertices, and since
    // 7 >= 3 the point GROWS a polygon, which the valence-3 case never does.
    const src = sphere(8, 6);
    const verdict = bevelLayoutOf(bevelGeometryRef(src, 0.05, '0-0').descriptor);
    expect(verdict.kind === 'refused' ? verdict.why : verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;

    const edges = edgeSetOf(src.descriptor);
    expect(edges).not.toBeNull();
    if (edges === null) return;
    // Valences of edge 0's two endpoints, derived from the edge set rather than assumed.
    const valence = new Map<number, number>();
    for (let e = 0; e < edges.count; e++)
      for (const v of [edges.pairs[2 * e], edges.pairs[2 * e + 1]])
        valence.set(v, (valence.get(v) ?? 0) + 1);
    const ends = [edges.pairs[0], edges.pairs[1]];
    const grew = ends.filter((v) => (valence.get(v) ?? 0) - 1 >= 3).length;
    // Exactly the endpoints whose `n - 1` reaches 3 mint a polygon, and at least one must, or the
    // row is not testing what it claims to.
    expect(grew).toBeGreaterThan(0);
    expect(verdict.layout.faceOrder.filter((f) => f === null).length).toBe(1 + grew);
    for (const v of ends) {
      const n = valence.get(v) ?? 0;
      if (n - 1 < 3) continue;
      expect(verdict.layout.corners).toContain(n - 1);
    }
  });

  it('🔴 A SCOPE SELECTING NOTHING IS REFUSED, not silently treated as "everything"', () => {
    // The loudest possible wrong answer wearing the quietest failure: an empty selection that
    // chamfered every edge would look exactly like a bevel nobody had scoped yet.
    const verdict = bevelLayoutOf(bevelGeometryRef(box(), 0.1, '^0-11').descriptor);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') return;
    expect(verdict.why).toMatch(/selects none/);
  });

  it('🔑 AN ALL-EDGES BEVEL IS UNCHANGED: corner -> point is still a BIJECTION', () => {
    // The property #827 had to preserve. Before it, an output point WAS a face-corner; after it,
    // a run of corners may share one. When every edge is chamfered every run is a single corner,
    // so the map must still be one-to-one — and if it were not, the renderer would weld corners
    // that used to be distinct and the chamfer would collapse silently.
    for (const [label, src] of [
      ['box', box()],
      ['sphere 8x6', sphere(8, 6)],
    ] as const) {
      const verdict = bevelLayoutOf(bevelGeometryRef(src, 0.05).descriptor);
      expect(verdict.kind, label).toBe('laid-out');
      if (verdict.kind !== 'laid-out') continue;
      const layout = verdict.layout;

      const used = new Set<number>();
      let corners = 0;
      for (let f = 0; f < layout.sourceFaces; f++) {
        for (const point of layout.rims[f]) {
          used.add(point);
          corners++;
        }
      }
      expect({ label, distinct: used.size }).toEqual({ label, distinct: corners });
      expect({ label, points: layout.points }).toEqual({ label, points: corners });
    }
  });

  it('🔑 `pointOrder` IS NON-DECREASING — one contiguous block per source point', () => {
    // The property the #827 renumbering bought, and it is checkable by a scan rather than by a
    // set comparison. It is also what makes "every output point has an honest origin" cheap to
    // assert: a hole would show up as a repeat after a gap.
    for (const query of [undefined, '0-3']) {
      const verdict = bevelLayoutOf(bevelGeometryRef(box(), 0.1, query).descriptor);
      expect(verdict.kind).toBe('laid-out');
      if (verdict.kind !== 'laid-out') continue;
      const order = verdict.layout.pointOrder;
      expect(order.length).toBe(verdict.layout.points);
      for (let i = 1; i < order.length; i++)
        expect(order[i] >= order[i - 1], `${String(query)} at ${i}`).toBe(true);
      // Every source point is named, and none from outside the source.
      expect(Math.max(...order)).toBeLessThan(verdict.layout.sourcePoints);
    }
  });

  it('🔴 TWO SCOPES OVER ONE SOURCE ARE TWO LAYOUTS — the cache key carries the query', () => {
    // Without the scope in the layout cache key, the second of these gets the first's layout:
    // both build, both draw, and the second is a mesh nobody asked for. The rows above would all
    // still pass, because each one asks for a single scope in isolation.
    const src = box();
    const loop = bevelLayoutOf(bevelGeometryRef(src, 0.1, '0-3').descriptor);
    const all = bevelLayoutOf(bevelGeometryRef(src, 0.1).descriptor);
    const loopAgain = bevelLayoutOf(bevelGeometryRef(src, 0.1, '0-3').descriptor);
    expect(loop.kind).toBe('laid-out');
    expect(all.kind).toBe('laid-out');
    if (loop.kind !== 'laid-out' || all.kind !== 'laid-out' || loopAgain.kind !== 'laid-out')
      return;
    expect(loop.layout.points).toBe(12);
    expect(all.layout.points).toBe(24);
    // And re-asking for the first one after the second has been derived returns the FIRST answer,
    // which is the half a "they differ" assertion cannot see.
    expect(loopAgain.layout.points).toBe(12);
  });

  it('🔴 #841 — EVERY `meet` IS PULLED TOWARD TWO CHAMFERED EDGES, not toward whatever preceded it', () => {
    // The half every row above is blind to. `placement` had NO reader here, and a wrong `toward`
    // leaves the point COUNT untouched — so the layout was internally consistent and externally
    // wrong. On a box with a chamfered edge loop, 4 of the 8 boundary vertices were pulled toward
    // an UNBEVELED edge, which moves them in the wrong DIRECTION and not merely by the wrong
    // distance (`geometryRegistry` sums the two unit vectors and scales by `amount`).
    //
    // A run of ONE corner cannot separate the right expression from the wrong one — both name the
    // same pair — so the fixture is asserted to contain a longer run before the check runs at all.
    const chamfered = new Set([0, 1, 2, 3]);
    const src = box();
    const verdict = bevelLayoutOf(bevelGeometryRef(src, 0.1, '0-3').descriptor);
    expect(verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;
    const layout = verdict.layout;

    // The fixture actually exercises a run longer than one corner: some output point is named by
    // two different source face-corners. Without this the row could pass vacuously.
    const corners: Record<number, number> = {};
    for (let f = 0; f < layout.sourceFaces; f++)
      for (const point of layout.rims[f]) corners[point] = (corners[point] ?? 0) + 1;
    expect(Object.values(corners).some((c) => c >= 2)).toBe(true);

    // Independently of the layout: which source points does each chamfered edge join?
    const edges = edgeSetOf(src.descriptor);
    expect(edges).not.toBeNull();
    if (edges === null) return;
    const chamferedFarEnds = new Map<number, Set<number>>();
    for (const e of chamfered) {
      const a = edges.pairs[2 * e];
      const b = edges.pairs[2 * e + 1];
      if (!chamferedFarEnds.has(a)) chamferedFarEnds.set(a, new Set());
      if (!chamferedFarEnds.has(b)) chamferedFarEnds.set(b, new Set());
      chamferedFarEnds.get(a)!.add(b);
      chamferedFarEnds.get(b)!.add(a);
    }

    let meets = 0;
    for (const rule of layout.placement) {
      if (rule.kind !== 'meet') continue;
      meets++;
      for (const toward of rule.toward)
        expect({ point: rule.point, toward }).toEqual({
          point: rule.point,
          toward: chamferedFarEnds.get(rule.point)?.has(toward) ? toward : 'NOT A CHAMFERED EDGE',
        });
    }
    // Eight of them, so the loop above is not passing by never running.
    expect(meets).toBe(8);
  });

  it('🔑 #830 THE SLIDE ARM REACHES THE GEOMETRY — on-edge, and split by face adjacency', () => {
    // Every row above stops at the layout. This one BUILDS, because the terminal case added an
    // arm to `geometryRegistry` that nothing else here evaluates — and a placement rule with no
    // reader is exactly what #841 turned out to be.
    //
    // Two separate claims, both measured in Blender 5.1.1: every boundary vertex of a terminal
    // point lies ON an incident unchamfered edge (perpendicular distance 0), and the distance
    // splits by FACE ADJACENCY rather than by angle — the two edges sharing a face with the
    // chamfered edge slide by `amount / sin θ`, every other edge by a flat `amount`.
    const amount = 0.05;
    const src = sphere(8, 6);
    const ref = bevelGeometryRef(src, amount, '0-0');
    const verdict = bevelLayoutOf(ref.descriptor);
    expect(verdict.kind === 'refused' ? verdict.why : verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;
    const layout = verdict.layout;

    const built = getForRead(ref);
    const sourceGeom = getForRead(src);
    expect(built, 'the bevel builds').not.toBeNull();
    expect(sourceGeom, 'the source builds').not.toBeNull();
    if (built === null || sourceGeom === null) return;

    // The welded-to-split bridge the builder uses, so a source point's position is read the same
    // way here as there rather than by assuming the two buffers share an indexing.
    const splitRims = alignedSplitRims(src, sourceGeom);
    expect(splitRims).not.toBeNull();
    if (splitRims === null) return;
    const srcPos = sourceGeom.getAttribute('position');
    const home = new Map<number, readonly [number, number, number]>();
    for (let f = 0; f < layout.sourceFaces; f++) {
      const welded = layout.sourceRims[f];
      for (let k = 0; k < welded.length; k++) {
        const at = splitRims[f][k];
        if (!home.has(welded[k]))
          home.set(welded[k], [srcPos.getX(at), srcPos.getY(at), srcPos.getZ(at)]);
      }
    }

    // 🔴 THE BUILT BUFFER IS SPLIT AND IS NOT INDEXED BY TOPOLOGICAL POINT ID. The builder
    // computes one position per output point and then emits split vertices by walking `rims`, so
    // reading `position` at a placement index reads an unrelated vertex — which is exactly the
    // wrong answer this file's header warns a plausible index buffer produces. Paired through the
    // output's own rims instead.
    const outSplit = alignedSplitRims(ref, built);
    expect(outSplit).not.toBeNull();
    if (outSplit === null) return;
    const outAttr = built.getAttribute('position');
    const out = new Map<number, readonly [number, number, number]>();
    for (let f = 0; f < layout.rims.length; f++)
      for (let k = 0; k < layout.rims[f].length; k++) {
        const at = outSplit[f][k];
        if (!out.has(layout.rims[f][k]))
          out.set(layout.rims[f][k], [outAttr.getX(at), outAttr.getY(at), outAttr.getZ(at)]);
      }

    let flat = 0;
    let widened = 0;
    let maxFlank = 0;
    for (let i = 0; i < layout.placement.length; i++) {
      const r = layout.placement[i];
      if (r.kind !== 'slide') continue;
      const a = home.get(r.point);
      const b = home.get(r.toward);
      expect(a, `source point ${r.point} has a position`).toBeDefined();
      expect(b, `source point ${r.toward} has a position`).toBeDefined();
      if (a === undefined || b === undefined) continue;

      const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
      const el = Math.hypot(e[0], e[1], e[2]);
      const u = [e[0] / el, e[1] / el, e[2] / el] as const;
      const q = out.get(i);
      expect(q, `output point ${i} appears in some rim`).toBeDefined();
      if (q === undefined) continue;
      const d = [q[0] - a[0], q[1] - a[1], q[2] - a[2]] as const;
      const along = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
      const perp = Math.hypot(d[0] - u[0] * along, d[1] - u[1] * along, d[2] - u[2] * along);

      // (1) ON the edge, and on the near side of it.
      expect(perp).toBeLessThan(1e-6);
      expect(along).toBeGreaterThan(0);
      // (2) the split. `sin θ <= 1`, so a flanking vertex slides by AT LEAST `amount` and by
      // strictly more wherever the two edges are not perpendicular.
      if (r.against === null) {
        flat++;
        expect(Math.abs(along - amount)).toBeLessThan(1e-6);
      } else {
        widened++;
        expect(along).toBeGreaterThanOrEqual(amount - 1e-6);
        maxFlank = Math.max(maxFlank, along);
      }
    }
    // Both kinds were actually seen, so neither branch passed by never running. A terminal point
    // has exactly two flanking edges, and this scope makes two points terminal.
    expect(widened).toBe(4);
    expect(flat).toBeGreaterThan(0);
    // 🔴 AND THE WIDENING IS REAL. Without this the row passes on a builder that dropped the
    // `1 / sin θ` scale entirely, since `>= amount` is satisfied by exactly `amount`. None of
    // these edges meets the chamfered one at a right angle, so at least one must exceed it.
    expect(maxFlank).toBeGreaterThan(amount + 1e-6);

    // 🔴 AND THE MINTED POLYGON IS WOUND THE RIGHT WAY ROUND. The terminal arm orders its ring by
    // walking the UNCHAMFERED EDGES away from the chamfered one, where every other arm orders it
    // by walking CORNERS — two different traversals that have to agree about direction. Nothing
    // else here would notice if they did not: a backwards-wound n-gon has the right corner count,
    // the right point count and the right arity, and renders as an invisible hole because it is
    // backface-culled. The source is a unit sphere about the origin, so "outward" is checkable —
    // the face normal must point away from the centre.
    const terminal: number[] = [];
    for (let f = 0; f < layout.faceOrder.length; f++)
      if (layout.faceOrder[f] === null && layout.corners[f] !== 4) terminal.push(f);
    expect(terminal.length, 'a terminal point grew a polygon').toBeGreaterThan(0);
    for (const f of terminal) {
      const ring = layout.rims[f].map((id) => out.get(id));
      expect(ring.every((q) => q !== undefined)).toBe(true);
      // Newell's normal — correct for a non-planar rim, which a minted n-gon generally is.
      const nrm = [0, 0, 0];
      const cen = [0, 0, 0];
      for (let k = 0; k < ring.length; k++) {
        const c = ring[k];
        const d = ring[(k + 1) % ring.length];
        if (c === undefined || d === undefined) continue;
        nrm[0] += (c[1] - d[1]) * (c[2] + d[2]);
        nrm[1] += (c[2] - d[2]) * (c[0] + d[0]);
        nrm[2] += (c[0] - d[0]) * (c[1] + d[1]);
        cen[0] += c[0] / ring.length;
        cen[1] += c[1] / ring.length;
        cen[2] += c[2] / ring.length;
      }
      expect(nrm[0] * cen[0] + nrm[1] * cen[1] + nrm[2] * cen[2]).toBeGreaterThan(0);
    }
  });
});
