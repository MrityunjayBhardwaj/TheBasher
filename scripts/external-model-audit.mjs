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

const REQUIRED = ['id', 'name', 'role', 'source', 'licence', 'verdict', 'reason', 'citations'];

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

export function listSourceFiles(root, exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json']) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p, exts));
    else if (exts.includes(path.extname(entry.name))) out.push(p);
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
export function auditExternalModels({ manifestPath, srcRoot }) {
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

  const files = listSourceFiles(srcRoot);
  const hits = findBlockedReferences(manifest, files);
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
      `${files.length} source files scanned, checked ${manifest.checkedAt}.`,
  );
  return 0;
}
