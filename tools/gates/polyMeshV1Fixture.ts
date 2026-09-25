// The one reader for the version-1 stored-mesh project fixture (#1117).
//
// It lives in `tools/` for the reason `preNs1Fixture.ts` states at length: it reads from disk, and
// a module under `src/` importing `node:fs` fails `npm run typecheck`.
//
// REF: tools/gates/preNs1Fixture.ts (the fence, and the rule that a captured fixture is never
//      regenerated); src/core/project/polyMeshV1Fixture.test.ts (the consumer); issues #1117, #1062.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolved from this file rather than from each caller's depth. */
export const POLYMESH_V1_FIXTURE_PATH = join(
  __dirname,
  '../../src/core/project/__fixtures__/polymesh-v1-project.json',
);

/** The fixture's bytes, exactly as committed. */
export function readPolyMeshV1FixtureBytes(): Buffer {
  return readFileSync(POLYMESH_V1_FIXTURE_PATH);
}
