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
// scoped-build bytes and registrySize()". Run literally, on the step-10 tree, it read:
//
//     121-frame 0-N scope sweep, box            1 distinct geometry key,  3.3 KB resident
//     121-frame 0-N scope sweep, sphere(32,16)  1 distinct geometry key, 92.6 KB resident
//
// ONE key, both times. Not because the scope was inert — the resolver genuinely produces a
// different selection every frame (counts 1..12 over a twelve-face box, asserted below) —
// but because at step 10 **nothing folded a scope into a geometry key at all.** `array` and
// `mirror` descriptors were `{kind, source, count, offset}` and their keys were
// `` `array|${source.key}|${n}|${offset}` ``. D9 folds the canonical query in; that landed
// at step 12.5, and the next block is what happened when it did.
//
// So the measurement the plan calls step 10's discriminating half would, run as written,
// report "92.6 KB, far under the 16 MB budget ✅" — a pass that is an artifact of the
// feature not existing, on the one clause that was supposed to decide whether an LRU bound
// ships. This is observation target 9 again: the step's instrument was authored against a
// population that does not reach it yet.
//
// ⇒ ROW 1 RECORDS THE ZERO AND IS BUILT TO RED WHEN THE FOLD REACHES THIS ROAD. The author
// who writes the fold is then the one who must face the budget, rather than a budget check
// being written afterwards by someone who already believes it is fine.
//
// ── 🔴 STEP 12.5 LANDED AND ROW 1 DID NOT RED. THE FUSE WAS AIMED ONE STEP SHORT ──────
//
// This file predicted, in these words: *"the moment `arrayGeometryRef` folds a scope, a
// 121-frame scope sweep mints 121 keys and this row fails."* Step 12.5 made
// `arrayGeometryRef` fold a scope. Measured on that tree: **still 1 key**, and the tier
// green. The sentence named the wrong subject.
//
// The sweep below cooks through `ArrayModifier.evaluate`, and that operator RECEIVES a
// resolved selection and discards it — by design, until step 13a makes it the first
// `'source'` consumer. So the fold exists at the key builder and nothing on this road calls
// it with a scope. Two different things had been collapsed into one phrase:
//
//     the KEY CAN carry a scope        step 12.5.  Measured below, on the descriptor road:
//                                      121 distinct keys, 6.99 MB over a sphere sweep.
//     the OPERATOR PUTS one there      step 13a.  What this row is actually waiting for.
//
// ⇒ the row keeps its literal `1` and is RE-AIMED, not relaxed and not deleted: the step
// that makes `ArrayModifier` pass its selection into `arrayGeometryRef` is the step that
// reds it. And because the budget question no longer has to wait for that step, it is
// ANSWERED HERE instead, against the real allocation — see row 6.
//
// 🔑 The general shape, and it is the second time in three steps: a fuse names the commit
// it expects to blow it, and "the commit that adds the mechanism" is not the same as "the
// commit that puts a caller on the road the fuse measures". Name the CALLER.
//
// ── ✅ STEP 13a IS THAT CALLER, AND THE RE-AIMED FUSE BLEW EXACTLY THERE ──────────────
//
// `ArrayModifier` declares a `scope` param and folds the resolved selection's
// `canonicalQuery` into `arrayGeometryRef`. The sweep below runs through that operator, so
// row 1's `1` became `121` and the row was updated to the new literal WITH the bytes
// beside it — which is the whole reason the fuse was written as a number rather than as a
// bound. The author who put a caller on this road is the one facing the budget.
//
//     121-frame 0-N sweep, box, THROUGH THE OPERATOR      121 keys,   0.29 MB
//     121-frame 0-N sweep, sphere(32,16), same road       121 keys,   6.99 MB
//     the same sweep driven through the DESCRIPTOR        121 keys,   6.99 MB
//
// 🔑 THE TWO ROADS AGREE TO THE BYTE — 7,325,820 B each, and that equality is now asserted
// as row 1's third case. It is a stronger statement than either number alone: it says the
// operator hands the key builder exactly the canonical query the descriptor road hands it,
// so the identity does not fork between the road a director drives and the road the gate
// measures. What it CANNOT see is a change to `arrayGeometryRef` itself ([[V189]] — both
// sides reach it through one builder), which is why the discriminating rows for this step
// are the arithmetic ones and not this equality.
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
//                        once, no sweep at all — projected **8.21 MB**, still under budget.
//                        🔴 MEASURED AT 12.5 against a real allocation: **6.99 MB**. Lower
//                        than the projection, because a scoped build is SMALLER than the
//                        unscoped one it replaces — the index shrinks while the positions
//                        ride through. Row 6 asserts both the total and that inequality,
//                        since row 4's ceiling uses the unscoped cost as its per-item
//                        figure and is only a ceiling if scoping cannot make a build
//                        bigger.
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
//      (`SWEEP_GROWTH_BUDGET`); src/app/modifierGeometry.ts (`arrayGeometryRef` — the key,
//      which folds a canonical scope since step 12.5); src/nodes/ArrayModifier.ts (the
//      caller that does not yet pass one — step 13a, and what row 1 is waiting for);
//      src/nodes/componentSelection.ts (`resolveComponentSelection`'s
//      degenerate arm); the plan's §5 D9/D10 and §8 step 10; issues #607, #650, #660.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import {
  arrayGeometryRef,
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

describe('ns-2 step 10 — row 1: the OPERATOR puts its scope in the key, and this row is what measured it arriving', () => {
  it('🔴 a 121-frame `0-N` scope sweep over a BOX mints 121 geometry keys, at 0.29 MB', () => {
    const mesh = meshOf('box');
    const keys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      keys.add(cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: `0-${n}` }));
    }
    // 🔴 THE FUSE BLEW HERE, AT STEP 13a, AND THIS IS THE NEW LITERAL. It read `1` from
    // step 10 until now, twice re-examined: green at 12.5 (the key COULD carry a scope, but
    // no caller put one there) and red at 13a (`ArrayModifier` folds its resolved
    // selection's `canonicalQuery`). One key per frame, stated as the frame count, never as
    // "more than one".
    expect(keys.size).toBe(DRAG_FRAMES);
    expect(registry.growthBySource().attach).toBe(DRAG_FRAMES);

    // AND THE BUDGET, WHICH IS THE POINT OF THE FUSE — the author who put the caller on
    // this road faces it here rather than inheriting a check written by someone who already
    // believed it was fine. A box is the cheap end: 121 resident scoped builds, 0.29 MB.
    const bytes = registry.residentBytes();
    expect(bytes).toBeLessThan(BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(200 * 1024);
    expect(bytes).toBeLessThan(400 * 1024);
  });

  it('🔴 …and the same sweep over a SPHERE(32,16) mints 121 too, at 6.99 MB, under budget', () => {
    const mesh = meshOf('sphere');
    const keys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      keys.add(cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: `0-${n}` }));
    }
    expect(keys.size).toBe(DRAG_FRAMES);
    expect(registry.growthBySource().attach).toBe(DRAG_FRAMES);

    // The expensive end, and the number D10 was decided against. Bounded rather than pinned
    // to the byte — the exact figure is three.js's buffer layout — but the BUDGET comparison
    // is exact, because that is the clause this file exists to settle.
    const bytes = registry.residentBytes();
    expect(bytes).toBeLessThan(BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(bytes).toBeLessThan(9 * 1024 * 1024);
  });

  it('🔴 the operator road and the DESCRIPTOR road agree to the byte', () => {
    // What the pair of numbers used to discriminate, now that they have converged. Until
    // 13a row 1 read 1 and row 6 read 121, and the gap WAS the finding. The gap is closed,
    // so the equality replaces it: the operator hands the key builder exactly the canonical
    // query the descriptor road hands it, and neither the key set nor the resident bytes
    // fork between them.
    //
    // ⚠️ WHAT IT CANNOT SEE, said here so it is not over-read: both roads end at
    // `arrayGeometryRef`, so a change to that builder moves both sides together
    // ([[V189]]). This row catches the operator dropping or mangling the scope on the way;
    // the arithmetic rows catch the builder.
    const viaOperator = new Set<string>();
    const mesh = meshOf('sphere');
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      viaOperator.add(cook(mesh, { count: 3, offset: [1, 0, 0], muted: false, scope: `0-${n}` }));
    }
    const operatorBytes = registry.residentBytes();

    registry.clear();
    registry.resetGrowth();
    const viaDescriptor = new Set<string>();
    const fresh = meshOf('sphere');
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      const ref = arrayGeometryRef(fresh.geometry, 3, [1, 0, 0], `0-${n}`);
      registry.getForAttach(ref);
      viaDescriptor.add(ref.key);
    }
    expect([...viaOperator].sort()).toEqual([...viaDescriptor].sort());
    expect(registry.residentBytes()).toBe(operatorBytes);
  });

  it('the sweep is NOT the scope being inert — the resolver answers differently every frame', () => {
    // The discriminator this row carried while the sweep read 1, kept now that it reads 121
    // because it still separates two different things: a sweep whose frames each mint a key
    // because the resolver genuinely discriminates, and one that would mint keys off a
    // string the resolver never looked at. A twelve-face box gives `0-N` twelve distinct
    // answers, and those twelve are what the operator's selection is built from.
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

describe('ns-2 step 12.5 — row 6: the fold exists, so the budget is measured, not projected', () => {
  // What step 10 could not run. The key builder folds a canonical query now, so a 121-frame
  // `0-N` sweep driven through the DESCRIPTOR mints a real build per frame — the allocation
  // D10's arithmetic was about. Row 1 above still reads 1 because the operator does not pass
  // a scope yet; the pair of numbers is the whole point of having both rows.

  it('🔴 the same sweep through the DESCRIPTOR mints 121 keys and stays under budget', () => {
    const mesh = meshOf('sphere');
    const keys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      const ref = arrayGeometryRef(mesh.geometry, 3, [1, 0, 0], `0-${n}`);
      registry.getForAttach(ref);
      keys.add(ref.key);
    }
    // One key per frame — the growth shape D10 refused to accept on an estimate.
    expect(keys.size).toBe(DRAG_FRAMES);

    // 🔴 AND 121, NOT 12, OVER A BOX TOO — which contradicts the projection step 10 made
    // under a simulated fold ("box: 12 keys, because the bound is DISTINCT ANSWERS and a
    // box has twelve faces"). The bound is distinct CANONICAL QUERIES, not distinct
    // answers: the canonicaliser deliberately does not know how many faces the mesh has,
    // because knowing would make it O(elements) on the drag road ([[V204]] — sound, not
    // total). The simulation had folded the resolved mask, which is the key option D9
    // REJECTED, so it measured the rejected design. Asserted here on a box so the two
    // cannot be confused again.
    const box = meshOf('box');
    const boxKeys = new Set<string>();
    for (let n = 0; n < DRAG_FRAMES; n += 1) {
      boxKeys.add(arrayGeometryRef(box.geometry, 3, [1, 0, 0], `0-${n}`).key);
    }
    expect(boxKeys.size).toBe(DRAG_FRAMES);

    // THE BUDGET, against a real allocation instead of a projection. Predicted at step 10
    // from a reverted simulation: 8.21 MB. Measured here: 6.99 MB — LOWER, because a scoped
    // build is smaller than an unscoped one (the index shrinks; the positions ride through
    // as dead weight). Bounded rather than pinned to the byte, since the exact figure is
    // three.js's buffer layout.
    const dragBytes = registry.residentBytes();
    expect(dragBytes).toBeLessThan(BUDGET_BYTES);
    expect(dragBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(dragBytes).toBeLessThan(9 * 1024 * 1024);
  });

  it('a scoped build is never more expensive than the unscoped one it replaces', () => {
    // The premise under row 4's ceiling. `SWEEP_GROWTH_BUDGET x perBuild` uses the UNSCOPED
    // per-build cost as the per-item figure, which is only a ceiling if scoping cannot make
    // a build bigger. Measured: 63.8 KB scoped to half against 69.5 KB unscoped. It is not
    // obvious — a subset keeps every position and only drops index entries — so it is
    // asserted rather than assumed.
    const mesh = meshOf('sphere');
    registry.getForAttach(mesh.geometry);
    const sourceOnly = registry.residentBytes();
    registry.getForAttach(arrayGeometryRef(mesh.geometry, 3, [1, 0, 0]));
    const unscoped = registry.residentBytes() - sourceOnly;

    registry.clear();
    const fresh = meshOf('sphere');
    registry.getForAttach(fresh.geometry);
    const freshSource = registry.residentBytes();
    registry.getForAttach(arrayGeometryRef(fresh.geometry, 3, [1, 0, 0], '0-479'));
    const scoped = registry.residentBytes() - freshSource;

    expect(scoped).toBeLessThanOrEqual(unscoped);
    expect(unscoped * SWEEP_GROWTH_BUDGET).toBeLessThan(BUDGET_BYTES);
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
