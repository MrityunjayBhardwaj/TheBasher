// #546 — "is this object editor chrome?" must have exactly ONE definition.
//
// ── WHY A GATE AND NOT JUST A REFACTOR ─────────────────────────────────────────────────
//
// The predicate had three spellings when this was filed, and two of them already
// described themselves as mirrors of the third in their own comments. That is the state
// this repo has learned to recognise: "one rule, N spellings", where the N+1th site is
// the one that forgets. Deduplicating without a gate leaves the fourth copy to arrive
// exactly the way the third did — a consumer that needed the answer, could not import it
// because it was module-private, and wrote it again. The third copy also got itself HALF
// wrong on its first pass (it matched the gizmo clause and not the flag clause), which is
// the failure mode in miniature: a copy that is missed does not throw, it silently starts
// measuring chrome as content.
//
// ── WHAT THE PREDICATE IS, AND WHY IT HAS TWO CLAUSES ──────────────────────────────────
//
// Clause 1 is the explicit `userData.editorChrome` flag every chrome component authors.
// Clause 2 is drei's `TransformControls`, injected raw into the scene so it cannot carry
// our flag — a workaround, and the reason the rule is worth centralising: a drei upgrade
// that renames the type, or a second raw-injected library, has to be found in ONE place.
//
// ── THE TELL, AND WHY IT IS A NAME RATHER THAN A SHAPE ─────────────────────────────────
//
// A sweep keyed to an expression's exact shape stops matching the first time someone
// moves the branch into a switch, and then reports a clean sweep forever. So the tell here
// is the two NAMES the predicate is made of — the flag and the three.js type — which any
// re-implementation must spell however it is written. Comments are stripped first: prose
// that discusses the rule is the good pattern, not a violation, and several specs discuss
// it deliberately.
//
// WRITES ARE NOT READS. `userData={{ editorChrome: true }}` is a component DECLARING
// itself chrome, which is the convention working; there are many and there should be. The
// census keys on reads — any other mention of the flag — because a read is a second
// implementation of the question.
//
// ── WHAT THIS GATE CANNOT SEE — STATED HERE, NOT DISCOVERED LATER ──────────────────────
//
// A consumer that reasons about chrome WITHOUT naming either clause — say, by matching
// object names, or by excluding a hard-coded list of groups — is invisible to a
// name-keyed census, exactly as it would be to a shape-keyed one. That is the residual
// this technique cannot close; the behavioural cover for it is the locality gate
// (`tests/e2e/p535-render-locality.spec.ts`), which reads what the renderer actually drew.
//
// REF: src/app/editorChrome.ts (the one definition); src/viewport/sceneBounds.ts +
//      src/render/renderToImage.ts (the two production consumers);
//      src/test-utils/sourceScan.ts (`stripComments`); vyapti V37 (the flag);
//      src/app/exposeParams.roadSweep.gate.test.ts (the census-with-opt-outs pattern);
//      issues #546, #535, #186.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stripComments } from '../test-utils/sourceScan';

const MODULE = 'src/app/editorChrome.ts';

/**
 * Reading the flag — i.e. re-asking the question. A WRITE declares chrome and is fine, and
 * it has two spellings: the JSX/object literal every component uses, and the assignment a
 * test fixture uses. Both were measured before this pattern was believed; the first draft
 * knew only the literal and reported `sceneBounds.test.ts` — which merely builds a chrome
 * object to test with — as a second implementation.
 */
const FLAG_WRITE = /editorChrome\s*(?::|=(?!=))\s*true/g;
/**
 * Every mention of the flag EXCEPT a module path — `'../app/editorChrome'` and
 * `'/src/app/editorChrome.ts'` both end in the flag's own name, so the first draft of this
 * tell reported each consumer as an offender the moment it started importing the
 * predicate, i.e. it reported the fix as the violation. A slash is what separates naming
 * the MODULE from reading the FLAG; the exported identifier (`isEditorChrome`) never
 * collides, being capitalised. Writes are subtracted separately.
 */
const FLAG_ANY = /(?<!\/)editorChrome/g;
/**
 * The gizmo clause. Keyed to the QUOTED type name, because that is what a type test is
 * made of however it is spelled (`startsWith` / `includes` / `===`) — while the bare
 * identifier is how five components legitimately MOUNT drei's control. The first draft
 * did not distinguish them and reported every mounting site as a copy of the predicate.
 */
const GIZMO = /['"`]TransformControls/g;

/**
 * Sites that name a clause for a DIFFERENT question, each with the reason. An opt-out is
 * a claim about intent that a census cannot make for itself; recording it here is what
 * keeps the census exact rather than approximately clean.
 */
const OPT_OUTS: Record<string, string> = {
  'tests/e2e/p322-curve-viewport-authoring.spec.ts':
    'counts gizmo objects to prove the TransformControls mounted at all — asks whether the gizmo EXISTS, not whether an object is chrome.',
};

/**
 * Every tracked source file except the definition and this gate. Both exclusions are
 * necessary and neither is a hole: the module IS the one definition, and this file has to
 * name both clauses to look for them. The patterns are regex literals rather than strings
 * so the gizmo tell does not match its own source either way.
 */
function trackedFiles(): string[] {
  const self = 'src/app/editorChrome.gate.test.ts';
  return execFileSync('git', ['ls-files', 'src', 'tests'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !/\/tmp-/.test(f) && f !== MODULE && f !== self);
}

function count(src: string, re: RegExp): number {
  return (src.match(new RegExp(re.source, 'g')) ?? []).length;
}

describe('#546 — the editor-chrome predicate has exactly one definition', () => {
  const files = trackedFiles();
  const scanned = files.map((f) => ({ file: f, src: stripComments(readFileSync(f, 'utf8')) }));

  it('the subject is real — the module exists and spells BOTH clauses', () => {
    // The companion every census needs: without it, deleting the module (or renaming a
    // clause inside it) empties the subject and turns the sweep below green while
    // covering nothing.
    expect(existsSync(MODULE), `${MODULE} must exist — it is the one definition`).toBe(true);
    const src = stripComments(readFileSync(MODULE, 'utf8'));
    expect(count(src, FLAG_ANY), 'the module must read the editorChrome flag').toBeGreaterThan(0);
    expect(count(src, GIZMO), 'the module must carry the gizmo clause').toBeGreaterThan(0);
  });

  it('the convention is real — chrome components still DECLARE themselves', () => {
    // A floor, not an exact count: new chrome is expected. Measured at 7 authoring sites.
    const writers = scanned.filter(({ src }) => count(src, FLAG_WRITE) > 0);
    expect(writers.length, 'the editorChrome convention has emptied').toBeGreaterThanOrEqual(6);
  });

  it('nobody else READS the flag — every consumer imports the predicate instead', () => {
    const offenders = scanned
      .filter(({ file }) => !(file in OPT_OUTS))
      .filter(({ src }) => count(src, FLAG_ANY) > count(src, FLAG_WRITE))
      .map(({ file }) => file);
    expect(offenders, `these re-ask the chrome question instead of importing ${MODULE}`).toEqual(
      [],
    );
  });

  it('nobody else names the gizmo clause — the drei workaround lives in one place', () => {
    const offenders = scanned
      .filter(({ file }) => !(file in OPT_OUTS))
      .filter(({ src }) => count(src, GIZMO) > 0)
      .map(({ file }) => file);
    expect(offenders, `these spell the gizmo clause instead of importing ${MODULE}`).toEqual([]);
  });
});
