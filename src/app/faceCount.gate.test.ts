// #633 (ns-1) — `faceCountOf` agrees with what the geometry actually tessellates to.
//
// The count is derived from the descriptor because the mint happens inside a node's
// `evaluate()`, which is pure and synchronous and must not build a `BufferGeometry`. That
// makes it a SECOND SPELLING of three.js's tessellation, and a second spelling that agrees
// today passes every behavioural test until the day it stops agreeing — at which point a
// face-domain attribute is silently the wrong length for its geometry.
//
// So this gate does the one thing that closes it: builds each sync-buildable descriptor
// through the registry and compares the built triangle count with the derived one. Included
// deliberately are the CLAMP edges, where three.js raises a sphere's segments to its own
// minimum without saying so — the arm most likely to drift, and the one a well-chosen
// "typical" fixture would never exercise.
//
// The two non-derivable kinds are censused exactly rather than left implicit: an escape
// hatch that is not counted is an escape hatch that widens.
//
// REF: src/app/faceCount.ts (`faceCountOf` — the leaf it now lives in);
//      src/app/geometryRegistry.ts (the build); issues #633, #395, #638.

import { describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { faceArityOf, faceCountOf } from './faceCount';
import { getForRead } from './geometryRegistry';

/**
 * Triangles in the BUILT geometry — the ground truth this gate compares against.
 *
 * ⚠️ #770 SPLIT WHAT THIS IS COMPARED WITH, and the name changed because the comparison did.
 * It used to be checked against `faceCountOf` directly, because a face WAS a triangle. A face
 * is a polygon now, so this is what the faces MATERIALISE to — `sum(faceArityOf)` — and the
 * face count is a second, separate comparison.
 */
function builtTriangleCount(ref: GeometryRef): number {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  const index = geom!.getIndex();
  return index ? index.count / 3 : geom!.getAttribute('position').count / 3;
}

const box = boxGeometryRef([1, 1, 1], null);

const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4], null),
  sphereGeometryRef(1, 32, 16, null),
  sphereGeometryRef(1, 8, 4, null),
  // Clamp edges: three.js raises width to 3 and height to 2 without reporting it.
  sphereGeometryRef(1, 1, 1, null),
  sphereGeometryRef(0.5, 3, 2, null),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphereGeometryRef(1, 8, 4, null), 2, [0, 2, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0),
  // ── ns-2 step 12.5 — ROW 1. The scoped descriptors join the SAME list, deliberately:
  // there is one parity gate, and a second one beside it would be a second spelling of the
  // same claim. A scoped generator preserves its whole input and generates from the subset
  // (plan §2.2), so the derived count and the built index have to agree here exactly as
  // they do above — including where the subset is empty, is everything, or is stepped.
  //
  // 🔴 READ THIS ROW WITH ITS PAIR. Parity detects DISAGREEMENT, which is what happens when
  // exactly one of `faceCountOf` and the builder honours the field. It is green when NEITHER
  // does — measured on the pre-work tree, where all four of these collapsed to their
  // unscoped twins and this gate passed 14/14. The row that catches the correlated omission
  // is `scopedGeneratorBuild.gate.test.ts`'s literal `24`, and neither row is the detector
  // without the other.
  //
  // 🔴 THE SCOPE STRINGS WERE RE-PICKED AT #770, BECAUSE THE SAME STRING NAMES A DIFFERENT SET
  // NOW — and two of these would otherwise have gone quietly degenerate. A box had 12 faces and
  // has 6, so `'0-5'` selected HALF of one and selects ALL of the other, and `'!0-11'` is the
  // complement of everything either way. A scoped row whose subset is everything or nothing
  // collapses to its unscoped twin: this gate stays green while checking strictly less, which
  // is the exact failure its own pair-of-rows warning above describes.
  //
  // Each row now names a PROPER, non-empty subset at polygon granularity.
  arrayGeometryRef(box, 3, [2, 0, 0], '0-2'),
  arrayGeometryRef(box, 3, [2, 0, 0], '!0-1'),
  arrayGeometryRef(sphereGeometryRef(1, 8, 4, null), 2, [0, 2, 0], '0-23:2'),
  mirrorGeometryRef(box, 'x', 1, '1-3'),
  mirrorGeometryRef(sphereGeometryRef(1, 8, 4, null), 'z', 0, '4-30'),
];

describe('#633 faceCountOf agrees with the built geometry', () => {
  // 🔴 #770 MADE THIS TWO CLAIMS, AND EITHER ONE ALONE PASSES ON A HALF-DONE FLIP.
  //
  // While a face was a triangle there was one number and one comparison. A face is a POLYGON
  // now, so there are two descriptor-side spellings to keep honest against three.js AND
  // against each other:
  //
  //   faceCountOf(d)        how many faces — arithmetic, allocation-free, on the drag road
  //   sum(faceArityOf(d))   what they materialise to — an array, on the build road
  //
  // `faceCountOf` deliberately does NOT call `faceArityOf` (the reason is in that function's
  // block: it runs per operator per evaluate and must not allocate), so the two are a second
  // spelling of each other on top of both being a second spelling of the tessellation. All
  // three are pinned here rather than any one being trusted.
  it.each(SYNC_BUILDABLE.map((ref) => [ref.key, ref] as const))(
    'derives the built triangle count for %s',
    (_key, ref) => {
      const arity = faceArityOf(ref.descriptor);
      expect(arity, `no arity for ${ref.key}`).not.toBeNull();
      // 1 — the two descriptor-side spellings agree on how many faces there are.
      expect(arity!.length, `${ref.key}: faces`).toBe(faceCountOf(ref.descriptor));
      // 2 — and what those faces materialise to is what three.js actually built.
      expect(
        arity!.reduce((a, b) => a + b, 0),
        `${ref.key}: triangles`,
      ).toBe(builtTriangleCount(ref));
    },
  );

  it('a MIXED-ARITY source is where a constant would pass every row above and still be wrong', () => {
    // The rows above compare TOTALS, and a total cannot see a per-face mistake that sums
    // correctly. On a box it could not anyway — every polygon is a quad, so a constant 2 is
    // right there. A sphere is where the two separate: its pole rows are triangles.
    const sphere = sphereGeometryRef(1, 8, 6, null);
    const arity = faceArityOf(sphere.descriptor)!;
    expect(arity).toHaveLength(48);
    // The SHAPE, not the total. A constant 2 gives 96 triangles against the real 80 and a
    // constant 1 gives 48, so the total catches both; what only the shape catches is the right
    // total in the wrong places.
    expect(arity.filter((a) => a === 1)).toHaveLength(16);
    expect(arity.filter((a) => a === 2)).toHaveLength(32);
    expect(arity.slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(arity.slice(8, 16)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(arity.slice(40)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(arity.reduce((a, b) => a + b, 0)).toBe(builtTriangleCount(sphere));
  });

  it('the arity COMPOSES through the derived arms, which is what made the flip one commit', () => {
    // `polygonLayoutOf` refuses these kinds — a rim cannot be stated in a merged geometry's
    // vertex numbering without a split vertex count (#777). An arity carries no vertex
    // numbering, so it rides the same face order a per-face attribute is gathered through.
    // Asserted against the BUILT buffer rather than against the composition rule, because a
    // rule and a restatement of it agree for any consistently wrong rule.
    const source = sphereGeometryRef(1, 8, 6, null);
    const mirrored = mirrorGeometryRef(source, 'x', 0);
    const arity = faceArityOf(mirrored.descriptor)!;
    expect(arity).toHaveLength(96);
    // The whole source, then the reflection — so the mixed-arity shape appears TWICE, and a
    // composition that flattened the source's shape would still total correctly.
    expect(arity.filter((a) => a === 1)).toHaveLength(32);
    expect(arity.slice(0, 48)).toEqual(faceArityOf(source.descriptor));
    expect(arity.slice(48)).toEqual(faceArityOf(source.descriptor));
    expect(arity.reduce((a, b) => a + b, 0) * 3).toBe(getForRead(mirrored)!.getIndex()!.count);
  });

  it('counts the not-derivable kinds EXACTLY', () => {
    const notDerivable = (
      [
        { kind: 'gltf', assetRef: 'asset', childName: 'child' },
        { kind: 'baked', hash: 'deadbeef', vertexCount: 24 },
      ] as const
    ).filter((descriptor) => faceCountOf(descriptor) === null);

    expect(notDerivable.map((d) => d.kind)).toEqual(['gltf', 'baked']);
    // #770 — AND THE ARITY DECLINES ON THE SAME TWO KINDS, WHICH IS THE WHOLE ESCAPE HATCH.
    // Per-triangle material assignment became unconstructible in this app at #770; where it
    // survives is here, and it survives because these two never reach the group derivation at
    // all — the registry refuses by name when the arity is null, so an imported mesh keeps
    // whatever ranges its loader built. A third kind answering `null` would be a third road on
    // which groups are silently not derived, so the census is on the SET, never on a count.
    for (const d of notDerivable) expect(faceArityOf(d), d.kind).toBeNull();
  });

  it('propagates non-derivability through a modifier rather than guessing', () => {
    const gltf: GeometryRef = {
      key: 'gltf|asset|child',
      descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
    };
    expect(faceCountOf(arrayGeometryRef(gltf, 3, [1, 0, 0]).descriptor)).toBeNull();
    expect(faceCountOf(mirrorGeometryRef(gltf, 'x', 0).descriptor)).toBeNull();
    // The arity propagates the same way, and this is not decoration: the registry declines to
    // lay out groups when it is null, so an arity that guessed where the count declined would
    // put a layout on a mesh whose triangles nothing here has counted.
    expect(faceArityOf(arrayGeometryRef(gltf, 3, [1, 0, 0]).descriptor)).toBeNull();
    expect(faceArityOf(mirrorGeometryRef(gltf, 'x', 0).descriptor)).toBeNull();
  });
});
