// The DISCARD HARNESS — ns-2 step 2. Built BEFORE the road it is meant to measure.
//
// ── WHAT IT ANSWERS, AND WHY NOTHING ELSE DOES ────────────────────────────────────────
//
// A census over call sites bounds who may SPEAK. It never shows that anyone LISTENED.
// That is not a worry, it is a measurement: on this codebase, reverting a whole render
// wiring redded exactly ONE test — a source census — while keeping the call and throwing
// its answer away at the point of use redded ZERO of 4059, byte for byte, on a road that
// looked fully wired. Two edits one line apart, the same user-visible effect, and the
// entire suite could tell them apart only in the direction that does not matter.
//
// So the question this harness exists for is: if the new layer's answer were computed and
// then discarded, would ANYTHING say so, and WHICH thing? It applies a named inverse edit,
// runs the standing unit command, reports the failures BY NAME, puts the tree back, and
// refuses to finish unless the tree is byte-identical to where it started.
//
// ── WHY IT IS BUILT NOW, BEFORE THE ROAD EXISTS ───────────────────────────────────────
//
// A harness written after the layer is written by someone who now believes the layer
// works, and it will be shaped — unconsciously — to agree. Written first, against a road
// that has nothing to do with this phase, it has to earn its positive control on a road
// that already exists, which is the only chance to see it fail honestly.
//
// ── WHY `.mjs` AND NOT `.ts` ──────────────────────────────────────────────────────────
//
// Measured, not assumed. This is a CLI, and nothing in this repo can execute a `.ts` file:
// there is no `tsx`/`ts-node` dependency, and `tools/**/*.ts` is only ever IMPORTED by
// vitest-transpiled test files. Node strips types natively from 23.6, but CI pins node 22
// (`.github/workflows/ci.yml`), so a `.ts` CLI would run on this machine and fail on the
// runner — the worst of the two outcomes, because it would look like it works. `scripts/`
// already carries every runnable thing in this repo as `.mjs` for the same reason; this
// one lives in `tools/gates/` because it is a gate instrument, not a build script.
//
// ── HOW TO RUN ────────────────────────────────────────────────────────────────────────
//
//   node tools/gates/discardHarness.mjs <patch-name>
//   node tools/gates/discardHarness.mjs --list
//
// Patches are `tools/gates/discards/<patch-name>.patch`, produced by `git diff`. Output is
// one JSON object on stdout: `{ patch, files, tests, red, names, reverted }`.
//
// REF: `.anvi/…/phases/ns-2-component-groups/PLAN.md` §8 step 2 + §2 clause 4 (the discard
//      perturbation IS the exit); src/core/dag/ops.ts (the positive control's subject);
//      tools/gates/discards/README.md; issues #607, #660.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const PATCH_DIR = join(HERE, 'discards');

/**
 * The standing unit command, spelled ONCE.
 *
 * The selection is byte-identical to what the repo runs by hand and in CI
 * (`npx vitest run --exclude '**\/tmp-*'`). Only the REPORTER differs, because failing
 * test NAMES have to come back structured — a rerun overwrites logs, so a harness that
 * reports counts alone forces a second full run to learn what broke. The null control is
 * what proves the reporter changed nothing: its `{files, tests}` must equal the standing
 * tier's own numbers.
 */
const SELECTION = ['vitest', 'run', '--exclude', '**/tmp-*'];

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

/** Every tracked file with uncommitted changes. The harness refuses to run if this is non-empty. */
function dirtyTrackedFiles() {
  return git('status', '--porcelain', '--untracked-files=no')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function listPatches() {
  if (!existsSync(PATCH_DIR)) return [];
  return readdirSync(PATCH_DIR)
    .filter((f) => f.endsWith('.patch'))
    .map((f) => f.replace(/\.patch$/, ''))
    .sort();
}

/**
 * Run the standing command and read the result back.
 *
 * Returns an `unreadable` reason rather than a count when the reporter's output cannot be
 * parsed into the shape we expect. A harness that silently reports `red: 0` because it
 * misread its own instrument is the exact failure it exists to catch, and a zero here
 * would agree with the most comfortable hypothesis available.
 */
function runStandingCommand() {
  const dir = mkdtempSync(join(tmpdir(), 'basher-discard-'));
  const outFile = join(dir, 'result.json');
  try {
    spawnSync('npx', [...SELECTION, '--reporter=json', `--outputFile=${outFile}`], {
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
    return {
      files: suites.length,
      tests: parsed.numTotalTests,
      red: parsed.numFailedTests ?? names.length,
      names: names.sort(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const arg = process.argv[2];
  if (arg === '--list' || arg === undefined) {
    process.stdout.write(`${JSON.stringify({ patches: listPatches() }, null, 2)}\n`);
    process.exit(arg === undefined ? 1 : 0);
  }

  const patchFile = join(PATCH_DIR, `${arg}.patch`);
  if (!existsSync(patchFile)) {
    process.stderr.write(`no such patch: ${arg} (have: ${listPatches().join(', ')})\n`);
    process.exit(1);
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

  const body = readFileSync(patchFile, 'utf8');
  const empty = body.trim() === '';
  if (!empty) execFileSync('git', ['apply', patchFile], { cwd: REPO });

  let result;
  try {
    result = runStandingCommand();
  } finally {
    if (!empty) execFileSync('git', ['apply', '-R', patchFile], { cwd: REPO });
  }

  // Asserted, not assumed, and asserted in the SAME command that did the mutating — the
  // later check is the one that gets skipped when the number looks right.
  const reverted = dirtyTrackedFiles().length === 0;
  process.stdout.write(`${JSON.stringify({ patch: arg, ...result, reverted }, null, 2)}\n`);
  if (!reverted) {
    process.stderr.write('THE TREE IS NOT BYTE-IDENTICAL AFTER REVERT — do not trust this run\n');
    process.exit(2);
  }
}

main();
