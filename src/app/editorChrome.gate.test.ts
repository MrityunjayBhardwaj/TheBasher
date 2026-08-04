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
 * The two sweeps this gate runs. They are INDEPENDENT questions — "who re-implements the
 * flag test" and "who re-implements the drei type test" — and a file can legitimately need
 * one exemption without the other.
 */
type Check = 'flag' | 'gizmo';

/**
 * Sites that name a clause for a DIFFERENT question, each with the reason — recorded
 * PER CHECK, because an opt-out is a claim about intent and the intent is per clause.
 *
 * This map was keyed by FILE until #561. That silently granted every exemption to both
 * sweeps, which is not what any of the three entries below meant: two of them say in their
 * own words that they only ever name the gizmo. Measured at the time: a real second
 * implementation of the flag read, appended to `p168-render-to-image.spec.ts`, left this
 * gate green — while the identical line in a non-exempt file reddened it. An exemption
 * applied more broadly than it was recorded gives back exactly the exactness this map is
 * here to buy, and it does it in the two files most likely to grow a hand-rolled chrome
 * check, since they already build chrome subjects by hand.
 *
 * Every entry is asserted LOAD-BEARING below: an exemption for a check the file does not
 * actually trip is stale, and a stale exemption reads as meaningful while covering nothing.
 */
const OPT_OUTS: Record<string, Partial<Record<Check, string>>> = {
  'tests/e2e/p322-curve-viewport-authoring.spec.ts': {
    gizmo:
      'counts gizmo objects to prove the TransformControls mounted at all — asks whether the gizmo EXISTS, not whether an object is chrome.',
  },
  'src/render/renderToImage.test.ts': {
    flag: "the render road's per-clause tests (#557) build a FLAGGED subject by hand and assert the gizmo subject carries no flag — naming the flag is how the subjects are made. Importing the predicate here would test it against itself.",
    gizmo:
      'the same tests build a TransformControls-typed subject by hand, and the whole point is that neither subject satisfies the other clause.',
  },
  'tests/e2e/p168-render-to-image.spec.ts': {
    gizmo:
      'same question as p322 — counts gizmo objects to prove a selection actually mounted the control, which the predicate cannot answer because it deliberately returns only chrome/not-chrome (#557). It asks the CHROME question through the imported predicate and only ever WRITES the flag (planting a chrome occluder), so it is an offender for the gizmo sweep alone.',
  },
};

/** Is `file` exempt from THIS check specifically? */
function exempt(file: string, check: Check): boolean {
  return Boolean(OPT_OUTS[file]?.[check]);
}

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

/**
 * Whether a file trips a given sweep, independent of any exemption. ONE definition per
 * check, consumed by both the sweep and the load-bearing assertion below, so the two can
 * never drift into disagreeing about what an offender is.
 */
const OFFENDS: Record<Check, (src: string) => boolean> = {
  flag: (src) => count(src, FLAG_ANY) > count(src, FLAG_WRITE),
  gizmo: (src) => count(src, GIZMO) > 0,
};

describe('#546 — the editor-chrome predicate has exactly one definition', () => {
  const files = trackedFiles();
  const scanned = files.map((f) => ({ file: f, src: stripComments(readFileSync(f, 'utf8')) }));

  /** Files tripping `check` that are not exempt from THAT check. */
  const offenders = (check: Check) =>
    scanned.filter(({ file }) => !exempt(file, check)).filter(({ src }) => OFFENDS[check](src));

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
    expect(
      offenders('flag').map(({ file }) => file),
      `these re-ask the chrome question instead of importing ${MODULE}`,
    ).toEqual([]);
  });

  it('nobody else names the gizmo clause — the drei workaround lives in one place', () => {
    expect(
      offenders('gizmo').map(({ file }) => file),
      `these spell the gizmo clause instead of importing ${MODULE}`,
    ).toEqual([]);
  });

  it('every opt-out is LOAD-BEARING — no file is exempted from a check it does not trip', () => {
    // Without this, the map rots in the direction that looks harmless: an entry survives a
    // refactor that removed the very mention it was written for, and from then on it is a
    // standing exemption for a file nobody has re-read. The same failure the sweeps guard
    // against — a claim that has stopped being measured — one level up.
    const byFile = new Map(scanned.map(({ file, src }) => [file, src]));
    const stale: string[] = [];
    for (const [file, checks] of Object.entries(OPT_OUTS)) {
      const src = byFile.get(file);
      // A named file that is no longer tracked is stale in a second way — it cannot be
      // scanned at all, so its exemption covers nothing and hides a typo in the path.
      if (src === undefined) {
        stale.push(`${file} (not a tracked source file — renamed or deleted?)`);
        continue;
      }
      for (const check of Object.keys(checks) as Check[]) {
        if (!OFFENDS[check](src)) stale.push(`${file} → '${check}'`);
      }
    }
    expect(stale, 'these exemptions no longer buy anything — delete them').toEqual([]);
  });
});
