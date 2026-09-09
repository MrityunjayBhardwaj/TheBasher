// #962 — THE SET OF SCOPABLE DOMAINS, ASSERTED AGAINST THE OPERATORS THAT DECLARE THEM.
//
// ── THE FAILURE THIS CLOSES ──────────────────────────────────────────────────────────
//
// `SCOPE_DOMAINS` grew from `['face']` to `['face', 'edge']` at #827, when `BevelModifier`
// became the first operator to declare a class other than `face`. Nothing in the substrate
// noticed. Eight comments across three files went on describing a face-only world, and they
// were still describing one two issues later:
//
//   componentSelection.ts   5 claims — three arms saying `ScopeDomain` "is still ['face']",
//                                      plus two doc-block sentences counting three unshipped
//                                      domains and three registered refusals
//   attributes.ts           2 claims — "every scoped operator carries … = 'face'", and
//                                      "FIVE OPERATORS CHOOSING 'face'"
//   attributes.gate.test.ts 1 claim  — "the arithmetic that decided ns-2 ships `face` alone"
//
// One of those was not merely stale but FALSE IN THE DANGEROUS DIRECTION: the `edge` arm of
// `componentCountOf` told a reader an edge scope was unreachable, sitting a few lines above
// the arm that resolves one.
//
// ── WHY AN UNDER-CLAIM IS WORSE THAN AN OVER-CLAIM ───────────────────────────────────
//
// A comment that promises an enforcement the code lacks is eventually caught, because
// somebody relies on the enforcement and gets bitten. A comment that DENIES a capability the
// code has is never falsified by use: a reader does not attempt the thing it says is
// impossible, so no observation ever contradicts it. It suppresses work instead of permitting
// a bug, and nothing reds — ever. #959 was filed partly on the strength of one of these
// literals, which is how a stale comment becomes a stale issue becomes speculative work.
//
// ── WHAT THIS GATE ASSERTS, AND WHAT THE TYPE ALREADY REFUSES ────────────────────────
//
// The `SCOPE_DOMAINS` / `SCOPE_ABSENT` partition is enforced by the TYPE — `SCOPE_ABSENT` is
// keyed on `Exclude<KnownDomain, ScopeDomain>`, so admitting a domain without deleting its
// absence record does not compile, and neither does the reverse. That half needs no gate.
//
// What a type cannot see is the CROSS-FILE half: whether each scopable domain actually has an
// operator declaring it. That is the invariant `CLASS_CARRIAGE`'s doc block states one level
// up — *a domain needs an operator that can declare it and mean something by it* — and it is
// what this gate pins. A domain admitted with no declarer is a scope nobody can name; a
// declarer at a domain the set excludes is an operator nobody can resolve.
//
// 🔴 COMMENTS COME OFF BEFORE ANY PARSE. A brace scan that walks raw source terminates inside
// a comment and returns a SHORTER, well-formed answer — measured on the descriptor union,
// where it silently dropped the newest member. Row D is the control that proves this parser
// can still see a declaration and is not fooled by one mentioned in prose.
//
// 🔴 AND THE DENOMINATOR IS ASSERTED. A scan that finds zero operator files passes every
// membership check vacuously, and reports exactly what a clean repo reports.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from '../test-utils/sourceScan';
import { KNOWN_DOMAINS, SCOPE_DOMAINS, SCOPE_ABSENT } from './attributes';

const NODES_DIR = join(__dirname);
const SRC_DIR = join(__dirname, '..');

const DECLARATION = /const SCOPE_DOMAIN:\s*ScopeDomain\s*=\s*'([a-z]+)'/;

/** Every production `.ts` under a root, RECURSIVELY. */
function sources(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * Every `const SCOPE_DOMAIN: ScopeDomain = '<domain>'` under `src/nodes`, by file.
 *
 * ⚠️ RECURSIVE DELIBERATELY. The first draft of this read only the top level, and
 * `src/nodes/passes/` already exists — so an operator landing one directory down would have
 * been invisible, and row C would have gone quietly vacuous for exactly the file that needed
 * it. A scan that cannot see a whole subtree reports the same clean answer as a clean subtree.
 */
function declarers(): { file: string; domain: string }[] {
  const out: { file: string; domain: string }[] = [];
  for (const full of sources(NODES_DIR)) {
    const m = stripComments(readFileSync(full, 'utf8')).match(DECLARATION);
    if (m) out.push({ file: relative(NODES_DIR, full), domain: m[1] });
  }
  return out;
}

describe('#962 — a scopable domain has a declarer, and an absent one has a reason', () => {
  it('A — the scan found operators at all (a vacuous pass reports what a clean repo reports)', () => {
    const found = declarers();
    // Not a floor for its own sake: every membership assertion below is satisfied trivially
    // by an empty scan, so this is the row that makes the rest mean something.
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(readdirSync(NODES_DIR).filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(20);
  });

  it('B — every scopable domain has at least one operator declaring it', () => {
    const declared = new Set(declarers().map((d) => d.domain));
    for (const domain of SCOPE_DOMAINS) {
      expect(
        declared.has(domain),
        `'${domain}' is in SCOPE_DOMAINS but no operator in src/nodes declares it. ` +
          `A domain admitted with no declarer is a scope nobody can name — see SCOPE_ABSENT ` +
          `for the shape an absence takes instead.`,
      ).toBe(true);
    }
  });

  it('C — no operator declares a domain the scopable set excludes', () => {
    for (const { file, domain } of declarers()) {
      expect(
        (SCOPE_DOMAINS as readonly string[]).includes(domain),
        `${file} declares SCOPE_DOMAIN '${domain}', which is not in SCOPE_DOMAINS. ` +
          `The selection would resolve at a class the set does not admit.`,
      ).toBe(true);
    }
  });

  it('D — CONTROL: the parser sees a real declaration and ignores one written in prose', () => {
    // Positive: the known edge declarer is found, and it is the one that made this gate
    // necessary. If BevelModifier's declaration ever stops being seen, row B goes vacuous.
    const found = declarers();
    expect(found.find((d) => d.file === 'BevelModifier.ts')?.domain).toBe('edge');
    expect(found.filter((d) => d.domain === 'face').length).toBeGreaterThanOrEqual(5);

    // Negative: the same pattern applied to a COMMENT must find nothing, because comments
    // come off first. This is the defect that bit the descriptor-union scan.
    const prose = "// const SCOPE_DOMAIN: ScopeDomain = 'point';\nconst x = 1;\n";
    expect(stripComments(prose).match(/const SCOPE_DOMAIN:\s*ScopeDomain\s*=\s*'([a-z]+)'/)).toBe(
      null,
    );
  });

  it('F — no operator declares a scope outside src/nodes, where this gate can see it', () => {
    // The escape hatch this closes: rows B–D only look under `src/nodes`, so a declarer
    // anywhere else would be invisible to all of them at once. Rather than widen the scan to
    // the whole tree — which would pull in gates that name a domain in order to test one —
    // the location itself is the invariant. Node types live here; a scoped operator that does
    // not is a layering question worth answering before it is a scoping one.
    const strays = sources(SRC_DIR)
      .filter((f) => !f.startsWith(NODES_DIR))
      .filter((f) => DECLARATION.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC_DIR, f));
    expect(strays).toEqual([]);
  });

  it('E — the two sets partition the known domains, and each absence carries a reason', () => {
    const scopable = [...SCOPE_DOMAINS] as string[];
    const absent = Object.keys(SCOPE_ABSENT);
    expect([...scopable, ...absent].sort()).toEqual([...KNOWN_DOMAINS].sort());
    expect(scopable.filter((d) => absent.includes(d))).toEqual([]);

    for (const [domain, record] of Object.entries(SCOPE_ABSENT)) {
      // A reason that is not a sentence is a reason nobody has to justify again.
      expect(record.why.length, `SCOPE_ABSENT.${domain} needs a real reason`).toBeGreaterThan(40);
      // An `until` that names no issue cannot be checked when the issue closes.
      expect(record.until, `SCOPE_ABSENT.${domain}.until must name an issue`).toMatch(/^#\d+$/);
    }
  });
});
