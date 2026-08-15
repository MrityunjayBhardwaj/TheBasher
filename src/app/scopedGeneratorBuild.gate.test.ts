// ns-2 step 12.5 — THE SCOPED GENERATOR: the descriptor field, the key, the count, and the
// two rows that make them a detector. (#607, #660)
//
// ── WHY FOUR THINGS LAND IN ONE COMMIT ────────────────────────────────────────────────
//
// D9 gives the `'source'` lane its home for a scope: `array` and `mirror` descriptors carry
// the CANONICAL QUERY as a field. None of the four pieces is correct alone.
//
//   the FIELD  alone   nothing reads it.
//   the KEY    alone   two differently-scoped arrays over one source resolve to ONE cached
//                      `BufferGeometry` — a wrong mesh on screen, not a wasted byte.
//   the COUNT  alone   `faceCountOf` still derives `source x count`, so a scoped build trips
//                      `faceCountMismatch` inside `build()`, warns, and returns the geometry
//                      with its MATERIAL GROUPS DROPPED — the exact class ns-1b closed.
//   the BUILD  alone   the count disagrees with it, same drop, from the other side.
//
// ── 🔴 WHY THERE ARE TWO ROWS AND NOT ONE ─────────────────────────────────────────────
//
// ROW 1 is PARITY: `3 x faceCountOf(d) === build(d).getIndex().count`, over every
// sync-buildable descriptor including scoped ones. It lives in `faceCount.gate.test.ts`,
// beside the unscoped rows, because there is one parity gate and a second one would be a
// second spelling of it.
//
// 🔴 PARITY IS A CONSISTENCY GATE, AND CONSISTENCY IS PRESERVED BY DOING NOTHING. It reds
// when EXACTLY ONE of `faceCountOf` and the builder honours the field. It is green when
// NEITHER does — which is precisely the state one author produces in one commit that adds
// `scope?: string` to the descriptor and the key and implements it in nothing. MEASURED, on
// the pre-work tree: with the field absent entirely (every scoped row collapsing to its
// unscoped twin), row 1 was GREEN on all fourteen descriptors. The plan predicted that in
// prose; this file's authoring run confirmed it against a real tree.
//
// ROW 2 is SCOPE-SENSITIVITY, AS A LITERAL:
//
//     faceCountOf({array, count: 3, scope: '0-5'}) over a box  ===  24
//
// asserted as THE NUMBER 24, never as an expression over the unscoped count — an expression
// would inherit the same omission it is meant to catch. Under the rule below, `12 + 6 x 2`.
// A correlated omission (both sides ignoring the field) reds this immediately, and leaves
// row 1 green. That asymmetry is the proof row 2 does work row 1 cannot.
//
// ── THE RULE, STATED ONCE (plan §2.2) ─────────────────────────────────────────────────
//
//     A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET.
//
// For MIRROR this is GROUNDED: Houdini's Mirror SOP has a documented *Keep Original* —
// "Preserves the input geometry" — while *Group* is "Primitives to mirror". The preserved
// thing is the whole input, the generated thing is the subset. Basher hard-codes Keep
// Original on. ⇒ `36 + 18 = 54` index entries for a box scoped to half.
//
// For ARRAY it is OURS, an extension by consistency, not a reading we inherited: copy 0 sits
// at the identity offset and is the preserved input; copies 1..n-1 are generated from the
// subset. ⇒ `12 + 6 x 2 = 24` faces. Copy-and-Transform's page does not decide it, and
// `18 x 3 = 54` reads its "a subset of input primitives to copy from" just as well. The row
// that makes the choice visible instead of assumed is `count = 1 -> 36`, which step 13a
// owns; here the discriminator is the literal 24 itself.
//
// REF: src/nodes/scopeQuery.ts (the language, and the count it derives);
//      src/app/modifierGeometry.ts (`arrayGeometryRef` / `mirrorGeometryRef` — the key);
//      src/app/faceCount.ts (the amended arms); src/app/geometryRegistry.ts (`faceSubset`);
//      src/app/faceCount.gate.test.ts (ROW 1); the ns-2 plan §5 D9/D6b and §8 step 12.5;
//      issues #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { declaredParamKeys } from './inspectorSectionBody';
import { __resetRegistryForTests, listNodeTypes } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import {
  arrayGeometryRef,
  boxGeometryRef,
  descriptorParamFields,
  mirrorGeometryRef,
  rebuildGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { faceCountOf, zeroIndexRefusal } from './faceCount';
import { clear, getForRead } from './geometryRegistry';
import type { GeometryRef } from '../nodes/types';

const box = () => boxGeometryRef([1, 1, 1], null);

/** Index entries in the BUILT geometry — never `position.count`, see the P3 block below. */
function builtIndex(ref: GeometryRef): number {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  const index = geom!.getIndex();
  expect(index, `${ref.key} built without an index`).not.toBeNull();
  return index!.count;
}

function built(ref: GeometryRef): BufferGeometry {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  return geom!;
}

beforeEach(() => {
  __resetRegistryForTests();
  // 🔴 `__reseedAllNodesForTests`, NOT `registerAllNodes` — measured at step 13a, and the
  // difference made this file's last row VACUOUS from the day it was written.
  // `registerAllNodes` carries a module-level `registered` once-guard, so paired with a
  // per-test reset it re-seeds on the FIRST test and returns immediately on every one
  // after: `listNodeTypes()` goes 80 → 0 and `declaredParamKeys` answers `[]` for every
  // node in the repo. The fuse below asks which generators declare a `scope` param and
  // therefore read `[]` whatever the answer was.
  // Censused when it was found: 7 of 105 files pair the reset with `registerAllNodes`, and
  // six of them use `beforeAll` — which runs once, so the guard never bites. This was the
  // only `beforeEach`, which is why nothing else in the tier was affected. (#678)
  __reseedAllNodesForTests();
  clear();
});

it('the registry is still seeded on a test that is not the first — the row below needs it', () => {
  // The instrument's own control, and it exists because the omission it guards against was
  // SILENT: an empty registry makes every question about a node's params answer "no", which
  // is the same shape as a clean pass ([[H360]] — a guard whose subject never arrives reads
  // as "no objection" forever). Asserted here rather than trusted to the `beforeEach`,
  // because this case is not the first in the file and that is the whole point.
  expect(listNodeTypes().length).toBeGreaterThan(0);
  expect(declaredParamKeys('MirrorModifier')).toContain('axis');
});

describe('ns-2 step 12.5 — ROW 2: the scoped count is scope-SENSITIVE, as a literal', () => {
  it('🔴 an array x3 over a box scoped to `0-5` derives 24 faces — THE NUMBER 24', () => {
    // The whole detector. Written as `24` and not as `12 + 6 * 2`, and not as anything
    // derived from `faceCountOf` of the unscoped descriptor: an expression over the
    // unscoped count inherits exactly the omission this row exists to catch.
    expect(faceCountOf(arrayGeometryRef(box(), 3, [2, 0, 0], '0-5').descriptor)).toBe(24);
  });

  it('🔴 …and a mirror over a box scoped to `0-5` derives 18', () => {
    // 12 preserved + 6 generated. The mirror figure is the GROUNDED half of §2.2's rule.
    expect(faceCountOf(mirrorGeometryRef(box(), 'x', 1, '0-5').descriptor)).toBe(18);
  });

  it('the unscoped counts are untouched, so the arms did not simply change meaning', () => {
    // The control for the two rows above. An implementation that subtracted from every
    // array would satisfy them and break every shipped graph.
    expect(faceCountOf(arrayGeometryRef(box(), 3, [2, 0, 0]).descriptor)).toBe(36);
    expect(faceCountOf(mirrorGeometryRef(box(), 'x', 1).descriptor)).toBe(24);
  });

  it('a scope selecting NOTHING is the IDENTITY, not an empty geometry', () => {
    // D6b, and it falls out of §2.2's rule rather than being special-cased: the whole input
    // is preserved and nothing is generated from it, so a box arrayed x3 over an empty
    // subset is a box. Parity holds here too, correctly — which is why the zero-index
    // refusal below has no reachable input.
    const nothing = arrayGeometryRef(box(), 3, [2, 0, 0], '!0-11');
    expect(faceCountOf(nothing.descriptor)).toBe(12);
    expect(builtIndex(nothing)).toBe(36);
  });
});

describe('ns-2 step 12.5 — the KEY carries the scope, so two scopes are two geometries', () => {
  it('🔴 two differently-scoped arrays over ONE source build TWO instances', () => {
    // Pre-mortem 3. Without the scope in the key both of these resolve to
    // `array|box|1,1,1|3|2,0,0` and share one cached `BufferGeometry` — and both draw
    // something, which is what makes it silent.
    const half = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5');
    const other = arrayGeometryRef(box(), 3, [2, 0, 0], '6-11');
    expect(half.key).not.toBe(other.key);

    const a = built(half);
    const b = built(other);
    expect(a.uuid).not.toBe(b.uuid);
    expect(a).not.toBe(b);
  });

  it('…and an identical scope still SHARES one instance — the cache is not defeated', () => {
    // The other direction, which the row above cannot see. A key that folded something
    // per-call (an object identity, a counter) would pass the two-instances row and mint a
    // geometry per frame.
    const a = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5');
    const b = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5');
    expect(a.key).toBe(b.key);
    expect(built(a)).toBe(built(b));
  });

  it('the key folds the CANONICAL query, so two spellings of one scope share a build', () => {
    // D9's stated choice: the canonical query string, not a hash of the resolved mask. The
    // canonicaliser is `scopeQuery`'s, so `5,4,3,2,1,0` and `0-5` are one entry rather than
    // two byte-identical geometries.
    const written = arrayGeometryRef(box(), 3, [2, 0, 0], '5,4,3,2,1,0');
    const canonical = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5');
    expect(written.key).toBe(canonical.key);
    expect(written.descriptor).toMatchObject({ kind: 'array', scope: '0-5' });
  });

  it('canonicalisation is IDEMPOTENT, because the rebuild road re-feeds its own output', () => {
    // `rebuildGeometryRef` hands `d.scope` — already canonical — back to the builder. If
    // canonicalising twice moved the string, an animated `count` write would repoint a
    // handle at a different cached geometry every time it ran.
    const once = arrayGeometryRef(box(), 3, [2, 0, 0], '5,4,3,2,1,0');
    const twice = arrayGeometryRef(
      box(),
      3,
      [2, 0, 0],
      (once.descriptor as { scope: string }).scope,
    );
    expect(twice.key).toBe(once.key);
  });

  it('a blank scope is the same handle as no scope at all', () => {
    // The authoring state "the author cleared the field" collapses to "unscoped" at the ONE
    // place a query becomes a key, rather than at each call site. `{scope: undefined}` is
    // NOT the same as an absent field to `Object.keys` (H265's shape), so the field is
    // OMITTED rather than written undefined — checked here, since `descriptorParamFields`
    // reads exactly those keys.
    const bare = arrayGeometryRef(box(), 3, [2, 0, 0]);
    expect(arrayGeometryRef(box(), 3, [2, 0, 0], '').key).toBe(bare.key);
    expect(arrayGeometryRef(box(), 3, [2, 0, 0], null).key).toBe(bare.key);
    expect(Object.keys(bare.descriptor)).not.toContain('scope');
  });
});

describe('ns-2 step 12.5 — P3, re-run THROUGH the descriptor rather than standalone', () => {
  // The research ran `mergeGeometries` on hand-built subsets and marked the drop-in
  // UNVERIFIED, because until this step there was nowhere on a descriptor for a subset to
  // live. These are the same three numbers, produced by the registry from a handle.

  it('array x3 over a box: unscoped 108, scoped-to-half 72 — the DIFFERING case first', () => {
    expect(builtIndex(arrayGeometryRef(box(), 3, [2, 0, 0], '0-5'))).toBe(72);
    expect(builtIndex(arrayGeometryRef(box(), 3, [2, 0, 0]))).toBe(108);
  });

  it('mirror over a box: unscoped 72, scoped-to-half 54', () => {
    expect(builtIndex(mirrorGeometryRef(box(), 'x', 1, '0-5'))).toBe(54);
    expect(builtIndex(mirrorGeometryRef(box(), 'x', 1))).toBe(72);
  });

  it('🔴 unreferenced positions ride through as DEAD WEIGHT — assert the index, never the position count', () => {
    // Measured by the research and restated here as a row, because it is the reading that
    // would make every number above wrong. A face subset is an INDEX subset over unchanged
    // attribute buffers, so the positions of the faces it dropped are still in the buffer;
    // `mergeGeometries` copies them out verbatim. A mirror over a box scoped to half has 54
    // index entries and 48 positions — 24 from each half, none of them removed.
    const geom = built(mirrorGeometryRef(box(), 'x', 1, '0-5'));
    expect(geom.getIndex()!.count).toBe(54);
    expect(geom.getAttribute('position').count).toBe(48);
  });

  it('a scoped sphere lands the same arithmetic on a mesh whose count is not 12', () => {
    // Box-only fixtures are the shape that lets `12` be hard-coded somewhere and pass.
    // sphere(8, 4) tessellates to 2 * 8 * 3 = 48 faces; `0-23` selects 24 of them.
    const sphere = sphereGeometryRef(1, 8, 4, null);
    expect(faceCountOf(sphere.descriptor)).toBe(48);
    expect(faceCountOf(arrayGeometryRef(sphere, 3, [2, 0, 0], '0-23').descriptor)).toBe(96);
    expect(builtIndex(arrayGeometryRef(sphere, 3, [2, 0, 0], '0-23'))).toBe(288);
  });
});

describe('ns-2 step 12.5 — the zero-index refusal, and the size of its population', () => {
  it('names both the descriptor and the number when a build yields an empty index', () => {
    // D6b, rewritten in revision 2 against a MEASUREMENT: `mergeGeometries` does not return
    // `null` for an empty input. `merge([full, empty])` returns index 36 with 48 dead
    // positions and `merge([empty])` returns index 0 — a VALID geometry that draws nothing,
    // which is more silent than a null would have been. So the trigger is the built index,
    // not a null from the merge.
    const why = zeroIndexRefusal(arrayGeometryRef(box(), 3, [2, 0, 0], '0-5').descriptor, 0);
    expect(why).not.toBeNull();
    expect(why).toContain('array');
    expect(why).toContain('0');
  });

  it('says nothing about a geometry that has faces, or about one with no index at all', () => {
    expect(zeroIndexRefusal(box().descriptor, 36)).toBeNull();
    // A non-indexed geometry is a different condition with a different answer, and is not
    // this refusal's to make — the same separation `faceCountMismatch` already draws.
    expect(zeroIndexRefusal(box().descriptor, null)).toBeNull();
  });

  it('🔴 and its reachable population is EMPTY today, which is stated rather than implied', () => {
    // The honest grade. Under §2.2's rule copy 0 is always the WHOLE input, so no scope can
    // drive a generator's index to zero — the row above had to call the refusal directly to
    // prove the instrument works at all (the H360 shape: a guard whose subject never arrives
    // reads as "no objection" forever). It is kept because it is the detector for a semantic
    // change that makes copy 0 a subset too, and because a valid geometry drawing nothing is
    // the quietest failure this module can produce.
    //
    // The claim, checked: every sync-buildable descriptor this phase can construct — scoped
    // to everything, to half, or to nothing — builds a non-empty index.
    const source = box();
    const scopes = [undefined, '0-11', '0-5', '!0-11', '0-11:2'] as const;
    const empties: string[] = [];
    for (const scope of scopes) {
      for (const ref of [
        arrayGeometryRef(source, 3, [2, 0, 0], scope),
        arrayGeometryRef(source, 1, [2, 0, 0], scope),
        mirrorGeometryRef(source, 'x', 1, scope),
      ]) {
        if (builtIndex(ref) === 0) empties.push(ref.key);
      }
    }
    expect({ examined: scopes.length * 3, empties }).toEqual({ examined: 15, empties: [] });
  });
});

describe('ns-2 step 12.5 — the scope survives the overlay rebuild road', () => {
  it('🔴 folding an animated `count` into a scoped array KEEPS the scope', () => {
    // V206's shape for a new optional field: the risk is not that a caller passes it, it is
    // that a REBUILD arm forgets to carry it. `rebuildGeometryRef` re-mints through the same
    // builder, and an arm that dropped `d.scope` would silently unscope a handle the moment
    // any animated param on that modifier moved — with every existing test green, because no
    // existing fixture is scoped.
    const scoped = arrayGeometryRef(box(), 3, [2, 0, 0], '0-5');
    const rebuilt = rebuildGeometryRef(scoped, { count: 5 });
    expect(rebuilt.descriptor).toMatchObject({ kind: 'array', count: 5, scope: '0-5' });
    expect(faceCountOf(rebuilt.descriptor)).toBe(12 + 6 * 4);

    const mirrored = mirrorGeometryRef(box(), 'x', 1, '0-5');
    expect(rebuildGeometryRef(mirrored, { offset: 3 }).descriptor).toMatchObject({
      kind: 'mirror',
      offset: 3,
      scope: '0-5',
    });
  });

  it('exposes `scope` as a param-fed descriptor field, like `count` and `offset`', () => {
    // The overlay finds what to fold by asking the descriptor for its own field names, and
    // the correspondence it rests on is that a descriptor field is named exactly like the
    // param that feeds it. `scope` is such a field the moment a generator carries one.
    expect(descriptorParamFields(arrayGeometryRef(box(), 3, [2, 0, 0], '0-5').descriptor)).toEqual([
      'count',
      'offset',
      'scope',
    ]);
    expect(descriptorParamFields(arrayGeometryRef(box(), 3, [2, 0, 0]).descriptor)).toEqual([
      'count',
      'offset',
    ]);
  });

  it('🔴 THE FUSE, BLOWN AND REPLACED — Array declares a `scope`; Mirror is step 13b', () => {
    // ── WHAT THIS ROW USED TO SAY, AND WHY IT IS REPLACED RATHER THAN DELETED ──────────
    //
    // It read `declaring: []` and named its own successor by hand:
    // *the step that declares a `scope` param on a generator must add the scoped refs to
    // `HANDLE_KINDS` in that same commit.* Step 13a is that step for `ArrayModifier`, and
    // the fixture moved with it. A blown fuse is replaced, never deleted ([[V208]]) —
    // deleting it would retire the question one step before its second half is answered.
    //
    // 🔴 AND THE FUSE WAS VACUOUS WHEN IT WAS WRITTEN. Measured at 13a: this file paired
    // `__resetRegistryForTests()` with `registerAllNodes()` in a `beforeEach`, and that
    // helper's once-guard left the registry EMPTY for every case after the first. This row
    // is the last in the file, so `declaredParamKeys` answered `[]` for every node in the
    // repo and the row read `[]` because it could see nothing — not because the claim held.
    // It went green on a tree where the claim was false, and only redded once the pairing
    // was fixed. (#678, and the `beforeEach` now carries a control case that would catch a
    // recurrence before this row could.)
    //
    // ── WHAT IT ASKS NOW ──────────────────────────────────────────────────────────────
    //
    // The same question, at the position the answer has actually reached. `ArrayModifier`
    // declares a `scope` param and its `HANDLE_KINDS` fixture is scoped, so the overlay's
    // name-correspondence IS checked for that field. `MirrorModifier` declares none, so its
    // fixture must stay unscoped — a scoped mirror fixture today would red the reach gate
    // correctly, because the param it names does not exist yet.
    //
    // 🔴 THE SUCCESSOR, WRITTEN DOWN AS THE PREVIOUS VERSION WROTE ITS OWN: STEP 13b
    // DECLARES `MirrorModifier.scope`, AND MUST SCOPE THE `mirror` ENTRY IN `HANDLE_KINDS`
    // IN THE SAME COMMIT — then this literal becomes both generators and the row retires,
    // because at that point nothing is left unchecked for it to be about.
    const declaring = ['ArrayModifier', 'MirrorModifier'].filter((type) =>
      declaredParamKeys(type).includes('scope'),
    );
    expect(declaring).toEqual(['ArrayModifier']);
  });
});
