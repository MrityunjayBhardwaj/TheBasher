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

export const VERDICTS = new Set(['ALLOWED', 'ALLOWED_WITH_CONDITIONS', 'BLOCKED']);

// Every root where a model id could be referenced by code that actually runs.
// `docs/` is absent on purpose: prose must be able to name a blocked model.
export const SCAN_ROOTS = ['src', 'tests', 'scripts'];

// The three files whose job is to name blocked models. Without this the gate reds
// on its own record. Enumerated exactly, never a glob or a directory — an
// over-broad exemption silently re-opens the hole it was cut for (#737).
export const EXEMPT = [
  'scripts/external-models.json',
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

function walkDir(dir, exts, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkDir(p, exts, out);
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
export function listSourceFiles(repoRoot, roots = SCAN_ROOTS, exempt = EXEMPT, exts = EXTS) {
  const exemptSet = new Set(exempt);
  const out = [];
  for (const root of roots) {
    for (const abs of walkDir(path.join(repoRoot, root), exts, [])) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (!exemptSet.has(rel)) out.push(rel);
    }
  }
  return out;
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
      `${files.length} files scanned across ${SCAN_ROOTS.join(', ')} (${EXEMPT.length} exempt), ` +
      `checked ${manifest.checkedAt}.`,
  );
  return 0;
}
