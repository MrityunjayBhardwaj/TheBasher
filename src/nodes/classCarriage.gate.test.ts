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
//      ref/architecture/polygonal-atoms.md (P1); issues #715, #716, #717, #723, #763, #718,
//      #722.

import { describe, expect, it } from 'vitest';
import { CLASS_CARRIAGE, carriageForDomain } from './meshAttributes';
import { ATTRIBUTE_TYPES, KNOWN_DOMAINS } from './attributes';
import { boxGeometryRef } from '../app/modifierGeometry';
import { arrayGeometryRef } from '../app/modifierGeometry';
import { tiledCornerOrder, tiledFaceOrder } from '../app/faceCount';
import { tiledPointOrder } from '../app/pointIdentity';
import type { AttributeData } from './attributes';

const BOX: [number, number, number] = [1, 1, 1];

/** A REAL tiling, taken from the same producers the production road uses. */
function tilingOfArrayedBox() {
  const ref = arrayGeometryRef(boxGeometryRef(BOX, null), 3, [2, 0, 0]);
  const faces = tiledFaceOrder(ref.descriptor);
  const corners = tiledCornerOrder(ref.descriptor);
  const points = tiledPointOrder(ref.descriptor);
  // Not `!` — a null here means the fixture stopped describing a tiling, and every row below
  // would then be asserting against orders nobody produced.
  if (faces === null || corners === null || points === null)
    throw new Error('fixture: arrayed box has no tiling');
  return { faces, corners, points };
}

/** A datum at `domain`, at a type this road carries — the ordinary case rows 4-7 ask about. */
const at = (domain: string, type: AttributeData['type'] = 'int'): AttributeData => ({
  domain,
  type,
  count: 1,
  data: new Int32Array(1),
});

describe('the per-class carriage census', () => {
  it('1 — every known atom class has a verdict, and the table declares no others', () => {
    expect(Object.keys(CLASS_CARRIAGE).sort()).toEqual([...KNOWN_DOMAINS].sort());
  });

  it('2 — 🔴 THE DECLARED DROP IS EXACTLY THIS ONE', () => {
    // Sorted, and a literal. It said `['edge', 'point']` and predicted its own move: *"when
    // #716 gives `point` a real order this row reds, and the fix is to delete the member
    // here"*. It took #716 AND #754 — the weld gave `point` a stable element to gather TO, and
    // the composition gave it an ORDER to gather THROUGH — but the mechanism is exactly as
    // written: the population shrank by an edit somebody made on purpose, never by a table
    // quietly answering differently. `edge` is now the only one, and #718 is what removes it.
    const dropped = Object.entries(CLASS_CARRIAGE)
      .filter(([, v]) => v.kind === 'dropped')
      .map(([domain]) => domain)
      .sort();
    expect(dropped).toEqual(['edge']);
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
    const { faces, corners, points } = tilingOfArrayedBox();
    const face = carriageForDomain(at('face'), 'array', faces, corners, points);
    const corner = carriageForDomain(at('corner'), 'array', faces, corners, points);
    const point = carriageForDomain(at('point'), 'array', faces, corners, points);

    expect(face.kind).toBe('laid-out');
    expect(corner.kind).toBe('laid-out');
    expect(point.kind).toBe('laid-out');
    if (face.kind !== 'laid-out' || corner.kind !== 'laid-out' || point.kind !== 'laid-out') return;

    // #717 — the third arm, held to the same identity rule as the other two.
    expect(point.layout.order).toBe(points.order);
    expect(point.layout.sourceElements).toBe(points.sourcePoints);
    expect(point.layout.noun).toBe('points');
    // ...and its length is a THIRD distinct value, so no two arms can pass by agreeing:
    // 18 faces, 108 corners, 24 points on an Array x3 of a box (#770 — it read 36 / 108 / 24,
    // and the POINT figure is the one that did not move, since points were never counted in
    // triangles).
    expect(points.order.length).toBe(24);

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
    //
    // 🔴 IT IS NOT `faces * 3` SINCE #770, AND THE EXPRESSION THAT REPLACED IT IS THE POINT. A
    // face is a POLYGON, so the corners it owns depend on how many TRIANGLES it materialises
    // to — two per quad on a box. Keeping `faces.order.length * 3` would have asserted 54
    // against a real 108 and read as a corner order half the size it needs to be.
    // Written as the three literals rather than as an expression: `sourceCorners * 3` would
    // be right here only because this array makes three copies, and would read as "three
    // corners per face" — the very relation this phase removed.
    expect(faces.order.length).toBe(18); // 6 source polygons x 3 copies
    expect(corners.order.length).toBe(108); // 12 source triangles x 3 corners x 3 copies
    expect(corners.sourceCorners).toBe(36);
  });

  it('5 — a dropped class resolves to its verdict, and to the SAME object', () => {
    const { faces, corners, points } = tilingOfArrayedBox();
    const edge = carriageForDomain(at('edge'), 'array', faces, corners, points);
    expect(edge.kind).toBe('dropped');
    // Identity, deliberately: the resolver must hand back the table's row rather than rebuild
    // one. A copy would be a second spelling of the reason, free to drift from the table this
    // gate censuses — which is exactly the defect #680 records at the scope param.
    //
    // The subject moved from `point` to `edge` at #717 for the reason row 2 states. The RULE
    // is unchanged, which is why this is the same row rather than a new one.
    expect(edge).toBe(CLASS_CARRIAGE.edge);
  });

  it('6 — 🔴 A FOREIGN DOMAIN IS NOT A DROP. They were one `null` and are now two values', () => {
    const { faces, corners, points } = tilingOfArrayedBox();
    const foreign = carriageForDomain(
      at('zz_domain_from_a_later_build'),
      'array',
      faces,
      corners,
      points,
    );

    expect(foreign.kind).toBe('foreign');
    // The row that carries the whole distinction: before #715 both of these were `null`, and
    // the function's doc had to spend a paragraph saying the two `null`s meant different
    // things — the shape of a type nobody had written. A drop is a decision THIS build took
    // about a class it knows; foreign is a class it has never heard of, which must round-trip
    // untouched because domains are data. Collapsed, a census of "what do we drop?" would
    // answer with somebody else's domain.
    expect(foreign.kind).not.toBe('dropped');
    expect(carriageForDomain(at('edge'), 'array', faces, corners, points).kind).toBe('dropped');
  });

  it('7 — neither answer tiles: foreign and dropped both stay off the layout road', () => {
    // The distinction in row 6 is about what we can SAY, not about what ships. Both classes
    // are still absent from the merged geometry, which is the pre-#694 behaviour deliberately
    // kept — refusing loudly would be a behaviour change for sources that exist today,
    // smuggled in under a widening. Stated as its own row so a reader cannot take row 6 for a
    // claim that foreign attributes now survive.
    const { faces, corners, points } = tilingOfArrayedBox();
    for (const domain of ['edge', 'zz_domain_from_a_later_build']) {
      expect(carriageForDomain(at(domain), 'array', faces, corners, points).kind, domain).not.toBe(
        'laid-out',
      );
    }
  });

  it('8 — 🔴 #717 A REFUSAL IS NOT A DROP: same fields, different question, and it is TYPE-keyed', () => {
    // The distinction this arm exists to draw. A DROP is about a CLASS and is true for every
    // operator: nothing lays out an edge, whoever is asking. A REFUSAL is about a (datum,
    // operator) PAIR — a `float3` rides an Array untouched and would leave a Mirror
    // unreflected, because `AttributeType` is a storage width and not a transform type (#723).
    //
    // Collapsing them would make a census of "what do we drop?" answer with a reflection
    // problem, and would make the refusal vanish the day its class starts tiling — which is
    // exactly what just happened to `point`.
    const { faces, corners, points } = tilingOfArrayedBox();
    const through = (kind: 'array' | 'mirror' | 'subset', domain: string, type: 'int' | 'float3') =>
      carriageForDomain(at(domain, type), kind, faces, corners, points).kind;

    // AT EVERY DOMAIN THIS ROAD LAYS OUT, because the reason has nothing to do with the class.
    for (const domain of ['point', 'face', 'corner']) {
      expect(through('mirror', domain, 'float3'), `mirror float3 ${domain}`).toBe('refused');
      // ...and the SAME datum travels fine through the operators that cannot corrupt it.
      // Measured, not assumed: an Array copy preserves position differences exactly at every
      // offset (identity linear part) while the Mirror's negates x.
      expect(through('array', domain, 'float3'), `array float3 ${domain}`).toBe('laid-out');
      expect(through('subset', domain, 'float3'), `subset float3 ${domain}`).toBe('laid-out');
      // ...and a non-direction type is untouched by any of them.
      expect(through('mirror', domain, 'int'), `mirror int ${domain}`).toBe('laid-out');
    }

    // `float2` is deliberately NOT refused, and this row is what stops a later tidy-up
    // "completing" the table with it. Blender's Mirror offers Flip UV as an OPTION rather than
    // a fix, so carrying UVs unflipped is a legitimate default in the reference — and #694
    // already ships corner UVs through a Mirror, so refusing would regress shipped behaviour.
    expect(carriageForDomain(at('corner', 'float2'), 'mirror', faces, corners, points).kind).toBe(
      'laid-out',
    );

    // A refusal carries the same two fields a drop does — a reason someone can act on, and the
    // issue that ends it — for the reason row 3 gives about drops.
    const refusal = carriageForDomain(at('point', 'float3'), 'mirror', faces, corners, points);
    if (refusal.kind !== 'refused') throw new Error('unreachable — asserted above');
    expect(refusal.why.length).toBeGreaterThan(20);
    expect(refusal.until).toMatch(/^#\d+$/);
  });
  it("9 — 🔴 #717 EXACTLY ONE TYPE IS REFUSED, AND THE WARNING'S SHAPE RESTS ON THAT", () => {
    // A TRIPWIRE, NOT A DESCRIPTION. `mintTiledModifierAttributes` names EVERY refused
    // attribute in one warning and then takes the `why` and the `until` from `refused[0]`.
    // That is correct for exactly as long as every refusal shares one reason — true while the
    // refused set holds a single type, and false the moment a second joins it, at which point
    // the message lists an attribute of one type beside a reason interpolated for another.
    //
    // Which is the defect #717 has already fixed once, one field over: the misfit message used
    // to print a global `N faces / M corners` pair instead of the denominator the check
    // actually applied, and a point misfit named two numbers that had nothing to do with it.
    // Same shape, same file, a different field — so it is worth catching before it ships
    // rather than after someone reads a reason that belongs to a different datum.
    //
    // ⚠️ THE FIX IS DEFERRED ON PURPOSE, AND THIS ROW IS THE DEFERRAL. A per-datum message
    // could be written today, but nothing could exercise it — there is no second refused type
    // — and an arm nobody has ever run reads as "no objection" forever, which is the argument
    // this file's own row 3 makes about declared drops. So the decision waits for a test that
    // reds when it becomes takeable: add a type to `REFLECTION_REFUSES` and this row fails,
    // naming what the warning must do before that addition can ship.
    //
    // Censused over the CLOSED type list rather than asserted type by type, so a new member of
    // `ATTRIBUTE_TYPES` is examined without an edit here. A type added and NOT refused leaves
    // this row green, correctly — the message only breaks when the refused SET grows.
    const { faces, corners, points } = tilingOfArrayedBox();
    const refused = ATTRIBUTE_TYPES.filter(
      (type) =>
        carriageForDomain(at('point', type), 'mirror', faces, corners, points).kind === 'refused',
    );
    expect(
      refused,
      'a second refused type means the refusal warning can no longer take one `why` from ' +
        '`refused[0]` — give each refused attribute its own reason in `meshAttributes.ts` ' +
        'before widening this set',
    ).toEqual(['float3']);
  });
});
