// #716 (P2) — the standing gate for topological point identity.
//
// Every row below was falsified by an inverse edit before it was kept; what each one reds on
// is written beside it, because a row that has never failed is a description of the code, not
// a check on it.
//
// REF: src/app/pointIdentity.ts (the subject); src/app/geometryRegistry.ts (the parity call);
//      issues #716, #717, #736.
import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pointCountMismatch, pointCountOf, weldByPosition } from './pointIdentity';
import {
  arrayGeometryRef,
  boxDescriptor,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereDescriptor,
  subsetGeometryRef,
} from './modifierGeometry';
import { getForRead } from './geometryRegistry';

/** Built through the production door, so these rows observe what the app builds. */
function built(ref: ReturnType<typeof boxGeometryRef>): BufferGeometry {
  const g = getForRead(ref);
  if (g === null) throw new Error('fixture: the registry declined to build this ref');
  return g;
}

describe('#716 the weld — a position has one identity regardless of its split copies', () => {
  it('welds a box from 24 split positions to 8 topological points', () => {
    // The phase's headline. Reds if the weld ever compares more than the position.
    const box = built(boxGeometryRef([1, 1, 1], null));
    expect(box.getAttribute('position').count).toBe(24);
    expect(weldByPosition(box).points).toBe(8);
  });

  it('🔴 is NOT `mergeVertices`, and this row is why the distinction survives a refactor', () => {
    // `mergeVertices` compares the WHOLE vertex, so it welds a box 24 -> 24 and answers a
    // different question. Anyone "simplifying" `weldByPosition` into it reds here, with the
    // two numbers side by side rather than a vague failure downstream.
    const box = new BoxGeometry(1, 1, 1);
    expect(mergeVertices(box.clone()).getAttribute('position').count).toBe(24);
    expect(weldByPosition(box).points).toBe(8);
  });

  it('produces a well-formed map: total, onto, and stable across calls', () => {
    const sphere = new SphereGeometry(1, 8, 6);
    const { map, points } = weldByPosition(sphere);

    expect(map.length).toBe(sphere.getAttribute('position').count);
    // Every split position lands on a real point, and every point is landed on. Reds if the
    // id counter and the map ever disagree — the shape a partial rewrite produces.
    const used = new Set<number>();
    for (const id of map) {
      expect(id).toBeLessThan(points);
      used.add(id);
    }
    expect(used.size).toBe(points);

    // Deterministic: same geometry, same answer. (Also the memo — same object back.)
    expect(weldByPosition(sphere)).toBe(weldByPosition(sphere));
    expect(Array.from(weldByPosition(new SphereGeometry(1, 8, 6)).map)).toEqual(Array.from(map));
  });
});

describe('#716 the arithmetic — and the parity that keeps it honest', () => {
  it('agrees with a real weld for a box at every size', () => {
    for (const s of [1, 0.001, 7.5, 1000] as const) {
      const ref = boxGeometryRef([s, s * 2, s * 3], null);
      expect(pointCountOf(ref.descriptor)).toBe(weldByPosition(built(ref)).points);
    }
  });

  it('agrees with a real weld for a sphere across the range AND at the clamp edges', () => {
    // The clamp edges are the half that matters: three.js raises the segments to its own
    // minimum before tessellating, so a second spelling that skipped the clamp would be right
    // everywhere a human tests by hand and wrong exactly where nobody looks.
    const cases: readonly (readonly [number, number])[] = [
      [3, 2],
      [4, 2],
      [5, 3],
      [8, 6],
      [16, 16],
      [32, 16],
      [64, 32],
      [9, 2],
      [33, 17],
      [1, 1],
      [2, 1],
      [0, 0],
      [3.7, 2.9],
    ];
    const disagreements: string[] = [];
    for (const [w, h] of cases) {
      const derived = pointCountOf(sphereDescriptor(1, w, h));
      const welded = weldByPosition(new SphereGeometry(1, w, h)).points;
      if (derived !== welded)
        disagreements.push(`sphere ${w}x${h}: derived ${derived}, welded ${welded}`);
    }
    expect(disagreements).toEqual([]);
  });

  it('a box is 8 and a sphere 8x6 is 42 — pinned, so a formula that merely self-agrees reds', () => {
    // The two rows above compare the arithmetic to the weld. Both could drift together if the
    // weld's tolerance changed. These are the absolute anchors.
    expect(pointCountOf(boxDescriptor([1, 1, 1]))).toBe(8);
    expect(pointCountOf(sphereDescriptor(1, 8, 6))).toBe(42);
  });
});

describe('#716 the refusals — and the measurement that earns them', () => {
  it('the three derived kinds decline, because a welded count is not combinatorial', () => {
    const box = boxGeometryRef([1, 1, 1], null);
    expect(pointCountOf(arrayGeometryRef(box, 3, [2, 0, 0]).descriptor)).toBeNull();
    expect(pointCountOf(mirrorGeometryRef(box, 'x', 2).descriptor)).toBeNull();
    expect(pointCountOf(subsetGeometryRef(box, '0-5', true).descriptor)).toBeNull();
  });

  it('🔴 and the refusal is MEASURED, not cautious: an array welds differently per offset', () => {
    // This row is what stops a later phase "completing" `pointCountOf` with a `source x count`
    // arm. The plan asserted the weld composes for Array and re-walks only for Mirror; it does
    // not. Same descriptor kind, same count, four offsets, four different answers.
    const box = boxGeometryRef([1, 1, 1], null);
    const welded = ([2, 1, 0.5, 0] as const).map(
      (dx) => weldByPosition(built(arrayGeometryRef(box, 3, [dx, 0, 0]))).points,
    );
    expect(welded).toEqual([24, 16, 20, 8]);
    // 3 x 8 = 24 is right at one end of the offset range and wrong by 3x at the other.
    expect(new Set(welded).size).toBe(4);
  });

  it('gltf and baked decline for the reason faces already decline', () => {
    expect(pointCountOf({ kind: 'gltf', assetRef: 'a', childName: 'c' })).toBeNull();
    expect(pointCountOf({ kind: 'baked', hash: 'h', vertexCount: 24 })).toBeNull();
  });
});

describe('#716 the parity check can construct its own failure', () => {
  it('reds when the descriptor and the geometry disagree', () => {
    // A guard that cannot be made to fire is a description. This pairs a box descriptor with a
    // sphere's geometry, which is the disagreement the production call exists to catch.
    const sphere = new SphereGeometry(1, 8, 6);
    const message = pointCountMismatch(boxDescriptor([1, 1, 1]), sphere);
    expect(message).not.toBeNull();
    expect(message).toContain('derives 8');
    expect(message).toContain('welds to 42');
  });

  it('says nothing when they agree, and nothing when the descriptor declines', () => {
    const box = built(boxGeometryRef([1, 1, 1], null));
    expect(pointCountMismatch(boxDescriptor([1, 1, 1]), box)).toBeNull();
    // A refusal is not a disagreement — the same rule `faceCountMismatch` holds.
    const arrayed = arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 3, [2, 0, 0]);
    expect(pointCountMismatch(arrayed.descriptor, built(arrayed))).toBeNull();
  });
});
