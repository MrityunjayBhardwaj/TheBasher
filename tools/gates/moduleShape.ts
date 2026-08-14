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

const REPO = join(__dirname, '../..');

/**
 * Strip line and block comments, so a module named in prose is not counted as an import.
 *
 * This matters concretely here: `faceCount.ts`'s own header names `geometryRegistry` and
 * `modifierGeometry` while explaining why it imports neither. A gate that counted those
 * would report the exact opposite of the truth — the failure mode this repo has measured
 * before, where a census over a string returns the union of the code and the commentary.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The module specifiers `file` imports, in source order, deduplicated.
 *
 * `file` is repo-relative (`src/app/faceCount.ts`). Type-only imports are included: a
 * `import type` still declares a dependency on another module's shape, and for the leaf
 * property being held here that is exactly what should be visible and counted.
 */
export function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(join(REPO, file), 'utf8'));
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  // `import './side-effect'` has no `from` clause and is a dependency all the same.
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = bare.exec(source)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
