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
    expect(importsOf('src/app/faceCount.ts')).toEqual(['../nodes/types', '../nodes/scopeQuery']);
    expect(importsOf('src/nodes/scopeQuery.ts')).toEqual([]);
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
    expect(importsOf('src/app/geometryRegistry.ts')).toEqual([
      'three',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      '../nodes/types',
      '../nodes/attributes',
      './attributeStore',
      './faceCount',
      './materialGroups',
      '../nodes/scopeQuery',
    ]);
  });

  it('and every module it gained at step 4 is itself a leaf, which is why widening was safe', () => {
    // The claim above, checked rather than asserted in prose. A leaf that stops being one
    // re-opens the graph through the registry, and nothing else would notice.
    expect(importsOf('src/app/materialGroups.ts')).toEqual([]);
    expect(importsOf('src/app/attributeStore.ts')).toEqual(['../nodes/attributes']);
    expect(importsOf('src/app/faceCount.ts')).toEqual(['../nodes/types', '../nodes/scopeQuery']);
    expect(importsOf('src/nodes/scopeQuery.ts')).toEqual([]);
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
    expect(faceCountOf(box())).toBe(12);
    expect(faceCountOf(mirror())).toBe(24);
    expect(faceCountOf(sphere())).toBe(2 * 8 * 3);
  });

  it('refuses a built geometry whose index disagrees with the descriptor', () => {
    // The build-time half: a triangle-indexed geometry carries 3x the face count.
    const why = faceCountMismatch(box(), 12);
    expect(why).not.toBeNull();
    expect(why).toContain('36');
    expect(why).toContain('12');
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
