// #847 — AN ANGLE LIMIT SELECTS EDGES, AND THE TWO WAYS IT WOULD SELECT THE WRONG ONES.
//
// The arithmetic rows are the cheap half. The two that earn their place are the traps, and
// both are cases where a wrong answer LOOKS right: the mesh still builds, the counts are
// still plausible, and nothing errors.
//
//   🔴 THE BOUNDARY EDGE. `edgeAnglesOf` answers zero for a flat edge, a boundary edge and a
//      non-manifold one alike, and says so. A rule phrased over the angle alone is therefore
//      not enough: at a low limit an open mesh's entire silhouette would be selected, which
//      on a `subset` is every cut edge. The reference cannot reach this state because it
//      calls `BM_edge_loop_pair` BEFORE testing the angle (MOD_bevel.cc:195), so the manifold
//      check is a precondition of asking, not a filter on the answer. Row 3 is that claim.
//
//   🔴 THE EMPTY SELECTION. A blank scope query is the authoring state "none written", which
//      `scopeField` turns into an ABSENT field and every generator reads as EVERYTHING. So a
//      limit that selects no edge must NOT travel as an empty query — it would bevel the
//      whole mesh, the exact inverse of what was asked. Rows 5 and 6 are that claim, and they
//      are asserted at the resolver because that is where the query string is produced.
//
//      ⚠️ ROW 5 ONCE ASSERTED A THROW, AND #862 IS WHY IT NO LONGER DOES. Naming the refusal
//      was right; making it a throw was not, because this resolver runs inside `evaluate` on
//      the render walk with no `try` above it — so an angle limit of 90 on a default cube
//      unmounted the app, and half the slider's own range reached it by a scrub drag. The
//      claim survived the fix and got stronger: an empty result now RESOLVES, to a spelling
//      that is neither blank nor null and that names {} at every length. Row 6 pins the
//      direction of the fallback, which is the whole reason the spelling is not `''`.
//
// REF: src/app/edgeAngleSelection.ts; src/app/edgeAngle.ts (the three zeros);
//      src/app/bevelNodeReach.gate.test.ts (the node's matching passthrough arm);
//      ref/sources/blender-mesh/MOD_bevel.cc:193-203; issues #847, #800, #862.

import { describe, expect, it } from 'vitest';
import {
  arrayGeometryRef,
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { bevelLayoutOf } from './bevelLayout';
import { scopeSelection } from '../nodes/scopeQuery';
import { edgeIndicesByAngle } from './edgeAngleSelection';
import { edgeFaceAdjacencyOf } from './edgeIdentity';
import { EMPTY_SELECTION_QUERY, resolveComponentSelection } from '../nodes/componentSelection';
import type { ObjectData } from '../nodes/types';

const box = boxGeometryRef([1, 1, 1], null);

const selected = (
  ref: Parameters<typeof edgeIndicesByAngle>[0],
  deg: number,
): readonly number[] => {
  const v = edgeIndicesByAngle(ref, deg);
  expect(v.kind, `angle ${deg}° on ${ref.key}: ${v.kind === 'refused' ? v.why : ''}`).toBe(
    'selected',
  );
  return v.kind === 'selected' ? v.edges : [];
};

describe('#847 — an angle limit selects edges', () => {
  it('1 — a box is 90° everywhere, so a 30° limit takes all 12 edges and a 120° limit none', () => {
    expect(selected(box, 30).length, 'box at 30°').toBe(12);
    expect(edgeIndicesByAngle(box, 120).kind, 'box at 120° selects nothing').toBe('selected');
    expect(selected(box, 120).length, 'box at 120°').toBe(0);
  });

  it("2 — the REFERENCE EPSILON, without which a limit typed at the mesh's own angle inverts", () => {
    // ⚠️ THIS ROW PINS THE EPSILON, NOT THE COMPARISON OPERATOR — measured, because the
    // comment here first claimed the latter. Flipping `>` to `>=` leaves all six rows green:
    // the epsilon (~1e-5°) is already an order of magnitude above the `Float32Array` error
    // (~2.5e-6°), so the two operators agree on every input this substrate can produce. What
    // DOES red is dropping the epsilon — a box's 90.0000025° then clears a 90° bar and the
    // limit a user is most likely to type selects everything instead of nothing.
    expect(selected(box, 90).length, 'box at exactly 90°').toBe(0);
    expect(selected(box, 89.9).length, 'box just below 90°').toBe(12);
  });

  it('3 — a boundary edge is never selected, at any limit including zero', () => {
    // 🔴 THIS ROW PINS THE BEHAVIOUR AND NOT THE GUARD, AND THE DIFFERENCE WAS MEASURED.
    // Removing the manifold precondition from `edgeIndicesByAngle` leaves this row GREEN,
    // because `edgeAnglesOf` answers ZERO for a boundary edge and `0 > limit` is false for
    // every limit at or above zero. So today the exclusion is done by that distant zero
    // convention, and the precondition is redundant.
    //
    // It is kept anyway, for the reason the reference keeps it: `MOD_bevel.cc:195` asks
    // `BM_edge_loop_pair` BEFORE testing the angle, which makes the rule correct without
    // depending on what a non-manifold edge's angle happens to be. If `edgeAnglesOf` ever
    // answers something other than zero for an edge without two faces — and its own header
    // flags non-manifold as unreached rather than impossible — this module does not move.
    // Stated here rather than implied, so nobody reads this row as coverage of that guard.
    // A subset is the open mesh this substrate builds. Its cut edges have ONE face, so
    // `edgeAnglesOf` answers zero for them — the same answer a flat edge gets, which is
    // exactly why the angle alone cannot be the rule.
    const open = subsetGeometryRef(box, '0-2', true);
    const adjacency = edgeFaceAdjacencyOf(open.descriptor)!;
    const boundary = adjacency.faces
      .map((fs, e) => (fs.length === 1 ? e : -1))
      .filter((e) => e >= 0);
    // The row is worthless if the fixture has no boundary edge — assert the population first.
    expect(boundary.length, 'the fixture must actually have boundary edges').toBeGreaterThan(0);

    for (const limit of [0, 1, 30, 90]) {
      const got = selected(open, limit);
      const leaked = got.filter((e) => boundary.includes(e));
      expect(leaked, `limit ${limit}° must select no boundary edge of ${open.key}`).toEqual([]);
    }
  });

  it('4 — composes through array and mirror, like every derived quantity in this arc', () => {
    for (const ref of [arrayGeometryRef(box, 3, [2, 0, 0]), mirrorGeometryRef(box, 'x', 1)]) {
      const got = selected(ref, 30);
      const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
      expect(got.length, `${ref.key} selects some edge at 30°`).toBeGreaterThan(0);
      for (const e of got)
        expect(adjacency.faces[e].length, `${ref.key} edge ${e} is manifold`).toBe(2);
    }
  });

  it('5 — 🔴 AN EMPTY RESULT RESOLVES TO THE EMPTY SET; IT MUST NOT TRAVEL AS A BLANK QUERY', () => {
    // ⚠️ THIS ROW USED TO ASSERT A THROW, AND THE INVERSION IS #862. Its CLAIM has not
    // changed — a blank query means "everything" downstream, so "no edge qualified" must
    // never be spelled `''` — but the answer to it has. Refusing by name meant throwing, and
    // this resolver runs inside `evaluate` on the render walk with no `try` above it, so a
    // limit of 90 on a cube took the app down and a scrub drag reached it. An empty selection
    // is an ordinary authoring state; the node passes its source through, which is pinned on
    // the selection axis of `bevelNodeReach.gate.test.ts` beside the amount axis it mirrors.
    //
    // So the row now pins THREE things, and the second is the one the old throw was
    // protecting: it resolves, it does not resolve to blank-or-null, and what it does
    // resolve to genuinely names {} — at every length, since a canonical query travels into
    // a descriptor re-read later against a freshly recomputed count.
    const spine = { kind: 'ModifiedData', geometry: box, material: undefined } as unknown as
      | ObjectData
      | undefined;
    for (const deg of [90, 120, 180]) {
      const got = resolveComponentSelection(
        spine,
        { limitMethod: 'angle', angleLimit: deg },
        'edge',
      );
      expect(got?.count, `${deg}° on a box selects nothing`).toBe(0);
      // 🔴 THE INVERSION GUARD. `''` and `null` both read as EVERYTHING downstream, so this
      // is the assertion that would have caught the whole mesh being beveled.
      expect(got?.canonicalQuery, `${deg}° must not travel as a blank query`).toBe(
        EMPTY_SELECTION_QUERY,
      );
      expect(got?.canonicalQuery, `${deg}° must not travel as null`).not.toBeNull();
    }
    // And the spelling is empty INDEPENDENTLY OF LENGTH, which is a property of
    // `scopeSelection` that no reader can see in the string `'^0'` itself. A complement
    // spelling passes at 12 and selects all 24 at 24, so this is the row that rejects it.
    for (const n of [0, 1, 8, 12, 24, 96, 960])
      expect(scopeSelection(EMPTY_SELECTION_QUERY, n).count, `empty at length ${n}`).toBe(0);
  });

  it('6 — 🔑 AND THE SPELLING FAILS SAFE: the builder REFUSES it rather than beveling everything', () => {
    // The node's passthrough arm (row 7) means `EMPTY_SELECTION_QUERY` normally stops before
    // the builder. This row asks what happens if that arm is ever removed — because the whole
    // point of not using `''` is the DIRECTION of the fallback. A blank query would have
    // chamfered every edge; this one is refused by name, so the worst case is "chamfers
    // nothing", which is what was asked for.
    const verdict = bevelLayoutOf(
      bevelGeometryRef(box, 0.1, EMPTY_SELECTION_QUERY, 'edge').descriptor,
    );
    expect(verdict.kind, 'the builder refuses an empty selection').toBe('refused');
    if (verdict.kind === 'refused') expect(verdict.why).toMatch(/selects none/);
  });

  it('7 — an angle limit and an authored scope are exclusive, and the conflict is named', () => {
    const spine = { kind: 'ModifiedData', geometry: box, material: undefined } as unknown as
      | ObjectData
      | undefined;
    expect(() =>
      resolveComponentSelection(
        spine,
        { limitMethod: 'angle', angleLimit: 30, scope: '0-2' },
        'edge',
      ),
    ).toThrow(/one producer/);
    // And the happy path still resolves, so the row above is not passing because everything throws.
    const ok = resolveComponentSelection(spine, { limitMethod: 'angle', angleLimit: 30 }, 'edge');
    expect(ok?.count, 'a box at 30° resolves to all 12 edges').toBe(12);
    expect(ok?.canonicalQuery, 'and canonicalises to a range, not 12 indices').toBe('0-11');
  });
});
