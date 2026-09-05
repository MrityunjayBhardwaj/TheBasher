// External-model licence gate.
//
// scripts/license-audit.mjs walks the npm production dependency tree. Models and
// weights reached over HTTP are not in that tree, so that gate cannot see them —
// the population is invisible to it by construction. This module covers it.
//
// Two checks, and the second is the one with teeth: a model recorded as BLOCKED
// must not be referenced from src/. Recording a verdict makes it known; this makes
// it enforced, which is the difference between "named as blocked" and "quietly
// built against and discovered at ship time".
//
// REF: THESIS.md §35 (permissive only), scripts/external-models.json,
// docs/EXTERNAL-MODEL-LICENCES.md, ref/architecture/ai-track.md phase A0.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const VERDICTS = new Set(['ALLOWED', 'ALLOWED_WITH_CONDITIONS', 'BLOCKED']);

// Every root where a model id could be referenced by code that actually runs.
// `docs/` is absent on purpose: prose must be able to name a blocked model.
//
// `public/` is here because its contents are SERVED — a JSON file naming a
// checkpoint reaches the client as surely as a TypeScript import does, and the
// scan read none of it (#750).
// `tools/` holds the repo's structural gates AND a vite plugin — build-path code
// by any reading. It is named here rather than swept in by recursion, because a
// covered root should be a decision somebody took.
export const SCAN_ROOTS = ['src', 'tests', 'scripts', 'public', 'tools'];

// The repo root, scanned FLAT. Eleven config files live here that very much run —
// vite.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.js,
// tailwind/postcss configs, the tsconfigs, package.json and its lock — and a
// model id reaches production perfectly well through a `define`, an npm script,
// or a dependency name. Measured before the fix: a blocked checkpoint planted in
// vite.config.ts and in public/ produced a CLEAN PASS.
//
// Flat rather than recursive, and the reason is about decisions rather than cost.
// Measured: with every root above named, recursing from `.` adds exactly ZERO
// further files — so recursion buys nothing today. What it would cost is the
// property that the covered set is CHOSEN: a directory added tomorrow would enter
// the scan because it exists, not because anyone decided it should, and a root
// nobody decided on is a root nobody re-examines. (Recursion's only current
// difference, before `tools` was named, was six files under tools/ — found by
// measuring rather than by the reasoning in an earlier draft of this comment,
// which claimed coverage/ and .git and was simply wrong: EXTS excludes their
// contents.)
export const SCAN_ROOT_FILES = ['.'];

// The three files whose job is to name blocked models. Without this the gate reds
// on its own record — and since the manifest moved under src/ so runtime code can
// read it, that is no longer hypothetical: it sits inside a scanned root.
// Enumerated exactly, never a glob or a directory — an over-broad exemption
// silently re-opens the hole it was cut for (#737).
export const EXEMPT = [
  'src/core/licensing/external-models.json',
  'scripts/external-model-audit.mjs',
  'scripts/external-model-audit.test.mjs',
];

const REQUIRED = ['id', 'name', 'role', 'source', 'licence', 'verdict', 'reason', 'citations'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parsed as UTC midnight so the verdict does not depend on the runner's timezone. */
function parseDay(s) {
  return Date.parse(`${s}T00:00:00Z`);
}

/** A verdict's own check date, falling back to the manifest-wide one (#740). */
export function entryCheckedAt(model, manifest) {
  return model?.checkedAt ?? manifest?.checkedAt ?? null;
}

/**
 * A recorded verdict is a measurement with a shelf life, not a fact — the NVIDIA
 * Open Model grant is revocable and incorporates terms by reference, so it can
 * change without anything here moving. `now` is injected so the result is
 * deterministic and the thresholds are testable without waiting (#740).
 */
export function checkStaleness(manifest, now = new Date()) {
  const cfg = manifest?.staleness ?? {};
  const warnAfter = Number(cfg.warnAfterDays);
  const failAfter = Number(cfg.failAfterDays);
  const warnings = [];
  const failures = [];
  if (!Number.isFinite(warnAfter) || !Number.isFinite(failAfter)) {
    return {
      warnings,
      failures: ['staleness.warnAfterDays / staleness.failAfterDays missing or not numbers'],
    };
  }
  const nowMs = now.getTime();
  for (const m of manifest?.models ?? []) {
    const at = entryCheckedAt(m, manifest);
    if (!at || !DATE.test(at)) {
      failures.push(`${m?.id}: checkedAt missing or not YYYY-MM-DD`);
      continue;
    }
    const ageDays = Math.floor((nowMs - parseDay(at)) / 86400000);
    if (ageDays > failAfter)
      failures.push(`${m.id}: checked ${at}, ${ageDays}d old (hard limit ${failAfter}d)`);
    else if (ageDays > warnAfter)
      warnings.push(`${m.id}: checked ${at}, ${ageDays}d old (review at ${warnAfter}d)`);
  }
  return { warnings, failures };
}

/** Structural check on the manifest itself. Returns an array of problem strings. */
export function checkManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.checkedAt ?? '')) {
    problems.push('checkedAt missing or not YYYY-MM-DD');
  }
  const models = manifest.models;
  if (!Array.isArray(models) || models.length === 0)
    return [...problems, 'models is empty or not an array'];

  const seen = new Set();
  for (const m of models) {
    const id = m?.id ?? '<no id>';
    for (const field of REQUIRED) {
      if (m?.[field] === undefined || m?.[field] === null || m?.[field] === '') {
        problems.push(`${id}: missing required field "${field}"`);
      }
    }
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
    if (!VERDICTS.has(m?.verdict)) {
      problems.push(`${id}: verdict "${m?.verdict}" is not one of ${[...VERDICTS].join(', ')}`);
    }
    // A verdict with no citation is an opinion. The whole point of A0 is the cited text.
    const cites = Array.isArray(m?.citations) ? m.citations : [];
    if (cites.length === 0)
      problems.push(`${id}: no citations — a verdict without cited terms is an opinion`);
    for (const c of cites) {
      if (typeof c !== 'string' || !/^https?:\/\//.test(c))
        problems.push(`${id}: citation is not a URL: ${c}`);
    }
    if (m?.checkedAt !== undefined && !DATE.test(String(m.checkedAt))) {
      problems.push(`${id}: checkedAt "${m.checkedAt}" is not YYYY-MM-DD`);
    }
    // Conditions are what makes a conditional grant honourable at the point of use.
    if (
      m?.verdict === 'ALLOWED_WITH_CONDITIONS' &&
      !(Array.isArray(m?.conditions) && m.conditions.length)
    ) {
      problems.push(`${id}: ALLOWED_WITH_CONDITIONS but lists no conditions`);
    }
    // The exact wording a licence demands is DATA, not prose buried inside a
    // condition. The NVIDIA grant requires a notice reading a specific sentence;
    // a generator that paraphrased it would produce a NOTICE that identifies the
    // obligation and does not discharge it — which is the failure this whole file
    // is about, one level in.
    if (m?.verdict === 'ALLOWED_WITH_CONDITIONS' && !String(m?.attribution ?? '').trim()) {
      problems.push(
        `${id}: ALLOWED_WITH_CONDITIONS but no "attribution" — the exact notice text the ` +
          'licence demands must be recorded verbatim so NOTICE can carry it, not paraphrase it',
      );
    }
  }
  return problems;
}

/** Every identifier a BLOCKED model would plausibly be referenced by. */
export function blockedNeedles(manifest) {
  const needles = [];
  for (const m of manifest.models ?? []) {
    if (m.verdict !== 'BLOCKED') continue;
    // The id, plus each comma-separated name — checkpoint families list several.
    const names = String(m.name)
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    // An id and a name can normalise to the same needle (kimodo-smplx-rp-v1), which
    // would report one reference twice and inflate the count. Dedupe per model.
    const seen = new Set();
    for (const n of [m.id, ...names]) {
      const needle = String(n ?? '').toLowerCase();
      if (needle.length < 4 || seen.has(needle)) continue;
      seen.add(needle);
      needles.push({ id: m.id, needle });
    }
  }
  return needles;
}

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'];

/** The matching files directly inside `dir`, never descending. */
function listFilesFlat(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((e) => e.isFile() && exts.includes(path.extname(e.name)))
    .map((e) => path.join(dir, e.name));
}

/**
 * Absolute paths git ignores, asked of git rather than restated here (#929).
 *
 * The recursive walk used to skip a hardcoded `node_modules` / `dist` pair. That
 * pair is a GUESS at the ignore list, and it drifted: `test-results/` is written
 * by every local Playwright run and is gitignored (.gitignore:33), so the
 * coverage check below found it, reported a directory outside every named root,
 * and redded. The tier was therefore red by default for anyone who had run the
 * e2e suite — a standing red that three sessions in a row triaged by hand and
 * wrote "environment, do not chase" into their handoffs. A red everyone is
 * trained to ignore is the state in which a REAL failure of that check is also
 * waved through, which is the whole value of the check gone.
 *
 * Asking git closes the drift permanently: the exemption cannot disagree with
 * what the repo actually ignores, because it IS what the repo ignores. It also
 * subsumes both hardcoded names and picks up `.anvi`, `playwright-report/` and
 * anything a future tool drops in.
 *
 * Returns an empty set if git is unavailable or this is not a work tree — the
 * walk then behaves as it did before, which is the safe direction: scanning too
 * much makes the gate noisy, never silently permissive.
 */
let ignoredCache = null;
export function gitIgnoredPaths(repoRoot) {
  if (ignoredCache && ignoredCache.root === repoRoot) return ignoredCache.set;
  const set = new Set();
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of out.split('\n')) {
      const rel = line.trim().replace(/\/$/, '');
      if (rel) set.add(path.resolve(repoRoot, rel));
    }
  } catch {
    // No git, or not a work tree. Fall through with an empty set.
  }
  ignoredCache = { root: repoRoot, set };
  return set;
}

function walkDir(dir, exts, out, ignored = new Set()) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (ignored.has(path.resolve(p))) continue;
    if (entry.isDirectory()) {
      walkDir(p, exts, out, ignored);
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Files to scan, as repo-relative POSIX paths, across every scan root minus the
 * exact exemptions. Repo-relative because the exemption list is written that way —
 * comparing absolute paths would make every exemption silently fail to match, and
 * the gate would then red on its own manifest (#737).
 */
export function listSourceFiles(
  repoRoot,
  roots = SCAN_ROOTS,
  exempt = EXEMPT,
  exts = EXTS,
  flatRoots = SCAN_ROOT_FILES,
) {
  const exemptSet = new Set(exempt);
  const seen = new Set();
  const out = [];
  const add = (abs) => {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    // Deduped because a flat root and a named root can name the same file if the
    // lists ever overlap; a file counted twice would report one reference twice
    // and inflate the count, the same hazard blockedNeedles dedupes for.
    if (exemptSet.has(rel) || seen.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  const ignored = gitIgnoredPaths(repoRoot);
  for (const root of roots) {
    for (const abs of walkDir(path.join(repoRoot, root), exts, [], ignored)) add(abs);
  }
  for (const root of flatRoots) {
    for (const abs of listFilesFlat(path.join(repoRoot, root), exts)) add(abs);
  }
  return out;
}

/** The NOTICE file's repo-relative path. Conventional name, repo root, so a
 *  recipient finds it where every other project puts it. */
export const NOTICE_PATH = 'NOTICE';

const NOTICE_HEADER = [
  'NOTICE',
  '',
  'This file is GENERATED from src/core/licensing/external-models.json.',
  'Do not edit it by hand — run `npm run notice` and commit the result.',
  '',
  'It exists because a licence condition that is only RECORDED is not honoured.',
  'The manifest names the obligations; this file is the repo carrying one of them',
  'out, and the external-model audit fails if the two disagree.',
  '',
];

/**
 * The NOTICE text a manifest entails, derived from the recorded conditions of
 * every non-blocked model that has any.
 *
 * Generated rather than written because a hand-maintained notice and a recorded
 * obligation drift the moment either moves, and the drift is silent in the
 * direction that matters: the notice keeps saying something reassuring while the
 * terms it describes have changed. Blocked models are excluded — we owe nothing
 * for something we do not use, and naming one here would trip the blocked-model
 * scan besides.
 */
export function buildNotice(manifest) {
  const lines = [...NOTICE_HEADER];
  const owing = (manifest?.models ?? []).filter(
    (m) => m.verdict !== 'BLOCKED' && Array.isArray(m.conditions) && m.conditions.length > 0,
  );
  if (owing.length === 0) {
    lines.push('No external model currently in use carries licence conditions.', '');
    return lines.join('\n');
  }
  for (const m of owing) {
    // The attribution line goes FIRST and verbatim, because it is the obligation
    // itself rather than a description of one.
    lines.push(`${m.attribution}`, '');
    lines.push(`  Applies to: ${m.name}`, `  Source: ${m.source}`, '');
    lines.push('  Conditions this project is obliged to honour:');
    for (const c of m.conditions) lines.push(`    - ${c}`);
    lines.push('');
    if (Array.isArray(m.citations) && m.citations.length) {
      // "Pass a copy of the agreement to recipients" is discharged here by
      // reference, not by bundling. Stated plainly rather than left ambiguous:
      // the agreement is not vendored into this repo, and if a distribution ever
      // needs the text itself rather than a link, that is a further step nobody
      // has taken.
      lines.push('  A copy of the agreement, by reference:');
      for (const c of m.citations) lines.push(`    ${c}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Does the shipped NOTICE match what the manifest entails? Returns problem
 * strings.
 *
 * This is the half of the gate with teeth. Checking that a conditional verdict
 * LISTS conditions — which the manifest check already did — asks whether we have
 * identified an obligation. It never asks whether anything carries one out, and
 * the first recorded condition is literally "ship a NOTICE file". Identification
 * is not prevention.
 */
export function checkNotice(repoRoot, manifest, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const expected = buildNotice(manifest);
  let actual;
  try {
    actual = readFile(path.join(repoRoot, NOTICE_PATH));
  } catch {
    return [
      `${NOTICE_PATH} is missing, and the manifest records conditions that require it. ` +
        'Run `npm run notice` and commit the result.',
    ];
  }
  if (actual.trimEnd() !== expected.trimEnd()) {
    return [
      `${NOTICE_PATH} does not match the manifest's recorded conditions. ` +
        'A notice that disagrees with the terms it describes is worse than none, ' +
        'because it reads as compliance. Run `npm run notice` and commit the result.',
    ];
  }
  return [];
}

/** Returns [{file, id, needle}] for every BLOCKED model referenced in the given files. */
export function findBlockedReferences(
  manifest,
  files,
  readFile = (f) => fs.readFileSync(f, 'utf8'),
) {
  const needles = blockedNeedles(manifest);
  const hits = [];
  for (const file of files) {
    let txt;
    try {
      txt = readFile(file).toLowerCase();
    } catch {
      continue;
    }
    for (const { id, needle } of needles) {
      if (txt.includes(needle)) hits.push({ file, id, needle });
    }
  }
  return hits;
}

/** Console-reporting entry point. Returns 0 clean, 3 on any problem. */
export function auditExternalModels({ manifestPath, repoRoot, now = new Date() }) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`✗ External-model manifest missing: ${manifestPath}`);
    return 3;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const problems = checkManifest(manifest);
  if (problems.length) {
    console.error(`✗ External-model manifest invalid (${problems.length}):`);
    for (const p of problems) console.error(`  ${p}`);
    return 3;
  }

  const { warnings, failures } = checkStaleness(manifest, now);
  if (failures.length) {
    console.error(`✗ External-model verdicts are stale (${failures.length}):`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('  Re-check the terms, update checkedAt, re-run. The NVIDIA grant is revocable.');
    return 3;
  }
  for (const w of warnings) console.warn(`⚠ ${w}`);

  const noticeProblems = checkNotice(repoRoot, manifest);
  if (noticeProblems.length) {
    console.error(`✗ Licence conditions are not honoured (${noticeProblems.length}):`);
    for (const n of noticeProblems) console.error(`  ${n}`);
    return 3;
  }

  const files = listSourceFiles(repoRoot);
  const hits = findBlockedReferences(manifest, files, (f) =>
    fs.readFileSync(path.join(repoRoot, f), 'utf8'),
  );
  if (hits.length) {
    console.error(`✗ BLOCKED model referenced in source (${hits.length}):`);
    for (const h of hits) console.error(`  ${h.file}: "${h.needle}" (${h.id})`);
    console.error('  See docs/EXTERNAL-MODEL-LICENCES.md. These terms forbid production use.');
    return 3;
  }

  const counts = { ALLOWED: 0, ALLOWED_WITH_CONDITIONS: 0, BLOCKED: 0 };
  for (const m of manifest.models) counts[m.verdict]++;
  console.log(
    `✓ External-model audit passed: ${manifest.models.length} recorded ` +
      `(${counts.ALLOWED} allowed, ${counts.ALLOWED_WITH_CONDITIONS} conditional, ${counts.BLOCKED} blocked), ` +
      `${files.length} files scanned across ${[...SCAN_ROOTS, ...SCAN_ROOT_FILES].join(', ')} ` +
      `(${EXEMPT.length} exempt), ` +
      `checked ${manifest.checkedAt}.`,
  );
  return 0;
}
