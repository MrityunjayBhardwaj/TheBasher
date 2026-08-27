// ns-2 step 15 — THE ARITHMETIC EXIT, AS STANDING TESTS. (#607, #660)
//
// ── WHAT THIS FILE IS ─────────────────────────────────────────────────────────────────
//
// The phase's DONE-WHEN clause 3, written down where it can fail. Until this file existed
// the arithmetic was a measurement I took at steps 13a and 13b and wrote into a commit
// message; a number in a commit message is a claim about a tree nobody re-reads. Here it
// is a row that runs on every push.
//
//     ArrayModifier x3 over a box:  unscoped 108  ≡  scoped-to-all 108  ≠  scoped-to-half 72
//     MirrorModifier over a box:    unscoped  72  ≡  scoped-to-all  72  ≠  scoped-to-half 54
//     the semantic discriminator:   ArrayModifier count = 1, scoped-to-half -> 36, NOT 18
//
// On a box AND a sphere, in the unit tier, through the operator. No browser, no pixels.
//
// ── 🔴 THE ERROR CLASS THIS FILE GUARDS MOVED AT #770, AND THE FIXTURE MOVED WITH IT ──
//
// What it used to guard: steps 12.5, 13a and 13b all scoped a box to `0-5`. A box's twelve
// faces were six sides of two TRIANGLES each, so `0-5` was exactly sides 0, 1 and 2 — a
// boundary every cube side agrees with, and an implementation resolving at CUBE-SIDE
// granularity produced byte-identical answers for every one of those rows. So this file
// scoped to `1-6` and `3-42`, whose endpoints land mid-side.
//
// #770 made a face a POLYGON. A box's faces ARE its cube sides now, so cube-side granularity
// is not an error a box can express — every boundary is aligned, and no box fixture can tell
// a granularity error from correct behaviour any more. The old `1-6` is not merely stale; it
// selects five of six faces, which is nearly the whole mesh.
//
// The class did not disappear. It became ARITY: an index range is no longer `faces x 3`,
// because a quad owns two triangles and a sphere's pole cell owns one. So the rival
// implementation is one that expands a polygon scope at a CONSTANT arity, and the fixture that
// separates it from the truth is a sphere, where the two arities coexist.
//
// This file scopes a box to `1-3` and a sphere to `4-27`. The box numbers are unchanged from
// the pre-flip tree — 72 against 108, 54 against 72 — which is itself the clearest statement
// of why a box is not the discriminator: three quads and six triangles occupy the same index
// entries. The sphere numbers are new, and the control at the end is a SECOND scope of the
// same cardinality over a different mix of arities: same face count, different index count.
// The arithmetic is a property of how many faces were selected AND of which.
//
// ── 🔴 EVERY EXPECTATION IS A LITERAL FROM THE ARITHMETIC ([[V210]]) ──────────────────
//
// Array and Mirror reach the geometry through ONE subset helper and ONE key builder, so an
// assertion routed through that builder cannot see a change to it. Nothing below calls a
// helper to compute what it expects, and nothing derives the scoped figure from the
// unscoped one: an expression over the unscoped count inherits exactly the omission these
// rows exist to catch. The counts are read off the BUILT index — never `position.count`
// (a scoped mirror of a box carries 54 index entries against 48 positions, measured at
// 12.5), and never the requested segment counts, because three.js clamps them silently
// ([[H324]]).
//
// ── WHAT WAS MEASURED TO PROVE THESE ROWS ARE DETECTORS, AND WHERE THE PLAN WAS WRONG ─
//
// This step adds no production code, so "does it pass on the pre-work tree?" is not a
// question — the tree IS the pre-work tree. The whole falsification burden sits on
// perturbing the road these rows watch, and both perturbations were run over the entire
// unit tier (357 files / 4282 tests green as the baseline):
//
//   CUBE-SIDE GRANULARITY, in `scopeQuery.scopeSelection` — snap each selected triangle to
//   its partner:            11 red. FIVE of them here: all four `≠` rows plus the boundary
//                           control below. 🔴 ZERO in `scopedGeneratorBuild.gate.test.ts`,
//                           `ArrayModifier.test.ts` or `MirrorModifier.test.ts` — every
//                           aligned scoped-generator assertion in the repo stayed green,
//                           which is the entire reason this file chose a different
//                           boundary. The other six are the query language's own rows and
//                           three sweeps over odd-boundaried ranges.
//                           🔴 The `count = 1` row stayed GREEN.
//
//   THE RIVAL ARRAY SEMANTIC, in `faceCount`'s array arm AND the registry's builder (they
//   are one claim spelled twice and must move together):
//                           14 red. THREE of them here: the two array `≠` rows and 🔴 the
//                           `count = 1` row. Zero mirror rows — the mirror rule is the
//                           reference's and this perturbation does not touch it.
//
// 🔴 THE PLAN ASKED FOR "AND ONLY IT" ON BOTH, AND NEITHER IS REACHABLE — the same finding
// step 13a recorded, for the same reason: a semantic lives in the count and the builder,
// and a granularity lives in the language every consumer shares. What holds instead is an
// asymmetry, and it is sharper than the wording it replaces: the two perturbations are
// COMPLEMENTARY on the `count = 1` row. Granularity reds the `≠` rows and leaves the
// semantic row green; the rival semantic reds the semantic row and leaves the boundary
// control green. Neither perturbation can be made to pass by satisfying the other.
//
// ── THE RULE THESE NUMBERS COME FROM (plan §2.2) ──────────────────────────────────────
//
//     A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET.
//
// GROUNDED for Mirror — Houdini's Mirror SOP pairs a *Group* of "primitives to mirror"
// with *Keep Original*, "Preserves the input geometry", which this node hard-codes on.
// OURS for Array, an extension by consistency: copy 0 sits at the identity offset and is
// the preserved input, copies 1..n-1 are generated from the subset. Copy-and-Transform's
// page does not decide it, and `18 x 3 = 54` reads its "a subset of input primitives to
// copy from" just as well — which is why the `count = 1` row below exists.
//
// REF: src/nodes/ArrayModifier.ts, src/nodes/MirrorModifier.ts (the rule, in each
//      operator's own words); src/nodes/componentSelection.ts (the ONE resolver);
//      src/app/modifierGeometry.ts (the shared key builder these rows must not route
//      through); src/app/scopedGeneratorBuild.gate.test.ts (the descriptor-road twin at
//      the ALIGNED boundary); the ns-2 plan §2 clause 3 and §8 step 15; issues #607, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { resolveComponentSelection } from '../nodes/componentSelection';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import * as geometryRegistry from './geometryRegistry';
import {
  boxDescriptor,
  boxGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
} from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { hydrateInlineMaterial } from '../nodes/materialSchema';
import { ArrayModifierNode } from '../nodes/ArrayModifier';
import { MirrorModifierNode } from '../nodes/MirrorModifier';
import type { MeshDataValue, ModifiedDataValue, ObjectData } from '../nodes/types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/** A box scoped to half — three of its six faces (#770; it read `1-6` over twelve). */
const BOX_HALF = '1-3';
/**
 * A sphere scoped to half its faces, MIXING ARITIES — sphere(8,6) is 48 polygons whose first
 * and last rows of eight are pole TRIANGLES and whose middle thirty-two are quads. `4-27` is
 * four pole triangles and twenty quads: 24 faces, 44 triangles, 132 index entries.
 */
const SPHERE_HALF = '4-27';
/**
 * 🔴 THE CONTROL, AND IT IS THE RIVAL IMPLEMENTATION MADE CONSTRUCTIBLE. Twenty-four faces
 * again — the SAME cardinality as {@link SPHERE_HALF} — but all of them quads, so 48 triangles
 * rather than 44. An implementation expanding a polygon scope at a constant arity gives these
 * two scopes the same answer; reading each face's real arity gives them different ones.
 */
const SPHERE_HALF_ALL_QUADS = '8-31';

function boxSource(): MeshDataValue {
  const descriptor = boxDescriptor([1, 1, 1]);
  const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], attributeKey),
    material: hydrateInlineMaterial(null, '#888888'),
    materialKey: null,
    attributeKey,
  };
}

function sphereSource(): MeshDataValue {
  // Both sibling fields are written rather than omitted, and that is not tidiness: a
  // PRE-vs-POST `tsc` sweep over this file caught them missing ([[H362]]). `npm run
  // typecheck` excludes test files and vitest strips types without checking them, so both
  // standing gates were green on a fixture that did not satisfy `MeshDataValue`.
  const descriptor = sphereDescriptor(1, 8, 6);
  const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
  return {
    kind: 'MeshData',
    geometry: sphereGeometryRef(1, 8, 6, attributeKey),
    material: hydrateInlineMaterial(null, '#888888'),
    materialKey: null,
    attributeKey,
  };
}

/** Index entries in the BUILT geometry — NEVER `position.count`, see this file's header. */
/**
 * How many FACES a scope names on a source — asserted so the control below is a claim about
 * arity and not accidentally about cardinality.
 *
 * Goes through the same resolver the operators do, so a scope that stopped meaning what these
 * rows think it means shows up here rather than as a puzzling index count.
 */
function selectedFaceCount(source: MeshDataValue, scope: string): number {
  const resolved = resolveComponentSelection(source, { scope }, 'face');
  if (resolved === null) throw new Error(`the fixture could not resolve '${scope}'`);
  return resolved.count;
}

function builtIndex(value: ObjectData | undefined): number {
  const geom = geometryRegistry.getForRead((value as ModifiedDataValue).geometry);
  expect(geom, 'the registry could not build this handle').not.toBeNull();
  const index = geom!.getIndex();
  expect(index, 'built without an index').not.toBeNull();
  return index!.count;
}

// Both drivers go through `resolveComponentSelection` — the real resolver the evaluator
// calls — and never a hand-built selection: a stand-in that skips the producer's
// transformation inverts the test ([[H328]]), and a second way of turning a source into a
// selection is the defect this phase exists to delete.
function arrayIndex(source: MeshDataValue, count: number, scope: string): number {
  const params = { count, offset: [2, 0, 0] as [number, number, number], muted: false, scope };
  return builtIndex(
    ArrayModifierNode.evaluate(
      params,
      { target: source },
      ctx,
      resolveComponentSelection(source, params, 'face'),
    ) as ObjectData,
  );
}

function mirrorIndex(source: MeshDataValue, scope: string): number {
  const params = { axis: 'x' as const, offset: 3, muted: false, scope };
  return builtIndex(
    MirrorModifierNode.evaluate(
      params,
      { target: source },
      ctx,
      resolveComponentSelection(source, params, 'face'),
    ) as ObjectData,
  );
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('ns-2 exit clause 3 — the arithmetic, on a BOX, at a non-aligned boundary', () => {
  it('🔴 THE DIFFERING CASE FIRST — an array x3 scoped to half is 72, not 108', () => {
    // 6 preserved + 3 + 3 = 12 faces = 24 triangles = 72 index entries, against 18 faces = 36
    // triangles = 108 unscoped. ⚠️ BOTH LITERALS SURVIVED #770 UNCHANGED while every face count
    // in the sentence halved — which is the reason the sphere rows below exist.
    // This is the row that proves the scope was HONOURED, and it is the one the discard
    // perturbation reds. Everything else in this file is context for it.
    const src = boxSource();
    expect(arrayIndex(src, 3, BOX_HALF)).toBe(72);
    expect(arrayIndex(src, 3, '')).toBe(108);
  });

  it('…and scoped to EVERYTHING it is 108 — the by-construction leg, LABELLED as such', () => {
    // ⚠️ THIS COMPARISON IS TRUE BY CONSTRUCTION, NOT BY TEST (plan §2, D2). A selection
    // covering every face resolves to the same subset as no selection at all, so this leg
    // cannot fail while the implementation compiles — it is reported, not counted as
    // evidence. The `≠` leg above is the one carrying proof. Recorded here so a later
    // reader cannot quote the triple as three independent findings.
    expect(arrayIndex(boxSource(), 3, '0-5')).toBe(108);
  });

  it('🔴 a mirror scoped to half is 54, not 72', () => {
    // 6 preserved + 3 reflected = 9 faces = 18 triangles = 54 index. The GROUNDED half.
    const src = boxSource();
    expect(mirrorIndex(src, BOX_HALF)).toBe(54);
    expect(mirrorIndex(src, '')).toBe(72);
  });

  it('…and scoped to EVERYTHING it is 72 — by construction again, same caveat', () => {
    expect(mirrorIndex(boxSource(), '0-5')).toBe(72);
  });
});

describe('ns-2 exit clause 3 — the same arithmetic on a SPHERE', () => {
  // Box-only fixtures are the shape that lets a constant be hard-coded somewhere and pass —
  // doubly so since #770, when a box became the shape on which the constant is CORRECT.
  // sphere(8,6) is 48 polygons materialising to 80 triangles = 240 index; `4-27` selects 24 of
  // those faces, and because four of them are pole triangles they are 44 triangles, not 48.
  it('🔴 an array x3 scoped to half is 504, not 720; scoped to everything, 720', () => {
    // 80 preserved + 44 + 44 = 168 triangles = 504, against 240 triangles = 720 unscoped.
    const src = sphereSource();
    expect(arrayIndex(src, 3, SPHERE_HALF)).toBe(504);
    expect(arrayIndex(src, 3, '')).toBe(720);
    expect(arrayIndex(src, 3, '0-47')).toBe(720); // by construction — see the box row above
  });

  it('🔴 a mirror scoped to half is 372, not 480; scoped to everything, 480', () => {
    // 80 preserved + 44 reflected = 124 triangles = 372.
    const src = sphereSource();
    expect(mirrorIndex(src, SPHERE_HALF)).toBe(372);
    expect(mirrorIndex(src, '')).toBe(480);
    expect(mirrorIndex(src, '0-47')).toBe(480); // by construction
  });
});

describe('ns-2 exit clause 3 — the semantic discriminator', () => {
  it('🔴 a scoped array with `count = 1` is the WHOLE source — 36, not 18', () => {
    // ⚠️ 🔴 NEVER CITE THIS ROW ALONE, AND THAT IS WRITTEN HERE SO A LATER READER CANNOT.
    //
    // It separates the two SEMANTICS and nothing else in the exit does: under our rule
    // copy 0 is the preserved input, so a scoped array of one copy is the whole box (36
    // index); under the rival reading of "a subset of input primitives to copy from" it
    // would be the subset alone (18). On the sphere the same pair is 240 against 120.
    //
    // What it does NOT show is that the scope was honoured at all — an implementation
    // ignoring the scope entirely yields 36 here too. The proof of honouring is the
    // 72-vs-108 row. Cite them together (plan §2, revision 2).
    expect(arrayIndex(boxSource(), 1, BOX_HALF)).toBe(36);
    expect(arrayIndex(sphereSource(), 1, SPHERE_HALF)).toBe(240);
  });
});

describe('ns-2 exit clause 3 — the arity is doing work, stated as the rival number', () => {
  it('🔴 two scopes of the SAME cardinality over different arities give different numbers', () => {
    // THE FIXTURE'S OWN CONTROL, and it exists because this file's only difference from its
    // three predecessors is the choice of boundary. If someone later "tidies" the sphere scope
    // to one that lands inside a single arity band, every row above still passes and the file
    // silently stops testing the thing it was written for — a row that reads its own subject
    // as a literal goes green without opening it.
    //
    // 🔴 THE RIVAL IS DIFFERENT SINCE #770 AND IT IS NOW CONSTRUCTIBLE RATHER THAN NAMED. The
    // old control quoted the number a cube-side-granularity resolver WOULD produce, because
    // nothing could run one. A box's faces are its cube sides now, so that error is
    // unexpressible; the error that replaced it is expanding a polygon scope at a constant
    // arity, and the difference between the two implementations is exactly the difference
    // between these two scopes.
    //
    // `4-27` and `8-31` both name TWENTY-FOUR faces. The first is four pole triangles and
    // twenty quads (44 triangles); the second is twenty-four quads (48). A constant-arity
    // implementation cannot tell them apart — it answers 48 for both, so both mirrors would
    // read 384. Reading each face's real arity gives 372 and 384.
    //
    // Asserted through the same road as everything else, so it cannot drift from it.
    const sphere = sphereSource();
    expect(selectedFaceCount(sphere, SPHERE_HALF), 'the two scopes must be the same SIZE').toBe(
      selectedFaceCount(sphere, SPHERE_HALF_ALL_QUADS),
    );
    expect(mirrorIndex(sphere, SPHERE_HALF)).toBe(372);
    expect(mirrorIndex(sphere, SPHERE_HALF_ALL_QUADS)).toBe(384);

    // And the box, which CANNOT carry the class — stated as a measurement rather than left
    // implied, because the temptation to "restore" a box control here is the whole hazard.
    const box = boxSource();
    expect(mirrorIndex(box, '1-3')).toBe(mirrorIndex(box, '2-4'));
  });
});
