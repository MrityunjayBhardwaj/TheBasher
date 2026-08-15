// ns-2 step 10 — THE GROWTH QUESTION, IN BYTES, AND THE HALF OF IT THIS STEP CANNOT ANSWER.
// (#607, #660)
//
// ── WHAT STEP 10 WAS FOR, AND WHAT WAS LEFT OF IT ─────────────────────────────────────
//
// The plan gives step 10 two halves: derive on the DEGENERATE population (every operator
// receives a TOTAL selection; every answer byte-identical), and measure registry growth
// under a swept scope query IN BYTES against D10's 16 MB budget, shipping an LRU bound
// in-phase if the budget is exceeded.
//
// 🔴 THE FIRST HALF WAS ALREADY SHIPPED, BY STEP 9b'S REPAIR. [[V205]] split a declared
// `null` from an omitted `undefined`, and the arm it added — *no scope authored, and the
// spine has a derivable face count* → `totalSelection(domain, length)` — IS the degenerate
// derivation. All four scoped operators receive a total selection today, asserted at
// `componentScopeChannel.gate.test.ts` ("a `source` operator receives a resolved selection
// with the mesh's own face count"). There is no rewrite left to land, and saying so is
// cheaper than landing a commit that changes nothing and calling it the step.
//
// ── 🔴 THE SECOND HALF CANNOT FIRE YET, AND THAT IS THIS FILE'S FIRST ROW ─────────────
//
// The plan says: "Drive a `0-N` sweep over a box and over a sphere(32,16), record resident
// scoped-build bytes and registrySize()". Run literally, on this tree, it reads:
//
//     121-frame 0-N scope sweep, box            1 distinct geometry key,  3.3 KB resident
//     121-frame 0-N scope sweep, sphere(32,16)  1 distinct geometry key, 92.6 KB resident
//
// ONE key, both times. Not because the scope is inert — the resolver genuinely produces a
// different selection every frame (counts 1..12 over a twelve-face box, asserted below) —
// but because **the geometry key does not carry a scope until step 12.5.** `array` and
// `mirror` descriptors are `{kind, source, count, offset}` and their keys are
// `` `array|${source.key}|${n}|${offset}` `` (`modifierGeometry.ts:264-270`). D9 folds the
// canonical query in; that lands at 12.5, four steps from here.
//
// So the measurement the plan calls step 10's discriminating half would, run as written,
// report "92.6 KB, far under the 16 MB budget ✅" — a pass that is an artifact of the
// feature not existing, on the one clause that was supposed to decide whether an LRU bound
// ships. This is observation target 9 again: the step's instrument was authored against a
// population that does not reach it yet.
//
// ⇒ ROW 1 RECORDS THE ZERO AND IS BUILT TO RED AT STEP 12.5. The moment `arrayGeometryRef`
// folds a scope, a 121-frame scope sweep mints 121 keys and this row fails — which is the
// point. The author who writes the fold is then the one who must face the budget, rather
// than a budget check being written afterwards by someone who already believes it is fine.
//
// ── WHAT *IS* DECIDABLE TODAY, AND IT DECIDES D10 ─────────────────────────────────────
//
// D10 refused "accept the bound" on an arithmetic estimate (C3): ≈71 KB per scoped
// array×3-over-sphere(32,16) build × ~960 canonical queries ≈ 68 MB, eighteen times a
// deferral this project already accepted. Two things in that chain had never been measured.
//
//   THE PER-BUILD COST.  C3 computed 71 KB on paper. Measured here: **69.5 KB**, within 2%.
//                        The premise is sound — D10 was decided on a good number.
//   THE SWEEP.           C3's 68 MB assumes every one of those builds stays resident. It
//                        multiplies a per-build cost by a QUERY-SPACE SIZE, with no sweep
//                        anywhere in the arithmetic. But D9 folds the scope into the key
//                        precisely so scoped builds live INSIDE the registry, where the
//                        scene sweep has jurisdiction — and the sweep's growth trigger
//                        (`SWEEP_GROWTH_BUDGET`, 64 entries) is a ceiling on how many
//                        builds can be resident between two sweeps. The bound is not
//                        `queries × perBuild`. It is `SWEEP_GROWTH_BUDGET × perBuild`.
//
//                            64 × 69.5 KB  =  4.34 MB peak,  against a 16 MB budget.
//
//                        Even the unbounded reading — all 121 frames of a drag resident at
//                        once, no sweep at all — is **8.21 MB**, still under budget.
//
// 🔑 **D10's FALLBACK IS EXPLICITLY NOT NEEDED, WITH THE NUMBER.** That is the plan's own
// done-when ("either shipped or explicitly not needed, with the number"), and the number
// says not needed. What makes this safe to conclude rather than hope is that the ceiling is
// asserted below rather than assumed: if the growth budget rises, or a scoped build gets
// more expensive, row 4 reds and the decision is re-taken by whoever moved it.
//
// ⚠️ WHAT THIS DOES NOT CLAIM. That the sweep FIRES often enough during a real drag is a
// question about cadence in a browser, not about jurisdiction, and #650 already records
// that both triggers are population-driven — favourable here, since a scope drag grows the
// population every frame, but it is a browser observation and it belongs to step 18.
// Row 2 claims only what it measures: the sweep CAN reclaim these builds, completely.
//
// ── THE NUMBER NOBODY ASKED FOR, RECORDED BECAUSE THE CONTROL FOUND IT ────────────────
//
// The control for row 1 — an equal-cardinality sweep of a key component that DOES vary —
// is `count`, and it is a shipped road with no scope in it at all. 121 frames over a
// sphere(32,16) leave **170 MB** resident unswept. That is ten times the budget this phase
// argues about, on a road that ships today, and it is exactly what #587's sweep exists to
// contain. Recorded as a number rather than as an alarm: it is the sweep's justification,
// measured, and it is why row 2's jurisdiction result is the load-bearing one.
//
// REF: src/app/geometryRegistry.ts (`residentBytes` — #588's byte instrument, and read its
//      warning about counting each ArrayBuffer once); src/viewport/geometrySweep.ts
//      (`SWEEP_GROWTH_BUDGET`); src/app/modifierGeometry.ts:264 (the key that does not yet
//      carry a scope); src/nodes/componentSelection.ts (`resolveComponentSelection`'s
//      degenerate arm); the plan's §5 D9/D10 and §8 step 10; issues #607, #650, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import {
  boxDescriptor,
  boxGeometryRef,
  sphereDescriptor,
  sphereGeometryRef,
} from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { hydrateInlineMaterial } from '../nodes/materialSchema';
import * as registry from './geometryRegistry';
import {
  __resetSelectionMemoForTests,
  resolveComponentSelection,
} from '../nodes/componentSelection';
import { SWEEP_GROWTH_BUDGET } from '../viewport/geometrySweep';
import type { MeshDataValue, ModifiedDataValue, ObjectData } from '../nodes/types';

/** D10's budget, in bytes. The one number this whole file is measured against. */
const BUDGET_BYTES = 16 * 1024 * 1024;

/** The drag length every measurement here uses, so the numbers are comparable. */
const DRAG_FRAMES = 121;

function meshOf(which: 'box' | 'sphere'): MeshDataValue {
  const descriptor = which === 'box' ? boxDescriptor([1, 1, 1]) : sphereDescriptor(1, 32, 16);
  const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
  return {
    kind: 'MeshData',
    geometry:
      which === 'box'
        ? boxGeometryRef([1, 1, 1], attributeKey)
        : sphereGeometryRef(1, 32, 16, attributeKey),
    material: hydrateInlineMaterial(null, '#123456'),
    materialKey: null,
    attributeKey,
  };
}

/**
 * Cook an ArrayModifier through the REAL evaluator and FORCE the registry build.
 *
 * The build is forced deliberately: `evaluate` mints a `GeometryRef` (a key and a
 * descriptor) and allocates no buffers at all, so a growth measurement that stopped at
 * evaluate would read zero bytes for every road and prove nothing about any of them. The
 * bytes appear when something attaches the handle, which is what the renderer does.
 */
function cook(mesh: MeshDataValue, params: Record<string, unknown>): string {
  const out = evaluateNodeAlone('ArrayModifier', params, { target: mesh }) as ModifiedDataValue;
  registry.getForAttach(out.geometry);
  return out.geometry.key;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
  registry.clear();
  registry.resetGrowth();
  __resetSelectionMemoForTests();
  // [[H329]] — growth counts over a never-evicting content-keyed store are order-dependent
  // WITHIN a file. A case that inherited the previous case's population would pass or fail
  // depending on the order the cases happen to be written in, so the fresh start is
  // ASSERTED rather than trusted to the reset calls above.
  expect(registry.size()).toBe(0);
  expect(registry.residentBytes()).toBe(0);
});

describe('ns-2 step 10 — row 1: the scope is not in the key yet, and this row reds when it is', () => {
  it('🔴 a 121-frame `0-N` scope sweep over a BOX mints exactly ONE geometry key', () => {
    const mesh = meshOf('box');
    const keys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      keys.add(cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: `0-${n}` }));
    }
    // ONE. Stated as the literal 1, never as "fewer than the frame count": the whole value
    // of this row is that it becomes 121 the moment step 12.5 folds the canonical query in.
    expect(keys.size).toBe(1);
    expect(registry.growthBySource().attach).toBe(1);
  });

  it('🔴 …and so does the same sweep over a SPHERE(32,16) — it is the key, not the mesh', () => {
    const mesh = meshOf('sphere');
    const keys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      keys.add(cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: `0-${n}` }));
    }
    expect(keys.size).toBe(1);
    expect(registry.growthBySource().attach).toBe(1);
  });

  it('the zero is NOT the scope being inert — the resolver answers differently every frame', () => {
    // The discriminator for row 1's reading. A sweep that minted one key because the query
    // never reached the resolver, and a sweep that minted one key because the resolver's
    // answer never reaches the KEY, are the same observation and completely different
    // findings. A twelve-face box gives `0-N` twelve distinct answers.
    const mesh = meshOf('box') as ObjectData;
    const counts = Array.from({ length: 12 }, (_, n) => {
      const selection = resolveComponentSelection(mesh, { scope: `0-${n}` });
      return selection === null ? -1 : selection.count;
    });
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('…and the query reaches the parser THROUGH the evaluator, on the sweep’s own road', () => {
    // The row above asks the resolver directly, which proves the resolver discriminates and
    // NOT that the sweep's frames ever got there — two different claims, and the sweep's is
    // the one row 1 rests on. The evaluator hands `scopeFor` the RAW `node.params`
    // (`evaluator.ts:259`), not the schema-parsed ones, so a query the schema would strip
    // still arrives. A malformed one is the cheapest proof it does: if it throws by name,
    // the parser ran on this exact road, which is the road rows 1 and 2 sweep down.
    const mesh = meshOf('box');
    expect(() => cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: 'arm*' })).toThrow(
      /wildcards are not implemented/,
    );
  });
});

describe('ns-2 step 10 — row 2: the sweep’s jurisdiction over array builds, measured', () => {
  it('a sweep with one live build reclaims every other one, in entries AND in bytes', () => {
    const mesh = meshOf('sphere');
    let last = mesh.geometry;
    for (let n = 1; n <= DRAG_FRAMES; n += 1) {
      const out = evaluateNodeAlone(
        'ArrayModifier',
        { count: n, offset: [1, 0, 0], muted: false },
        { target: mesh },
      ) as ModifiedDataValue;
      registry.getForAttach(out.geometry);
      last = out.geometry;
    }
    const beforeBytes = registry.residentBytes();
    const beforeSize = registry.size();
    const live = registry.getForAttach(last);
    expect(live).not.toBeNull();

    const result = registry.sweep(new Set(live ? [live] : []));

    // D10's assumption, in three numbers rather than one: the entries go, the BYTES go,
    // and the sweep says how many it disposed. Bytes are the load-bearing one — an entry
    // count cannot tell a reclaimed sphere array from a reclaimed empty geometry.
    expect(result.disposed).toBe(DRAG_FRAMES);
    expect(registry.size()).toBe(1);
    expect(registry.residentBytes()).toBeLessThan(beforeBytes / 10);
    expect(beforeSize).toBe(DRAG_FRAMES + 1);
  });
});

describe('ns-2 step 10 — rows 3 and 4: the per-build cost, and the budget it implies', () => {
  it('one scoped array×3 over a sphere(32,16) costs ~69.5 KB resident — C3 said 71 KB', () => {
    const mesh = meshOf('sphere');
    registry.getForAttach(mesh.geometry);
    const sourceOnly = registry.residentBytes();
    cook(mesh, { count: 3, offset: [1, 0, 0], muted: false });
    const perBuild = registry.residentBytes() - sourceOnly;

    // Bounded rather than pinned to the byte, because the exact figure is three.js's
    // buffer layout and a minor version may move it. The claim being made is that C3's
    // PAPER arithmetic matches a real allocation, which a ±15% window tests and an exact
    // literal would only make brittle.
    expect(perBuild).toBeGreaterThan(60 * 1024);
    expect(perBuild).toBeLessThan(80 * 1024);
  });

  it('🔴 the peak is bounded by the SWEEP’s growth budget, not by the query space', () => {
    const mesh = meshOf('sphere');
    registry.getForAttach(mesh.geometry);
    const sourceOnly = registry.residentBytes();
    cook(mesh, { count: 3, offset: [1, 0, 0], muted: false });
    const perBuild = registry.residentBytes() - sourceOnly;

    // THE DECISION, as arithmetic that reds if either input moves. C3 multiplied the
    // per-build cost by the size of the QUERY SPACE (~960) and got 68 MB, which is what
    // refused "accept the bound". But a scoped build lives inside the registry (D9), and
    // no more than one growth budget of entries can be resident between two sweeps — so
    // the ceiling is the growth budget, not the query space.
    const peakBytes = perBuild * SWEEP_GROWTH_BUDGET;
    expect(peakBytes).toBeLessThan(BUDGET_BYTES);

    // And the pessimistic reading too: a whole drag resident at once, sweep never firing.
    // Still under budget, which is what makes the conclusion robust to the cadence
    // question this file explicitly does not answer.
    const unsweptDragBytes = perBuild * DRAG_FRAMES;
    expect(unsweptDragBytes).toBeLessThan(BUDGET_BYTES);
  });
});

describe('ns-2 step 10 — row 5: what the shipped `count` road costs unswept', () => {
  it('121 distinct array builds over a sphere(32,16) hold ~170 MB with no sweep', () => {
    const mesh = meshOf('sphere');
    for (let n = 1; n <= DRAG_FRAMES; n += 1) {
      cook(mesh, { count: n, offset: [1, 0, 0], muted: false });
    }
    const bytes = registry.residentBytes();

    // Recorded, not alarmed at. This is a road that ships today with no scope anywhere in
    // it, and the number is ten times the budget this phase argues about — which is the
    // measured justification for the sweep existing at all (#587), and the reason row 2's
    // jurisdiction result is the one carrying the decision rather than row 4's arithmetic.
    // Asserted only as an order of magnitude: the exact figure is a function of the drag
    // length and the mesh, both of which are this file's choices.
    expect(registry.size()).toBe(DRAG_FRAMES + 1);
    expect(bytes).toBeGreaterThan(100 * 1024 * 1024);
  });
});
