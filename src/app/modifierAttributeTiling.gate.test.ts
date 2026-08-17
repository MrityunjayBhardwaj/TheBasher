// #644 / #649 — the per-face material index survives the Array and Mirror modifiers.
//
// ── WHY THIS FILE EXISTS AND WHY EVERY ROW IS AN ABSOLUTE LITERAL ──────────────────────
//
// `faceCount.gate.test.ts` holds the PARITY row: the descriptor's derived face count against
// the built geometry's index. That row cannot be the detector for this work, and the reason
// is quoted from `faceCount.ts:91-97` rather than inferred:
//
//   "Parity catches ONE of them drifting; it is green when NEITHER honours the field."
//
// The state this file exists to leave is exactly the state where neither honours it — the
// modifier refs carry no `attributeKey` at all, so `build()` returns before it ever reaches
// `addGroup` and the merged geometry has no layout. Parity is green throughout. So every
// assertion below is a NUMBER, hand-derived from the builders' face order, and every one was
// run BEFORE the change and observed to red ([[H326]] — a gate that passes before the work
// is not a detector).
//
// ── THE FACE ORDER, MEASURED FROM THE BUILDERS RATHER THAN FROM THE ARITHMETIC ─────────
//
// `buildArray` (`geometryRegistry.ts`) makes `copies[0] = source.clone()` — the whole input —
// and `copies[1..n-1] = faceSubset(source, scope)`, which walks `f = 0..faces-1` ASCENDING
// and keeps the ones the mask names. `mergeGeometries` concatenates in copy order. So:
//
//     array:   [ ...source, ...(count - 1) x source.filter(selected) ]
//     mirror:  [ ...source,               ...source.filter(selected) ]
//
// which is `faceCountOf`'s `source + subset * (copies - 1)` and `source + subset`, in the
// same order. Both roads take the subset through `scopeSelection` — the ONE evaluation of a
// query at a length — so the tiling and the builder cannot disagree about which faces those
// are.
//
// 🔴 #644's ISSUE BODY IS WRONG ABOUT MIRROR, AND IT IS WRONG IN THE DIRECTION THAT SHIPS A
// BUG. It says the mirrored half's reversed winding means "a naive concatenation puts the
// right slot on the wrong triangle". Measured: `reverseWinding` swaps `arr[i+1]` with
// `arr[i+2]` WITHIN each triangle. Triangle ORDER is untouched, so a plain concatenation is
// correct and a reversal would be the defect. The row for the mirrored half's slots below is
// what makes that a measurement rather than a reading.
//
// ── SCOPE CHOICE ──────────────────────────────────────────────────────────────────────
//
// The scoped rows use `1-6`, never `0-5`. `0-5` is simultaneously the first three cube sides
// AND the two-material split boundary used here, so a resolver that answered "cube sides" or
// one that answered "the slot-0 faces" would both pass ([[H374]] — four derivations over one
// shared input are not four observations). `1-6` straddles the split, which is what makes the
// mirrored/copied slots discriminating: the subset carries five slot-0 faces and one slot-1
// face, an asymmetry no coincidence reproduces.
//
// ── 🔴 WHAT THIS DOES *NOT* REACH, MEASURED IN A BROWSER AND STATED HERE ───────────────
//
// Every row below is about the GEOMETRY. The layout is genuinely built and it genuinely
// mounts — driven observation of a two-material box with an ArrayModifier spliced in, in the
// running app:
//
//     no modifier   index  36, groups 2, [0,6,→1] [6,30,→0]                 material ARRAY of 2
//     Array x3      index 108, groups 6, [0,6,→1] [6,30,→0] [36,6,→1]
//                                        [42,30,→0] [72,6,→1] [78,30,→0]    material 1, NOT an array
//
// The layout is correct and the renderer IGNORES it, because three.js honours groups only on
// a mesh whose `material` is an array — and `needsMaterialSlots` (`SceneFromDAG.tsx`) reads
// `materialSlots ?? [material]`, while the modifiers drop the slot TABLE. So the picture does
// not change. That is #645's work (the object-level slot table), declared out of scope on
// #644, and it is now the SOLE remaining consumer with the numbers above as its baseline.
//
// This paragraph exists because the opposite is the expensive mistake: a green gate over a
// correctly-derived value that nothing reads is exactly a covered-but-unhonoured grade, which
// gets RELIED ON and has already cost this epic three failed attempts (#367). The collapse is
// still PINNED, in `ArrayModifier.test.ts` — "an Array over a two-slot box emits no table" —
// so #645 will red it rather than discover it, the same handover #638 left for this issue.
//
// REF: src/app/modifierGeometry.ts (the two builders — where the key and the attribute key
//      are minted in one expression); src/app/geometryRegistry.ts (`buildArray`,
//      `buildMirror`, `faceSubset`, `build`); src/app/faceCount.ts (the arithmetic this
//      mirrors); src/nodes/meshAttributes.ts (the minter);
//      src/viewport/SceneFromDAG.tsx (`needsMaterialSlots` — the boundary above);
//      issues #644, #649, #638, #645.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { faceCountOf, tiledFaceOrder } from './faceCount';
import { clear, getForRead } from './geometryRegistry';
import { faceRangeMaterialAttributes, uniformMaterialAttributes } from '../nodes/meshAttributes';
import { insert } from './attributeStore';
import { mintAttributes } from '../nodes/attributeKey';
import { MATERIAL_INDEX, UV_MAP, type AttributeData } from '../nodes/attributes';
import type { GeometryRef } from '../nodes/types';

const BOX_SIZE: [number, number, number] = [1, 1, 1];

/** The bare box descriptor, for the minters that take a descriptor rather than a handle. */
const boxDescriptor = () => boxGeometryRef(BOX_SIZE, null).descriptor;

/**
 * A box whose faces 6..11 are on slot 1 and 0..5 on slot 0 — the two-material source every
 * row below tiles. Anchored on `faceRangeMaterialAttributes`, the untouched #638 producer,
 * so the fixture does not route through any code this file is checking ([[V210]]).
 */
function twoMaterialBox(): GeometryRef {
  const minted = faceRangeMaterialAttributes(boxDescriptor(), 6, 11);
  expect(minted, 'the two-material fixture failed to mint').not.toBeNull();
  insert(minted!.key, minted!.set, 'evaluate');
  return boxGeometryRef(BOX_SIZE, minted!.key);
}

/** A box with every face on slot 0 — the control for "an unattributed mesh grows no groups". */
function oneMaterialBox(): GeometryRef {
  const minted = uniformMaterialAttributes(boxDescriptor());
  expect(minted, 'the one-material fixture failed to mint').not.toBeNull();
  insert(minted!.key, minted!.set, 'evaluate');
  return boxGeometryRef(BOX_SIZE, minted!.key);
}

function built(ref: GeometryRef) {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  return geom!;
}

/** `[start, count, materialIndex]` per group — the layout as three plain numbers. */
function layoutOf(ref: GeometryRef): number[][] {
  return built(ref).groups.map((g) => {
    // three.js types `materialIndex` as OPTIONAL, and the assertion is kept rather than cast
    // away: a group written without a slot falls back to the default material, which draws
    // something plausible and is exactly the class of quiet wrongness this file exists to
    // catch. Every group the registry writes passes one, so this only ever fires on a defect.
    expect(g.materialIndex, `a group in ${ref.key} was written with no material slot`).not.toBe(
      undefined,
    );
    return [g.start, g.count, g.materialIndex as number];
  });
}

function builtIndexCount(ref: GeometryRef): number {
  const index = built(ref).getIndex();
  expect(index, `${ref.key} built without an index`).not.toBeNull();
  return index!.count;
}

beforeEach(() => {
  clear();
});

describe('#644 — ARRAY tiles the source assignment across its copies', () => {
  it('🔴 an array x3 over a two-material box lays out SIX groups, alternating 18 index entries', () => {
    // 12 source faces -> 36 (12 + 12 x 2), tiled as [src, src, src]. Each half of the source
    // is 6 faces = 18 index entries, so the runs alternate 0,1,0,1,0,1 at a constant 18.
    // Written as the numbers. Before this change the layout is `[]` — `build()` returns at
    // `ref.attributeKey === undefined` before `addGroup`.
    const ref = arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0]);

    expect(faceCountOf(ref.descriptor)).toBe(36);
    expect(builtIndexCount(ref)).toBe(108);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 18, 0],
      [54, 18, 1],
      [72, 18, 0],
      [90, 18, 1],
    ]);
  });

  it('🔴 a SCOPED array x3 (`1-6`) tiles only the subset, and the subset is 5 slot-0 faces + 1 slot-1', () => {
    // The arm that separates "tiles correctly" from "tiles the whole source regardless of
    // scope". Faces 1..6 of the source are slots [0,0,0,0,0,1], so each generated copy
    // contributes a 15-entry slot-0 run followed by a 3-entry slot-1 run. 12 + 6 x 2 = 24
    // faces. A tiling that ignored scope would produce the unscoped six-group layout above
    // and a 108-entry index; a tiling that took the subset for copy 0 too would produce 18.
    const ref = arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0], '1-6');

    expect(faceCountOf(ref.descriptor)).toBe(24);
    expect(builtIndexCount(ref)).toBe(72);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 15, 0],
      [51, 3, 1],
      [54, 15, 0],
      [69, 3, 1],
    ]);
  });

  it('🔴 a one-material source through an array grows exactly ONE group, not six and not zero', () => {
    // The no-spurious-groups row. A uniform index is a single run, so the layout is one group
    // covering everything. It is not `[]`: `[]` is what a mesh with a DROPPED layout looks
    // like, and telling those two apart is the whole point of #638's road.
    const ref = arrayGeometryRef(oneMaterialBox(), 3, [2, 0, 0]);

    expect(layoutOf(ref)).toEqual([[0, 108, 0]]);
  });
});

describe('#644 — MIRROR tiles the source assignment onto the reflected half', () => {
  it('🔴 a mirror over a two-material box lays out FOUR groups — and the reflected half keeps its slots', () => {
    // 12 + 12 = 24 faces, tiled as [src, src]. This is the row that measures the winding
    // claim: `reverseWinding` swaps vertices inside a triangle and leaves triangle order
    // alone, so the reflected half's slots are the source's in the SAME order. A
    // concatenation reversed to "correct for winding" would put [1,1,1,1,1,1] first in the
    // second half and produce [[0,18,0],[18,18,1],[36,18,1],[54,18,0]] — three groups after
    // the runs merge, which is why the length alone would not have caught it.
    const ref = mirrorGeometryRef(twoMaterialBox(), 'x', 0);

    expect(faceCountOf(ref.descriptor)).toBe(24);
    expect(builtIndexCount(ref)).toBe(72);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 18, 0],
      [54, 18, 1],
    ]);
  });

  it('🔴 a SCOPED mirror (`1-6`) reflects only the subset, carrying its 5+1 slot split', () => {
    // 12 + 6 = 18 faces. The reflected half is faces 1..6 -> [0,0,0,0,0,1].
    const ref = mirrorGeometryRef(twoMaterialBox(), 'x', 0, '1-6');

    expect(faceCountOf(ref.descriptor)).toBe(18);
    expect(builtIndexCount(ref)).toBe(54);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 15, 0],
      [51, 3, 1],
    ]);
  });
});

describe('#644 — the tiled index and the derived face count agree, so groups are never dropped', () => {
  // The plan's open question, asserted directly rather than left to the literals. `build()`
  // consults `faceCountMismatch` BEFORE deriving a layout, so a tiled index one face out of
  // step with `faceCountOf` would warn and return the geometry with its groups dropped —
  // re-entering the exact failure this change exists to remove, through the back door. A
  // non-empty layout is the observable proof the gate was passed, not merely not tripped.
  const cases: ReadonlyArray<readonly [string, () => GeometryRef]> = [
    ['array unscoped', () => arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0])],
    ['array scoped', () => arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0], '1-6')],
    ['array count=1', () => arrayGeometryRef(twoMaterialBox(), 1, [2, 0, 0], '1-6')],
    ['mirror unscoped', () => mirrorGeometryRef(twoMaterialBox(), 'x', 0)],
    ['mirror scoped', () => mirrorGeometryRef(twoMaterialBox(), 'x', 0, '1-6')],
    [
      'nested array->mirror',
      () => mirrorGeometryRef(arrayGeometryRef(twoMaterialBox(), 2, [2, 0, 0]), 'z', 0),
    ],
  ];

  it.each(cases)('🔴 %s — the layout covers every triangle exactly once', (_name, make) => {
    const ref = make();
    const geom = built(ref);
    const indexCount = geom.getIndex()!.count;

    expect(faceCountOf(ref.descriptor)! * 3).toBe(indexCount);
    expect(geom.groups.length).toBeGreaterThan(0);
    expect(geom.groups.reduce((sum, g) => sum + g.count, 0)).toBe(indexCount);
    expect(geom.groups[0].start).toBe(0);
  });
});

describe('#649 — the modifier key names what the merged geometry carries, and nothing else', () => {
  it('🔴 two sources with the SAME assignment but different attribute sets share one array key', () => {
    // #649's residual, and the reason the source key's own `|a:` fragment is stripped rather
    // than left embedded. Both sources carry an identical `material_index`; one also carries a
    // UV map. The merged geometry and its group layout are therefore identical, so the two
    // must resolve to ONE cached build. While the source's component is embedded verbatim the
    // keys differ on a fragment the merged geometry does not express — the literal complaint
    // in #649's title.
    const faces = 12;
    const materialIndex: AttributeData = {
      domain: 'face',
      type: 'int',
      count: faces,
      data: new Int32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]),
    };
    const bare = mintAttributes({ [MATERIAL_INDEX]: materialIndex })!;
    const withUv = mintAttributes({
      [MATERIAL_INDEX]: materialIndex,
      [UV_MAP]: {
        domain: 'corner',
        type: 'float2',
        count: faces * 3,
        data: new Float32Array(faces * 3 * 2),
      },
    })!;
    expect(bare.key, 'the fixture needs two DIFFERENT source keys to be a test').not.toBe(
      withUv.key,
    );
    insert(bare.key, bare.set, 'evaluate');
    insert(withUv.key, withUv.set, 'evaluate');

    const a = arrayGeometryRef(boxGeometryRef(BOX_SIZE, bare.key), 3, [2, 0, 0]);
    const b = arrayGeometryRef(boxGeometryRef(BOX_SIZE, withUv.key), 3, [2, 0, 0]);

    expect(a.key).toBe(b.key);
    expect(getForRead(a)).toBe(getForRead(b));
  });

  it('🔴 two sources with DIFFERENT assignments still key apart — the variance that is honest', () => {
    // The other half, and it is what stops the row above from being satisfied by throwing the
    // attribute away entirely. These two merged geometries differ in their group layout, so
    // sharing one cached instance would give whichever built first to both ([[V213]] — an
    // identity field is also a cache key).
    const split = twoMaterialBox();
    const uniform = oneMaterialBox();
    const a = arrayGeometryRef(split, 3, [2, 0, 0]);
    const b = arrayGeometryRef(uniform, 3, [2, 0, 0]);

    expect(a.key).not.toBe(b.key);
    expect(layoutOf(a).length).toBe(6);
    expect(layoutOf(b).length).toBe(1);
  });

  it('a source whose assignment does not fit its OWN descriptor is refused BY NAME, not tiled', () => {
    // The refusal's population is EMPTY on every production road — a ref's key and its
    // `attributeKey` are minted in one expression, and the one road that could break the
    // pair drops the set instead of carrying a stale one. So it is exercised by direct
    // construction, which is the only way to run it at all: a named guard whose subject
    // never arrives reads as "no objection" forever, and a reader who finds it stops
    // looking. Constructed by handing a 12-face box the key of a 36-face assignment.
    const wrongSize = mintAttributes({
      [MATERIAL_INDEX]: { domain: 'face', type: 'int', count: 36, data: new Int32Array(36) },
    })!;
    insert(wrongSize.key, wrongSize.set, 'evaluate');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ref = arrayGeometryRef(boxGeometryRef(BOX_SIZE, wrongSize.key), 3, [2, 0, 0]);
      // Degrades to the pre-#644 behaviour — no component, no layout — rather than
      // gathering 36 slots through a 12-entry order and putting the right slots on the
      // wrong triangles.
      expect('attributeKey' in ref).toBe(false);
      expect(layoutOf(ref)).toEqual([]);
      // TWO refusals, and the second one is worth asserting rather than tolerating: the
      // registry independently refuses the same malformed SOURCE when it tries to derive
      // that box's own layout. Two guards at two levels, reached by one fixture — which is
      // also independent evidence that the fixture really is malformed and the row is not
      // passing because nothing happened.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(
        messages.filter((m) => m.includes('cannot tile an assignment over 36 faces')),
      ).toHaveLength(1);
      expect(messages.filter((m) => m.includes('they describe different meshes'))).toHaveLength(1);
      expect(messages).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('an UNATTRIBUTED source keys byte-identically to what it always did', () => {
    // The preservation row. A source that answered `null` to the attribute question has
    // nothing to tile, so the modifier mints nothing and the key keeps its historical
    // spelling — the same one `attributeKey.test.ts` pins.
    expect(arrayGeometryRef(boxGeometryRef(BOX_SIZE, null), 3, [2, 0, 0]).key).toBe(
      'array|box|1,1,1|3|2,0,0',
    );
    expect(mirrorGeometryRef(boxGeometryRef(BOX_SIZE, null), 'x', 0).key).toBe(
      'mirror|box|1,1,1|x|0',
    );
  });

  // ── #689 — THE LAYOUT IS NOT RE-DERIVED WHEN NOTHING IT DEPENDS ON MOVED ────────────
  //
  // The rows above are all about the VALUE. These are about the cost of producing it, and none
  // of them is a timer: a wall-clock assertion in the unit tier is flaky by construction and
  // would tell a reader nothing about WHY it got faster.
  //
  // The observable used instead is OBJECT IDENTITY. `tiledFaceOrder` builds a fresh array on
  // every miss, so a returned array that is reference-equal to the previous one is proof the
  // loop did not run — deterministic, and it fails for exactly one reason. The measurement that
  // motivated it is in #689: 389 µs per call at 7,680 merged faces against 0.2 µs for the
  // untiled path, on the road `ArrayModifier.evaluate` walks every frame.
  describe('the tiling is memoised on what the layout actually depends on', () => {
    it('an offset drag re-uses one layout and one tiled key', () => {
      const source = twoMaterialBox();
      const first = tiledFaceOrder(arrayGeometryRef(source, 3, [2, 0, 0]).descriptor);
      const second = tiledFaceOrder(arrayGeometryRef(source, 3, [9, 4, 1]).descriptor);

      expect(first).not.toBeNull();
      // IDENTITY, not equality — `toEqual` would pass on a rebuild and prove nothing.
      expect(second!.order).toBe(first!.order);
      // ...and the whole way up: the two refs differ in their offset, so their KEYS differ,
      // while the attribute component they carry is the same minted key.
      const a = arrayGeometryRef(source, 3, [2, 0, 0]);
      const b = arrayGeometryRef(source, 3, [9, 4, 1]);
      expect(a.key).not.toBe(b.key);
      expect(b.attributeKey).toBe(a.attributeKey);
    });

    it('an Array with count 2 and a Mirror share one layout, because they ARE one layout', () => {
      // `faceCount.ts`'s cache key deliberately omits `kind`, on the stated grounds that
      // `repeats` already carries it and the two coincide at `count: 2`. That is a claim about
      // behaviour, so it is checked here rather than left in a comment — if it were false the
      // omission would be a correctness bug and not an optimisation.
      const source = twoMaterialBox();
      const asArray = tiledFaceOrder(arrayGeometryRef(source, 2, [2, 0, 0]).descriptor);
      const asMirror = tiledFaceOrder(mirrorGeometryRef(source, 'x', 0).descriptor);
      expect(asArray!.order).toBe(asMirror!.order);
      // And the shared layout is the RIGHT one: the whole 12-face source, then one copy.
      expect(asArray!.order).toHaveLength(24);
      expect(asMirror!.sourceFaces).toBe(12);
    });

    it('two scopes over one source do NOT share a layout', () => {
      // The over-eager direction, which is the one that would ship a wrong picture: a cache
      // keyed too loosely gives the second modifier the first one's face order.
      const source = twoMaterialBox();
      const wide = tiledFaceOrder(arrayGeometryRef(source, 3, [2, 0, 0], '1-6').descriptor);
      const narrow = tiledFaceOrder(arrayGeometryRef(source, 3, [2, 0, 0], '1-2').descriptor);
      expect(wide!.order).not.toBe(narrow!.order);
      expect(wide!.order).toHaveLength(24); // 12 + 2 x 6
      expect(narrow!.order).toHaveLength(16); // 12 + 2 x 2
    });

    it('past the cache ceiling the answers stay correct', () => {
      // The cache clears wholesale at 8 entries. Nine distinct layouts therefore cross that
      // boundary, and the row that matters is that the NINTH is still right — a cache whose
      // reclaim path returns a stale or empty layout would drop every group downstream.
      const source = twoMaterialBox();
      const lengths = [];
      for (let count = 2; count <= 10; count++) {
        const order = tiledFaceOrder(arrayGeometryRef(source, count, [2, 0, 0]).descriptor)!.order;
        lengths.push(order.length);
        // Every layout starts with the whole preserved source, whatever the cache did.
        expect(order.slice(0, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      }
      // 12 faces x count, for count 2..10 — and it agrees with the count road, which is the
      // agreement `build()` consults before it derives any groups at all.
      expect(lengths).toEqual([24, 36, 48, 60, 72, 84, 96, 108, 120]);
      for (let count = 2; count <= 10; count++) {
        expect(faceCountOf(arrayGeometryRef(source, count, [2, 0, 0]).descriptor)).toBe(12 * count);
      }
    });

    it('a repeat over an unchanged source skips the gather and the content hash', () => {
      // ── WHY THIS ROW IS A RATIO AND NOT AN IDENTITY CHECK ─────────────────────────────
      //
      // The rows above observe the LAYOUT cache through object identity. That instrument is
      // blind to the second cache — the one holding the tiled key — because a memo miss
      // re-mints a key that is CONTENT-DERIVED and therefore byte-identical to the hit's. No
      // value-based assertion can separate them, and the blindness is not theoretical: with
      // the key cache's read deleted, all five sibling rows here stayed green while the cost
      // went back to 1655 µs per call at 31,744 faces. The cache carrying ~99% of the win had
      // no detector at all, so this is that detector.
      //
      // Two populations, measured in the SAME run so anything that shifts the whole machine
      // lands in both terms and cancels — an absolute microsecond bound is the shape that does
      // not travel to another CPU:
      //
      //   MISS — one layout, a DIFFERENT source assignment per call. The layout cache hits, so
      //          the gather and the hash run every time, at a constant face count.
      //   HIT  — one layout, one source, a varying offset. Exactly a drag.
      //
      // Same descriptor shape, same face count, same code path; the memo is the only
      // difference. The sources are built OUTSIDE the timed loop so minting them is not
      // measured.
      //
      // ⚠️ THE SOURCE IS A SPHERE, NOT THE BOX EVERY OTHER ROW USES, AND THAT IS THE FINDING
      // THAT WROTE THIS PARAGRAPH. Written first with the 36-face box it reads
      // `hit 0.21ms / miss 0.17ms` over 300 calls — the hit measuring SLOWER, three runs in a
      // row. Nothing was wrong with the cache: the work it skips is ~0.5 µs on 36 faces, below
      // the cost of the differing key string the varying-offset arm builds. A cost instrument
      // is only a detector on a population where the cost EXISTS, and the fixture that suits
      // every correctness row here is too small by three orders of magnitude for this one.
      const sphereDescriptor = sphereGeometryRef(1, 32, 16, null).descriptor;
      const sourceFaces = faceCountOf(sphereDescriptor);
      expect(sourceFaces, 'the sphere fixture has no derivable face count').toBe(960);

      // Annotated, not inferred. An evolving `[]` would be `any[]` here because the timed
      // callbacks below read it before the pushes are all seen — three errors that neither
      // `npm run typecheck` (it excludes tests) nor vitest's esbuild transpile can see, found
      // by the changed-file sweep.
      const sources: GeometryRef[] = [];
      for (let variant = 0; variant < 6; variant++) {
        const minted = faceRangeMaterialAttributes(sphereDescriptor, variant, 500);
        insert(minted!.key, minted!.set, 'evaluate');
        sources.push(sphereGeometryRef(1, 32, 16, minted!.key));
      }
      const COPIES = 8; // 960 source faces x 8 = 7,680 merged — where the cost is real
      const RUNS = 20;

      const time = (fn: (i: number) => void) => {
        for (let i = 0; i < 5; i++) fn(i); // warm, so neither population pays for JIT
        const t0 = performance.now();
        for (let i = 0; i < RUNS; i++) fn(i);
        return performance.now() - t0;
      };

      const miss = time((i) => {
        arrayGeometryRef(sources[i % sources.length], COPIES, [2, 0, 0]);
      });
      const hit = time((i) => {
        arrayGeometryRef(sources[0], COPIES, [i * 0.001, 0, 0]);
      });

      // 5x, against a ratio measured at several hundred on this fixture. The margin is
      // deliberately vast: this row exists to catch the cache being REMOVED, not to police its
      // efficiency, and it is a RATIO within one run rather than a microsecond bound so a
      // slower CPU moves both terms and cancels. If it ever fires, the cache is not consulted.
      expect(
        hit * 5,
        `a memoised repeat cost ${hit.toFixed(2)}ms against ${miss.toFixed(2)}ms for a genuine ` +
          `miss over ${RUNS} calls at ${COPIES * 960} merged faces — the tiled-key cache is ` +
          `not being consulted`,
      ).toBeLessThan(miss);
    });

    it('a refused source is warned about EVERY time, not just the first', () => {
      // The memo is written on the success path only, and the refusal returns BEFORE the cache
      // is consulted at all — so as the code stands today no perturbation of the caching can
      // make this row red. It is a FORWARD guard rather than a detector, said plainly because
      // the two are worth different amounts and a reader should not have to work it out.
      //
      // What it guards is one specific edit: hoisting the cache read above the refusal and
      // recording refusals too. Run as an arm, that is exactly what it catches — the warning
      // count goes 2 -> 1 and nothing else in this file moves. A guard that goes quiet after
      // its first firing stops reporting a condition that is still true, which is worse than
      // not having it: the second reader sees a clean console and concludes the fixture is fine.
      const wrongSize = mintAttributes({
        [MATERIAL_INDEX]: {
          domain: 'face',
          type: 'int',
          count: 36,
          data: new Int32Array(36),
        } satisfies AttributeData,
      });
      insert(wrongSize!.key, wrongSize!.set, 'evaluate');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const source = boxGeometryRef(BOX_SIZE, wrongSize!.key);
        arrayGeometryRef(source, 3, [2, 0, 0]);
        arrayGeometryRef(source, 3, [9, 4, 1]);
        const refusals = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('cannot tile an assignment over 36 faces'));
        expect(refusals).toHaveLength(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
