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
//     m = k      when k >= 2       one per run of corners between two consecutive chamfered edges
//     REFUSED    when k = 1        the terminal case, deferred — see the refusal rows below
//
// and a point grows a POLYGON exactly when `m >= 3`, with `m` corners.
//
// Measured live in Blender 5.1.1 over 15 selections spanning valence 3, 4, 5 and 8 and `k` from
// 0 to 8, including two randomised ones where four different `k` values sit on one torus. The
// source's own sentence is `bmesh_bevel.cc:3554-3556`: *"we make BoundVerts to connect the sides
// of the beveled edges. Non-beveled edges in between will just join to the appropriate juncture
// point."*
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
): { points: number; faces: number; chamfered: number } | null {
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
    if (k === 1) return null;
    const m = k === 0 ? 1 : k;
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
  ];

  it.each(CASES)('$label — points and faces match the independent oracle', ({ source, query }) => {
    const src = source();
    const [from, to] = query.split('-').map(Number);
    const expected = oracle(src, range(from, to).test);
    expect(expected, 'this row is meant to be answerable').not.toBeNull();

    const verdict = bevelLayoutOf(bevelGeometryRef(src, 0.05, query).descriptor);
    expect(verdict.kind === 'refused' ? verdict.why : verdict.kind).toBe('laid-out');
    if (verdict.kind !== 'laid-out') return;

    expect({
      points: verdict.layout.points,
      faces: verdict.layout.faceOrder.length,
    }).toEqual({
      points: expected!.points,
      faces: verdict.layout.sourceFaces + expected!.chamfered + expected!.faces,
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

  it('🔴 THE TERMINAL CASE IS REFUSED BY NAME, AND THE REFUSAL SAYS WHAT TO DO', () => {
    // Reachable by an author in one keystroke, unlike the manifoldness gate — so the message has
    // to be actionable, and the point has to be named.
    const verdict = bevelLayoutOf(bevelGeometryRef(box(), 0.1, '0').descriptor);
    expect(verdict.kind).toBe('refused');
    if (verdict.kind !== 'refused') return;
    expect(verdict.why).toMatch(/exactly one chamfered edge/);
    expect(verdict.why).toMatch(/closed loop/);
    // And the oracle agrees it is unanswerable, which is what makes the refusal a DECISION
    // rather than a failure to derive.
    expect(oracle(box(), (e) => e === 0)).toBeNull();
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
});
