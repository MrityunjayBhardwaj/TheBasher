// #716 (P2) — the standing gate for topological point identity.
//
// Every row below was falsified by an inverse edit before it was kept; what each one reds on
// is written beside it, because a row that has never failed is a description of the code, not
// a check on it.
//
// REF: src/app/pointIdentity.ts (the subject); src/app/geometryRegistry.ts (the parity call);
//      issues #716, #754, #744, #717, #712, #736.
import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry, type BufferGeometry } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  composePointWeld,
  pointCountMismatch,
  pointCountOf,
  weldByPosition,
} from './pointIdentity';
import {
  arrayGeometryRef,
  boxDescriptor,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { getForRead } from './geometryRegistry';

/** The verdict shape, so a row asserts a count without spelling the wrapper each time. */
function counted(count: number) {
  return { kind: 'counted', count };
}

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
      expect(pointCountOf(ref.descriptor)).toEqual(counted(weldByPosition(built(ref)).points));
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
      if (derived.kind !== 'counted' || derived.count !== welded)
        disagreements.push(
          `sphere ${w}x${h}: derived ${JSON.stringify(derived)}, welded ${welded}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it('a box is 8 and a sphere 8x6 is 42 — pinned, so a formula that merely self-agrees reds', () => {
    // The two rows above compare the arithmetic to the weld. Both could drift together if the
    // weld's tolerance changed. These are the absolute anchors.
    expect(pointCountOf(boxDescriptor([1, 1, 1]))).toEqual(counted(8));
    expect(pointCountOf(sphereDescriptor(1, 8, 6))).toEqual(counted(42));
  });
});

describe("#754 the composition — a generator's point identity comes from its source", () => {
  it('🔑 an Array x3 of a box is 24 points at EVERY offset, the coincident one included', () => {
    // The headline, and the row the whole issue turns on. The position weld answers
    // 24 / 16 / 20 / 8 across these same four offsets — see the row below, which still holds.
    // Both are true; they answer different questions, and this one is the question "how many
    // points does this geometry have?" actually asks.
    const box = boxGeometryRef([1, 1, 1], null);
    const composed = ([2, 1, 0.5, 0] as const).map((dx) =>
      pointCountOf(arrayGeometryRef(box, 3, [dx, 0, 0]).descriptor),
    );
    expect(composed).toEqual([counted(24), counted(24), counted(24), counted(24)]);
  });

  it('🔴 the position weld still answers differently per offset — and that is why it is not used here', () => {
    // Kept verbatim from #716, where it was the argument for REFUSING. It is now the argument
    // for not asking this instrument the structural question: the numbers did not change, the
    // question did. If a later phase "simplifies" the composed arms into a weld of the merged
    // buffer, this row and the one above red together and print both answers side by side.
    const box = boxGeometryRef([1, 1, 1], null);
    const welded = ([2, 1, 0.5, 0] as const).map(
      (dx) => weldByPosition(built(arrayGeometryRef(box, 3, [dx, 0, 0]))).points,
    );
    expect(welded).toEqual([24, 16, 20, 8]);
    expect(new Set(welded).size).toBe(4);
  });

  it('composes for mirror (2x) and subset (1x), and through a chain', () => {
    const box = boxGeometryRef([1, 1, 1], null);
    const sphere = sphereGeometryRef(1, 8, 6, null);
    const arrayed = arrayGeometryRef(box, 3, [2, 0, 0]);
    expect(pointCountOf(mirrorGeometryRef(box, 'x', 2).descriptor)).toEqual(counted(16));
    expect(pointCountOf(subsetGeometryRef(box, '0-5', true).descriptor)).toEqual(counted(8));
    // A subset merges nothing, so it keeps its source's point set whichever polarity it takes.
    expect(pointCountOf(subsetGeometryRef(box, '0-5', false).descriptor)).toEqual(counted(8));
    expect(pointCountOf(arrayGeometryRef(sphere, 3, [4, 0, 0]).descriptor)).toEqual(counted(126));
    // Chains: the composition is recursive, so a mirror of an array is 2 x (3 x 8).
    expect(pointCountOf(mirrorGeometryRef(arrayed, 'x', 9).descriptor)).toEqual(counted(48));
    expect(pointCountOf(arrayGeometryRef(arrayed, 2, [20, 0, 0]).descriptor)).toEqual(counted(48));
    expect(
      pointCountOf(arrayGeometryRef(mirrorGeometryRef(box, 'x', 2), 2, [9, 0, 0]).descriptor),
    ).toEqual(counted(32));
  });

  it('🔴 SIX FIGURES PINNED WITH THE ISSUE THAT MOVES THEM — a scope does not change the count, and #712 is why', () => {
    // ⚠️ THIS ROW IS DESIGNED TO RED. The structural rule for a scoped generator is
    // `source + subset x repeats`; these figures are `source x copies` because TODAY the
    // subset's point set IS the source's — a face subset is an index subset over UNCHANGED
    // attribute buffers, so a scoped copy carries every source position and references a
    // fraction of them. That is #712, and the day it compacts, the arithmetic needs the
    // subset's own point count and these numbers move.
    //
    // Pinned WITH that reason so the red explains itself instead of reading as a regression.
    // The INDEX column is the evidence the scope is being honoured at all — it moves while
    // the point count does not, which is the whole tell (a parameter that should have
    // mattered and did not).
    const box = boxGeometryRef([1, 1, 1], null);
    // ⚠️ THE QUERIES MOVED AT #770 AND TWO OF THEM HAD TO. A box has six FACES now, so `'0-5'`
    // names all of them and `'6-11'` names none — the first would have collapsed onto the
    // unscoped row and the second onto the empty one, leaving three distinct index figures
    // where this row needs four. `'0-2'` and `'3-5'` are proper halves at the new count.
    const rows = ([null, '0-2', '0-1', '0', '3-5'] as const).map((scope) => {
      const ref = arrayGeometryRef(box, 3, [2, 0, 0], scope);
      const verdict = pointCountOf(ref.descriptor);
      return {
        scope: scope ?? '(none)',
        points: verdict.kind === 'counted' ? verdict.count : verdict.kind,
        index: built(ref).getIndex()?.count ?? 0,
      };
    });
    expect(rows).toEqual([
      { scope: '(none)', points: 24, index: 108 },
      { scope: '0-2', points: 24, index: 72 },
      { scope: '0-1', points: 24, index: 60 },
      { scope: '0', points: 24, index: 48 },
      { scope: '3-5', points: 24, index: 72 },
    ]);
    // The sixth figure, on the other side of the same defect: a subset of a sphere keeping ONE
    // face still reports its source's 42 points, because it still carries all 63 positions.
    // Face 0 of a sphere is a POLE cell, so it is one triangle — the index below reads 3 both
    // before and after #770, which is a coincidence of the pole row and not a constant.
    const sphere = sphereGeometryRef(1, 8, 6, null);
    const one = subsetGeometryRef(sphere, '0', true);
    expect(pointCountOf(one.descriptor)).toEqual(counted(42));
    expect(built(one).getAttribute('position').count).toBe(63);
    expect(built(one).getIndex()?.count).toBe(3);
  });

  it('🔴 composePointWeld REFUSES a fractional copy count instead of half-filling the map', () => {
    // Falsified by removing the guard: `new Uint32Array(24 * 2.5)` allocates 60 slots, the
    // loop writes 72, and a typed array discards the overflow WITHOUT raising — so the map
    // comes back plausible and a third of it wrong. The silent shape, caught by a throw.
    const source = weldByPosition(built(boxGeometryRef([1, 1, 1], null)));
    expect(() => composePointWeld(source, 2.5)).toThrow('#755');
    expect(() => composePointWeld(source, 0)).toThrow('positive integer');
    expect(() => composePointWeld(source, -1)).toThrow('positive integer');
    // ...and the honest values still work.
    expect(composePointWeld(source, 1).points).toBe(8);
    expect(composePointWeld(source, 4).map.length).toBe(96);
  });

  it('the composed MAP is total and injective — every merged point traces to exactly one source point', () => {
    // #717 gathers through this. Injectivity is what makes "gather" well defined at all: a
    // many-to-one map would mean a point attribute has two candidate values and no rule, which
    // is the decision neither reference system takes silently.
    const box = boxGeometryRef([1, 1, 1], null);
    const source = weldByPosition(built(box));
    for (const dx of [2, 1, 0.5, 0] as const) {
      const merged = built(arrayGeometryRef(box, 3, [dx, 0, 0]));
      const composed = composePointWeld(source, 3);
      // Total: one entry per split position of the merged buffer.
      expect(composed.map.length).toBe(merged.getAttribute('position').count);
      expect(composed.points).toBe(24);
      // Injective source-wise, checked rather than assumed.
      const fanIn = new Map<number, Set<number>>();
      for (let i = 0; i < composed.map.length; i++) {
        const id = composed.map[i];
        if (!fanIn.has(id)) fanIn.set(id, new Set());
        fanIn.get(id)!.add(source.map[i % source.map.length]);
      }
      expect(fanIn.size).toBe(24);
      expect(Math.max(...Array.from(fanIn.values(), (s) => s.size))).toBe(1);
      // ...and the inverse is the arithmetic the doc promises.
      for (const [id, sources] of fanIn) expect(sources).toEqual(new Set([id % source.points]));
    }
  });
});

describe('#744 an absence carries its own reason, and there is now only one kind', () => {
  it('gltf and baked decline, and say why in their own words', () => {
    const gltf = pointCountOf({ kind: 'gltf', assetRef: 'a', childName: 'c' });
    expect(gltf.kind).toBe('outside-the-descriptor');
    expect(gltf.kind === 'outside-the-descriptor' && gltf.why).toContain('asset clone');
    const baked = pointCountOf({ kind: 'baked', hash: 'h', vertexCount: 24 });
    expect(baked.kind).toBe('outside-the-descriptor');
    expect(baked.kind === 'outside-the-descriptor' && baked.why).toContain('OPFS');
  });

  it('a derived kind over one of them PROPAGATES that reason rather than minting its own', () => {
    // The point of carrying the reason on the value: three links down a chain, the message
    // still names the link that actually could not answer.
    const gltfRef = {
      key: 'g',
      descriptor: { kind: 'gltf' as const, assetRef: 'a', childName: 'c' },
    };
    const arrayed = pointCountOf({ kind: 'array', source: gltfRef, count: 3, offset: [2, 0, 0] });
    expect(arrayed).toEqual(pointCountOf(gltfRef.descriptor));
    expect(arrayed.kind === 'outside-the-descriptor' && arrayed.why).toContain("'gltf'");
  });
});

describe('#716 / #754 the parity check can construct its own failure', () => {
  it('reds when a PRIMITIVE descriptor and its geometry disagree', () => {
    // A guard that cannot be made to fire is a description. This pairs a box descriptor with a
    // sphere's geometry, which is the disagreement the production call exists to catch.
    const sphere = new SphereGeometry(1, 8, 6);
    const message = pointCountMismatch(boxDescriptor([1, 1, 1]), sphere, () => null);
    expect(message).not.toBeNull();
    expect(message).toContain('derives 8');
    expect(message).toContain('welds to 42');
  });

  it("🔴 reds for a DERIVED kind when a copy stops carrying its source's whole buffer — and names #712", () => {
    // The self-explaining red. #712 compacts a subset's attributes to the elements its index
    // names, at which point an Array's copies stop being full source buffers and this fires
    // with the issue in the message — instead of the count silently going wrong.
    //
    // Constructed here by handing the parity a source weld half the size of the real one,
    // which is exactly the shape compaction produces.
    const box = boxGeometryRef([1, 1, 1], null);
    const arrayed = arrayGeometryRef(box, 3, [2, 0, 0]);
    const real = weldByPosition(built(box));
    const compacted = { map: real.map.slice(0, 12), points: real.points };
    const message = pointCountMismatch(arrayed.descriptor, built(arrayed), () => compacted);
    expect(message).not.toBeNull();
    expect(message).toContain('#712');
    expect(message).toContain('72'); // what the buffer actually holds
    expect(message).toContain('36'); // what the compacted source would imply
  });

  it('reds when a derived kind is handed NO source weld, rather than skipping the check', () => {
    // A parity check that silently skips is the covered-but-unhonoured grade: it reads as "no
    // objection" forever. `null` is legitimate for a primitive and a defect for a generator.
    const arrayed = arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 3, [2, 0, 0]);
    const message = pointCountMismatch(arrayed.descriptor, built(arrayed), () => null);
    expect(message).not.toBeNull();
    expect(message).toContain('none was supplied');
  });

  it('reds when the source ARITHMETIC and the source GEOMETRY disagree', () => {
    // The second half of a derived kind's parity: the layout can be right while the source's
    // own count is wrong. Handing it a source weld with the right length and the wrong point
    // total is what a drifted primitive arm would look like from one link down.
    const box = boxGeometryRef([1, 1, 1], null);
    const arrayed = arrayGeometryRef(box, 3, [2, 0, 0]);
    const real = weldByPosition(built(box));
    const message = pointCountMismatch(arrayed.descriptor, built(arrayed), () => ({
      map: real.map,
      points: 7,
    }));
    expect(message).not.toBeNull();
    expect(message).toContain('welds to 7');
  });

  it('🔴 never ASKS for the source weld on a path that declines — the laziness is the point', () => {
    // A weld is a walk of a whole position buffer. Passed eagerly, an Array over an imported
    // mesh would weld that mesh on every first build to feed a check that returns null on its
    // first line. Counted rather than asserted in prose, because "it is lazy" is exactly the
    // kind of claim that survives the refactor that stops making it true.
    let asked = 0;
    const supplier = () => {
      asked++;
      return null;
    };
    const box = boxGeometryRef([1, 1, 1], null);
    const gltfRef = {
      key: 'g',
      descriptor: { kind: 'gltf' as const, assetRef: 'a', childName: 'c' },
    };
    // A refusing descriptor, and a GENERATOR standing on one — the case that would have cost
    // the most, since it has a real source geometry to walk.
    expect(pointCountMismatch(gltfRef.descriptor, built(box), supplier)).toBeNull();
    expect(
      pointCountMismatch(
        { kind: 'array', source: gltfRef, count: 3, offset: [2, 0, 0] },
        built(box),
        supplier,
      ),
    ).toBeNull();
    expect(asked).toBe(0);

    // ...and it IS asked when the check actually runs, or the count above proves nothing.
    const arrayed = arrayGeometryRef(box, 3, [2, 0, 0]);
    pointCountMismatch(arrayed.descriptor, built(arrayed), supplier);
    expect(asked).toBe(1);
  });

  it('says nothing when they agree — primitive and derived alike, at every offset', () => {
    const box = boxGeometryRef([1, 1, 1], null);
    expect(pointCountMismatch(boxDescriptor([1, 1, 1]), built(box), () => null)).toBeNull();
    const source = weldByPosition(built(box));
    for (const dx of [2, 1, 0.5, 0] as const) {
      const arrayed = arrayGeometryRef(box, 3, [dx, 0, 0]);
      expect(pointCountMismatch(arrayed.descriptor, built(arrayed), () => source)).toBeNull();
    }
    const mirrored = mirrorGeometryRef(box, 'x', 0);
    expect(pointCountMismatch(mirrored.descriptor, built(mirrored), () => source)).toBeNull();
    // A refusal is not a disagreement — the same rule `faceCountMismatch` holds.
    const gltf = { kind: 'gltf' as const, assetRef: 'a', childName: 'c' };
    expect(pointCountMismatch(gltf, built(box), () => null)).toBeNull();
  });
});
