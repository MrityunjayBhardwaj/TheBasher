// #713 rung 1 — WHICH BUILD ARMS RESOLVE THEIR SOURCE TO REAL BUFFERS, counted exactly.
//
// ── THE FAILURE THIS CLOSES, WHICH HAS NOW HAPPENED TWICE ─────────────────────────────
//
// `buildFromDescriptor` is a `switch` closed by a `never`, so a new descriptor kind cannot
// ship without a build arm. What the `never` does not ask is WHAT KIND of arm it is. Three
// classes live in that switch and nothing distinguishes them:
//
//   leaves          `box`, `sphere`   — build from params, resolve nothing.
//   declared nulls  `gltf`, `baked`   — the buffers live elsewhere ON PURPOSE, and say so.
//   materialisers   the rest          — each resolves its source to real buffers first,
//                                       which is exactly the half of handle-not-buffers
//                                       that #606 records as NOT holding.
//
// #713 was filed by an author who joined that third class without noticing, and named the
// set as three: `array`, `mirror`, `subset`. It is FOUR. `bevel` joined the same class the
// same silent way, AFTER the issue was filed — so the failure recurred while its own issue
// was open. That is the argument for a literal rather than a note.
//
// ── WHY EXACT, AND WHY NOT A REFUSAL ─────────────────────────────────────────────────
//
// The population cannot be empty: the reference model that would fix the divergence is not
// built, and Phase 4 is where it is scheduled. So this does not refuse a materialising arm —
// it makes joining the class a decision somebody took, with their name on the commit. Exact
// rather than a floor, because a floor lets the set grow one quiet arm at a time, which is
// the failure. When Phase 4 lands, this same list is what has to go to zero, and it cannot be
// satisfied by editing a sentence.
//
// ── THE INSTRUMENT CONTROL IS NOT OPTIONAL ───────────────────────────────────────────
//
// A probe that lost its subject reports the same clean answer as a clean repo. So case B
// proves the parser can still SEE a materialiser, and that it is not fooled by the two
// look-alikes that would make it over-report: a comment mentioning the call, and a resolving
// function that is not a build arm at all (`sourceWeldFor` resolves a source and must not be
// counted).
//
// 🔴 COMMENTS COME OFF BEFORE ANY PARSE, and that is recorded because it BIT while this gate
// was being written: a brace-matched scan of the descriptor union terminated on a `;` inside
// a comment and silently returned 7 kinds instead of 8 — dropping `bevel`, the very arm this
// gate exists to catch. The same defect `interfaceBody` in `materialKeyReach.gate.test.ts`
// documents having had.
//
// REF: src/app/geometryRegistry.ts (`buildFromDescriptor` and the build functions);
//      src/nodes/types.ts (the `GeometryDescriptor` union this partitions);
//      issues #713, #606, #712, #671.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../test-utils/sourceScan';

const REPO = join(__dirname, '..', '..');
const REGISTRY = join(REPO, 'src', 'app', 'geometryRegistry.ts');
const TYPES = join(REPO, 'src', 'nodes', 'types.ts');

/** The brace-matched body of `function <name>(...)`, or `null`. Comment-stripped input. */
function functionBody(code: string, name: string): string | null {
  const head = new RegExp(`function ${name}\\s*\\(`).exec(code);
  if (!head) return null;
  // Walk to the `{` that opens the body — the parameter list can itself contain braces
  // (an inline object type), so this counts parens first rather than finding the next `{`.
  let i = head.index + head[0].length;
  let depth = 1;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') depth--;
  }
  const open = code.indexOf('{', i);
  if (open === -1) return null;
  depth = 1;
  let j = open + 1;
  for (; j < code.length && depth > 0; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') depth--;
  }
  return depth === 0 ? code.slice(open + 1, j - 1) : null;
}

/** Does this function body resolve a geometry source to real buffers? */
function resolvesSource(body: string): boolean {
  return /\bget\(\s*(?:d\.)?source\s*,\s*'internal'\s*\)/.test(body);
}

/** `case '<kind>':` → the expression its arm returns, following fallthrough. */
function switchArms(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const pending: string[] = [];
  for (const line of body.split('\n')) {
    const c = /^\s*case '([a-z]+)':/.exec(line);
    if (c) {
      pending.push(c[1]);
      continue;
    }
    const r = /^\s*return\s+([^;]+);/.exec(line);
    if (r && pending.length > 0) {
      for (const k of pending) out.set(k, r[1].trim());
      pending.length = 0;
    }
  }
  return out;
}

/** The `kind` literals of the `GeometryDescriptor` union, comment-stripped. */
function descriptorKinds(typesSrc: string): string[] {
  const code = stripComments(typesSrc);
  const start = code.indexOf('export type GeometryDescriptor');
  expect(start, 'the GeometryDescriptor union was not found in types.ts').toBeGreaterThan(-1);
  let depth = 0;
  let j = start;
  for (; j < code.length; j++) {
    const c = code[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ';' && depth === 0 && j > start + 10) break;
  }
  return [...code.slice(start, j).matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]);
}

const CODE = stripComments(readFileSync(REGISTRY, 'utf8'));
const ARMS = switchArms(functionBody(CODE, 'buildFromDescriptor') as string);

function classify(): { materialisers: string[]; declaredNulls: string[]; leaves: string[] } {
  const materialisers: string[] = [];
  const declaredNulls: string[] = [];
  const leaves: string[] = [];
  for (const [kind, expr] of ARMS) {
    if (expr === 'null') {
      declaredNulls.push(kind);
      continue;
    }
    const called = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    const body = called ? functionBody(CODE, called[1]) : null;
    if (body !== null && resolvesSource(body)) materialisers.push(kind);
    else leaves.push(kind);
  }
  return {
    materialisers: materialisers.sort(),
    declaredNulls: declaredNulls.sort(),
    leaves: leaves.sort(),
  };
}

describe('#713 — the build arms that materialise their source, counted', () => {
  it('A. EXACTLY four arms resolve a source, and `bevel` is the one that arrived unannounced', () => {
    // Anti-vacuity first: a parse that found no arms would make every assertion below green
    // over an empty set. 8 kinds reach the switch.
    expect(ARMS.size, 'the switch parse did not read the build arms').toBe(8);

    const { materialisers } = classify();
    expect(
      materialisers,
      'a build arm now resolves a source and is not named here — it has joined the ' +
        'handle-not-buffers divergence (#606). Add it deliberately, or do not resolve.',
    ).toEqual(['array', 'bevel', 'mirror', 'subset']);
  });

  it('B. CONTROL — the parser can see a materialiser, and is not fooled by the look-alikes', () => {
    // Positive: a known materialiser is detected THROUGH the real parse, not asserted.
    const arrayBody = functionBody(CODE, 'buildArray');
    expect(arrayBody, 'buildArray was not found — the probe lost its subject').not.toBeNull();
    expect(resolvesSource(arrayBody as string)).toBe(true);

    // Look-alike 1: a COMMENT naming the call must not count. This is the defect that bit
    // while writing this gate, in the sibling parse over the descriptor union.
    expect(resolvesSource(stripComments("// get(d.source, 'internal') one day\nreturn x;"))).toBe(
      false,
    );
    expect(resolvesSource(stripComments("const g = get(d.source, 'internal');"))).toBe(true);

    // Look-alike 2: `sourceWeldFor` resolves a source and is NOT a build arm. It must be
    // excluded by not being reachable from the switch, rather than by being special-cased —
    // so assert both halves: it does resolve, and it is not in the classified set.
    const weld = functionBody(CODE, 'sourceWeldFor');
    expect(weld, 'sourceWeldFor was not found').not.toBeNull();
    expect(resolvesSource(weld as string)).toBe(true);
    const all = classify();
    expect([...all.materialisers, ...all.declaredNulls, ...all.leaves]).not.toContain(
      'sourceWeldFor',
    );

    // The body extractor must brace-match rather than stop at the first `}`.
    const nested = 'function f(a: { b: string }) {\n  if (x) { y(); }\n  return 1;\n}\n';
    expect(functionBody(nested, 'f')).toContain('return 1;');
  });

  it('C. the three classes PARTITION the union — no kind is left in an unexamined remainder', () => {
    const { materialisers, declaredNulls, leaves } = classify();
    expect(declaredNulls).toEqual(['baked', 'gltf']);
    expect(leaves).toEqual(['box', 'sphere']);

    const kinds = descriptorKinds(readFileSync(TYPES, 'utf8')).sort();
    // 8, and the count is stated so a union parse that silently dropped an arm — which is
    // exactly what a comment-terminated scan did here — cannot pass as a clean partition.
    expect(kinds.length, 'the GeometryDescriptor union parse looks short').toBe(8);
    expect([...materialisers, ...declaredNulls, ...leaves].sort()).toEqual(kinds);
  });
});
