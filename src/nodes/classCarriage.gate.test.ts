// The per-class carriage census (#715, P1 of the polygonal-atoms plan).
//
// ── WHAT THIS GATE IS FOR ─────────────────────────────────────────────────────────────
//
// A drop is a legitimate answer. A drop nobody declared is not — it is indistinguishable
// from an oversight, and from a bug. `CLASS_CARRIAGE` is the one place that states what this
// road does with each atom class; this file is what stops that statement from being
// decorative.
//
// Three properties, and each one fails differently:
//
//   1. TOTALITY — every class has a verdict. Mostly held at COMPILE time by
//      `Record<KnownDomain, …>`; asserted here too because a compile-time guarantee is
//      invisible to a reader auditing the drop list, and because the table could be widened
//      with a member `KNOWN_DOMAINS` does not have.
//   2. THE EXACT DROP POPULATION — spelled as a literal, so the list can only shrink
//      DELIBERATELY. A drop that closes (#716 lands, `point` starts riding a real order)
//      must edit this file to say so. That is the property the plan calls "the population can
//      only shrink deliberately", and a `toBeGreaterThan(0)`-shaped assertion would not have
//      it.
//   3. THE VERDICTS ARE CONSULTED — a table nobody reads is a comment with a type. Every row
//      is put through `carriageForDomain` against a REAL tiling and the answer checked.
//
// ⚠️ NOT ASSERTED HERE, ON PURPOSE: that the laid-out arms return the RIGHT orders. That is a
// runtime claim about winding and it is already held by `modifierAttributeTiling.gate.test.ts`'s
// mirrored-corner row, where an arm returning a wrong-but-valid order compiles perfectly and
// reds. Restating it here would be a second statement free to drift from the first.
//
// REF: src/nodes/meshAttributes.ts (`CLASS_CARRIAGE`, `carriageForDomain`);
//      ref/architecture/polygonal-atoms.md (P1); issues #715, #716, #718, #722.

import { describe, expect, it } from 'vitest';
import { CLASS_CARRIAGE, carriageForDomain } from './meshAttributes';
import { KNOWN_DOMAINS } from './attributes';
import { boxGeometryRef } from '../app/modifierGeometry';
import { arrayGeometryRef } from '../app/modifierGeometry';
import { tiledCornerOrder, tiledFaceOrder } from '../app/faceCount';

const BOX: [number, number, number] = [1, 1, 1];

/** A REAL tiling, taken from the same producers the production road uses. */
function tilingOfArrayedBox() {
  const ref = arrayGeometryRef(boxGeometryRef(BOX, null), 3, [2, 0, 0]);
  const faces = tiledFaceOrder(ref.descriptor);
  const corners = tiledCornerOrder(ref.descriptor);
  // Not `!` — a null here means the fixture stopped describing a tiling, and every row below
  // would then be asserting against orders nobody produced.
  if (faces === null || corners === null) throw new Error('fixture: arrayed box has no tiling');
  return { faces, corners };
}

describe('the per-class carriage census', () => {
  it('1 — every known atom class has a verdict, and the table declares no others', () => {
    expect(Object.keys(CLASS_CARRIAGE).sort()).toEqual([...KNOWN_DOMAINS].sort());
  });

  it('2 — 🔴 THE DECLARED DROPS ARE EXACTLY THESE TWO', () => {
    // Sorted, and a literal. When #716 gives `point` a real order this row reds, and the fix
    // is to delete the member here — which is the whole point: the population shrinks by an
    // edit somebody made on purpose, never by a table quietly answering differently.
    const dropped = Object.entries(CLASS_CARRIAGE)
      .filter(([, v]) => v.kind === 'dropped')
      .map(([domain]) => domain)
      .sort();
    expect(dropped).toEqual(['edge', 'point']);
  });

  it('3 — every drop says WHY and names the issue that closes it', () => {
    // A reason nobody can act on is the same as no reason. The issue reference is what turns
    // "we drop this" into "we drop this until X", and it is why a reader who finds the drop
    // does not have to go looking for whether anyone knows.
    const drops = Object.entries(CLASS_CARRIAGE).filter(([, v]) => v.kind === 'dropped');
    expect(drops.length).toBeGreaterThan(0); // guards row 3 against vacuity if row 2 changes
    for (const [domain, verdict] of drops) {
      if (verdict.kind !== 'dropped') throw new Error('unreachable — filtered above');
      expect(verdict.why.length, `${domain} why`).toBeGreaterThan(20);
      expect(verdict.until, `${domain} until`).toMatch(/^#\d+$/);
    }
  });

  it('4 — a laid-out class resolves to the order its verdict names', () => {
    const { faces, corners } = tilingOfArrayedBox();
    const face = carriageForDomain('face', faces, corners);
    const corner = carriageForDomain('corner', faces, corners);

    expect(face.kind).toBe('laid-out');
    expect(corner.kind).toBe('laid-out');
    if (face.kind !== 'laid-out' || corner.kind !== 'laid-out') return;

    // Order IDENTITY, not equality: `faceCount.ts` returns the same object for an unchanged
    // tiling, so `toBe` is what catches a face arm wired to the corner order. A deep-equality
    // check would pass on a box only because both orders happen to be ascending runs.
    expect(face.layout.order).toBe(faces.order);
    expect(corner.layout.order).toBe(corners.order);

    // The denominator travels with the order — the pair a misfit check compares against.
    expect(face.layout.sourceElements).toBe(faces.sourceFaces);
    expect(corner.layout.sourceElements).toBe(corners.sourceCorners);
    expect(face.layout.noun).toBe('faces');
    expect(corner.layout.noun).toBe('corners');

    // And the two orders are genuinely different lengths, so row 4 could not pass by the two
    // arms accidentally agreeing.
    expect(corners.order.length).toBe(faces.order.length * 3);
  });

  it('5 — a dropped class resolves to its verdict, and to the SAME object', () => {
    const { faces, corners } = tilingOfArrayedBox();
    const point = carriageForDomain('point', faces, corners);
    expect(point.kind).toBe('dropped');
    // Identity, deliberately: the resolver must hand back the table's row rather than rebuild
    // one. A copy would be a second spelling of the reason, free to drift from the table this
    // gate censuses — which is exactly the defect #680 records at the scope param.
    expect(point).toBe(CLASS_CARRIAGE.point);
    expect(carriageForDomain('edge', faces, corners)).toBe(CLASS_CARRIAGE.edge);
  });

  it('6 — 🔴 A FOREIGN DOMAIN IS NOT A DROP. They were one `null` and are now two values', () => {
    const { faces, corners } = tilingOfArrayedBox();
    const foreign = carriageForDomain('zz_domain_from_a_later_build', faces, corners);

    expect(foreign.kind).toBe('foreign');
    // The row that carries the whole distinction: before #715 both of these were `null`, and
    // the function's doc had to spend a paragraph saying the two `null`s meant different
    // things — the shape of a type nobody had written. A drop is a decision THIS build took
    // about a class it knows; foreign is a class it has never heard of, which must round-trip
    // untouched because domains are data. Collapsed, a census of "what do we drop?" would
    // answer with somebody else's domain.
    expect(foreign.kind).not.toBe('dropped');
    expect(carriageForDomain('point', faces, corners).kind).toBe('dropped');
  });

  it('7 — neither answer tiles: foreign and dropped both stay off the layout road', () => {
    // The distinction in row 6 is about what we can SAY, not about what ships. Both classes
    // are still absent from the merged geometry, which is the pre-#694 behaviour deliberately
    // kept — refusing loudly would be a behaviour change for sources that exist today,
    // smuggled in under a widening. Stated as its own row so a reader cannot take row 6 for a
    // claim that foreign attributes now survive.
    const { faces, corners } = tilingOfArrayedBox();
    for (const domain of ['point', 'edge', 'zz_domain_from_a_later_build']) {
      expect(carriageForDomain(domain, faces, corners).kind, domain).not.toBe('laid-out');
    }
  });
});
