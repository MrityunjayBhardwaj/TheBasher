// The one reader for the pre-ns-1 project fixture (#631, #395).
//
// ── WHY IT LIVES IN `tools/` AND NOT BESIDE THE FIXTURE ────────────────────────────────
//
// It reads from disk, and that decides the directory. `tsconfig.app.json` includes all of
// `src` and excludes only `src/**/*.test.ts(x)`, with `"types": ["vite/client"]` and no
// `@types/node`. A plain module under `src/` importing `node:fs` therefore fails
// `npm run typecheck` — measured here, not assumed: placing this file at
// `src/core/project/__fixtures__/` produced TS2307 on `node:path`, TS2304 on `__dirname`
// and TS2591 on `Buffer`.
//
// `tools/**/*.ts` is in `tsconfig.node.json` with `"types": ["node"]` and excluded from
// the app project, so this file is fully typechecked WITH node types and pulls nothing
// into the browser bundle. This is the same fence `tools/gates/sourceFiles.ts` documents,
// and the same conclusion.
//
// ── WHY IT IS SHARED RATHER THAN SPELLED TWICE ────────────────────────────────────────
//
// Two suites need these bytes: the pre-phase load gate and #631's save-size gate. The
// obvious alternative — importing one `.test.ts` from the other — re-executes the
// imported file's `describe` blocks, so its assertions run twice under two names and the
// repo's test count moves for a reason unrelated to any test being added. Measured while
// writing these gates: the borrowing suite reported 7 tests when it defined 3.
//
// REF: tools/gates/sourceFiles.ts (the same fence, stated at length);
//      src/core/project/preNs1Fixture.test.ts + src/core/project/saveIsOScene.gate.test.ts
//      (the two consumers); issues #631, #395, #628.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolved from this file rather than from each caller's depth. */
export const PRE_NS1_FIXTURE_PATH = join(
  __dirname,
  '../../src/core/project/__fixtures__/pre-ns1-project.json',
);

/** The fixture's bytes, exactly as committed.
 *
 *  Read as bytes rather than imported as a JSON module: the save-size gate needs the real
 *  payload length, and a bundler-parsed import is not the thing that was written to disk. */
export function readPreNs1FixtureBytes(): Buffer {
  return readFileSync(PRE_NS1_FIXTURE_PATH);
}
