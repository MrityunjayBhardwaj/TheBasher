#!/usr/bin/env node
// License audit (V5).
// Walks the production dependency tree (`npm ls --omit=dev --all --json`),
// reads each package.json's `license`/`licenses` field, and fails the build
// if any dependency is not on the permissive allowlist.
//
// REF: THESIS.md §35, vyapti V5, memory/feedback_license.md.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ALLOW = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'WTFPL',
  'Zlib',
  '(MIT OR CC0-1.0)',
  '(MIT OR Apache-2.0)',
  '(Apache-2.0 OR MIT)',
  '(MIT AND BSD-3-Clause)',
  '(MIT AND Zlib)',
]);

const FORBIDDEN_TOKENS = ['GPL', 'AGPL', 'LGPL', 'CC-BY-NC', 'SSPL', 'BUSL', 'CDDL'];

function findPackageJsonAndDir(name, version) {
  // Try the hoisted location first; fall back to a recursive nested search.
  const root = path.resolve('node_modules', name, 'package.json');
  if (fs.existsSync(root)) {
    const pj = JSON.parse(fs.readFileSync(root, 'utf8'));
    if (!version || pj.version === version) {
      return { pj, dir: path.resolve('node_modules', name) };
    }
  }
  const candidates = [];
  function search(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const sub = path.join(dir, entry.name);
      const pjPath = path.join(sub, 'package.json');
      if (entry.name.startsWith('@')) {
        search(sub);
        continue;
      }
      if (fs.existsSync(pjPath)) {
        try {
          const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
          if (pj.name === name && (!version || pj.version === version)) {
            candidates.push({ pj, dir: sub });
          }
        } catch {
          // ignore
        }
      }
      const nested = path.join(sub, 'node_modules');
      if (fs.existsSync(nested)) search(nested);
    }
  }
  search(path.resolve('node_modules'));
  return candidates[0] ?? { pj: null, dir: null };
}

function detectLicenseFromText(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8').slice(0, 4000);
    if (/MIT License/i.test(txt)) return 'MIT';
    if (/Apache License,?\s*Version 2\.0/i.test(txt)) return 'Apache-2.0';
    if (/BSD 3-Clause/i.test(txt)) return 'BSD-3-Clause';
    if (/BSD 2-Clause/i.test(txt)) return 'BSD-2-Clause';
    if (/ISC License/i.test(txt) || /Permission to use, copy, modify/i.test(txt)) return 'ISC';
    if (/CC0 1\.0 Universal/i.test(txt)) return 'CC0-1.0';
    if (/Mozilla Public License/i.test(txt)) return 'MPL-2.0';
  }
  return null;
}

function readLicenseFromPj(pj, dir) {
  if (pj) {
    if (typeof pj.license === 'string') return pj.license;
    if (Array.isArray(pj.licenses)) {
      return pj.licenses.map((l) => l.type ?? l).join(' OR ');
    }
    if (pj.license?.type) return pj.license.type;
  }
  return detectLicenseFromText(dir) ?? 'UNKNOWN';
}

function walk(node, results = new Map()) {
  if (!node || typeof node !== 'object') return results;
  for (const [name, info] of Object.entries(node.dependencies ?? {})) {
    if (!info || typeof info !== 'object') continue;
    // npm ls may emit empty `{}` for unmet peer deps; skip — they aren't shipped.
    if (!info.version && Object.keys(info).length === 0) continue;
    const { pj, dir } = findPackageJsonAndDir(name, info.version);
    const version = info.version ?? pj?.version ?? 'unresolved';
    const key = `${name}@${version}`;
    if (results.has(key)) continue;
    results.set(key, readLicenseFromPj(pj, dir));
    walk(info, results);
  }
  return results;
}

function main() {
  const out = execSync('npm ls --omit=dev --all --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const tree = JSON.parse(out);
  const map = walk(tree);

  const violations = [];
  const unknowns = [];
  for (const [pkg, license] of map) {
    const lic = (license ?? 'UNKNOWN').toString();
    if (FORBIDDEN_TOKENS.some((tok) => lic.toUpperCase().includes(tok))) {
      violations.push(`${pkg}: ${lic}`);
      continue;
    }
    if (!ALLOW.has(lic)) {
      unknowns.push(`${pkg}: ${lic}`);
    }
  }

  if (violations.length) {
    console.error(`✗ License violations (${violations.length}):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(2);
  }

  if (unknowns.length) {
    console.warn(`⚠ Unknown licenses (${unknowns.length}) — review and extend allowlist:`);
    for (const u of unknowns) console.warn(`  ${u}`);
    process.exit(1);
  }

  console.log(`✓ License audit passed: ${map.size} production deps, all permissive.`);
}

main();
