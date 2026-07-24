#!/usr/bin/env node
//
// The e2e merge gate: a SET DIFFERENCE, not a label.
//
// Our e2e job is red on `main` and has been for a long time — headless-linux
// rendering debt that passes on darwin. That is tolerable. What is not
// tolerable is the way it was consulted: the merge decision asked "is e2e red?"
// (yes, expected) instead of "does this branch fail anything main does not?".
// A gate that answers the first question absorbs every new failure silently,
// and it did — 18 of them across three merges (#461, #462), while the recorded
// accepted list stayed perfectly accurate the whole time. The list never went
// stale; the comparison simply never ran.
//
// So the fix is the OPERATION, not the data. This script computes the failing
// set from a Playwright HTML report and compares it against a committed
// baseline that lives here, in the repo, where CI reads it — never in a doc a
// human is expected to remember.
//
// Three properties are load-bearing. Please don't quietly change them:
//
//   1. The predicate is ⊆, not ==. We fail only on failures NOT in the
//      baseline. An accepted test that flakes GREEN must not red the build —
//      that happens for real (p7.14-my-imports and spline-projection both
//      flaked green on PR #464 while failing on main). Under == that is a
//      spurious red every few runs, and a gate that cries wolf gets bypassed,
//      which puts us right back where we started.
//
//   2. Tests are keyed by file + title, NEVER by line number. Line numbers
//      shift in any file a branch edits, which manufactures phantom diffs on
//      exactly the branches we most want to read carefully.
//
//   3. The baseline is measured on linux, because linux is what CI runs. A
//      gate can only compare against the platform it executes on. darwin has a
//      smaller accepted set and remains the better LOCAL instrument — run
//      `list` against a local playwright-report to use it — but there is one
//      committed baseline and it is linux's.
//
// Usage:
//   node scripts/e2e-diff.mjs check <report-dir>        # the CI gate
//   node scripts/e2e-diff.mjs list  <report-dir>        # print the failing set
//   node scripts/e2e-diff.mjs diff  <dir-a> <dir-b>     # compare two runs
//
// <report-dir> is a Playwright HTML report directory (the `playwright-report/`
// our config writes, or an unpacked `playwright-report` CI artifact).
//
// Options:
//   --baseline <path>   override the baseline file (default: the constant below)
//   --min-tests <n>     override the vacuous-run floor (default: 500)

import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = join(REPO_ROOT, 'tests', 'e2e', 'accepted-failures.txt');

// Guard-the-guard. The CI step that runs Playwright is allowed to fail (that is
// the whole point — this script decides the job's verdict instead). But that
// means an infrastructure failure — build broken, dev server never came up,
// Playwright died on startup — produces a report with almost no tests in it,
// and an empty failing set would sail through as "nothing new". So refuse to
// render a verdict on a run that plainly did not happen. The suite is ~650
// tests; this is a floor, not a target, and it only ever needs raising.
const MIN_EXPECTED_TESTS = 500;

// Playwright's HTML report precomputes an `outcome` per test. Anything outside
// this set is a genuine failure. `flaky` means it failed then passed on retry —
// we run with retries:1 in CI, and a test that eventually passed is not a
// regression this gate should block on.
const PASSING_OUTCOMES = new Set(['expected', 'skipped', 'flaky']);

/**
 * Decode a Playwright HTML report directory into its report + per-file shards.
 *
 * The report data is a base64 zip embedded in a <template> element inside
 * index.html — NOT on `window.playwrightReportBase64`, which is what you find
 * by guessing and which does not exist. Found by reading a real artifact.
 */
function unpackReport(dir) {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) {
    fail(
      `no index.html in ${dir}\n` +
        `  Expected a Playwright HTML report directory. If the e2e run died before\n` +
        `  writing one, that is the real failure — fix that, don't skip this gate.`,
    );
  }
  const html = readFileSync(indexPath, 'utf8');
  const m = html.match(/<template id="playwrightReportBase64"[^>]*>([\s\S]*?)<\/template>/);
  if (!m) fail(`no embedded report payload in ${indexPath}`);

  const b64 = m[1]
    .trim()
    .replace(/^data:[^,]*,/, '')
    .replace(/\s/g, '');
  const work = mkdtempSync(join(tmpdir(), 'e2e-diff-'));
  writeFileSync(join(work, 'r.zip'), Buffer.from(b64, 'base64'));
  try {
    execFileSync('unzip', ['-o', '-q', 'r.zip'], { cwd: work });
  } catch (err) {
    fail(`could not unzip the embedded report (is \`unzip\` on PATH?): ${err.message}`);
  }
  return work;
}

/**
 * The identity of a test, for set comparison.
 *
 * File + full title path. No line number, deliberately — see property 2 above.
 * `path` holds enclosing describe() titles, which we include so two same-named
 * tests in different describe blocks stay distinguishable.
 */
export function keyFor(fileName, test) {
  return [fileName, ...(test.path ?? []), test.title].join(' › ');
}

/**
 * The gate's verdict, as a pure function so it can be tested without a report.
 *
 * `novel` is the only thing that fails a build: failures present in this run
 * and absent from the baseline. Everything else is reported but never fatal,
 * which is property 1 (⊆, not ==).
 *
 * The two non-fatal buckets are worth keeping apart, because only one of them
 * is actionable from a single run:
 *   - `recovered` — the test ran and passed. Could be a real fix worth pruning,
 *     could be an accepted test that flaked green and will be back. Telling
 *     those apart needs a second run.
 *   - `obsolete`  — no test with that key exists any more (renamed, deleted,
 *     retired). Unambiguously prunable, and worth surfacing loudly: under ⊆ a
 *     dead entry is invisible forever, which is how an allowlist quietly grows
 *     into the thing #463 exists to prevent.
 * `present` is every test key in the run; omit it to skip the obsolete split.
 */
export function classify(failing, baseline, present) {
  const failingSet = new Set(failing);
  const notFailing = [...baseline].filter((k) => !failingSet.has(k)).sort();
  if (!present) return { novel: failing.filter((k) => !baseline.has(k)), recovered: notFailing };
  return {
    novel: failing.filter((k) => !baseline.has(k)),
    recovered: notFailing.filter((k) => present.has(k)),
    obsolete: notFailing.filter((k) => !present.has(k)),
  };
}

/** Parse baseline file contents. Blank lines and `#` comments are ignored. */
export function parseBaseline(contents) {
  return new Set(
    contents
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

/** Read a report directory → { failing: string[], present: Set<string>, total: number }. */
function readFailing(dir) {
  const work = unpackReport(dir);
  const report = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8'));

  const failing = [];
  const present = new Set();
  let total = 0;
  for (const f of report.files ?? []) {
    const shard = JSON.parse(readFileSync(join(work, f.fileId + '.json'), 'utf8'));
    for (const t of shard.tests ?? []) {
      total += 1;
      const key = keyFor(shard.fileName, t);
      present.add(key);
      if (!PASSING_OUTCOMES.has(t.outcome)) failing.push(key);
    }
  }
  failing.sort();
  return { failing, present, total };
}

/** Read the committed baseline. Blank lines and `#` comments are ignored. */
function readBaseline(path) {
  if (!existsSync(path)) {
    fail(
      `no baseline at ${path}\n` +
        `  Seed it from a linux CI run on main:\n` +
        `    gh run download <run-id> -n playwright-report -D /tmp/main-report\n` +
        `    node scripts/e2e-diff.mjs list /tmp/main-report > ${path}`,
    );
  }
  return parseBaseline(readFileSync(path, 'utf8'));
}

function fail(msg) {
  console.error(`e2e-diff: ${msg}`);
  process.exit(2);
}

/** Refuse to render a verdict on a run that plainly did not happen. */
function assertRunHappened(total, minTests, dir) {
  if (total < minTests) {
    fail(
      `only ${total} tests in ${dir} (floor is ${minTests}).\n` +
        `  A run this small means the suite did not execute — a broken build, a dev\n` +
        `  server that never came up, or Playwright dying on startup. Reporting\n` +
        `  "no new failures" here would be a vacuous pass, so this is a hard error.`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI. Guarded so the pure helpers above can be imported by the unit test
// without this running — and calling process.exit — on import.

function runList(dirs) {
  if (dirs.length !== 1) fail('usage: e2e-diff.mjs list <report-dir>');
  const { failing, total } = readFailing(dirs[0]);
  // The set goes to stdout and the summary to stderr, so `list > baseline.txt`
  // captures exactly the baseline and nothing else.
  console.log(failing.join('\n'));
  console.error(`# ${failing.length} failing of ${total} tests in ${dirs[0]}`);
}

function runDiff(dirs) {
  if (dirs.length !== 2) fail('usage: e2e-diff.mjs diff <dir-a> <dir-b>');
  const a = readFailing(dirs[0]);
  const b = readFailing(dirs[1]);
  // Same predicate as the gate, read in both directions: B-vs-A gives what B
  // newly breaks, A-vs-B what B no longer fails.
  const { novel: added } = classify(b.failing, new Set(a.failing));
  const { novel: gone } = classify(a.failing, new Set(b.failing));

  console.log(`A ${dirs[0]}: ${a.failing.length} failing of ${a.total}`);
  console.log(`B ${dirs[1]}: ${b.failing.length} failing of ${b.total}`);
  console.log(`\nNEW in B (${added.length}):`);
  console.log(added.length ? added.map((k) => `  + ${k}`).join('\n') : '  (none)');
  // Always print this side too. It is where accepted tests that merely flaked
  // GREEN show up, and mistaking one of those for a fix is how you conclude a
  // branch improved something it never touched.
  console.log(`\nGONE in B (${gone.length}) — fixes AND accepted tests that flaked green:`);
  console.log(gone.length ? gone.map((k) => `  - ${k}`).join('\n') : '  (none)');
  return added.length ? 1 : 0;
}

function runCheck(dirs, opts) {
  const dir = dirs[0] ?? 'playwright-report';
  const baseline = readBaseline(opts.baseline);
  const { failing, present, total } = readFailing(dir);
  assertRunHappened(total, opts.minTests, dir);

  const { novel, recovered, obsolete } = classify(failing, baseline, present);

  console.log(
    `e2e-diff: ${failing.length} failing of ${total}; baseline accepts ${baseline.size}.`,
  );
  if (recovered.length) {
    // Informational only — the predicate is ⊆, so this never fails the build.
    // Some of these are real fixes worth pruning from the baseline; others are
    // accepted tests that flaked green and will be back next run. Telling them
    // apart takes a second run, not a build failure.
    console.log(
      `\n${recovered.length} baseline entr${recovered.length === 1 ? 'y' : 'ies'} passed this run ` +
        `(a fix to prune, or a flake — confirm across two runs before removing):`,
    );
    for (const k of recovered) console.log(`  ~ ${k}`);
  }
  if (obsolete.length) {
    // These name tests that no longer exist — renamed, deleted, retired. Safe
    // to delete from the baseline right now; no second run needed to be sure.
    // Surfaced because under ⊆ a dead entry is otherwise invisible forever, and
    // a baseline that only ever grows is the disease this script treats.
    console.log(
      `\n${obsolete.length} baseline entr${obsolete.length === 1 ? 'y names a test' : 'ies name tests'} ` +
        `that no longer exist — safe to prune now:`,
    );
    for (const k of obsolete) console.log(`  ? ${k}`);
  }
  if (novel.length) {
    console.error(`\n✗ ${novel.length} failure(s) NOT in the baseline:`);
    for (const k of novel) console.error(`  + ${k}`);
    console.error(
      `\nThese are failures main does not have. If one is genuinely pre-existing\n` +
        `debt you have decided to accept, add it to ${opts.baseline} in this PR,\n` +
        `with a comment saying why — that keeps the record and the gate the same\n` +
        `object, which is the entire point of this script.`,
    );
    return 1;
  }
  console.log('\n✓ no failures outside the accepted baseline.');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { baseline: DEFAULT_BASELINE, minTests: MIN_EXPECTED_TESTS };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') opts.baseline = argv[++i];
    else if (argv[i] === '--min-tests') opts.minTests = Number(argv[++i]);
    else positional.push(argv[i]);
  }
  const [cmd, ...dirs] = positional;

  if (cmd === 'list') return runList(dirs);
  if (cmd === 'diff') return process.exit(runDiff(dirs));
  if (cmd === 'check' || cmd === undefined) return process.exit(runCheck(dirs, opts));
  fail(`unknown command "${cmd}"\n  usage: e2e-diff.mjs <check|list|diff> <report-dir...>`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
