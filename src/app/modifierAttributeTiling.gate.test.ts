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
  subsetGeometryRef,
} from './modifierGeometry';
import { faceArityOf, faceCountOf, tiledFaceOrder } from './faceCount';
import { clear, getForRead } from './geometryRegistry';
import { faceRangeMaterialAttributes, uniformMaterialAttributes } from '../nodes/meshAttributes';
import { insert, read } from './attributeStore';
import { mintAttributes } from '../nodes/attributeKey';
import * as attributeKey from '../nodes/attributeKey';
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
/**
 * A box's corners — POLYGON corners since #776, so six quads' worth of rim.
 *
 * Named rather than spelled, because every plausible expression for it is wrong in a way that
 * still produces a number: `faces * 3` read 36 while a face was a triangle and reads 18 now,
 * and the triangle total's `12 * 3` reads 36, which is what this constant held until #776. A
 * box's split VERTEX count is also 24 and that agreement is a coincidence of `BoxGeometry`'s
 * layout — a sphere separates them at 176 loops against 63 vertices.
 */
const BOX_CORNERS = 24;

function twoMaterialBox(): GeometryRef {
  // #770 — FACES 3..5, and it read 6..11 while a face was a triangle. A box has six faces
  // now, so the old range clamps to nothing and every face stays on slot 0: the fixture would
  // silently become the one-material control it is here to be contrasted with.
  const minted = faceRangeMaterialAttributes(boxDescriptor(), 3, 5);
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
    // 6 source faces -> 18 (6 + 6 x 2), tiled as [src, src, src]. Each half of the source is
    // 3 faces = 3 quads = 18 index entries, so the runs alternate 0,1,0,1,0,1 at a constant 18.
    // ⚠️ THE LAYOUT BELOW IS BYTE-IDENTICAL ACROSS #770 AND THE FACE COUNT HALVED, which is the
    // clearest single statement of why a box cannot discriminate an arity mistake: three quads
    // and six triangles occupy the same eighteen index entries.
    // Written as the numbers. Before this change the layout is `[]` — `build()` returns at
    // `ref.attributeKey === undefined` before `addGroup`.
    const ref = arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0]);

    expect(faceCountOf(ref.descriptor)).toBe(18);
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

  it('🔴 a SCOPED array x3 (`1-4`) tiles only the subset, and the subset straddles the slot split', () => {
    // The arm that separates "tiles correctly" from "tiles the whole source regardless of
    // scope". ⚠️ THE QUERY MOVED FROM `1-6` TO `1-4` AT #770 AND HAD TO: over six faces
    // `'1-6'` names 1..5, which is five of six — nearly the whole source, so a tiling that
    // ignored scope would look almost right. `'1-4'` names four of six and still straddles the
    // slot boundary, which is the property the row was written for.
    //
    // Faces 1..4 are slots [0,0,1,1], so each generated copy contributes a 12-entry slot-0 run
    // then a 12-entry slot-1 run. 6 + 4 x 2 = 14 faces. A tiling that ignored scope would
    // produce the unscoped six-group layout above and a 108-entry index; one that took the
    // subset for copy 0 too would produce 12 faces.
    const ref = arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0], '1-4');

    expect(faceCountOf(ref.descriptor)).toBe(14);
    expect(builtIndexCount(ref)).toBe(84);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 12, 0],
      [48, 12, 1],
      [60, 12, 0],
      [72, 12, 1],
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
    // 6 + 6 = 12 faces, tiled as [src, src]. This is the row that measures the winding
    // claim: `reverseWinding` swaps vertices inside a triangle and leaves triangle order
    // alone, so the reflected half's slots are the source's in the SAME order. A
    // concatenation reversed to "correct for winding" would put [1,1,1] first in the second
    // half and produce [[0,18,0],[18,18,1],[36,18,1],[54,18,0]] — three groups after the runs
    // merge, which is why the length alone would not have caught it.
    const ref = mirrorGeometryRef(twoMaterialBox(), 'x', 0);

    expect(faceCountOf(ref.descriptor)).toBe(12);
    expect(builtIndexCount(ref)).toBe(72);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 18, 0],
      [54, 18, 1],
    ]);
  });

  it('🔴 a SCOPED mirror (`1-4`) reflects only the subset, carrying its 2+2 slot split', () => {
    // 6 + 4 = 10 faces. The reflected half is faces 1..4 -> [0,0,1,1]. Same query change as the
    // scoped array above, for the same reason.
    const ref = mirrorGeometryRef(twoMaterialBox(), 'x', 0, '1-4');

    expect(faceCountOf(ref.descriptor)).toBe(10);
    expect(builtIndexCount(ref)).toBe(60);
    expect(layoutOf(ref)).toEqual([
      [0, 18, 0],
      [18, 18, 1],
      [36, 12, 0],
      [48, 12, 1],
    ]);
  });
});

describe("#719 — SUBSET carries the surviving faces' slots, so a Mask keeps its materials", () => {
  it('🔴 a mask keeping `2-8` of a two-material box lays out TWO groups, split where the source splits', () => {
    // #671 derived a `subsetFaceOrder` for exactly this, and #719 measured that the order was
    // consumed by nothing: `mintTiledModifierAttributes` refused every kind but `array` and
    // `mirror` four lines before it asked for one. The subset ref minted with no
    // `attributeKey`, the store held nothing for it, and `build()` returned before `addGroup`
    // — so this box built with `groups: []`, drew entirely in slot 0, and raised nothing.
    //
    // 🔴 THE SCOPE SPANS THE SOURCE'S OWN MATERIAL BOUNDARY, WHICH IS WHAT MAKES THIS A
    // DETECTOR. The two-material fixture puts faces 0-2 on slot 0 and 3-5 on slot 1, so keeping
    // `2-3` keeps one of each. A scope landing inside one material would produce a SINGLE
    // group, and a single group is also what the defect produces once `addGroup` is reached at
    // all — the two are told apart only by a mask that has to survive a boundary.
    //
    // ⚠️ THE QUERY MOVED FROM `2-8` AT #770. Over six faces `'2-8'` names 2..5, whose
    // COMPLEMENT is [0,0] — one material — so the inverse row below would have stopped
    // straddling anything. `'2-3'` straddles on both sides, which is what the pair needs.
    // Written as the numbers for the reason this whole file is: 2 faces -> 2 quads -> 12 index
    // entries, 6 on slot 0 then 6 on slot 1.
    const ref = subsetGeometryRef(twoMaterialBox(), '2-3', true);

    expect(faceCountOf(ref.descriptor)).toBe(2);
    expect(builtIndexCount(ref)).toBe(12);
    expect(layoutOf(ref)).toEqual([
      [0, 6, 0],
      [6, 6, 1],
    ]);
  });

  it('🔴 the INVERSE mask keeps the complement, and its slot split is the complement too', () => {
    // `keep: false` over the same query — faces 0,1 (slot 0) and 4,5 (slot 1) survive. The
    // polarity is asserted here rather than left to the descriptor's own row because the gather
    // reads `order`, and an order built from the wrong side of the mask would produce a valid
    // layout over the wrong faces: 4 faces and 24 entries either way, differing only in WHICH
    // slots they carry. 2 quads = 12 on slot 0, then 2 quads = 12 on slot 1.
    const ref = subsetGeometryRef(twoMaterialBox(), '2-3', false);

    expect(faceCountOf(ref.descriptor)).toBe(4);
    expect(builtIndexCount(ref)).toBe(24);
    expect(layoutOf(ref)).toEqual([
      [0, 12, 0],
      [12, 12, 1],
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
    ['array scoped', () => arrayGeometryRef(twoMaterialBox(), 3, [2, 0, 0], '1-4')],
    ['array count=1', () => arrayGeometryRef(twoMaterialBox(), 1, [2, 0, 0], '1-4')],
    ['mirror unscoped', () => mirrorGeometryRef(twoMaterialBox(), 'x', 0)],
    ['mirror scoped', () => mirrorGeometryRef(twoMaterialBox(), 'x', 0, '1-4')],
    [
      'nested array->mirror',
      () => mirrorGeometryRef(arrayGeometryRef(twoMaterialBox(), 2, [2, 0, 0]), 'z', 0),
    ],
  ];

  it.each(cases)('🔴 %s — the layout covers every triangle exactly once', (_name, make) => {
    const ref = make();
    const geom = built(ref);
    const indexCount = geom.getIndex()!.count;

    // ⚠️ `faces x 3` UNTIL #770; a face is a polygon now, so what has to equal the index count
    // is what those faces MATERIALISE to. The old expression is off by a factor of two on a box
    // and by a varying factor on a sphere.
    expect(faceArityOf(ref.descriptor)!.reduce((a, b) => a + b, 0) * 3).toBe(indexCount);
    expect(faceArityOf(ref.descriptor)!.length).toBe(faceCountOf(ref.descriptor));
    expect(geom.groups.length).toBeGreaterThan(0);
    expect(geom.groups.reduce((sum, g) => sum + g.count, 0)).toBe(indexCount);
    expect(geom.groups[0].start).toBe(0);
  });
});

describe('#649 — the modifier key names what the merged geometry carries, and nothing else', () => {
  it('🔴 two sources differing only in an EDGE attribute share one array key', () => {
    // #649's residual, and the reason the source key's own `|a:` fragment is stripped rather
    // than left embedded. Both sources carry an identical `material_index`; one also carries a
    // point-domain attribute. The merged geometry and its group layout are therefore
    // identical, so the two must resolve to ONE cached build. While the source's component is
    // embedded verbatim the keys differ on a fragment the merged geometry does not express —
    // the literal complaint in #649's title.
    //
    // 🔴 THIS ROW USED A UV MAP UNTIL #694 AND A POINT ATTRIBUTE UNTIL #717, AND THE HANDOVER
    // IS THE POINT. Its own note predicted this: *"if a point order is ever built, this row
    // moves again rather than being deleted, and the row below it is what says where to."*
    // #754 built the order, so a point attribute is now a difference the merged geometry DOES
    // express, and the point fixture moved to the row below exactly as the UV fixture did.
    //
    // #649's guarantee did not expire; it moved to the last domain still not laid out — EDGE.
    // The day #718 lays edges out, this row has nowhere left to move, and that is the honest
    // outcome rather than a failure: "a difference the merged geometry does not express" will
    // be an empty category, and the row should be deleted with #649 recorded as fully closed.
    const faces = 6;
    const materialIndex: AttributeData = {
      domain: 'face',
      type: 'int',
      count: faces,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    };
    const bare = mintAttributes({ [MATERIAL_INDEX]: materialIndex })!;
    const withEdge = mintAttributes({
      [MATERIAL_INDEX]: materialIndex,
      // An EDGE attribute now, and its count is 12 because a box has twelve edges. There is no
      // edge buffer to check that against — which is the whole reason `edge` is still dropped.
      zz_edge: { domain: 'edge', type: 'float', count: 12, data: new Float32Array(12) },
    })!;
    expect(bare.key, 'the fixture needs two DIFFERENT source keys to be a test').not.toBe(
      withEdge.key,
    );
    insert(bare.key, bare.set, 'evaluate');
    insert(withEdge.key, withEdge.set, 'evaluate');

    const a = arrayGeometryRef(boxGeometryRef(BOX_SIZE, bare.key), 3, [2, 0, 0]);
    const b = arrayGeometryRef(boxGeometryRef(BOX_SIZE, withEdge.key), 3, [2, 0, 0]);

    expect(a.key).toBe(b.key);
    expect(getForRead(a)).toBe(getForRead(b));
  });

  it('🔴 two sources differing only in their UVs now key APART — #694, the sharing loss closed', () => {
    // The defect #694 was filed for, asserted as closed. Before the corner order these two
    // resolved to ONE cached build: the UV map was dropped from the tiled set, so it reached
    // neither the merged geometry nor the key, and `uvSharesWithBare` was `true`. Whichever
    // built first was handed to both.
    //
    // This is observable today even though nothing yet READS a tiled UV — a key is a string,
    // and the sharing loss is a statement about identity rather than about pixels. What is
    // deliberately NOT claimed here is that anything draws differently; see the corner-layout
    // row below for the part that would catch a wrong layout.
    const faces = 6;
    const materialIndex: AttributeData = {
      domain: 'face',
      type: 'int',
      count: faces,
      data: new Int32Array([0, 0, 0, 1, 1, 1]),
    };
    const bare = mintAttributes({ [MATERIAL_INDEX]: materialIndex })!;
    const withUv = mintAttributes({
      [MATERIAL_INDEX]: materialIndex,
      [UV_MAP]: {
        domain: 'corner',
        type: 'float2',
        // ⚠️ A CORNER IS A POLYGON CORNER SINCE #776, so a box's six quads carry 24 and not
        // the 36 triangle corners this said before. At the wrong count the attribute misfits,
        // the whole set is refused, and this row asserts against a store that holds nothing.
        count: BOX_CORNERS,
        data: new Float32Array(BOX_CORNERS * 2).fill(0.25),
      },
    })!;
    insert(bare.key, bare.set, 'evaluate');
    insert(withUv.key, withUv.set, 'evaluate');

    const a = arrayGeometryRef(boxGeometryRef(BOX_SIZE, bare.key), 3, [2, 0, 0]);
    const b = arrayGeometryRef(boxGeometryRef(BOX_SIZE, withUv.key), 3, [2, 0, 0]);

    expect(a.key).not.toBe(b.key);
    const tiled = read(b.attributeKey!);
    expect(tiled, `nothing stored under ${b.attributeKey}`).not.toBeNull();
    expect(Object.keys(tiled!).sort()).toEqual([MATERIAL_INDEX, UV_MAP].sort());
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
    // looking. Constructed by handing a 6-face box the key of a 36-face assignment.
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
        messages.filter((m) => m.includes("cannot tile 'material_index' over 36 faces")),
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
      // And the shared layout is the RIGHT one: the whole 6-face source, then one copy.
      expect(asArray!.order).toHaveLength(12);
      expect(asMirror!.sourceFaces).toBe(6);
    });

    it('two scopes over one source do NOT share a layout', () => {
      // The over-eager direction, which is the one that would ship a wrong picture: a cache
      // keyed too loosely gives the second modifier the first one's face order.
      const source = twoMaterialBox();
      const wide = tiledFaceOrder(arrayGeometryRef(source, 3, [2, 0, 0], '1-4').descriptor);
      const narrow = tiledFaceOrder(arrayGeometryRef(source, 3, [2, 0, 0], '1-2').descriptor);
      expect(wide!.order).not.toBe(narrow!.order);
      expect(wide!.order).toHaveLength(14); // 6 + 2 x 4
      expect(narrow!.order).toHaveLength(10); // 6 + 2 x 2
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
        expect(order.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
      }
      // 6 faces x count, for count 2..10 — and it agrees with the count road, which is the
      // agreement `build()` consults before it derives any groups at all.
      expect(lengths).toEqual([12, 18, 24, 30, 36, 42, 48, 54, 60]);
      for (let count = 2; count <= 10; count++) {
        expect(faceCountOf(arrayGeometryRef(source, count, [2, 0, 0]).descriptor)).toBe(6 * count);
      }
    });

    it('a repeat over an unchanged source skips the gather and the content hash', () => {
      // ── WHY THIS ROW COUNTS A CALL AND NOT A DURATION (#705) ──────────────────────────
      //
      // The rows above observe the LAYOUT cache through object identity. That instrument is
      // blind to the second cache — the one holding the tiled key — because a memo miss
      // re-mints a key that is CONTENT-DERIVED and therefore byte-identical to the hit's. No
      // value-based assertion can separate them, and the blindness is not theoretical: with
      // the key cache's read deleted, all five sibling rows here stayed green while the cost
      // went back to 1655 µs per call at 31,744 faces. The cache carrying ~99% of the win had
      // no detector at all, so this is that detector.
      //
      // 🔴 IT USED TO BE A WALL-CLOCK RATIO, WHICH MADE IT NON-DETERMINISTIC IN THE ONE TIER
      // THAT IS TRUSTED TO BE DETERMINISTIC. It turned `main` red twice on a shared runner,
      // most recently on a tree BYTE-IDENTICAL to one that had passed the same job ninety
      // minutes earlier — the comparison that settles it as runner load and not code. A red
      // then said either "the cache regressed" or "the runner was busy", with nothing in the
      // output to tell a reader which, so the row spent trust instead of earning it.
      //
      // What the row actually claims is that the cache was CONSULTED. `mintAttributes` is the
      // content hash named in this row's own title, and it is reachable only THROUGH the
      // gather — the gather builds the record it is handed, with no early return between the
      // two — while the memo returns above both. So one call count answers for both nouns in
      // the title, exactly, and without a clock.
      //
      // `growthBySource()` cannot do this job, which is worth saying because it looks like it
      // could: `insert` returns early for a resident key and a miss re-mints the same content
      // key, so the counter reads identically whether or not the memo was consulted.
      //
      // Both literals were OBSERVED before being written, and the arms are ORDERED — the miss
      // control runs first, while nothing is memoised yet:
      //
      //   MISS — 6 distinct source assignments, one constant offset, cycled 20 times.
      //          Exactly 6 gathers: one per distinct source, memoised thereafter.
      //   HIT  — one source, a varying offset. Exactly a drag, and exactly 0 gathers.
      //
      // The sphere fixture is KEPT from the timing version deliberately. It is no longer
      // needed for cost, but it is the population the sibling rows reason about, and
      // shrinking it would change what this row covers in exchange for nothing.
      const sphereDescriptor = sphereGeometryRef(1, 32, 16, null).descriptor;
      const sourceFaces = faceCountOf(sphereDescriptor);
      // 512 = w x h since #770, where it was 960 = 2 x w x (h - 1) triangles. The figure moved
      // and what the row measures — one gather per distinct source — did not.
      expect(sourceFaces, 'the sphere fixture has no derivable face count').toBe(512);

      // Annotated, not inferred. An evolving `[]` would be `any[]` here — an error neither
      // `npm run typecheck` (it excludes tests) nor vitest's esbuild transpile can see.
      const sources: GeometryRef[] = [];
      for (let variant = 0; variant < 6; variant++) {
        const minted = faceRangeMaterialAttributes(sphereDescriptor, variant, 500);
        insert(minted!.key, minted!.set, 'evaluate');
        sources.push(sphereGeometryRef(1, 32, 16, minted!.key));
      }

      const COPIES = 8; // 512 source faces x 8 = 4,096 merged
      const RUNS = 20;

      // Spied through the NAMESPACE rather than the named import, because that is the binding
      // `meshAttributes.ts` calls through once vitest has transformed it — verified by a fresh
      // call registering before either arm was written, rather than assumed from the tooling.
      const gather = vi.spyOn(attributeKey, 'mintAttributes');
      try {
        gather.mockClear();
        for (let i = 0; i < RUNS; i++) {
          arrayGeometryRef(sources[i % sources.length], COPIES, [2, 0, 0]);
        }
        // The message is built from the SAME number the assertion reads — the old one was
        // composed from a different measurement than the one it asserted, and so described a
        // comfortable pass while reporting a failure.
        expect(
          gather,
          `${RUNS} calls over ${sources.length} distinct sources gathered ` +
            `${gather.mock.calls.length} times — expected exactly one gather per distinct source`,
        ).toHaveBeenCalledTimes(sources.length);

        gather.mockClear();
        for (let i = 0; i < RUNS; i++) {
          arrayGeometryRef(sources[0], COPIES, [i * 0.001, 0, 0]);
        }
        expect(
          gather,
          `a ${RUNS}-step offset drag over one unchanged source gathered ` +
            `${gather.mock.calls.length} times at ${COPIES * sourceFaces!} merged faces — ` +
            `the tiled-key cache is not being consulted`,
        ).toHaveBeenCalledTimes(0);
      } finally {
        gather.mockRestore();
      }
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
          .filter((m) => m.includes("cannot tile 'material_index' over 36 faces"));
        expect(refusals).toHaveLength(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

// ── #688 — THE GATHER READS THE DOMAIN, NOT A NAME ────────────────────────────────────
//
// #649 made the generator's key name exactly the tiled `material_index`. That was a true
// statement about the merged geometry only while `material_index` was the only face-domain
// attribute anything minted, and `AttributeSet`'s own comment exists to say that will not
// last. With a second face attribute present the same sentence inverted: the key stopped
// varying with something the merged geometry SHOULD express, two genuinely different results
// collapsed onto one cached build, and the second attribute was dropped on the way through.
//
// 🔴 EVERY ROW BELOW WAS RUN AGAINST `e84ff4a` FIRST, IN A WORKTREE, TWICE — and the two runs
// name the same set, so the numbers here are a measurement and not one reading. **FIVE of this
// block's rows red there:** the key row because the two keys are equal; the survival, scope and
// component rows because the tiled set has one member; the refusal row because it asserts the
// per-name message this change introduced.
//
// **The THREE control rows pass there and here, which is what makes them controls** — their
// literals were read off that tree, not chosen to match this one. (A sixth row, the sibling cost
// ratio in the block above, redded once in a loaded full-file run and passes in isolation on that
// same tree and in two clean full runs; recorded as the flake it is rather than filed as a
// finding.)
//
// Two rows in the `#649` block above also red on `e84ff4a`, and only because this change made the
// refusal message name the attribute — `cannot tile 'material_index' over 36 faces` where it read
// `cannot tile an assignment over 36 faces`. That is a literal being updated, not behaviour
// moving: both rows assert the same two counts on either side of it.
//
//     BEFORE (e84ff4a)   arrayKey  array|box|1,1,1|3|2,0,0|a:ea2140ba
//                        mirrorKey mirror|box|1,1,1|x|0|a:33d7e0b5
//                        tiledNames ["material_index"]   uvSharesWithBare true
//     AFTER              byte-identical on every one of those fields
//
// The single-attribute population being untouched is therefore a measurement rather than a
// claim, which matters more here than usual: a widening that silently re-hashed every existing
// generator key would invalidate every cached build in the wild and nothing would say so.
describe('#688 — the tiling carries EVERY face-domain attribute, selected by domain', () => {
  /** A face-domain `int` attribute whose value IS the face index — so the order is readable. */
  function faceOrdinal(faces: number): AttributeData {
    const data = new Int32Array(faces);
    for (let face = 0; face < faces; face++) data[face] = face;
    return { domain: 'face', type: 'int', count: faces, data };
  }

  /** The two-material split as a bare attribute, identical on every source built from it. */
  function splitSlots(): AttributeData {
    const data = new Int32Array(6);
    data.fill(1, 3);
    return { domain: 'face', type: 'int', count: 6, data };
  }

  /** A box carrying `material_index` plus whatever else the caller names. */
  function boxCarrying(extra: Readonly<Record<string, AttributeData>>): GeometryRef {
    const minted = mintAttributes({ [MATERIAL_INDEX]: splitSlots(), ...extra });
    expect(minted, 'the fixture failed to mint').not.toBeNull();
    insert(minted!.key, minted!.set, 'evaluate');
    return boxGeometryRef(BOX_SIZE, minted!.key);
  }

  /** The tiled set a generator's handle points at, by name. */
  function tiledSet(ref: GeometryRef) {
    expect('attributeKey' in ref, `${ref.key} carries no tiled attributes`).toBe(true);
    const set = read(ref.attributeKey!);
    expect(set, `nothing stored under ${ref.attributeKey}`).not.toBeNull();
    return set!;
  }

  it('🔴 THE DISCRIMINATING ROW — two sources differing ONLY in a second face attribute key APART', () => {
    // The defect, as filed. Both sources carry an IDENTICAL `material_index`, so their group
    // layouts are identical and #649's row would have them share a build. They differ in
    // `face_group`, which the merged geometry genuinely does express — so sharing one cached
    // instance hands whichever built first to both.
    //
    // Measured on `e84ff4a`: both keys are `array|box|1,1,1|3|2,0,0|a:ea2140ba` and this row
    // reds on the first assertion. The layouts being equal is asserted too, because that is
    // what stops the row from being satisfied by the two simply differing in some other way.
    const a = boxCarrying({ face_group: faceOrdinal(6) });
    const b = boxCarrying({
      face_group: { domain: 'face', type: 'int', count: 6, data: new Int32Array(6).fill(7) },
    });
    expect(a.key, 'the fixture needs two different SOURCE keys to be a test').not.toBe(b.key);

    const refA = arrayGeometryRef(a, 3, [2, 0, 0]);
    const refB = arrayGeometryRef(b, 3, [2, 0, 0]);

    expect(refA.key).not.toBe(refB.key);
    expect(layoutOf(refA)).toEqual(layoutOf(refB));
  });

  it('🔴 the second attribute SURVIVES, tiled through the same order as the material index', () => {
    // Not merely "the key differs" — the data has to arrive. `face_group` holds the face index,
    // so the tiled values ARE the order, readable as a literal: the whole source, then two more
    // passes over the whole source, because this array is unscoped.
    const ref = arrayGeometryRef(boxCarrying({ face_group: faceOrdinal(6) }), 3, [2, 0, 0]);
    const set = tiledSet(ref);

    expect(Object.keys(set).sort()).toEqual(['face_group', 'material_index']);
    expect(Array.from(set.face_group.data)).toEqual([
      ...[0, 1, 2, 3, 4, 5],
      ...[0, 1, 2, 3, 4, 5],
      ...[0, 1, 2, 3, 4, 5],
    ]);
    // Domain and type are FORWARDED, not re-declared — a gather that rebuilt them from a
    // literal would be a second place deciding what the tiled attribute is.
    expect(set.face_group.domain).toBe('face');
    expect(set.face_group.type).toBe('int');
    expect(set.face_group.count).toBe(18);
  });

  it('🔴 a SCOPED generator takes the second attribute through the SUBSET, not the whole source', () => {
    // The arm that separates "gathers the second attribute" from "gathers it ignoring scope".
    // `1-4` keeps faces 1..4, so the order is the whole source followed by two passes over
    // exactly those four — and because `face_group` is the face index, that subset is legible
    // as a literal rather than as a count.
    const ref = arrayGeometryRef(boxCarrying({ face_group: faceOrdinal(6) }), 3, [2, 0, 0], '1-4');
    const set = tiledSet(ref);

    expect(faceCountOf(ref.descriptor)).toBe(14);
    expect(Array.from(set.face_group.data)).toEqual([
      ...[0, 1, 2, 3, 4, 5],
      ...[1, 2, 3, 4],
      ...[1, 2, 3, 4],
    ]);
  });

  it('🔴 a MULTI-COMPONENT face attribute is gathered per element, not sheared by its width', () => {
    // `count` is in ELEMENTS and `data` is flattened component-major, so a gather that stepped
    // by 1 instead of by `componentsOf(type)` would read across element boundaries. It would
    // still produce a well-formed array of the right length — which is exactly why this needs
    // literal values and not a length check. Face f holds (f, f+100, f+200); a stride-1 gather
    // puts (1, 100, 200) at f=0... and (100, 200, 1) at f=1, so the first triple alone does
    // not discriminate and the second one does.
    const faces = 6;
    const data = new Float32Array(faces * 3);
    for (let face = 0; face < faces; face++) {
      data[face * 3] = face;
      data[face * 3 + 1] = face + 100;
      data[face * 3 + 2] = face + 200;
    }
    const ref = arrayGeometryRef(
      boxCarrying({ face_colour: { domain: 'face', type: 'float3', count: faces, data } }),
      2,
      [2, 0, 0],
    );
    const set = tiledSet(ref);

    expect(set.face_colour.type).toBe('float3');
    expect(set.face_colour.count).toBe(12);
    expect(set.face_colour.data.length).toBe(36);
    // The first two elements of each of the two copies, which is where a stride error shows.
    expect(Array.from(set.face_colour.data.slice(0, 6))).toEqual([0, 100, 200, 1, 101, 201]);
    expect(Array.from(set.face_colour.data.slice(18, 24))).toEqual([0, 100, 200, 1, 101, 201]);
  });

  it("🔴 each tiled attribute keeps its SOURCE's array class, per attribute (#696)", () => {
    // The gather allocates through `emptyLike`, which forwards the class off the source rather
    // than deriving it from the declared `type`. Nothing else in the tier can see that choice:
    // the content key copies values into plain arrays before hashing, and every integer these
    // fixtures carry is exact in float32 — so a gather that put `material_index` into a
    // `Float32Array` produces identical keys, identical lengths and identical VALUES, and the
    // whole suite stays green. Measured, not assumed: returning the wrong class from
    // `emptyLike` left 359 files / 4319 tests passing byte for byte.
    //
    // So this row is the only thing standing between that choice and a silent drift, and it
    // asserts the two classes SEPARATELY — a single-attribute check would pass on a gather
    // that allocated one class for everything, which is precisely the failure mode.
    const ref = arrayGeometryRef(
      boxCarrying({
        face_colour: {
          domain: 'face',
          type: 'float3',
          count: 6,
          data: new Float32Array(18),
        },
      }),
      2,
      [2, 0, 0],
    );
    const set = tiledSet(ref);

    expect(set.material_index.data).toBeInstanceOf(Int32Array);
    expect(set.face_colour.data).toBeInstanceOf(Float32Array);
  });

  it('the single-attribute population RE-HASHED at #770, once and on purpose', () => {
    // 🔴 THIS ROW'S CLAIM INVERTED, AND IT IS NOT REPAIRABLE BY UPDATING THE LITERALS QUIETLY.
    //
    // It read *"keys BYTE-IDENTICALLY to before the widening"*, with two literals taken off
    // `e84ff4a`, and its reason was that a generator key is also a cache key: a widening that
    // re-hashed the existing population would invalidate every build in the wild with nothing
    // saying so. #688 was a widening and correctly left the keys alone.
    //
    // #770 is not a widening. A face-domain attribute now carries ONE ELEMENT PER POLYGON, so
    // a box's `material_index` went from twelve entries to six — different content, therefore a
    // different content hash, necessarily and by design. There is no version of this phase that
    // keeps these strings, so the honest row records the move rather than asserting a stability
    // that stopped being available:
    //
    //     BEFORE  array|box|1,1,1|3|2,0,0|a:ea2140ba   mirror|box|1,1,1|x|0|a:33d7e0b5
    //     AFTER   array|box|1,1,1|3|2,0,0|a:a864052d   mirror|box|1,1,1|x|0|a:1204cccc
    //
    // ⚠️ AND THE CONSEQUENCE IS STATED RATHER THAN LEFT TO BE DISCOVERED: every cached build
    // keyed on a face-domain attribute misses once after this lands. That is the correct
    // outcome — the old entries describe geometry laid out at the wrong granularity — but it is
    // a real one-time cost and not a free rename.
    //
    // The row keeps its job for everything after this: the literals are read off THIS tree and
    // the next unintended re-hash still reds here.
    const source = twoMaterialBox();
    expect(arrayGeometryRef(source, 3, [2, 0, 0]).key).toBe('array|box|1,1,1|3|2,0,0|a:a864052d');
    expect(mirrorGeometryRef(source, 'x', 0).key).toBe('mirror|box|1,1,1|x|0|a:1204cccc');
  });

  it('a CORNER-domain attribute now REACHES the tiled set, still by domain and not by name', () => {
    // 🔴 THIS ROW INVERTED AT #694 AND THAT IS THE HANDOVER IT WAS WRITTEN FOR. It used to
    // assert `UVMap` stayed OUT of the tiled set, with the reason stated in the negative:
    // `order` was a permutation of FACE indices and could not lay out a corner attribute. A
    // corner order exists now, so the same domain-not-name selection admits it.
    //
    // What did NOT change is why this is a domain test: nothing here knows what `UVMap` means.
    // A second corner attribute under any name rides the same order.
    const uv: AttributeData = {
      domain: 'corner',
      type: 'float2',
      count: BOX_CORNERS,
      data: new Float32Array(BOX_CORNERS * 2),
    };
    const withUv = arrayGeometryRef(boxCarrying({ [UV_MAP]: uv }), 3, [2, 0, 0]);
    const bare = arrayGeometryRef(boxCarrying({}), 3, [2, 0, 0]);

    expect(Object.keys(tiledSet(withUv)).sort()).toEqual([MATERIAL_INDEX, UV_MAP].sort());
    // The tiled corner attribute spans the merged geometry's corners, not the source's.
    expect(tiledSet(withUv)[UV_MAP].count).toBe(BOX_CORNERS * 3);
    expect(withUv.key).not.toBe(bare.key);
  });

  it('🔴 #717 THE EXIT — a point attribute survives Array, Mirror AND Mask, with gathered values', () => {
    // The issue's exit criterion, as one row, because "survives Array" alone was satisfiable by
    // a build that still lost it at the other two. A box has 8 topological points; the datum is
    // an `int` so the Mirror does not refuse it — that refusal is `float3`-only and has its own
    // rows in `classCarriage.gate.test.ts`.
    const ids = new Int32Array([10, 11, 12, 13, 14, 15, 16, 17]);
    const src = boxCarrying({
      zz_ids: { domain: 'point', type: 'int', count: 8, data: ids },
    });

    const cases: readonly (readonly [string, GeometryRef, number, number])[] = [
      // name, ref, expected merged point count, expected copies of the source run
      ['array x3', arrayGeometryRef(src, 3, [2, 0, 0]), 24, 3],
      ['mirror', mirrorGeometryRef(src, 'x', 2), 16, 2],
      ['mask (subset)', subsetGeometryRef(src, '0-5', true), 8, 1],
    ];

    for (const [name, ref, points, copies] of cases) {
      const set = tiledSet(ref);
      expect(Object.keys(set).sort(), name).toEqual([MATERIAL_INDEX, 'zz_ids']);
      expect(set['zz_ids'].count, name).toBe(points);
      expect(set['zz_ids'].domain, name).toBe('point');
      // 🔴 THE VALUES, NOT JUST THE COUNT. A wrong order of the right LENGTH is the failure
      // this phase exists to prevent, and a count assertion cannot see it. Every copy must
      // repeat the source's run verbatim, because a gather through `[0..7]` per copy is what
      // the order promises.
      const out = Array.from(set['zz_ids'].data);
      expect(out.length, name).toBe(8 * copies);
      for (let c = 0; c < copies; c++)
        expect(out.slice(c * 8, c * 8 + 8), `${name} copy ${c}`).toEqual(Array.from(ids));
    }
  });

  it('🔴 #717 a POINT-domain attribute now TILES — and its count is 8, not 24', () => {
    // This row said "still excluded, by domain and not by name", kept alive at the domain that
    // then had no order. #754 gave it one, so it flips — and the fixture's own justification
    // is the thing worth reading, because it went false a phase before the row did:
    //
    //   *"24, not 8: a box is seam-split, so its point count is what the builder actually
    //    produces rather than the cube's eight corners."*
    //
    // #716 made `point` mean the TOPOLOGICAL set. A box has 8 points and 24 split positions,
    // and an attribute rides the 8 — the renderer does the duplication. Left at 24 this
    // fixture does not merely mis-describe: it MISFITS, the whole tiling is refused, and the
    // row would have read as "point attributes still do not travel" for a reason that has
    // nothing to do with whether they can.
    const pt: AttributeData = {
      domain: 'point',
      type: 'float3',
      count: 8,
      data: new Float32Array([...Array(24).keys()]),
    };
    const withPoint = arrayGeometryRef(boxCarrying({ zz_point: pt }), 3, [2, 0, 0]);
    const bare = arrayGeometryRef(boxCarrying({}), 3, [2, 0, 0]);

    expect(Object.keys(tiledSet(withPoint)).sort()).toEqual([MATERIAL_INDEX, 'zz_point']);
    // It spans the MERGED geometry's points — 3 copies of 8 — not the source's.
    expect(tiledSet(withPoint)['zz_point'].count).toBe(24);
    // ...and it is a GATHER, so copy 1 repeats copy 0's values verbatim. A row asserting only
    // the count would pass on an order that gathered garbage of the right length.
    const out = tiledSet(withPoint)['zz_point'].data;
    expect(Array.from(out.slice(0, 6))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(out.slice(24, 30))).toEqual([0, 1, 2, 3, 4, 5]);
    // A source carrying one is now a source the merged geometry EXPRESSES, so the keys part.
    expect(withPoint.key).not.toBe(bare.key);
  });

  it('CONTROL — a source with attributes at NO LAYABLE domain takes the historical road', () => {
    // Distinct from "the source has no attributes at all": this one has a set, and a key, and
    // nothing any order can lay out. It must reach the same unattributed spelling rather than
    // minting an empty set — `{}` has no representation ([[V188]]) and a uniform stand-in would
    // be this module inventing an assignment.
    //
    // 🔴 THE FIXTURE MOVED CORNER -> POINT AT #694 AND POINT -> EDGE AT #717, AND IT IS THE
    // SAME ROW EACH TIME. Its note predicted this move in as many words: *"it shrinks again
    // the day a point order exists, and then this row needs `edge`."* The condition this
    // guards has never gone away; the set of domains satisfying it keeps shrinking, and it is
    // now down to ONE. #718 empties it, and then this row has no fixture left — at which point
    // it should be deleted rather than kept alive on a domain invented to feed it.
    const edgeOnly = mintAttributes({
      zz_edge: { domain: 'edge', type: 'float', count: 12, data: new Float32Array(12) },
    });
    insert(edgeOnly!.key, edgeOnly!.set, 'evaluate');
    const ref = arrayGeometryRef(boxGeometryRef(BOX_SIZE, edgeOnly!.key), 3, [2, 0, 0]);

    expect(ref.key).toBe('array|box|1,1,1|3|2,0,0');
    expect('attributeKey' in ref).toBe(false);
    expect(layoutOf(ref)).toEqual([]);
  });

  it('🔴 a MIRRORED copy takes its corners in REVERSED winding — the row a wrong layout reds', () => {
    // THE DISCRIMINATING ROW. Everything above this is satisfied by a corner order that is
    // merely the right LENGTH; this is the one that reds if the values land in the wrong
    // places. `buildMirror` runs `reverseWinding` over its reflected half so the reflected
    // faces are not back-facing, which at the POLYGON level means a copied face traverses its
    // rim the other way round (#785 measured it, per face, against the built index buffer). So
    // a corner order that just counts up is correct for an Array and WRONG for a Mirror, and it
    // is wrong quietly: a UV lands somewhere plausible rather than nowhere.
    //
    // Every corner carries its own source index as its value, so the gathered array IS the
    // order and a misplacement is readable rather than inferred.
    const corners = BOX_CORNERS;
    const stamped = mintAttributes({
      [UV_MAP]: {
        domain: 'corner',
        type: 'float2',
        count: corners,
        // component 0 is the source corner index; component 1 is a constant so a shear by a
        // factor of two would not read as a plausible permutation.
        data: new Float32Array(Array.from({ length: corners }, (_, c) => [c, -1]).flat()),
      },
    })!;
    insert(stamped.key, stamped.set, 'evaluate');
    const source = boxGeometryRef(BOX_SIZE, stamped.key);

    const mirrored = tiledSet(mirrorGeometryRef(source, 'x', 0))[UV_MAP];
    const read = (element: number) => mirrored.data[element * 2];

    // The preserved original comes first and is NOT reversed: face 0's four rim corners in
    // rim order.
    expect([read(0), read(1), read(2), read(3)]).toEqual([0, 1, 2, 3]);
    // The reflected half is, and it is the SAME source face read the other way round with
    // corner 0 held fixed — `[0, 3, 2, 1]` and not `[3, 2, 1, 0]`. Which of those two it is is
    // pinned by the built index buffer rather than chosen: the two fans split a quad along
    // different diagonals, and `cornerCount.gate.test.ts` row 6 reds on the wrong one.
    // `reversedCornerAt` is the one place that states it, shared with `weldedPolygonsOf`.
    expect([read(corners + 0), read(corners + 1), read(corners + 2), read(corners + 3)]).toEqual([
      0, 3, 2, 1,
    ]);
    expect(mirrored.count).toBe(corners * 2);

    // An ARRAY never reverses — `buildArray` applies translations only — so the same fixture
    // through the other generator must come back in source order. Without this pair the row
    // could be satisfied by swapping unconditionally.
    const arrayed = tiledSet(arrayGeometryRef(source, 2, [2, 0, 0]))[UV_MAP];
    expect([
      arrayed.data[corners * 2],
      arrayed.data[corners * 2 + 2],
      arrayed.data[corners * 2 + 4],
      arrayed.data[corners * 2 + 6],
    ]).toEqual([0, 1, 2, 3]);
  });

  it('the refusal names EVERY misfit attribute, not just the alphabetically first', () => {
    // One misfit refuses the whole set, because tiling the ones that fit and dropping the one
    // that does not is this function silently losing an attribute — the defect it was widened
    // to remove. The message lists all of them so a reader who fixes one is not sent back for
    // the next with no warning that it was already known.
    const wrong = mintAttributes({
      [MATERIAL_INDEX]: { domain: 'face', type: 'int', count: 36, data: new Int32Array(36) },
      zz_group: { domain: 'face', type: 'int', count: 36, data: new Int32Array(36) },
    });
    insert(wrong!.key, wrong!.set, 'evaluate');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ref = arrayGeometryRef(boxGeometryRef(BOX_SIZE, wrong!.key), 3, [2, 0, 0]);
      expect('attributeKey' in ref).toBe(false);

      const tiling = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('cannot tile'));
      expect(tiling).toHaveLength(1);
      expect(tiling[0]).toContain("'material_index' over 36 faces (this source has 6)");
      expect(tiling[0]).toContain("'zz_group' over 36 faces (this source has 6)");
    } finally {
      warn.mockRestore();
    }
  });

  it('🔴 #717 the misfit message names the denominator the CHECK used, not a global pair', () => {
    // Caught by OBSERVING a real build rather than by reading the code. The message used to end
    // `onto a source of N faces / M corners` — a global pair, correct while exactly two domains
    // tiled. The moment `point` tiled, a point misfit printed its count beside two denominators
    // that had nothing to do with it. Measured verbatim before the fix:
    //
    //     'zz' over 98 points onto a source of 168 faces / 504 corners
    //
    // The sphere's 86 points — the one number a reader needs to fix the attribute — was the one
    // number absent. Now the expected count comes from the SAME layout the comparison used, so
    // the message cannot name a denominator the check did not apply, and a fourth domain needs
    // no edit here at all.
    const wrong = mintAttributes({
      // Twelve is a MISFIT now — a box has six faces since #770 — but this row's subject is the
      // point attribute below, so the material index must FIT or it joins the message and the
      // assertion stops measuring what it names.
      [MATERIAL_INDEX]: { domain: 'face', type: 'int', count: 6, data: new Int32Array(6) },
      // A box has 8 topological points; 24 is its SPLIT count, which is the exact mistake the
      // fixtures in this file used to make and the one a reader is most likely to repeat.
      zz_pts: { domain: 'point', type: 'int', count: 24, data: new Int32Array(24) },
    });
    insert(wrong!.key, wrong!.set, 'evaluate');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ref = arrayGeometryRef(boxGeometryRef(BOX_SIZE, wrong!.key), 3, [2, 0, 0]);
      expect('attributeKey' in ref).toBe(false);
      const tiling = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('cannot tile'));
      expect(tiling).toHaveLength(1);
      expect(tiling[0]).toContain("'zz_pts' over 24 points (this source has 8)");
      // ...and the misleading global pair is gone, not merely supplemented.
      expect(tiling[0]).not.toContain('corners');
    } finally {
      warn.mockRestore();
    }
  });
});
