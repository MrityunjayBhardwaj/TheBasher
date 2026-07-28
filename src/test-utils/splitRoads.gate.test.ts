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
import { SPLIT_KIND_NAMES } from './splitKinds';
import { isCovered, KIND_MARKERS, ROAD_IDS, SPLIT_ROADS, type RoadSpec } from './splitRoads';

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

describe('road-coverage gate (#491)', () => {
  it('every delegated road answers for every kind (totality)', () => {
    const missing: string[] = [];
    for (const road of delegatedRoads()) {
      for (const kind of SPLIT_KIND_NAMES) {
        if (!road.coverage || !(kind in road.coverage)) missing.push(`${road.id}/${kind}`);
      }
    }
    expect(
      missing,
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
    const bad: string[] = [];
    for (const road of delegatedRoads()) {
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
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('every gap carries a reason and an issue', () => {
    const bad: string[] = [];
    for (const road of delegatedRoads()) {
      for (const kind of SPLIT_KIND_NAMES) {
        const cell = road.coverage![kind];
        if (isCovered(cell)) continue;
        if (!cell.why.trim()) bad.push(`${road.id}/${kind}: gap with no reason`);
        if (!/^#\d+$/.test(cell.issue)) bad.push(`${road.id}/${kind}: gap with no issue number`);
      }
    }
    expect(
      bad,
      'a gap with no reason is indistinguishable from an oversight, and a gap with no issue ' +
        'is one nobody will close',
    ).toEqual([]);
  });

  it("every gap's candidate specs exist and touch the kind (a stale lead is worse than none)", () => {
    const bad: string[] = [];
    for (const road of delegatedRoads()) {
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

  it('the table covers all ten roads and both derivations are represented (guard the guard)', () => {
    // Without this, an empty or all-derived table would pass every check above by having
    // nothing to check — the same zero-rows-reads-as-covered failure the kind axis guards
    // with its own length assertion.
    expect(ROAD_IDS.length).toBe(10);
    expect(delegatedRoads().length).toBeGreaterThan(0);
    expect(derivedRoads().length).toBeGreaterThan(0);
    // And the gap branch is actually exercised, so the checks above are not vacuous.
    const gaps = delegatedRoads().flatMap((r) =>
      SPLIT_KIND_NAMES.map((k) => r.coverage![k]).filter((c) => !isCovered(c)),
    );
    const covered = delegatedRoads().flatMap((r) =>
      SPLIT_KIND_NAMES.map((k) => r.coverage![k]).filter(isCovered),
    );
    expect(gaps.length, 'no gaps at all would mean the gap checks never ran').toBeGreaterThan(0);
    expect(
      covered.length,
      'no covered cells would mean the named-spec check never ran',
    ).toBeGreaterThan(0);
  });

  it('reports the coverage it is describing, so the number is visible in CI', () => {
    const total = delegatedRoads().length * SPLIT_KIND_NAMES.length;
    const covered = delegatedRoads().reduce(
      (n, r) => n + SPLIT_KIND_NAMES.filter((k) => isCovered(r.coverage![k])).length,
      0,
    );
    // Pinned as a floor, not an equality: it must not silently REGRESS, and it should not
    // churn when a gap is closed. Raise it when cells are promoted (#491).
    expect(covered).toBeGreaterThanOrEqual(4);
    expect(total).toBe(24);
  });
});

// The compile-time half of totality lives in `splitRoads.ts`, where each delegated road's
// `coverage` is typed `Record<SplitKindName, RoadCell>` — adding a kind to the union fails
// to compile until every road answers for it. Nothing is restated here: a local
// `Record<SplitKindName, true>` built through `Object.fromEntries` needs a cast to typecheck
// at all, and that cast is exactly what would stop it from catching the omission. It would
// read as a second guarantee while providing none.
