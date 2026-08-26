// Regenerate the NOTICE file from the external-model manifest.
//
// The NOTICE is generated rather than hand-written because a hand-maintained
// notice and a recorded obligation drift the moment either moves, and the drift
// is silent in the direction that matters: the file keeps saying something
// reassuring while the terms it describes have changed. `checkNotice` in the
// audit fails when the two disagree, so this script is how you make them agree.
//
// REF: scripts/external-model-audit.mjs (buildNotice, checkNotice, NOTICE_PATH).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNotice, NOTICE_PATH } from './external-model-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const manifestPath = path.join(repoRoot, 'src', 'core', 'licensing', 'external-models.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const target = path.join(repoRoot, NOTICE_PATH);
const next = `${buildNotice(manifest)}\n`;
const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;

fs.writeFileSync(target, next);
console.log(
  prev === next ? `✓ ${NOTICE_PATH} already up to date.` : `✓ ${NOTICE_PATH} regenerated.`,
);
