// `sourceFiles` — the one enumeration the repo's structural gates walk (#536 S3).
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
//
// Three gates assert something about the SET of modules that import a thing:
// `overlayIdentity.gate.test.ts` (who may patch an evaluated value),
// `materialComposition.gate.test.ts` (who may translate the composition decision), and
// `registryDoors.gate.test.ts` (who may open a shared-resource door). Each was about to
// carry its own verbatim copy of this walk.
//
// That duplication is not a style problem. All three gates are CENSUSES, and a census is
// only as honest as its subject: if one copy silently narrowed — stopped descending into a
// new directory, started skipping an extension — that gate would report a clean, closed
// importer set over a SMALLER set of files, and it would keep passing. Three copies would
// drift apart about what "every source file" means while each stayed internally consistent.
//
// ── WHY IT LIVES IN `tools/` AND NOT IN `src/test-utils/` ─────────────────────────────
//
// Measured, not assumed. `src/test-utils/*.ts` IS typechecked: `tsconfig.app.json`
// includes `src`, excludes only `src/**/*.test.ts(x)`, and declares `"types":
// ["vite/client"]` with no `@types/node`. A plain module there importing `node:fs` fails
// `npm run typecheck` with `TS2307: Cannot find module 'node:fs'` — confirmed by building
// exactly that file and watching `tsc -b --force` exit 2. This is the fence
// `src/test-utils/sourceScan.ts` documents when it says the file-enumeration half "stays
// in each gate's own `.test.ts`".
//
// Putting the walk in a `.test.ts` clears the fence but has its own defect, also measured:
// importing a spec file RE-REGISTERS its `describe`/`it` blocks into the importing suite,
// so the walk's own controls ran three times and inflated the unit count by 10 (3637 → 3652
// where 3642 was expected). A repo that predicts its test floor before every CI run cannot
// afford a helper that changes the count depending on who imports it.
//
// `tools/**/*.ts` is in `tsconfig.node.json` with `"types": ["node"]`, and excluded from
// the app project — so this file is fully typechecked WITH node types, imports nothing into
// the browser bundle (only `.test.ts` files import it), and registers no tests.
//
// REF: tsconfig.app.json + tsconfig.node.json (the two include sets — the whole argument);
//      src/test-utils/sourceScan.ts (`stripComments`, the sibling half of this concern);
//      src/test-utils/sourceFiles.test.ts (this walk's positive controls);
//      the three consumers named above; issues #394, #536.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Repo `src/`, resolved from this file rather than from each caller's depth. */
const SRC = join(__dirname, '../../src');

/**
 * Every non-test source file under `src/`, as `[repo-relative path, contents]`.
 *
 * "Non-test" is what makes the census meaningful: a gate asks who in the PRODUCT imports a
 * thing, and a spec importing it in order to test it is not a consumer. Paths come back
 * `src/`-prefixed so a gate's expected table reads the way the repo does.
 */
export function sourceFiles(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs, `${rel}${entry}/`);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry)) continue;
      out.push([`${rel}${entry}`, readFileSync(abs, 'utf8')]);
    }
  };
  walk(SRC, 'src/');
  return out;
}
