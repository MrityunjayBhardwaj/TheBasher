// #535 — the locality gate's PERTURBATION SET must be enumerated from the op union, not
// from whatever the author thought of.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
//
// `tests/e2e/p535-render-locality.spec.ts` asserts that an edit landing in one subgraph
// cannot change what a disjoint one draws. That claim is only as good as the set of edits
// it tries. The first version tried five, and every one of them was an EDIT — none removed
// a holder, so nothing reached the material registry's refcount and its deferred eviction,
// which is the only per-consumer bookkeeping in the system and therefore the likeliest
// place the next violation lands.
//
// That gap was caught by re-reading the file, which is the weakest instrument there is: a
// person remembering to look. The enumeration at this boundary had already been incomplete
// three times before that, each time caught by a DIFFERENT instrument and never by the same
// one twice. So the correction is not "remember to enumerate the verbs" — a rule that is
// remembered is a rule that will be forgotten. The correction is to make the enumeration
// come from something that cannot forget.
//
// ── THE CLOSED TABLE, AND WHY IT IS THE RIGHT ONE ───────────────────────────────────────
//
// `OpSchema` (`src/core/dag/types.ts`) is a `z.discriminatedUnion` over every mutation the
// application can perform. It IS the verb list — create, remove, re-point, edit — expressed
// in the domain's own vocabulary rather than in a category a test author invented. Anything
// a director or an agent can do to the graph is one of its members, so a perturbation set
// that covers the union covers the ways a subgraph can be edited at all.
//
// Consulting it found what re-reading did not: five of nine members exercised, and
// `setHidden` neither exercised nor considered — despite writing the very visibility the
// spec's snapshot already reads.
//
// ── WHAT THIS GATE REQUIRES ─────────────────────────────────────────────────────────────
//
// Every member of the union is either EXERCISED by the locality spec or EXEMPT with a
// stated, MEASURED reason. Not "probably can't matter" — each exemption below names what
// was run and what was observed, because an exemption asserted rather than measured is the
// same failure this gate exists to stop, one tier down.
//
// The exempt set is counted EXACTLY rather than floored. A floor guards against the set
// emptying; only an exact count guards against it GROWING, and growing is how a gate like
// this dies — one quiet addition at a time until the census covers nothing.
//
// ── HOW THE UNION IS READ, AND WHY TWICE ────────────────────────────────────────────────
//
// The member list is derived two independent ways — the names inside the
// `discriminatedUnion([...])` call, and the `z.literal(...)` on each `Op*Schema`
// declaration — and the two must agree. A lazy regex that silently reads two arms of a
// nine-arm union produces a census that is vacuous and green, which has happened twice in
// this repo. Two derivations that must agree is what turns that into a red.
//
// REF: tests/e2e/p535-render-locality.spec.ts (the subject); src/core/dag/types.ts
//      (`OpSchema` — the closed table); src/test-utils/sourceScan.ts (`stripComments`, so
//      prose naming an op is not counted as coverage); docs/RENDER-RESOURCE-IDENTITY-DESIGN.md
//      §4 + S4; issues #530, #533, #535, #536.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripComments } from './sourceScan';

const REPO_ROOT = join(__dirname, '..', '..');
const TYPES = 'src/core/dag/types.ts';
const SPEC = 'tests/e2e/p535-render-locality.spec.ts';

/**
 * Union members the locality spec deliberately does not perturb, each with the measurement
 * that earned the exemption. Measured 2026-08-03 in a browser, two cubes sharing one
 * geometry and one material, comparing every mesh drawn before and after the op.
 */
const EXEMPT: Record<string, string> = {
  setMeta:
    'Renames a node (`meta.name`, the display label). Measured: dispatching it changed ' +
    'nothing in the drawn scene — no geometry, material, visibility or matrix moved. No ' +
    'render road reads `meta.name`.',
  setSpareParam:
    'Adds a spare param to a node. Measured: no change to anything drawn. A spare param is ' +
    'inert until something READS it, and the road that can — a driver binding it to a real ' +
    'param — reaches the renderer as a `setParam`, which IS exercised.',
  removeSpareParam:
    'The inverse of `setSpareParam`, and inert for the same measured reason: dispatching it ' +
    'changed nothing drawn.',
};

/** Op types the spec actually dispatches, read from source with comments blanked. */
function exercisedOps(): Set<string> {
  const src = stripComments(readFileSync(join(REPO_ROOT, SPEC), 'utf8'));
  const found = new Set<string>();
  for (const m of src.matchAll(/type:\s*'([a-zA-Z]+)'/g)) found.add(m[1]);
  return found;
}

/** The union's members, by the names listed inside `discriminatedUnion([...])`. */
function unionMemberSchemas(src: string): string[] {
  const block = /OpSchema\s*=\s*z\.discriminatedUnion\(\s*'type',\s*\[([^\]]*)\]/.exec(src);
  if (!block) throw new Error('could not find the OpSchema discriminatedUnion member list');
  return block[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The op-type string each `Op*Schema` declares, keyed by schema name. */
function declaredLiterals(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /export const (Op[A-Za-z]+Schema)\s*=\s*z\.object\(\{\s*type:\s*z\.literal\('([a-zA-Z]+)'\)/g,
  )) {
    out.set(m[1], m[2]);
  }
  return out;
}

describe('#535 — the locality spec perturbs every verb the graph has', () => {
  const src = stripComments(readFileSync(join(REPO_ROOT, TYPES), 'utf8'));

  it('reads the op union two independent ways, and they agree', () => {
    const members = unionMemberSchemas(src);
    const literals = declaredLiterals(src);
    // A lazy terminator that reads two arms of a nine-arm union yields a vacuous, green
    // census. Requiring two derivations to agree is what makes that a red instead.
    expect(
      members.length,
      'the union parse collapsed — a census over it would be vacuous',
    ).toBeGreaterThan(1);
    const missing = members.filter((name) => !literals.has(name));
    expect(missing, 'a union member whose op-type literal could not be read').toEqual([]);
  });

  it('covers every member of the op union — exercised, or exempt with a measured reason', () => {
    const members = unionMemberSchemas(src);
    const literals = declaredLiterals(src);
    const exercised = exercisedOps();

    const uncovered = members
      .map((name) => literals.get(name)!)
      .filter((op) => !exercised.has(op) && !(op in EXEMPT));

    expect(
      uncovered,
      'op types the locality spec neither perturbs nor exempts — decide, do not drift',
    ).toEqual([]);
  });

  it('has no stale exemption: every exempt op still exists, and none is secretly covered', () => {
    const literals = new Set(declaredLiterals(src).values());
    const exercised = exercisedOps();

    for (const op of Object.keys(EXEMPT)) {
      expect(literals.has(op), `exemption names '${op}', which is no longer an op type`).toBe(true);
      expect(
        exercised.has(op),
        `'${op}' is exempt but the spec exercises it — drop the exemption`,
      ).toBe(false);
      expect(EXEMPT[op].length, `exemption for '${op}' states no reason`).toBeGreaterThan(40);
    }
  });

  it('exempts exactly three ops — an exact count, so growing the set is a decision', () => {
    // Floored, this stays green while the exempt set swallows the union one op at a time.
    expect(Object.keys(EXEMPT)).toHaveLength(3);
  });
});
