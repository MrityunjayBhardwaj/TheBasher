// The retire-a-kind gate (#471, Deliverable B-III) — no tracked end-to-end spec and no
// production file may CONSTRUCT a node type that the object↔data split has retired.
//
// WHY THIS EXISTS, and why a green suite is not the same thing.
// Retiring a fused kind turns its `evaluate` into a throwing sentinel, so any fixture that
// EVALUATES a relic fails loudly — that half is already mechanised and needs no gate. The
// hole is the other half: a fixture that BUILDS a relic and never evaluates it stays green
// while measuring a shape no user can create any more. That has happened twice, both times
// found the expensive way. Three specs carried a retired fused light for a whole release and
// stayed green because nothing evaluated it (#386 slice 5). Sixteen specs quietly failed for
// three merges because they still built a fused `SphereMesh` (#462). Neither had anything
// watching the SET of retired kinds against the files that name them.
//
// WHAT IT IS SCOPED TO, and the reasoning is load-bearing — this gate's scope was MEASURED,
// not assumed, and the measurement moved it twice:
//
//   1. It matches a CONSTRUCTION POSITION (`nodeType: '<relic>'`), never a bare name.
//      Necessary, because the relic names are OVERLOADED. `'DirectionalLight'` is
//      simultaneously a retired node type AND a live `LightValue.kind` discriminator (the
//      recompose target, src/nodes/types.ts:56) AND an Add-menu creation kind
//      (src/app/addPrimitives.ts). A name-grep over src/ fires on ~20 files of permanent,
//      correct code and would need an allowlist longer than the thing it guards. `nodeType:`
//      is the one position that unambiguously means "mint a node of this type".
//
//   2. It strips COMMENTS first. Four end-to-end specs name a relic in prose precisely to
//      record that it is retired (`// The fused 'Curve' node type is retired.`). Those are
//      the good pattern, not carriers, and a comment cannot build a node. Stripping costs
//      ~30 lines and buys an allowlist of zero — see `stripComments` on why it tracks string
//      state rather than blanking from `//` to end-of-line.
//
//   3. It reads the TRACKED file list, not the filesystem. There are commonly a dozen or
//      more untracked `tmp-*.spec.ts` probes in a working tree and they freely build relics.
//      A gate that is red locally and green in CI gets switched off, so the subject has to be
//      exactly what CI sees: `git ls-files`.
//
//   4. It scans `tests/**` AND `src/**`, unit tests included. It did not always: unit
//      fixtures were carved out because ~22 of them built a relic to exercise graph plumbing
//      and never evaluated it, which made them stale rather than broken and a separate blast
//      radius — filed as #476. #476 is done, so the carve-out went with it. Keeping it would
//      have left the finished state indistinguishable from the debt: the gate would pass
//      either way, and the next fixture to reach for a relic would be caught by nobody.
//
//      The CARRIER sweep widened; the SENTINEL derivation below did NOT. A retirement is
//      something a relic declares in its own production source, so deriving the retired set
//      from test files as well would let a test that merely quotes the sentinel enrol a type
//      that no node ever retired — the same failure that made this issue 22 files instead of
//      17, but from the other side: a set gaining a non-member rather than missing one.
//      Measured before the split: no test file matches the sentinel
//      pattern today, so the two lists agree right now and the separation is about what may
//      happen next, not about a current disagreement.
//
// THE ALLOWLIST IS EMPTY, AND IT SHOULD STAY THAT WAY. An accepted carrier is how a gate
// comes to excuse the very thing it was built to catch, so `ACCEPTED_CARRIERS` requires a
// reason and an issue number per entry and is asserted as a SET (a novel carrier fails; an
// entry whose file is clean is reported as prunable) rather than consulted as a label.
//
// WHAT IT CANNOT GUARD — stated because a gate that hides its blind spot reads as more
// coverage than it has. A relic minted through a COMPUTED type (`nodeTypeFor(kind)`) is
// invisible to any grep. That path is covered instead by the throwing sentinel plus the
// registry: production code that computed its way to a relic would throw on first evaluate.
//
// REF: src/test-utils/splitKinds.ts (`fusedTypes` — the derived subject); src/a11y/grepGates.test.ts
//      (the grep-gate-as-unit-test precedent this mirrors); .anvi/krama.md K23 finding 6 (the
//      green-suite-proves-nothing case); issues #471, #462, #476.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { snapshotRegistry } from '../core/dag/registry';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { stripComments } from './sourceScan';
import { SPLIT_KINDS, SPLIT_KIND_NAMES } from './splitKinds';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * A tracked file this gate accepts as a carrier despite the rule.
 *
 * Empty on purpose. Adding an entry means the gate stops protecting that file, so each one
 * carries the reason and the issue that will remove it — and the assertion below treats this
 * as a set, so an entry that is no longer needed is reported rather than quietly kept.
 *
 * Distinct from `RELIC_IS_THE_SUBJECT` below: an entry here is DEBT with an expiry, and its
 * issue number is the expiry. Those two are permanent and have no issue, because there is
 * nothing to fix.
 */
const ACCEPTED_CARRIERS: readonly { file: string; why: string; issue: string }[] = [];

/**
 * The files that must construct a retired kind FOREVER, because the relic is their subject
 * rather than their scaffolding. Not an allowlist — an allowlist excuses; this states a
 * category, and the category has exactly two members.
 *
 * The distinction that decides membership: would the file still make its point if the relic
 * were replaced by a live kind? For every fixture #476 retargeted, yes — the relic was a
 * stand-in for "some node". For these two, no. A migration that does not build the
 * pre-migration shape proves nothing, and a detector whose fixtures are not the thing it
 * detects is testing a different regex.
 *
 * Asserted as a set below in BOTH directions, exactly like ACCEPTED_CARRIERS: a member that
 * has stopped carrying a relic is reported, so this cannot quietly outlive its reason.
 */
const RELIC_IS_THE_SUBJECT: readonly { file: string; why: string }[] = [
  {
    file: 'src/core/project/migrations.test.ts',
    why: 'byte-identity fixtures for the load-migration — it must hand-build the PRE-migration shape, which is the fused kind, or it is not testing a migration',
  },
  {
    file: 'src/test-utils/retiredKinds.gate.test.ts',
    why: 'this file — its positive controls are relic constructions in string literals, and they are what prove the detector is not vacuous while its real subject is empty',
  },
];

/**
 * Every node type the split has retired, derived from the kind descriptor rather than listed.
 *
 * Derived, because a list is a checklist: #388 and #389 each retire more fused types, and a
 * hardcoded set would silently stop covering them. `fusedTypes` is already the one place each
 * kind records what it replaced, so a new kind enrolls in this gate by existing. Note that
 * `AmbientLight` is correctly absent — ambient is a World datablock and never split, the one
 * partial retirement.
 */
function retiredNodeTypes(): string[] {
  return [...new Set(SPLIT_KIND_NAMES.flatMap((kind) => [...SPLIT_KINDS[kind].fusedTypes]))].sort();
}

// `stripComments` moved to `./sourceScan` when #387's band grep-gate became its second
// consumer — same reasoning, stated there. Enumerating tracked files stayed HERE (and in
// the other gate) because `src/test-utils/*.ts` is typechecked against a tsconfig with no
// `@types/node`, so a shared helper could not call `git ls-files`.

/** The construction position: `nodeType: '<relic>'`, in any of the three quote styles. */
function carrierPattern(types: readonly string[]): RegExp {
  const alt = types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\bnodeType\\s*:\\s*['"\`](${alt})['"\`]`);
}

/** Every tracked `.ts`/`.tsx` under `src/` and `tests/` — exactly what CI sees. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src', 'tests'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => /\.tsx?$/.test(p));
}

/** Where a retirement is DECLARED: production source only. See note 4 in the header. */
function sentinelFiles(): string[] {
  return trackedFiles().filter((p) => !/\.test\.tsx?$/.test(p));
}

/** Where a relic may not be CONSTRUCTED: everything except the two files it is the subject of. */
function scannedFiles(): string[] {
  const subjects = new Set(RELIC_IS_THE_SUBJECT.map((s) => s.file));
  return trackedFiles().filter((p) => !subjects.has(p));
}

interface Carrier {
  file: string;
  line: number;
  text: string;
  type: string;
}

function findCarriers(files: readonly string[], re: RegExp): Carrier[] {
  const hits: Carrier[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    src.split('\n').forEach((text, i) => {
      const m = re.exec(text);
      if (m) hits.push({ file, line: i + 1, text: text.trim(), type: m[1] });
    });
  }
  return hits;
}

describe('retire-a-kind gate (#471 B-III)', () => {
  it('derives the retired types from the kind descriptor, and covers every sentinel relic', () => {
    const retired = retiredNodeTypes();
    // Guard-the-guard: an empty or shrunken subject would make every assertion below pass
    // vacuously, which is the exact failure mode this gate exists to prevent one level down.
    // 9 with the camera's two fused types (#387); 7 before it.
    expect(retired.length).toBeGreaterThanOrEqual(9);

    // The independent cross-check, and the reason a forgotten retirement cannot slip through.
    // A retirement has TWO end states and this asserts the disjunction of them, because
    // asserting either one alone is wrong in the other's case:
    //
    //   REGISTERED + SENTINEL — the relic still exists as a node definition, and announces
    //     itself in its own source with `'<Type> is retired;'`. This is where a type sits
    //     while something still depends on its file: a live export awaiting a rehome, or a
    //     ladder not yet moved.
    //   ABSENT — the definition is DELETED (#365 Phase 5). No source, so no sentinel; the
    //     type is simply not in the registry. This is the stronger state, and the one every
    //     retirement should end in: a sentinel makes a wrong call throw, deletion makes the
    //     call unwritable.
    //
    // Asserting only the sentinel would forbid the deletion — which is exactly what happened
    // before #596, where this equality read as a veto on retiring the seven unentangled
    // relics for good. Asserting only absence would forbid the intermediate state that three
    // types are legitimately in today. What must NEVER hold is the third combination:
    // REGISTERED with no sentinel, i.e. a fused type that still evaluates for real.
    const sentinelRe = /['"](\w+) is retired[;,]/;
    const declared = new Set<string>();
    for (const file of sentinelFiles()) {
      // Comment-stripped for the same reason the carrier sweep is: prose that quotes the
      // sentinel while discussing a retirement would otherwise enrol a type here and break the
      // equality below from the wrong side. String contents survive stripping, and the real
      // sentinel lives in one.
      const src = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const line of src.split('\n')) {
        const m = sentinelRe.exec(line);
        if (m) declared.add(m[1]);
      }
    }

    __reseedAllNodesForTests();
    const registry = snapshotRegistry();
    for (const type of retired) {
      const isRegistered = registry[type] !== undefined;
      expect(
        { type, registered: isRegistered, sentinel: declared.has(type) },
        `${type} is a retired fused type, so it must be EITHER registered with a throwing ` +
          `sentinel in its own source OR absent from the registry entirely. Registered ` +
          `without a sentinel means it still evaluates for real.`,
      ).toEqual({ type, registered: isRegistered, sentinel: isRegistered });
    }

    // The other direction: nothing may declare the sentinel that the descriptor does not
    // name as a fused predecessor. A stray declaration would mean a type retired without
    // enrolling in this gate, which is the blindness the equality used to buy.
    expect([...declared].sort()).toEqual(retired.filter((t) => registry[t] !== undefined));

    // Guard-the-guard, and it is the assertion that keeps the disjunction honest: if EVERY
    // relic were deleted the sentinel road above would be vacuous, and if none were the
    // absence road would be. Both states are populated today (3 registered, 7 deleted), and
    // this says so out loud so a future reader can see which arms are actually exercised.
    const stillRegistered = retired.filter((t) => registry[t] !== undefined);
    expect(
      stillRegistered.length,
      'no relic is still registered — the sentinel arm is vacuous',
    ).toBeGreaterThan(0);
    expect(
      stillRegistered.length,
      'every relic is still registered — the deletion arm is vacuous',
    ).toBeLessThan(retired.length);
  });

  it('no tracked file constructs a retired node type, unit fixtures included', () => {
    const retired = retiredNodeTypes();
    const files = scannedFiles();
    // Guard-the-guard: if the tracked-file walk ever returns (nearly) nothing — no git, a
    // changed layout, a filter typo — the sweep finds no carriers and reports success while
    // having looked at nothing. Asserted per SCOPE rather than as one total, because a filter
    // bug that dropped an entire half (all of tests/, say) would still clear a combined
    // threshold on the surviving half alone. Counted structurally rather than by naming a
    // canary file, which would red this gate for the unrelated reason of a rename.
    expect(files.filter((f) => f.startsWith('tests/e2e/')).length).toBeGreaterThan(100);
    expect(files.filter((f) => f.startsWith('src/')).length).toBeGreaterThan(300);
    // The third scope, and the reason it is counted separately: unit tests are the half this
    // gate did NOT watch until #476 closed. A filter regression that dropped them again
    // re-opens exactly the hole that was just shut, and it would clear both floors above on
    // the surviving files alone. This is the assertion that says the carve-out is gone.
    expect(files.filter((f) => /^src\/.*\.test\.tsx?$/.test(f)).length).toBeGreaterThan(250);

    const carriers = findCarriers(files, carrierPattern(retired));
    const accepted = new Map(ACCEPTED_CARRIERS.map((a) => [a.file, a]));
    const novel = carriers.filter((c) => !accepted.has(c.file));

    if (novel.length > 0) {
      const detail = novel.map((c) => `  ${c.file}:${c.line}  ${c.text}`).join('\n');
      throw new Error(
        `${novel.length} file(s) construct a RETIRED node type (${retired.join(', ')}).\n` +
          `A relic's evaluate() throws, so if this is an end-to-end spec it is either failing ` +
          `or — worse — passing while asserting on a shape the product can no longer build. ` +
          `Retarget it onto the split pair with the matching tests/e2e/_split<Kind>.ts helper.\n` +
          `Carriers:\n${detail}`,
      );
    }
    expect(novel).toHaveLength(0);

    // The other direction: an accepted entry whose file is now clean is stale and should be
    // pruned, so the allowlist can only ever shrink by itself.
    const carrying = new Set(carriers.map((c) => c.file));
    const stale = ACCEPTED_CARRIERS.filter((a) => !carrying.has(a.file));
    expect(
      stale.map((s) => s.file),
      'accepted carriers no longer carrying a relic — remove these entries',
    ).toEqual([]);

    // Same discipline for the permanent category, which is excluded from the sweep and so
    // could rot unnoticed: each member must still BE a carrier. A file listed here that has
    // stopped building a relic has stopped needing the exemption, and leaving it listed hides
    // that file from the gate for free.
    const subjectRe = carrierPattern(retired);
    const notCarrying = RELIC_IS_THE_SUBJECT.filter(
      (s) => findCarriers([s.file], subjectRe).length === 0,
    );
    expect(
      notCarrying.map((s) => s.file),
      'listed as relic-is-the-subject but no longer constructs one — drop the entry and let the sweep cover the file',
    ).toEqual([]);
  });

  it('the detector fires on a construction and stays silent on prose (positive + negative controls)', () => {
    // The standing proof that the sweep above is not vacuous. Its subject is currently empty —
    // which is the goal — so without these controls a broken regex, a broken comment stripper
    // or an empty type list would read exactly like a clean repository.
    const re = carrierPattern(retiredNodeTypes());
    const fires = (src: string) => re.test(stripComments(src));

    // Constructions — every spelling a fixture actually uses.
    for (const line of [
      "{ type: 'addNode', nodeId: sid, nodeType: 'SphereMesh', params: {} },",
      '    nodeType: "BoxMesh",',
      "nodeType:'Curve'",
      "  nodeType: 'AreaLight',",
      "{ id: 'a', nodeType: 'DirectionalLight' }",
    ]) {
      expect(fires(line), `must be detected: ${line}`).toBe(true);
    }

    // Prose and live vocabulary — none of these may trip the gate.
    for (const line of [
      "// selection/sampling name. The fused 'Curve' node type is retired.",
      "/* reaches an area LightData, not a node whose `type` is 'AreaLight'. */",
      "  readonly kind: 'DirectionalLight';", // the surviving LightValue discriminator
      "  { kind: 'PointLight', label: 'Point' },", // the Add-menu creation kind
      "  Area: 'AreaLight',", // lightKind → LightValue.kind map
      "case 'SpotLight':", // a switch over LightValue.kind
      "nodeType: 'Object',", // the surviving type
      "nodeType: 'SphereData',",
    ]) {
      expect(fires(line), `must NOT be detected: ${line}`).toBe(false);
    }

    // A carrier hiding behind a URL on the same line — the case that rules out the naive
    // strip-from-`//`-to-end-of-line implementation.
    expect(fires("const doc = 'https://x/y'; const op = { nodeType: 'BoxMesh' };")).toBe(true);
    // ...while a genuine trailing comment on the same line is still stripped.
    expect(fires("const op = { nodeType: 'Object' }; // not a 'BoxMesh' any more")).toBe(false);
  });
});
