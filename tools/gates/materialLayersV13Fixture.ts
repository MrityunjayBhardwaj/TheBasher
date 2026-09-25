// The one reader for the format-13 material fixture (#1062).
//
// It lives in `tools/` for the reason `preNs1Fixture.ts` states at length: it reads from disk, and
// a module under `src/` importing `node:fs` fails `npm run typecheck`.
//
// REF: tools/gates/polyMeshV1Fixture.ts (the same shape, one issue earlier);
//      src/core/project/materialLayersV13Fixture.test.ts (the consumer); issues #1062, #1117.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolved from this file rather than from each caller's depth. */
export const MATERIAL_LAYERS_V13_FIXTURE_PATH = join(
  __dirname,
  '../../src/core/project/__fixtures__/material-layers-v13-project.json',
);

/** The fixture's bytes, exactly as committed. */
export function readMaterialLayersV13FixtureBytes(): Buffer {
  return readFileSync(MATERIAL_LAYERS_V13_FIXTURE_PATH);
}
