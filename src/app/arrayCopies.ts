// arrayCopies — the ONE statement of how many copies an array descriptor means (#755).
//
// ── WHY THIS IS ITS OWN MODULE, WHICH IS OTHERWISE THE WRONG SHAPE FOR ONE FUNCTION ──────
//
// A module holding a single function is normally a function. This one earns the file for a
// reason that is about the import graph rather than about size: FOUR modules need this answer —
// the constructor (`modifierGeometry.ts`), the builder (`geometryRegistry.ts`), and both
// arithmetics (`faceCount.ts`, `pointIdentity.ts`) — and they sit on opposite sides of the
// `faceCount -> bevelLayout -> edgeIdentity -> faceCount` cycle that `importCycles.gate.test.ts`
// polices. Homing the rule in any one of them adds an edge between two of the others. A leaf
// that imports NOTHING can be read by all four and closes no loop.
//
// ── WHAT WENT WRONG WITHOUT IT ───────────────────────────────────────────────────────────
//
// The same quantity was spelled four times: `Math.max(1, Math.floor(count))` at the constructor,
// the same expression `- 1` in `faceTilingOf`, the same expression again in `pointTilingOf`, and
// — the one that diverged — a bare `i < d.count` in `buildArray`. Three agreed and the fourth
// did not, so the divergence was held shut by the constructor clamping on the way in rather than
// by anything structural. `GeometryDescriptor`'s array variant declares `readonly count: number`,
// and `number` includes 2.7, 0 and NaN.
//
// Measured on a raw descriptor built past the constructor, over sphere(1, 8, 6):
//
//   count 2.7 -> the builder emitted 3 copies (189 split positions) while the arithmetic
//                derived 2 (96 faces). `faceCountMismatch` would then warn about a geometry
//                that is not wrong — the two sides read one field two ways.
//   count 3.9 -> 4 against 3, the same shape.
//   count 0, -1, NaN -> the builder produced NO copies at all and `mergeGeometries` THREW
//                (`Cannot read properties of undefined (reading 'index')`) from inside three,
//                while the arithmetic answered 1. That crash is not in the issue's report and
//                is the sharper half: a disagreement is a wrong number, this is an exception
//                out of a build.
//
// REF: src/app/modifierGeometry.ts (`arrayGeometryRef` — the door that was holding it shut);
//      src/app/geometryRegistry.ts (`buildArray` — the reading that diverged);
//      src/app/faceCount.ts (`faceTilingOf`); src/app/pointIdentity.ts (`pointTilingOf`);
//      issue #755.

/**
 * How many copies of its source an `array` descriptor means — the preserved input plus the
 * generated ones, so the smallest answer is 1 and never 0.
 *
 * 🔴 TOTAL OVER `number`, INCLUDING THE VALUES THE FIELD'S TYPE ADMITS AND NOBODY INTENDED.
 * `Math.max(1, Math.floor(x))` is NOT total: `Math.floor(NaN)` is `NaN` and `Math.max(1, NaN)`
 * is `NaN`, so the old spelling propagated it into every count downstream and into a loop bound
 * that then ran zero times. A non-finite count answers 1 here — the identity array — because
 * that is what the `>= 1` clamp already meant for every other unusable value, and because a
 * build that throws out of three is a worse answer than an array of one.
 *
 * This does NOT make a fractional count unconstructible; it makes every reader agree about what
 * one means. Climbing that last rung is a type change on `GeometryDescriptor` — measured at one
 * production construction site and ten test files — and is deliberately not folded in here.
 */
export function arrayCopiesOf(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.floor(count));
}
