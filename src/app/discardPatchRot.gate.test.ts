// ns-2 step 11 — THE INSTRUMENT THAT MEASURES THE EXIT MUST STILL WORK. (#607, #660)
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────
//
// This phase's exit has four clauses and only one of them discriminates: the DISCARD
// perturbation. The other three are censuses, and a census bounds who may SPEAK without
// ever showing that anyone LISTENED — measured on this codebase, reverting a whole render
// wiring redded one test while discarding the resolved value at the point of use redded
// ZERO of 4059, byte for byte. So "apply the inverse edit and see what reds" is the only
// instrument here that can tell a wired road from a decorative one, and step 16 re-runs it
// as the exit.
//
// 🔴 THAT INSTRUMENT IS A `git diff` PINNED TO LINE CONTEXT, AND IT ROTS IN SILENCE.
// Nothing fails. Nothing warns. The harness is only ever run by hand, because each run is
// a full unit tier — so a dead patch stays dead until step 16 tries to run it, which is the
// worst possible moment to discover that the thing measuring your exit has not worked for
// six commits. An instrument everyone can point at and nothing checks is the
// covered-but-unhonoured shape this project has paid for three times, and it is strictly
// worse than an open gap because it gets relied on.
//
// ⚠️ THE ROT SURFACE IS NARROWER THAN IT FIRST LOOKS, and it was measured rather than
// asserted — the first draft of this comment claimed any nearby reflow would break a patch,
// and that is false. `git apply` searches for the hunk's context rather than trusting line
// numbers, so an edit three lines above the hunk is tolerated. What breaks a patch is an
// edit to a CONTEXT line or the target line, which is precisely what this gate is for.
// `tools/gates/discardPatches.ts` carries both measurements.
//
// ── WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────
//
// It asks `git apply --check`, which is the same question the harness will ask — not a
// proxy for it, so there is no gap between what passes here and what the instrument needs.
// It does NOT run the perturbations: that is four full tiers, and a gate nobody can afford
// to run is another instrument that rots.
//
// It also pins the patch SET, because a patch can rot by deletion as easily as by drift,
// and a gate that only checked the patches it found would report a serene green on an
// empty directory.
//
// ⚠️ IT READS THE WORKING TREE. A patch that cannot apply because of your own uncommitted
// edit to those lines genuinely cannot be run right now, and saying so is the honest
// answer rather than a false alarm — the harness refuses on a dirty tree for the same
// reason. CI checks out clean, so there this is purely a rot detector.
//
// REF: tools/gates/discardPatches.ts; tools/gates/discardHarness.mjs;
//      tools/gates/discards/README.md (the step-11 numbers); the ns-2 plan §8 steps 2, 11
//      and 16; issues #607, #660.

import { describe, expect, it } from 'vitest';
import { discardPatchApplicability, discardPatchNames } from '../../tools/gates/discardPatches';

/**
 * Every discard patch that must exist, as a LITERAL.
 *
 * A literal and not a count: a count cannot tell a deleted patch from a renamed one, and
 * this phase's exit names `scopeHandOff` specifically. Adding a patch is a deliberate act
 * and updating this list is the cheapest possible acknowledgement of it.
 */
const REQUIRED_PATCHES = [
  // The two controls, from step 2. The null control is what proves the harness's reporter
  // changes nothing about what runs; the positive control is on a FOREIGN road on purpose,
  // because a harness validated only against the road it was built for is validated by its
  // own author's belief that the road works.
  'inputAccepts',
  'null',
  // This phase's own road (steps 9b–11), at discard point (a), the hand-off.
  'scopeHandOff',
  'scopeNeverResolved',
  'scopeRoadRemoved',
  'scopeValueCorrupted',
  // 🔴 DISCARD POINT (b), AND THE CONTROL THIS HARNESS HAS OWED SINCE STEP 2. Every patch
  // above it discards at the hand-off; this one discards the selection INSIDE the consumer,
  // which could not be written until an operator read one (step 12). Until it had been
  // observed naming a behavioural assertion, a `red > 0` from this phase's own discard could
  // not be told apart from a harness silently no-opping on a road nobody drives.
  'scopeConsumed',
  // 🔴 THE TWO THE EXIT TABLE NAMED AND THE HARNESS DID NOT HAVE (step 16, #679).
  //
  // Discard point (b) again, once per GENERATOR. `scopeConsumed` covers the one operator
  // that WRITES through a selection; these cover the two that turn one into a geometry
  // key, and the exit requires each to red its own operator's rows and NEITHER of the
  // others'. Nothing already here could stand in for them, and that was measured rather
  // than assumed: with all eight of the other patches run, ZERO named a single row of
  // `componentScope.test.ts` — the file written specifically to grade these two. Four of
  // them patch `evaluator.ts` while a generator's rows call `evaluate` directly, and the
  // fifth corrupts a total selection's LENGTH while a generator reads only its
  // `canonicalQuery`, so a generator is structurally blind to it.
  //
  // The step that shipped each generator measured the discard by hand and wrote the number
  // into a commit message. A hand measurement is not a standing arm, and the exit is
  // re-run at every future step of this epic.
  'scopeArrayConsumed',
  'scopeMirrorConsumed',
].sort();

describe('ns-2 step 11 — the discard harness’s patches have not rotted', () => {
  it('every required patch is still present, by NAME', () => {
    expect(discardPatchNames()).toEqual(REQUIRED_PATCHES);
  });

  it('🔴 every patch still applies — the exit’s only discriminating instrument is alive', (ctx) => {
    const report = discardPatchApplicability();

    // 🔴 THE HARNESS RUNS THIS VERY TEST WITH A PATCH APPLIED, so mid-run the tree is
    // modified by construction and two of these patches touch the same hunk of
    // `evaluator.ts` — while one is on, the other genuinely cannot apply. Asserting
    // regardless would add a spurious red to every harness run that used a neighbouring
    // patch, i.e. this gate would corrupt the exit measurement it exists to protect. The
    // harness refuses to START on a dirty tree, so any run that got this far had a clean
    // tree first and this row already had its say.
    //
    // 🔴 BUT IT SKIPS RATHER THAN PASSING (#720), AND THE DIFFERENCE IS NOT COSMETIC. This
    // row abstains on a dirty tree, and a dirty tree is the normal state of a working tree
    // during development — so a silent green here covered exactly the edit-test loop in
    // which patches get rotted. Measured on #714: two full-tier runs reported
    // `368 files / 4413 tests` green with three of these patches ALREADY rotted, and the
    // third run, on a clean tree, found them. Read from a green tier, this row's own name
    // asserted something that was false for the duration of that work.
    //
    // A gate's green has to distinguish THREE states — decided-and-passed,
    // decided-and-failed, and could-not-decide — and a boolean assertion has two. `skip`
    // is the third colour. It costs nothing in the harness case above (a skip is not a
    // red, so the exit measurement is still uncorrupted) and it means a GREEN row here
    // always carries its name's claim.
    if (!report.decidable) {
      // The shape check still runs: an undecidable report must be EMPTY, not a partial
      // list that reads like a verdict.
      expect(report.patches).toEqual([]);
      ctx.skip();
      return;
    }

    const broken = report.patches.filter((r) => !r.applies);
    // The failure message carries git's own complaint, which names the file and the hunk
    // that moved. A bare "expected true" here would tell the next reader that something
    // rotted and nothing about what to fix.
    expect(broken.map((r) => `${r.name}: ${r.error ?? ''}`)).toEqual([]);
    expect(report.patches).toHaveLength(REQUIRED_PATCHES.length);
  });
});
