// The ADEQUACY HARNESS — issue #883.
//
// ── WHAT IT ANSWERS, AND WHY A GREEN SUITE DOES NOT ───────────────────────────────────
//
// A gate that has never been seen RED carries no information. It is a test that happens
// to pass, and the two are indistinguishable from the outside: both print a tick. Three
// defects in the animation / import / retarget sector — a bone sweeping 360 degrees
// through a clip (#867), the same through a glTF clip (#876), and a bake that smoothsteps
// what its source lerps (#877) — were each found by a human looking at a screen. Every one
// had a test file pointed straight at it, and every one of those files stayed green,
// because a property of a SEQUENCE was being asserted at a single POINT.
//
// So the question this harness exists for is: if the defect a gate claims to guard were
// put back into the production code, would that gate say so? It applies a named inverse
// edit, runs the paired gate files, records red/green BY NAME, puts the tree back, and
// refuses to report anything unless the tree is byte-identical afterwards.
//
// ── WHY IT COMPARES AGAINST A DECLARED EXPECTATION AND NOT JUST red > 0 ───────────────
//
// The first run of this sweep produced 8 greens out of 19 pairs. Reporting all 8 as blind
// gates would have been the same overclaiming the sweep exists to catch: five of them were
// inversions aimed OUTSIDE that gate's subject, which is the sweep's aim being wrong, not
// the gate's coverage. So every pair in the manifest declares what it EXPECTS, with the
// reason, and the harness reports agreement rather than a bare colour. A green that is
// expected — `retargetThenBake` under a value corruption — is a documented blindness held
// in place on purpose, and it is worth as much as a red.
//
// ── THE META-TRAP, WHICH BIT ON DESIGN ────────────────────────────────────────────────
//
// An inversion that silently fails to apply — a string that no longer matches after a
// refactor — makes a perfectly good gate look blind, and the report is indistinguishable
// from a real finding. So the patch's effect on the tree is ASSERTED, per file, before any
// gate runs; a pair whose inversion did not land is reported as `applied: false` and its
// verdict is withheld rather than guessed. The same applies at the other end: the revert is
// checked against a clean tree, in the same command that did the mutating.
//
// A gate is also run CLEAN first. A gate that is already red proves nothing about the
// inversion, and without the baseline the two cases read identically.
//
// ── WHY `.mjs` AND NOT `.ts` ──────────────────────────────────────────────────────────
//
// The same reason `discardHarness.mjs` gives, measured rather than assumed: nothing in
// this repo can execute a `.ts` file (no `tsx`/`ts-node`), and CI pins node 22, which does
// not strip types. A `.ts` CLI would run on a developer machine and fail on the runner —
// the worst outcome, because it would look like it works.
//
// ── HOW TO RUN ────────────────────────────────────────────────────────────────────────
//
//   node tools/gates/adequacyHarness.mjs --list
//   node tools/gates/adequacyHarness.mjs --all
//   node tools/gates/adequacyHarness.mjs <inversion-name>
//
// Inversions are `tools/gates/inversions/<name>.patch`, produced by `git diff`, and paired
// with the gates they should move in `tools/gates/inversions/manifest.json`. Output is one
// JSON object on stdout. Exit code is 1 if any pair disagrees with its declared
// expectation, 2 if the tree did not come back clean.
//
// REF: tools/gates/inversions/README.md (the measured table); tools/gates/discardHarness.mjs
//      (the sibling instrument — whole-tier discards rather than paired gates); issue #883.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const PATCH_DIR = join(HERE, 'inversions');
const MANIFEST = join(PATCH_DIR, 'manifest.json');

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

/** Every tracked file with uncommitted changes. The harness refuses to run if non-empty. */
function dirtyTrackedFiles() {
  return git('status', '--porcelain', '--untracked-files=no')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')).pairs;
}

function listInversions() {
  if (!existsSync(PATCH_DIR)) return [];
  return readdirSync(PATCH_DIR)
    .filter((f) => f.endsWith('.patch'))
    .map((f) => f.replace(/\.patch$/, ''))
    .sort();
}

/** The files a patch touches, read from its own headers — so "did it apply?" is asked of
 *  the exact set the patch claims, not of a guess. */
function filesInPatch(body) {
  const files = new Set();
  for (const line of body.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files];
}

/** Content hashes, not sizes — the edits this sweep makes are same-length substitutions
 *  ('linear' -> 'cubic'), which a size comparison cannot see at all. */
function fingerprint(files) {
  const out = {};
  for (const f of files) {
    const abs = join(REPO, f);
    out[f] = existsSync(abs) ? hash(readFileSync(abs, 'utf8')) : 'ABSENT';
  }
  return out;
}

/** FNV-1a, 32-bit. Enough to answer "did these bytes change?", which is all that is asked. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Run vitest over exactly the named gate files and read the result back.
 *
 * Returns an `unreadable` reason rather than a count when the reporter's output cannot be
 * parsed. A harness that silently reports `red: 0` because it misread its own instrument
 * is the exact failure it exists to catch, and a zero there would agree with the most
 * comfortable hypothesis available.
 */
function runGate(file) {
  const dir = mkdtempSync(join(tmpdir(), 'basher-adequacy-'));
  const outFile = join(dir, 'result.json');
  try {
    spawnSync('npx', ['vitest', 'run', file, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!existsSync(outFile)) {
      return { unreadable: 'the reporter wrote no output file — the run did not start' };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch (e) {
      return { unreadable: `the reporter's output is not JSON: ${String(e)}` };
    }
    const suites = Array.isArray(parsed.testResults) ? parsed.testResults : null;
    if (suites === null || typeof parsed.numTotalTests !== 'number') {
      return { unreadable: `unexpected reporter shape: keys ${Object.keys(parsed).join(',')}` };
    }
    const names = [];
    for (const suite of suites) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status === 'failed') names.push(assertion.fullName ?? '<unnamed>');
      }
    }
    // A file that collected zero tests is not a green — it is an unreadable instrument.
    if (parsed.numTotalTests === 0) {
      return { unreadable: `${file} collected 0 tests` };
    }
    return { tests: parsed.numTotalTests, red: parsed.numFailedTests ?? names.length, names };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPair(pair) {
  const patchFile = join(PATCH_DIR, `${pair.inversion}.patch`);
  if (!existsSync(patchFile)) {
    return { inversion: pair.inversion, error: `no such patch: ${pair.inversion}` };
  }
  const body = readFileSync(patchFile, 'utf8');
  // Only the entry literally named `null` is allowed to be empty. Any OTHER empty patch is
  // an accident — a capture that wrote nothing — and it would otherwise sail through as
  // "applied", turn every paired gate green, and read exactly like a blind-gate finding.
  // That is the meta-trap this harness exists to avoid, one level up.
  const isNull = pair.inversion === 'null';
  if (body.trim() === '' && !isNull) {
    return {
      inversion: pair.inversion,
      defect: pair.defect,
      files: [],
      applied: false,
      note: `${pair.inversion}.patch is EMPTY and is not the null control — VERDICT WITHHELD`,
    };
  }
  const touched = filesInPatch(body);

  // Baseline: the gate must be GREEN before the inversion, or its red afterwards says
  // nothing about the inversion.
  const baseline = {};
  for (const g of pair.gates) baseline[g.file] = runGate(g.file);

  const before = fingerprint(touched);
  if (!isNull) execFileSync('git', ['apply', patchFile], { cwd: REPO });
  const after = fingerprint(touched);
  // ASSERTED, not assumed, and asserted BEFORE the gates run — an inversion that silently
  // failed to apply makes a good gate look blind and reads exactly like a real finding.
  const applied = isNull
    ? true
    : touched.length > 0 && touched.every((f) => before[f] !== after[f]);

  const gates = [];
  try {
    if (applied) {
      for (const g of pair.gates) {
        const base = baseline[g.file];
        const run = runGate(g.file);
        const observed = run.unreadable ? 'unreadable' : run.red > 0 ? 'red' : 'green';
        const baseObserved = base.unreadable ? 'unreadable' : base.red > 0 ? 'red' : 'green';
        gates.push({
          file: g.file,
          subject: g.subject,
          baseline: baseObserved,
          expected: g.expect,
          observed,
          agrees: baseObserved === 'green' && observed === g.expect,
          tests: run.tests,
          red: run.red,
          names: (run.names ?? []).sort(),
          ...(run.unreadable ? { unreadable: run.unreadable } : {}),
          ...(baseObserved !== 'green'
            ? { note: 'the gate was NOT green before the inversion — no verdict is available' }
            : {}),
        });
      }
    }
  } finally {
    if (!isNull) execFileSync('git', ['apply', '-R', patchFile], { cwd: REPO });
  }

  return {
    inversion: pair.inversion,
    defect: pair.defect,
    files: touched,
    applied,
    ...(applied
      ? { gates }
      : { note: 'the patch did not change every file it names — VERDICT WITHHELD' }),
  };
}

function main() {
  const arg = process.argv[2];
  if (arg === '--list' || arg === undefined) {
    const pairs = loadManifest().map((p) => ({
      inversion: p.inversion,
      gates: p.gates.map((g) => `${g.file} → ${g.expect}`),
    }));
    process.stdout.write(`${JSON.stringify({ patches: listInversions(), pairs }, null, 2)}\n`);
    process.exit(arg === undefined ? 1 : 0);
  }

  // The harness reverts with `git apply -R`. If anything tracked is already modified, a
  // failed revert would take real work with it — so refuse before touching anything.
  const dirty = dirtyTrackedFiles();
  if (dirty.length > 0) {
    process.stderr.write(
      `refusing to run: ${dirty.length} tracked file(s) already modified.\n${dirty.join('\n')}\n`,
    );
    process.exit(1);
  }

  const manifest = loadManifest();
  const selected = arg === '--all' ? manifest : manifest.filter((p) => p.inversion === arg);
  if (selected.length === 0) {
    process.stderr.write(
      `no such inversion in the manifest: ${arg} (have: ${manifest.map((p) => p.inversion).join(', ')})\n`,
    );
    process.exit(1);
  }

  const results = selected.map(runPair);
  const reverted = dirtyTrackedFiles().length === 0;
  const disagreements = results.flatMap((r) =>
    (r.gates ?? []).filter((g) => !g.agrees).map((g) => `${r.inversion} / ${g.file}`),
  );
  const withheld = results.filter((r) => !r.applied).map((r) => r.inversion);

  process.stdout.write(
    `${JSON.stringify({ results, disagreements, withheld, reverted }, null, 2)}\n`,
  );
  if (!reverted) {
    process.stderr.write('THE TREE IS NOT BYTE-IDENTICAL AFTER REVERT — do not trust this run\n');
    process.exit(2);
  }
  process.exit(disagreements.length > 0 || withheld.length > 0 ? 1 : 0);
}

main();
