// The road-coverage gate (#491) — every (road, kind) cell is either covered by a NAMED
// spec that demonstrably touches that kind, or declared a gap with a reason and an issue.
//
// WHY THIS EXISTS
// The kind axis is already machine-derived. This gate closes the other axis: the four roads
// the matrix delegates to hand-written specs, whose coverage was recorded in prose and was
// wrong. See `splitRoads.ts` for the measurement.
//
// THE THREE CHECKS THAT DO THE WORK, in ascending order of what they would have caught:
//
//   1. TOTALITY — every delegated road answers for every kind. TypeScript already forces
//      this (`Record<SplitKindName, RoadCell>`), so the runtime check is a backstop for the
//      case the type cannot see: a kind added to the union while a road's table is widened
//      with a cast or a spread. Cheap, and the type has been circumvented before.
//
//   2. THE NAMED SPEC MUST EXIST AND MUST TOUCH THE KIND. This is the one that bites. A
//      cell saying `{ by: 'tests/e2e/p422-...' }` is a claim that spec exercises this kind;
//      the gate reads the file and requires one of the kind's markers (its data type, or
//      the builder that mints a split pair of it). Naming a spec that never builds the kind
//      is exactly how the prose claim this module replaces came to be false, so the
//      replacement refuses to accept the same shape of assertion on trust.
//
//   3. A DERIVED ROAD MUST ACTUALLY ITERATE THE KINDS. `derivation: 'derived'` is the
//      strongest claim in the table — it says no bookkeeping is needed because the road
//      sweeps the set itself. If the file it names stops iterating `SPLIT_KIND_NAMES`, the
//      road quietly becomes per-kind again while still advertising that it cannot go stale.
//      Checked by reading the file, because that claim is about the code, not about a value.
//
// WHY GAPS ARE ASSERTED RATHER THAN SKIPPED — the same rule the kind descriptor already
// lives by. A gap builds nothing and runs nothing, but it must carry a reason and an issue,
// and it is asserted as a SET: a cell that quietly becomes covered still has to be moved by
// hand, and until it is, the table is honest about what nobody is watching. What this gate
// must never grow is a way to say "not applicable" without saying why.
//
// WHAT IT CANNOT GUARD, stated plainly because a gate that hides its blind spot reads as
// more coverage than it has: a named spec that CONTAINS the kind's marker but asserts
// something unrelated to the road still passes. The marker proves the spec touches the
// kind, not that it asks this road's question — only reading the spec proves that. This is
// why `splitRoads.ts` records unverified leads as `candidates` rather than promoting them
// to named cells on the strength of a builder import.
//
// REF: src/test-utils/splitRoads.ts (the table); src/test-utils/splitKinds.ts (the kind
//      axis); issues #491, #471.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPLIT_KIND_NAMES, type SplitKindName } from './splitKinds';
import {
  isCovered,
  KIND_MARKERS,
  ROAD_IDS,
  SPLIT_ROADS,
  type RoadCell,
  type RoadSpec,
} from './splitRoads';

const REPO_ROOT = join(__dirname, '..', '..');

function readRepoFile(rel: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

const delegatedRoads = (): RoadSpec[] =>
  ROAD_IDS.map((id) => SPLIT_ROADS[id]).filter((r) => r.derivation === 'delegated');

const derivedRoads = (): RoadSpec[] =>
  ROAD_IDS.map((id) => SPLIT_ROADS[id]).filter((r) => r.derivation === 'derived');

// THE CHECKS ARE PURE FUNCTIONS OVER A ROAD LIST, and that is the point (#506).
//
// Every per-cell check below iterates the DELEGATED roads. That means all of them go
// vacuous together the moment that list is empty — and emptying it is not a hypothetical,
// it is what finishing this work looks like: R2 is the last delegated road. The old
// arrangement tried to cover that with three assertions on live debt
// (`delegatedRoads().length > 0`, `gaps.length > 0`, `covered.length > 0`), all of which
// went red for the work that pays the debt off, and all of which only bit in that order so
// fixing one revealed the next.
//
// Taking a road list as a PARAMETER lets the same checker run against a synthetic table
// whose cells are deliberately broken. That answers "is this check exercised?" from a
// fixture instead of from however much real debt happens to exist — so the answer stays
// true when the debt reaches zero, which is the only state we are actually aiming for.
function checkTotality(roads: RoadSpec[]): string[] {
  const bad: string[] = [];
  for (const road of roads)
    for (const kind of SPLIT_KIND_NAMES)
      if (!road.coverage || !(kind in road.coverage)) bad.push(`${road.id}/${kind}`);
  return bad;
}

function checkNamedSpecs(roads: RoadSpec[]): string[] {
  const bad: string[] = [];
  for (const road of roads) {
    for (const kind of SPLIT_KIND_NAMES) {
      const cell = road.coverage![kind];
      if (!isCovered(cell)) continue;
      const src = readRepoFile(cell.by);
      if (src === null) {
        bad.push(`${road.id}/${kind}: named spec ${cell.by} does not exist`);
        continue;
      }
      const markers = KIND_MARKERS[kind];
      if (!markers.some((m) => src.includes(m))) {
        bad.push(
          `${road.id}/${kind}: ${cell.by} is named as covering ${kind}, but contains none ` +
            `of ${markers.join(', ')} — it does not build this kind at all`,
        );
      }
    }
  }
  return bad;
}

function checkGapMetadata(roads: RoadSpec[]): string[] {
  const bad: string[] = [];
  for (const road of roads) {
    for (const kind of SPLIT_KIND_NAMES) {
      const cell = road.coverage![kind];
      if (isCovered(cell)) continue;
      if (!cell.why.trim()) bad.push(`${road.id}/${kind}: gap with no reason`);
      if (!/^#\d+$/.test(cell.issue)) bad.push(`${road.id}/${kind}: gap with no issue number`);
    }
  }
  return bad;
}

function checkCandidates(roads: RoadSpec[]): string[] {
  const bad: string[] = [];
  for (const road of roads) {
    for (const kind of SPLIT_KIND_NAMES) {
      const cell = road.coverage![kind];
      if (isCovered(cell) || !cell.candidates) continue;
      for (const cand of cell.candidates) {
        const src = readRepoFile(cand);
        if (src === null) {
          bad.push(`${road.id}/${kind}: candidate ${cand} does not exist`);
          continue;
        }
        if (!KIND_MARKERS[kind].some((m) => src.includes(m))) {
          bad.push(
            `${road.id}/${kind}: candidate ${cand} does not build ${kind} — it would send ` +
              `whoever closes this gap to the wrong file`,
          );
        }
      }
    }
  }
  return bad;
}

describe('road-coverage gate (#491)', () => {
  it('every delegated road answers for every kind (totality)', () => {
    expect(
      checkTotality(delegatedRoads()),
      'a delegated road has no answer for a kind, so that kind ships with the road unswept ' +
        'and nothing reports it — the exact failure the matrix exists to end',
    ).toEqual([]);
  });

  it('a delegated road carries a coverage table and a derived road does not', () => {
    // Two shapes, one field. Without this a road could be marked 'derived' — the claim that
    // needs no bookkeeping — while still carrying a stale table nobody reads, or marked
    // 'delegated' with no table at all, which the totality check above would then pass
    // vacuously over.
    for (const road of delegatedRoads()) {
      expect(road.coverage, `${road.id} is delegated but carries no coverage table`).toBeDefined();
    }
    for (const road of derivedRoads()) {
      expect(
        road.coverage,
        `${road.id} claims to be derived but carries a per-kind table — one of the two is a lie`,
      ).toBeUndefined();
    }
  });

  it('every NAMED spec exists and demonstrably touches the kind it is named for', () => {
    const bad = checkNamedSpecs(delegatedRoads());
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every gap carries a reason and an issue', () => {
    expect(
      checkGapMetadata(delegatedRoads()),
      'a gap with no reason is indistinguishable from an oversight, and a gap with no issue ' +
        'is one nobody will close',
    ).toEqual([]);
  });

  it("every gap's candidate specs exist and touch the kind (a stale lead is worse than none)", () => {
    const bad = checkCandidates(delegatedRoads());
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every road points at a file that exists', () => {
    // `runsIn` is checked for content only on derived roads, where it carries the
    // iterate-the-kinds claim. On a delegated road nothing else reads it, which is exactly
    // the kind of field that quietly comes to name a spec somebody renamed two refactors
    // ago — still legible, no longer true, and pointing whoever reads it at nothing.
    const missing = ROAD_IDS.map((id) => SPLIT_ROADS[id])
      .filter((r) => readRepoFile(r.runsIn) === null)
      .map((r) => `${r.id}: runsIn ${r.runsIn} does not exist`);
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('a derived road really does iterate the kind set', () => {
    // The strongest claim in the table, and the only one whose failure is silent: a road
    // that stops looping still reads as "cannot go stale".
    const bad: string[] = [];
    for (const road of derivedRoads()) {
      const src = readRepoFile(road.runsIn);
      if (src === null) {
        bad.push(`${road.id}: runsIn ${road.runsIn} does not exist`);
        continue;
      }
      if (!src.includes('SPLIT_KIND_NAMES')) {
        bad.push(
          `${road.id}: ${road.runsIn} is declared derived but never mentions ` +
            `SPLIT_KIND_NAMES, so it does not sweep the kind set`,
        );
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the table covers all ten roads (guard the guard)', () => {
    // Table integrity, and nothing about how much debt exists. Combined with the
    // `delegated + derived === ROAD_IDS.length` identity below, these two pin that every
    // road is present and sits on exactly one side — which is the whole of what this test
    // used to be reaching for.
    //
    // WHAT WAS REMOVED AND WHY (#506). This test also asserted `delegatedRoads().length > 0`,
    // `gaps.length > 0` and `covered.length > 0`. All three were pinned to the CURRENT SHAPE
    // OF THE DEBT rather than to a property, so all three went red for the work that pays the
    // debt off — R2 is the last delegated road, and promoting it empties every one of those
    // three quantities at once. They also failed in sequence rather than together, so fixing
    // the known one would simply have revealed the next.
    //
    // `derivedRoads().length > 0` is kept: it only ever grows, so it is a floor on progress
    // rather than a floor on debt.
    expect(ROAD_IDS.length).toBe(10);
    expect(derivedRoads().length).toBeGreaterThan(0);
  });

  it('each per-cell check REJECTS a broken cell (vacuity guarded by a synthetic road)', () => {
    // The question the three deleted assertions were trying to answer — "are these checks
    // actually exercised, or are they looping over nothing?" — asked of a FIXTURE instead of
    // of live debt. Every checker is run against a road built to fail it, so the answer stays
    // true on the day the real table has no gaps left. That is the state we are aiming for,
    // and the old guard treated it as a regression.
    //
    // The fixtures are TOTAL apart from the one cell under test. That is deliberate: only
    // `checkTotality` is a backstop for an incomplete table (the type normally guarantees
    // totality), so the other checkers are entitled to assume every kind is present. Making
    // them defensive to suit a fixture would weaken the production check to buy a test.
    //
    // `id` is only ever interpolated into a message, so borrowing a real RoadId is harmless.
    const wellFormedGap = (): RoadCell => ({ gap: true, why: 'declared', issue: '#500' });
    const totalTable = (): Record<SplitKindName, RoadCell> =>
      Object.fromEntries(SPLIT_KIND_NAMES.map((k) => [k, wellFormedGap()])) as Record<
        SplitKindName,
        RoadCell
      >;
    const synthetic = (override: Partial<Record<SplitKindName, RoadCell>> = {}): RoadSpec => ({
      id: 'R1',
      title: 'synthetic road — fixture only, never registered in SPLIT_ROADS',
      runsIn: 'src/test-utils/splitRoads.gate.test.ts',
      derivation: 'delegated',
      coverage: { ...totalTable(), ...override },
    });

    // 1. TOTALITY catches missing kinds. An empty table is missing all six.
    const empty: RoadSpec = { ...synthetic(), coverage: {} as Record<SplitKindName, RoadCell> };
    expect(checkTotality([empty])).toHaveLength(SPLIT_KIND_NAMES.length);

    // 2. A NAMED SPEC THAT DOES NOT EXIST is caught.
    const ghost = checkNamedSpecs([synthetic({ box: { by: 'tests/e2e/does-not-exist.spec.ts' } })]);
    expect(ghost.join('\n')).toContain('does not exist');

    // 3. A NAMED SPEC THAT EXISTS BUT NEVER BUILDS THE KIND is caught. This is the one that
    //    matters — it is the exact false claim the whole module was written to end, and a
    //    check that merely confirmed the file exists would pass it. This very file exists and
    //    contains no box marker.
    const wrongFile = checkNamedSpecs([
      synthetic({ box: { by: 'src/test-utils/splitRoads.gate.test.ts' } }),
    ]);
    expect(wrongFile.join('\n')).toContain('does not build this kind at all');

    // 4. GAP METADATA catches an empty reason and a malformed issue — two complaints.
    const badGap = checkGapMetadata([
      synthetic({ box: { gap: true, why: '   ', issue: 'not-an-issue' } }),
    ]);
    expect(badGap).toHaveLength(2);
    expect(badGap.join('\n')).toContain('no reason');
    expect(badGap.join('\n')).toContain('no issue number');

    // 5. A STALE CANDIDATE LEAD is caught.
    const badCand = checkCandidates([
      synthetic({
        box: { gap: true, why: 'why', issue: '#1', candidates: ['tests/e2e/nope.spec.ts'] },
      }),
    ]);
    expect(badCand.join('\n')).toContain('does not exist');

    // And the complement: a WELL-FORMED gap draws no complaint, so the checks above are
    // discriminating rather than merely noisy.
    const goodGap = synthetic();
    expect(checkTotality([goodGap])).toEqual([]);
    expect(checkGapMetadata([goodGap])).toEqual([]);
    expect(checkCandidates([goodGap])).toEqual([]);
    expect(checkNamedSpecs([goodGap])).toEqual([]);
  });

  it('reports the coverage it is describing, so the number is visible in CI', () => {
    const total = delegatedRoads().length * SPLIT_KIND_NAMES.length;
    const covered = delegatedRoads().reduce(
      (n, r) => n + SPLIT_KIND_NAMES.filter((k) => isCovered(r.coverage![k])).length,
      0,
    );
    // Every cell that somebody is answerable for: the derived roads cover their kinds by
    // construction, the delegated ones cell by cell.
    const answered = derivedRoads().length * SPLIT_KIND_NAMES.length + covered;
    const allCells = ROAD_IDS.length * SPLIT_KIND_NAMES.length;
    console.log(
      `split-roads coverage: ${answered}/${allCells} cells answered ` +
        `(${covered}/${total} delegated cells covered; ` +
        `${derivedRoads().length}/${ROAD_IDS.length} roads derived)`,
    );

    // THE FLOOR IS ON `answered`, NOT ON `covered` (#500, R7).
    //
    // A floor on delegated covered cells has the same defect as the hardcoded `total === 24`
    // this file already replaced, one level in: promoting a road from delegated to derived
    // — the intended direction of travel, and what closing a road's gaps properly looks like
    // — moves its covered cells OUT of the numerator. R7 went derived with its one covered
    // cell (box) and this assertion reddened for work that strictly increased coverage.
    //
    // `answered` is the quantity that actually cannot go down without coverage being lost:
    // a promotion converts one covered cell into six answered ones, and closing a gap adds
    // one. Both directions of real progress raise it; only deleting coverage lowers it.
    expect(
      answered,
      'fewer cells are answered than before — coverage has regressed, not been restructured',
    ).toBeGreaterThanOrEqual(56);

    // This replaces a hardcoded `total === 24` (#500). That number was 4 delegated roads × 6
    // kinds, and what it was really protecting is that a road cannot leave the table
    // unnoticed. But it also read the INTENDED direction of travel as a regression: promoting
    // a whole road from delegated to derived — which is what closing a road's gaps properly
    // looks like — shrinks the denominator and reddened this assertion for the right work.
    //
    // So pin the thing that actually matters instead: every road sits on exactly one side,
    // and the derived count is a floor so a road cannot be DELETED to make a promotion look
    // free. Combined with `ROAD_IDS.length === 10` above, the total is fully determined
    // without naming it.
    expect(delegatedRoads().length + derivedRoads().length).toBe(ROAD_IDS.length);
    expect(
      derivedRoads().length,
      'a derived road has been removed rather than promoted — the denominator shrank without ' +
        'coverage being added',
    ).toBeGreaterThanOrEqual(9);
  });
});

// The compile-time half of totality lives in `splitRoads.ts`, where each delegated road's
// `coverage` is typed `Record<SplitKindName, RoadCell>` — adding a kind to the union fails
// to compile until every road answers for it. Nothing is restated here: a local
// `Record<SplitKindName, true>` built through `Object.fromEntries` needs a cast to typecheck
// at all, and that cast is exactly what would stop it from catching the omission. It would
// read as a second guarantee while providing none.
