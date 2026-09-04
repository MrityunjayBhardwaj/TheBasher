// #638 (ns-1b step 1) — the count lives in a LEAF, and a disagreement is refused BY NAME.
//
// Two properties, both of which decay silently if only intended:
//
//   1. `faceCount.ts` imports ONE thing. The move exists so `meshAttributes.ts` and
//      `geometryRegistry.ts` can both depend on the count without depending on each other;
//      a leaf that grows an import re-opens exactly that, and nothing fails when it does.
//   2. A count disagreement produces a MESSAGE NAMING BOTH NUMBERS, not a `false` and not a
//      silently-skipped derivation. Step 4 derives a group layout from a per-face index; if
//      the index and the geometry describe different meshes, the layout covers some other
//      mesh's triangles. The refusal is what makes that state say so.
//
// REF: src/app/faceCount.ts (both); tools/gates/moduleShape.ts (the import parse and its
//      stated limits); src/app/faceCount.gate.test.ts (the count vs BUILT geometry);
//      issues #638, #633.

import { describe, expect, it } from 'vitest';
import { importsOf } from '../../tools/gates/moduleShape';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';
import { faceCountMismatch, faceCountOf } from './faceCount';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';

const box = (): GeometryDescriptor => ({ kind: 'box', size: [1, 1, 1] });
const sphere = (w = 8, h = 4): GeometryDescriptor => ({
  kind: 'sphere',
  radius: 1,
  widthSegments: w,
  heightSegments: h,
});
const refOf = (descriptor: GeometryDescriptor): GeometryRef => ({
  key: 'k',
  descriptor,
});
const mirror = (): GeometryDescriptor => ({
  kind: 'mirror',
  source: refOf(box()),
  axis: 'x',
  offset: 0,
});

describe('#638 the count is a leaf', () => {
  it('imports only its type and one LEAF — and the leaf is why that is still a leaf', () => {
    // The whole point of the move. If this grows, say why in the same commit: whatever the
    // new import drags in becomes reachable from every consumer of the count.
    //
    // 🔴 WIDENED at ns-2 step 12.5, and the reason is the property rather than the number.
    // A scoped generator derives `source + subset x (count - 1)`, so the count has to ask
    // how many elements a query names — and the module that owns the query language,
    // `componentSelection.ts`, IMPORTS THIS ONE. Measured: that is a real cycle, not a
    // shape preference. So the language moved below both, into `scopeQuery.ts`, which has
    // ZERO value imports (asserted below). What this gate protects is not "one import", it
    // is that nothing this module depends on can depend back on it.
    //
    // 🔴 WIDENED AGAIN at #770, and by the same test rather than by the same excuse. A face is
    // a POLYGON now, so the count's checks are against what a polygon MATERIALISES to, and the
    // arity that says so is grounded in three's own tessellation — which lives in
    // `polygonLayout.ts`. That module imports ONE TYPE and nothing else (asserted below), so
    // it cannot depend back on this one, which is the property rather than the number.
    //
    // 🔴 WIDENED AGAIN at #814 — AND THIS TIME THE PROPERTY ITSELF WAS TRADED, NOT PRESERVED.
    // Every widening above could say "the new import cannot depend back on this one". This one
    // cannot: `bevelLayout.ts` imports `edgeIdentity.ts`, which imports THIS module. The ring is
    // real and it is deliberate.
    //
    // It cannot be moved away, which is why it was accepted rather than designed around. A
    // bevel's face count is `F + E + V`; the `E` term is the source's EDGE count; edges live in
    // `edgeIdentity`, which needs the face order to compose a derived kind's welded rims. The
    // ring closes at `faceCountOf('bevel')`, and shuffling code between the three modules
    // relocates it without breaking it.
    //
    // ⚠️ SO THIS ROW NO LONGER CARRIES THE ACYCLICITY CLAIM, and pretending otherwise is how a
    // gate becomes decoration. What it still carries is the ORIGINAL and separate value: the
    // EXACT import set, so a module that quietly gains a heavy dependency is a red. The
    // acyclicity question moved to `importCycles.gate.test.ts`, which enumerates every runtime
    // cycle in the product — the two that predate this work included — and holds the one rule
    // that makes them safe: nothing in a ring may read across it at module level, because that
    // is the read which silently evaluates to `undefined`.
    //
    // 🔴 WIDENED AGAIN at #755, by one, and this one is back to the strictest bar — the one
    // `polygonInterpolation` met at #825 and the two at #814 openly did not. `arrayCopies`
    // imports NOTHING (asserted in the row below), so it cannot depend back on this module or
    // on anything else. It is its own file for a reason that is about THIS graph: four modules
    // need one statement of how many copies an array means — the constructor, the builder, and
    // both arithmetics — and they sit on both sides of the ring named above. Homing the rule in
    // any one of them adds an edge between two of the others.
    expect(importsOf('src/app/faceCount.ts')).toEqual([
      '../nodes/types',
      '../nodes/scopeQuery',
      './polygonLayout',
      './bevelLayout',
      './arrayCopies',
    ]);
    expect(importsOf('src/nodes/scopeQuery.ts')).toEqual([]);
    expect(importsOf('src/app/polygonLayout.ts')).toEqual(['../nodes/types']);
  });

  it('is where the mint reads the count from — not `modifierGeometry`', () => {
    // The detector for "somebody moved it back". `meshAttributes` importing the count out of
    // `modifierGeometry` is the exact edge that made the two modules mutually dependent.
    const imports = importsOf('src/nodes/meshAttributes.ts');
    expect(imports).toContain('../app/faceCount');
    expect(imports).not.toContain('../app/modifierGeometry');
  });

  it('is not re-exported by `modifierGeometry`, so there is one spelling of the count', () => {
    expect(importsOf('src/app/faceCount.ts')).not.toContain('./modifierGeometry');
  });

  it('leaves `geometryRegistry` at its declared import set', () => {
    // Not "at most three" — the exact set. A registry that quietly gains a heavy import is
    // the thing this holds; widening it is a deliberate one-line edit here, with a reason.
    //
    // 🔴 WIDENED at step 4, when `build()` started writing group layouts, and the reason is
    // the whole point of the leaf move: every one of the four additions is itself a LEAF.
    // `attributes` is a vocabulary, `attributeStore` imports one type, `faceCount` imports
    // one type, and `materialGroups` imports nothing at all. That is the difference this
    // gate exists to keep visible — importing the count from `modifierGeometry` instead
    // would have dragged the evaluator, the node registry, `dataSectionCapability` and the
    // hash into a module that had three imports.
    //
    // 🔴 WIDENED AGAIN at ns-2 step 12.5, by one, for the same reason: `scopeQuery` is a
    // leaf with no imports at all, and a scoped build has to know WHICH triangles survive.
    //
    // 🔴 WIDENED AGAIN at #716 (P2), by one: `pointIdentity` imports TWO TYPES and nothing
    // else, so it is a leaf by the same measure as the four before it. The registry needs
    // it because the descriptor's point arithmetic can only be checked against a geometry,
    // and this is the one place a built geometry and its descriptor are both in hand.
    //
    // 🔴 WIDENED AGAIN at #814, by TWO, and neither is a leaf — which is the honest way to say
    // it. `bevelLayout` is the descriptor-side topology a bevel builds to, and `builtRims` is the
    // split-space rim walk the builder needs to place positions at the source's real corners.
    // The second creates a `builtRims` <-> `geometryRegistry` ring of its own, because
    // `builtRims` already reached back here for `getForRead`. Both rings are enumerated in
    // `importCycles.gate.test.ts` rather than left to be discovered.
    //
    // 🔴 WIDENED AGAIN at #825 slice 2, by one, and this one is back to being a LEAF — the bar
    // the four step-4 additions met and the two at #814 openly did not. `polygonInterpolation`
    // imports NOTHING: it is arithmetic over `Float64Array`s that names no geometry type, no
    // descriptor and no registry. It is asserted to import nothing in the row below, so it
    // cannot quietly grow a graph into the registry the way an unheld addition could.
    //
    // 🔴 WIDENED AGAIN at #755, by one, and it is a LEAF by the strictest measure in this file:
    // `arrayCopies` imports NOTHING at all. The registry needs it because `buildArray` was the
    // one reading of an array's copy count that did not go through the shared rule — a bare
    // `i < d.count` against three floored spellings elsewhere — so a fractional count built one
    // copy more than every count function derived, and 0 / negative / NaN built none and threw
    // out of `mergeGeometries`. Importing the rule is what makes those one reading rather than
    // four that happened to agree.
    //
    // Why the registry needs it at all: a bevel's UVs cannot be written anywhere else. The
    // corner layer travels geometry → store (`uvAttributes.ts` LIFTS it off built geometry), so
    // a bevel that does not emit `uv` here has none anywhere downstream — censused across 603
    // non-test files, where the only other `setAttribute('uv', …)` is `bakedGeometryStore`
    // restoring OPFS bytes. The alternative — reaching positions from the attribute path — is
    // what this gate's whole subject forbids.
    expect(importsOf('src/app/geometryRegistry.ts')).toEqual([
      'three',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      '../nodes/types',
      '../nodes/attributes',
      './attributeStore',
      './faceCount',
      './pointIdentity',
      './materialGroups',
      '../nodes/scopeQuery',
      './bevelLayout',
      './builtRims',
      './arrayCopies',
      './polygonInterpolation',
    ]);
  });

  it('and every module it gained at step 4 is itself a leaf, which is why widening was safe', () => {
    // The claim above, checked rather than asserted in prose. A leaf that stops being one
    // re-opens the graph through the registry, and nothing else would notice.
    expect(importsOf('src/app/materialGroups.ts')).toEqual([]);
    // #825 slice 2 — the claim made in the widening note above, checked. An interpolation module
    // that grew an import of `three`, of a descriptor type, or of the registry would re-open the
    // graph through exactly the door this file guards, and nothing else would notice.
    expect(importsOf('src/app/polygonInterpolation.ts')).toEqual([]);
    expect(importsOf('src/app/attributeStore.ts')).toEqual(['../nodes/attributes']);
    // #755 — the claim made in both widening notes above, checked. `arrayCopies` states how many
    // copies an array descriptor means, and it is read by four modules on both sides of the ring.
    // The day it grows ANY import it stops being safe for all four, and nothing else would say so.
    expect(importsOf('src/app/arrayCopies.ts')).toEqual([]);
    expect(importsOf('src/app/faceCount.ts')).toEqual([
      '../nodes/types',
      '../nodes/scopeQuery',
      './polygonLayout',
      // #814 — the one that is NOT a leaf. See the first row in this file for why it was taken
      // anyway and what replaced the property it broke.
      './bevelLayout',
      './arrayCopies',
    ]);
    expect(importsOf('src/nodes/scopeQuery.ts')).toEqual([]);
    // #770 — the leaf added by the polygon flip, and a leaf by the strictest measure here:
    // one type import, no value imports at all.
    expect(importsOf('src/app/polygonLayout.ts')).toEqual(['../nodes/types']);
    // #716 — the leaf added at P2. Two type imports, no value imports at all, which is what
    // made widening the registry's set above safe rather than merely convenient.
    // #814 — `pointIdentity` stopped being a leaf too: its `bevel` arms read the same layout.
    // It is in the same ring, held by the same rule, in the same place.
    expect(importsOf('src/app/pointIdentity.ts')).toEqual([
      'three',
      '../nodes/types',
      './bevelLayout',
      // #755 — the point arithmetic reads the SAME copy count the builder does.
      './arrayCopies',
    ]);
    expect(importsOf('src/app/geometryRegistry.ts')).not.toContain('./modifierGeometry');
  });
});

describe('#638 a count disagreement is refused by name', () => {
  it('the counts a mint-time refusal is measured against are the ones this leaf derives', () => {
    // #654 retired `faceAttributeMismatch`, whose rows used to sit here. What it compared is
    // still compared — by `mintTiledModifierAttributes`, against the SOURCE descriptor, and
    // `modifierAttributeTiling.gate.test.ts` holds the rows that construct the disagreement
    // and assert the message. What this leaf still owes that refusal is the NUMBERS, so they
    // are pinned here: a mirror doubles its source and an array multiplies it.
    //
    // 🔴 EVERY NUMBER HERE MOVED AT #770, AND THE RELATIONSHIPS DID NOT. A face is a POLYGON,
    // so a box is 6 rather than 12 and a sphere is `w * h` rather than `2 * w * (h - 1)` —
    // but a mirror still doubles its source and an array still multiplies it, which is what
    // these rows were pinned for.
    expect(faceCountOf(box())).toBe(6);
    expect(faceCountOf(mirror())).toBe(12);
    expect(faceCountOf(sphere())).toBe(8 * 4);
  });

  it('refuses a built geometry whose index disagrees with the descriptor', () => {
    // The build-time half. ⚠️ IT IS NO LONGER `3 x faceCount` — #770 made a face a polygon, so
    // the expected index entry count is `3 x sum(arity)`: a box's 6 quads fan to 12 triangles
    // and 36 entries. The two arrive at the same 36 here, which is exactly why the row is kept
    // rather than rewritten — a box is the shape where the old arithmetic still lands right,
    // and the sphere rows in `faceCount.gate.test.ts` are where it separates.
    const why = faceCountMismatch(box(), 12);
    expect(why).not.toBeNull();
    expect(why).toContain('36');
    expect(why).toContain('12');
    // The faces, the triangles they materialise to, and what the geometry actually carried —
    // three numbers now, because the middle one stopped being derivable from the first.
    expect(why).toContain('6 faces');
    expect(why).toContain('12 triangles');
    expect(faceCountMismatch(box(), 36)).toBeNull();
  });

  it('the retired mint-time guard is GONE, not merely uncalled — #654', () => {
    // The row this replaces censused `faceAttributeMismatch` for production callers and found
    // zero for three phases. The zero was true and the conclusion was not: the rule ran the
    // whole time, re-implemented inline rather than called, so a census over the NAME could
    // not see it. Now that the identifier is retired, the thing worth pinning is that it did
    // not come back — a second statement of a live rule is what was actually being removed.
    const files = sourceFiles();
    const found = files
      .filter(([, src]) => /\bfaceAttributeMismatch\b/.test(stripComments(src)))
      .map(([path]) => path);

    // `examined` beside `found`, so a walk that stopped descending cannot report an empty
    // set over a smaller repo — a found of zero is only worth reading beside a denominator.
    expect({ examined: files.length, found }).toEqual({ examined: files.length, found: [] });
    expect(files.length).toBeGreaterThan(500);
  });

  it('has NO OBJECTION where there is nothing to compare, and the two cases are distinct', () => {
    // A non-indexed geometry is a different condition with a different answer (it is what
    // makes coverage undefined rather than violated) and is not this gate's to refuse.
    expect(faceCountMismatch(box(), null)).toBeNull();
    // A descriptor with no derivable count cannot disagree with anything.
    const gltf: GeometryDescriptor = { kind: 'gltf', assetRef: 'a', childName: 'n' };
    expect(faceCountOf(gltf)).toBeNull();
    expect(faceCountMismatch(gltf, 999)).toBeNull();
  });
});
