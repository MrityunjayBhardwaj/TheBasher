// #755 — an array's copy count has ONE reading, and the builder shares it with both arithmetics.
//
// ── WHAT THIS GATE IS FOR ────────────────────────────────────────────────────────────────
//
// The divergence this closes was never reachable through `arrayGeometryRef`, which clamps on the
// way in. It was reachable through the TYPE: `GeometryDescriptor`'s array variant declares
// `readonly count: number`, and `number` includes 2.7, 0 and NaN. So every row here builds the
// descriptor PAST the constructor — that is the door, and a gate that went through the factory
// would be testing the clamp instead of the thing the clamp was hiding.
//
// Two failure modes are pinned, and they are different in kind:
//   a fractional count built one copy MORE than the arithmetic derived — a silent wrong
//   geometry, with `faceCountMismatch` then blaming the build; and
//   0 / negative / NaN built NO copies, so `mergeGeometries` THREW out of three.
import { describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import { arrayCopiesOf } from './arrayCopies';
import { sphereGeometryRef, boxGeometryRef, arrayGeometryRef } from './modifierGeometry';
import { faceCountOf } from './faceCount';
import { pointCountOf } from './pointIdentity';
import { getForRead } from './geometryRegistry';

const sphere = sphereGeometryRef(1, 8, 6, null);
const box = boxGeometryRef([1, 1, 1], null);

/** An array descriptor built past `arrayGeometryRef`'s clamp — the door the type leaves open. */
function rawArray(source: GeometryRef, count: number): GeometryRef {
  return {
    key: `gate-755|${source.key}|${String(count)}|2,0,0`,
    descriptor: { kind: 'array' as const, source, count, offset: [2, 0, 0] as const },
  } as unknown as GeometryRef;
}

/** Copies the BUILDER actually emitted, read off the merged position buffer. */
function builtCopies(source: GeometryRef, ref: GeometryRef): number {
  const src = getForRead(source);
  const built = getForRead(ref);
  if (src === null || built === null) throw new Error('gate-755: a geometry failed to build');
  return built.getAttribute('position').count / src.getAttribute('position').count;
}

// Every value the field's type admits that the constructor would have clamped, plus the
// integers either side, so a rule that only handled fractions would still red.
const COUNTS = [1, 2, 2.7, 3, 3.9, 0.5, 0, -1, -2.5, Number.NaN, Number.POSITIVE_INFINITY];

describe('#755 — one reading of an array copy count', () => {
  it('1 — arrayCopiesOf is total: a whole number >= 1 for every input the type admits', () => {
    for (const count of COUNTS) {
      const n = arrayCopiesOf(count);
      expect(Number.isInteger(n), `arrayCopiesOf(${String(count)}) = ${n} is not an integer`).toBe(
        true,
      );
      expect(
        n,
        `arrayCopiesOf(${String(count)}) = ${n} is below the preserved input`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('2 — the BUILDER emits exactly what arrayCopiesOf says, for every admitted count', () => {
    for (const count of COUNTS.filter((c) => Number.isFinite(c))) {
      const ref = rawArray(sphere, count);
      expect(
        builtCopies(sphere, ref),
        `count=${String(count)}: builder disagrees with the rule`,
      ).toBe(arrayCopiesOf(count));
    }
  });

  it('3 — the FACE arithmetic derives the same number of copies as the builder emits', () => {
    const sourceFaces = faceCountOf(sphere.descriptor) as number;
    for (const count of COUNTS.filter((c) => Number.isFinite(c))) {
      const ref = rawArray(sphere, count);
      const derived = (faceCountOf(ref.descriptor) as number) / sourceFaces;
      expect(derived, `count=${String(count)}: face arithmetic vs builder`).toBe(
        builtCopies(sphere, ref),
      );
    }
  });

  it('4 — the POINT arithmetic derives the same number of copies as the face arithmetic', () => {
    const sourceFaces = faceCountOf(box.descriptor) as number;
    const sourcePoints = (pointCountOf(box.descriptor) as { count: number }).count;
    for (const count of COUNTS.filter((c) => Number.isFinite(c))) {
      const ref = rawArray(box, count);
      const byFaces = (faceCountOf(ref.descriptor) as number) / sourceFaces;
      const byPoints = (pointCountOf(ref.descriptor) as { count: number }).count / sourcePoints;
      expect(byPoints, `count=${String(count)}: point arithmetic vs face arithmetic`).toBe(byFaces);
    }
  });

  it('5 — a count of 0, negative or NaN builds the identity array rather than throwing', () => {
    // The sharper half, and it is not in the issue's report: before the shared reading these
    // produced an EMPTY copy list and `mergeGeometries` threw `Cannot read properties of
    // undefined (reading 'index')` from inside three, several frames below the descriptor.
    for (const count of [0, -1, Number.NaN]) {
      expect(
        () => builtCopies(sphere, rawArray(sphere, count)),
        `count=${String(count)}`,
      ).not.toThrow();
      expect(builtCopies(sphere, rawArray(sphere, count)), `count=${String(count)}`).toBe(1);
    }
  });

  it('6 — arrays through the constructor are unchanged: integers still mean themselves', () => {
    // The behaviour-preserving half. Every array in production goes through this door, so if
    // any integer moved, this change would be a regression wearing a fix's clothes.
    for (const count of [1, 2, 3, 5]) {
      const ref = arrayGeometryRef(sphere, count, [2, 0, 0]);
      expect(builtCopies(sphere, ref), `arrayGeometryRef count=${count}`).toBe(count);
      expect((ref.descriptor as { count: number }).count, `descriptor count=${count}`).toBe(count);
    }
  });
});
