// `importsOf` — the module specifiers a source file imports (#638, ns-1b step 1).
//
// ── WHY A GATE ON A MODULE'S IMPORT LIST ──────────────────────────────────────────────
//
// ns-1b moves `faceCountOf` into `src/app/faceCount.ts` so that two modules which must not
// reach each other can both depend on it. That move is only worth something while the leaf
// STAYS a leaf: the moment `faceCount.ts` imports a second module, whatever that module
// drags in becomes reachable from every consumer of the count, and the cycle the move was
// made to break can re-form without anyone editing the two modules it was between.
//
// An import list is exactly the kind of property that decays silently. Nothing fails when a
// leaf grows an import — the code still compiles, the tests still pass, and the cost lands
// somewhere else entirely, as bundle weight or as a cycle a later refactor trips over. So
// the shape is asserted rather than intended.
//
// ⚠️ This is a TEXTUAL parse, not a resolver, and the limit is stated because a gate that
// overstates its own reach is worse than no gate. It sees static `import`/`export … from`
// specifiers. It does NOT see dynamic `import()`, `require`, or a re-export chain: module A
// importing B which imports C reports A → B, and C is invisible here. That is acceptable
// for the property being held — "this leaf imports exactly one thing" is a statement about
// A's own text, and a re-export would show up as a specifier A does not declare.
//
// It lives in `tools/` for the same measured reason `sourceFiles.ts` does: `src/**` is
// typechecked without node types, so a helper there importing `node:fs` fails
// `npm run typecheck`, and a helper in a `.test.ts` re-registers its describes into every
// importing suite.
//
// REF: tools/gates/sourceFiles.ts (the sibling walk, and the tsconfig argument in full);
//      src/app/faceCount.ts (the leaf this holds); issues #638, #633.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Comments are stripped so a module named in PROSE is not counted as an import — which
// matters concretely here, because `faceCount.ts`'s own header names `geometryRegistry` and
// `modifierGeometry` while explaining why it imports neither. A gate that counted those
// would report the exact opposite of the truth.
//
// #676 — THIS MODULE USED TO CARRY ITS OWN TWO-LINE VERSION, AND IT SWALLOWED REAL CODE.
// It stripped block comments FIRST, with a plain `/\*…\*/` scan over the raw text, so a
// `/*` sequence appearing INSIDE a line comment opened a block that ran to the next `*/`
// — taking every import after it. Measured across the repo: **15 files write a `/*`
// sequence inside a `//` line** (`src/nodes/**`, `src/render/*` and friends, in prose about
// eslint scopes), and **7 of them lost real import specifiers** — `dryRun.ts` alone lost
// seven. The gate reported a smaller import set for those modules and reported it
// confidently, which is the census failure this repo has measured in both directions.
//
// So the second spelling is deleted rather than repaired ([[V188]]). `sourceScan`'s
// stripper is a single pass that tracks quote state and handles the two comment forms in
// the order they actually nest; it is deliberately node-free, so `tools/` can use it.
import { stripComments } from '../../src/test-utils/sourceScan';

const REPO = join(__dirname, '../..');

/**
 * The module specifiers `file` imports, in source order, deduplicated.
 *
 * `file` is repo-relative (`src/app/faceCount.ts`). Type-only imports are included: a
 * `import type` still declares a dependency on another module's shape, and for the leaf
 * property being held here that is exactly what should be visible and counted.
 */
export function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(join(REPO, file), 'utf8'));
  // #756 — EVERY PASS BELOW RECORDS WHERE IT MATCHED, AND THE ORDER IS IMPOSED AT THE END.
  // The three passes used to append to one list in turn, so a specifier's position in the
  // answer was decided by WHICH PATTERN found it rather than by where it sits in the file —
  // and since Prettier wraps a clause the moment it names three or four symbols, every
  // wrapped import sorted to the back. Measured on `geometryRegistry.ts`: adding one symbol
  // to an existing clause moved `./pointIdentity` from 7th to 9th with no specifier added or
  // removed, reddening an ordered `toEqual` on a pure reformat. The set was never wrong; the
  // sequence the doc above promises was.
  const found: { specifier: string; at: number }[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push({ specifier: m[1], at: m.index });
  // A NAMED clause written across several lines — `import { a,\n b } from '…'`. #676: the
  // scan above anchors at a line start and then refuses to cross a newline, so it was blind
  // to every import written this way, which is how one is written as soon as it names more
  // than a symbol or two. Measured before the fix: a module whose ONLY import was multi-line
  // reported `[]`, and `modifierGeometry.ts` was missing `../nodes/types` — while the two
  // leaves this gate actually holds happened to have single-line imports, so the blindness
  // had never fired. An exact-set assertion that cannot see the ordinary way a set grows
  // reads as a stronger claim than it makes.
  //
  // ⚠️ THIS IS A SECOND PATTERN RATHER THAN A WIDER FIRST ONE, deliberately. Letting the
  // first cross newlines (`[^;]*?`) lets a match run out of an `export interface` and into a
  // LATER import — trading a false-negative class for a false-positive one. Joining
  // newlines inside braces first was tried and REJECTED on measurement: brace depth cannot
  // be counted without lexing strings and template literals, it went NEGATIVE in real files,
  // and the collapse then MERGED import lines into the statement above them — the fix lost
  // 27 real specifiers across 7 files while adding 142. This pattern instead bounds itself
  // structurally: `[^{}]*` cannot leave the clause, because an import clause never contains
  // a brace. Verified by diffing both answers over every source file.
  const braced =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^{}]*\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = braced.exec(source)) !== null) found.push({ specifier: m[1], at: m.index });
  // `import './side-effect'` has no `from` clause and is a dependency all the same.
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(source)) !== null) found.push({ specifier: m[1], at: m.index });

  // Sorted by position, THEN deduplicated — that order matters. A single-line braced import
  // is matched by two of the passes above at the same offset, so deduplicating first would
  // keep whichever pass ran first and discard the position agreement rather than use it.
  // `sort` is stable in every engine this runs on, so equal offsets keep pass order.
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const { specifier } of found) if (!out.includes(specifier)) out.push(specifier);
  return out;
}
