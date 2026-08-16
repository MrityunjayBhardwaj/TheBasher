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
import { arrayGeometryRef, boxGeometryRef, mirrorGeometryRef } from './modifierGeometry';
import { faceCountOf } from './faceCount';
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
});
