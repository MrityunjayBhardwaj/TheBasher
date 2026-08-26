import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkManifest,
  blockedNeedles,
  findBlockedReferences,
  checkStaleness,
  entryCheckedAt,
  listSourceFiles,
  SCAN_ROOTS,
  SCAN_ROOT_FILES,
  buildNotice,
  checkNotice,
  NOTICE_PATH,
  EXEMPT,
} from './external-model-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(here, '..', 'src', 'core', 'licensing', 'external-models.json'),
    'utf8',
  ),
);

// This gate exists because the npm dependency walk in license-audit.mjs cannot
// see a model reached over HTTP. Each test below pins a property that would
// otherwise let a restricted model reach production quietly — which is the exact
// failure phase A0 was written to prevent.

describe('the shipped manifest', () => {
  it('is structurally valid', () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it('records at least one BLOCKED model, so the gate has something to enforce', () => {
    // A gate whose blocked set is empty passes for a reason unrelated to correctness.
    expect(manifest.models.filter((m) => m.verdict === 'BLOCKED').length).toBeGreaterThan(0);
  });

  it('licenses Kimodo checkpoints per checkpoint, not per release', () => {
    // Measured 2026-08-26: six Kimodo checkpoints are NVIDIA Open Model and one
    // is NVIDIA R&D. Probing a single checkpoint answers for that checkpoint only.
    const kimodo = manifest.models.filter((m) => m.id.startsWith('kimodo-'));
    const verdicts = new Set(kimodo.map((m) => m.verdict));
    expect(verdicts.size).toBeGreaterThan(1);
  });
});

describe('checkManifest — what it refuses', () => {
  const good = { checkedAt: '2026-08-26', models: [{ ...manifest.models[0] }] };

  it('rejects a verdict with no citation, because that is an opinion', () => {
    const bad = { ...good, models: [{ ...good.models[0], citations: [] }] };
    expect(checkManifest(bad).join(' ')).toMatch(/no citations/);
  });

  it('rejects an unknown verdict rather than ignoring it', () => {
    const bad = { ...good, models: [{ ...good.models[0], verdict: 'PROBABLY_FINE' }] };
    expect(checkManifest(bad).join(' ')).toMatch(/not one of/);
  });

  it('rejects a conditional grant that lists no conditions', () => {
    const bad = {
      ...good,
      models: [{ ...good.models[0], verdict: 'ALLOWED_WITH_CONDITIONS', conditions: [] }],
    };
    expect(checkManifest(bad).join(' ')).toMatch(/lists no conditions/);
  });

  it('rejects a missing or malformed checkedAt, so a stale audit cannot pass silently', () => {
    expect(checkManifest({ ...good, checkedAt: 'recently' }).join(' ')).toMatch(/checkedAt/);
  });

  it('rejects a duplicate id', () => {
    const bad = { ...good, models: [good.models[0], { ...good.models[0] }] };
    expect(checkManifest(bad).join(' ')).toMatch(/duplicate id/);
  });
});

describe('findBlockedReferences — the half with teeth', () => {
  const read = (f) =>
    ({ 'blocked.ts': "import 'Kimodo-SMPLX-RP-v1';", 'fine.ts': 'export const x = 1;' })[f];

  it('finds a blocked model by name, case-insensitively', () => {
    const hits = findBlockedReferences(manifest, ['blocked.ts'], read);
    expect(hits.map((h) => h.id)).toEqual(['kimodo-smplx-rp-v1']);
  });

  it('reports one hit per reference, not one per alias', () => {
    // The id and the name normalise to the same needle here. Reporting both
    // doubles the count and makes the number meaningless.
    expect(findBlockedReferences(manifest, ['blocked.ts'], read)).toHaveLength(1);
  });

  it('does not fire on an unrelated file', () => {
    expect(findBlockedReferences(manifest, ['fine.ts'], read)).toEqual([]);
  });

  it('never puts an ALLOWED model in the needle set', () => {
    const allowed = manifest.models.filter((m) => m.verdict !== 'BLOCKED').map((m) => m.id);
    const needles = blockedNeedles(manifest).map((n) => n.needle);
    for (const id of allowed) expect(needles).not.toContain(id.toLowerCase());
  });
});

describe('scan coverage — the roots and their exemptions (#737)', () => {
  it('covers tests/ and scripts/, not only src/', () => {
    // The original gate read src/ alone, so a blocked model named in an e2e spec
    // or a fixture generator passed silently.
    expect(SCAN_ROOTS).toContain('src');
    expect(SCAN_ROOTS).toContain('tests');
    expect(SCAN_ROOTS).toContain('scripts');
  });

  it('does not scan docs/, because prose must be able to name a blocked model', () => {
    expect(SCAN_ROOTS).not.toContain('docs');
  });

  it('exempts individual files only — never a directory or a root', () => {
    // An exemption that grows to cover a root silently re-opens the hole it was
    // cut for, and the gate keeps printing a pass.
    for (const e of EXEMPT) {
      expect(e.endsWith('/')).toBe(false);
      expect(path.extname(e)).not.toBe('');
      expect(SCAN_ROOTS).not.toContain(e);
    }
  });

  it('covers public/, whose contents are SERVED to the client (#750)', () => {
    // A JSON file under public/ reaches the browser as surely as an import does,
    // and the scan read none of it.
    expect(SCAN_ROOTS).toContain('public');
  });

  it('covers the repo root, where eleven config files that run actually live (#750)', () => {
    // vite.config.ts, vitest/playwright/eslint/tailwind/postcss configs, the
    // tsconfigs, package.json and its lock. A model id reaches production
    // through a `define`, an npm script, or a dependency name.
    expect(SCAN_ROOT_FILES).toContain('.');
  });

  it('covers tools/, which holds repo gates and a vite plugin', () => {
    // Build-path code by any reading. It was reachable only by recursing from the
    // root, which is to say it was covered by accident or not at all.
    expect(SCAN_ROOTS).toContain('tools');
  });

  it('the repo root contributes its own files', () => {
    const repoRoot = path.resolve(here, '..');
    const files = listSourceFiles(repoRoot);
    expect(files).toContain('vite.config.ts');
    expect(files).toContain('package.json');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('the NAMED roots are the whole covered set — recursion would add nothing', () => {
    // The property flatness actually buys: the covered set is CHOSEN. This reds
    // the day a directory with scannable files appears outside every named root,
    // which is exactly when somebody should decide whether it belongs.
    //
    // An earlier version of this check asserted "no duplicate paths", which
    // listSourceFiles dedupes anyway — so it passed with the root made recursive
    // and proved nothing. This one fails under that same change if any unnamed
    // directory has matching files.
    const repoRoot = path.resolve(here, '..');
    const named = listSourceFiles(repoRoot);
    const recursive = listSourceFiles(repoRoot, [...SCAN_ROOTS, '.'], EXEMPT, undefined, []);
    expect(recursive.filter((f) => !named.includes(f))).toEqual([]);
  });

  it('finds a blocked id planted in a root config file and under public/', () => {
    // The acceptance test the fix was written against, run without touching the
    // real tree: both locations produced a CLEAN PASS before this.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(here, '..', 'src', 'core', 'licensing', 'external-models.json'),
        'utf8',
      ),
    );
    const blocked = manifest.models.find((m) => m.verdict === 'BLOCKED');
    const planted = {
      'vite.config.ts': `// ${blocked.name.split(',')[0].trim()}`,
      'public/served.json': JSON.stringify({ model: blocked.id }),
    };
    const hits = findBlockedReferences(manifest, Object.keys(planted), (f) => planted[f]);
    expect(hits.map((h) => h.file).sort()).toEqual(['public/served.json', 'vite.config.ts']);
  });

  it('excludes the three self-naming files but still returns real source', () => {
    const repoRoot = path.resolve(here, '..');
    const files = listSourceFiles(repoRoot);
    for (const e of EXEMPT) expect(files).not.toContain(e);
    expect(files.some((f) => f.startsWith('src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('tests/'))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });
});

describe('checkStaleness — a verdict has a shelf life (#740)', () => {
  const base = {
    checkedAt: '2026-01-01',
    staleness: { warnAfterDays: 180, failAfterDays: 365 },
    models: [{ id: 'a' }, { id: 'b' }],
  };

  it('is silent while the verdicts are fresh', () => {
    const r = checkStaleness(base, new Date('2026-02-01T00:00:00Z'));
    expect(r).toEqual({ warnings: [], failures: [] });
  });

  it('warns past the soft threshold without failing', () => {
    const r = checkStaleness(base, new Date('2026-08-01T00:00:00Z')); // 212d
    expect(r.warnings).toHaveLength(2);
    expect(r.failures).toEqual([]);
  });

  it('fails past the hard threshold, and names the entry', () => {
    const r = checkStaleness(base, new Date('2027-06-01T00:00:00Z')); // 516d
    expect(r.failures).toHaveLength(2);
    expect(r.failures.join(' ')).toMatch(/\ba\b/);
  });

  it('lets a per-model date override the manifest-wide one', () => {
    // Re-checking one model must not claim the others were re-checked.
    const m = { ...base, models: [{ id: 'a', checkedAt: '2027-05-01' }, { id: 'b' }] };
    const r = checkStaleness(m, new Date('2027-06-01T00:00:00Z'));
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/^b:/);
    expect(entryCheckedAt(m.models[0], m)).toBe('2027-05-01');
    expect(entryCheckedAt(m.models[1], m)).toBe('2026-01-01');
  });

  it('fails rather than passes when the thresholds are missing', () => {
    // A staleness check with no thresholds must not silently become a no-op.
    const r = checkStaleness({ ...base, staleness: undefined }, new Date('2026-02-01T00:00:00Z'));
    expect(r.failures).toHaveLength(1);
  });

  it('is timezone-independent', () => {
    // Parsed as UTC midnight, so a runner west of Greenwich does not get a
    // different verdict from one east of it.
    const a = checkStaleness(base, new Date('2026-06-30T23:59:59Z'));
    const b = checkStaleness(base, new Date('2026-06-30T00:00:01Z'));
    expect(a).toEqual(b);
  });

  it('holds the shipped manifest inside its own soft threshold today', () => {
    const r = checkStaleness(manifest, new Date(`${manifest.checkedAt}T12:00:00Z`));
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe('checkManifest — per-entry dates', () => {
  it('rejects a malformed per-entry checkedAt', () => {
    const bad = {
      checkedAt: '2026-08-26',
      models: [{ ...manifest.models[0], checkedAt: 'last spring' }],
    };
    expect(checkManifest(bad).join(' ')).toMatch(/not YYYY-MM-DD/);
  });
});

describe('a recorded condition is honoured, not merely identified (#749)', () => {
  const manifestPath = path.resolve(here, '..', 'src', 'core', 'licensing', 'external-models.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const repoRoot = path.resolve(here, '..');

  it('the shipped NOTICE matches what the manifest entails', () => {
    expect(checkNotice(repoRoot, manifest())).toEqual([]);
  });

  it('a MISSING notice fails the audit — the acceptance test for this gate', () => {
    // Constructed rather than observed: the pass above proves nothing on its own.
    const problems = checkNotice(repoRoot, manifest(), () => {
      throw new Error('ENOENT');
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/missing/i);
  });

  it('a notice that DRIFTED from the manifest fails too', () => {
    // The likelier failure in practice, and the more dangerous one: a stale
    // notice reads as compliance while describing terms that have moved.
    const problems = checkNotice(repoRoot, manifest(), () => 'NOTICE\n\nsomething else entirely');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not match/i);
  });

  it("carries the licence's required sentence VERBATIM, not a paraphrase", () => {
    // The whole point. The NVIDIA grant demands a notice reading a specific
    // sentence; a generated file that said "Licensed under: X" would identify the
    // obligation and not discharge it.
    const m = manifest();
    const text = buildNotice(m);
    for (const model of m.models) {
      if (model.verdict === 'BLOCKED' || !model.conditions?.length) continue;
      expect(model.attribution, `${model.id} records no attribution`).toBeTruthy();
      // As its own LINE, not merely as a substring. The condition's prose QUOTES
      // the required sentence, so a `toContain` here is reached on every run and
      // discriminates on none — it passed with the attribution replaced by a
      // paraphrase, which is exactly the defect it was written to catch.
      expect(text.split('\n')).toContain(model.attribution);
    }
  });

  it('lists every recorded condition, so none can be silently dropped', () => {
    const m = manifest();
    const text = buildNotice(m);
    for (const model of m.models) {
      if (model.verdict === 'BLOCKED') continue;
      for (const c of model.conditions ?? []) expect(text).toContain(c);
    }
  });

  it('names no BLOCKED model — we owe nothing for what we do not use', () => {
    // And a blocked name here would trip the scan two functions up, on a file the
    // repo generates itself.
    const m = manifest();
    const text = buildNotice(m).toLowerCase();
    for (const { needle } of blockedNeedles(m)) expect(text).not.toContain(needle);
  });

  it('the manifest check REQUIRES an attribution on any conditional grant', () => {
    // Without this, a future conditional record ships a NOTICE with a blank line
    // where its obligation should be, and every test above still passes.
    const m = manifest();
    const stripped = {
      ...m,
      models: m.models.map((x) =>
        x.verdict === 'ALLOWED_WITH_CONDITIONS' ? { ...x, attribution: '' } : x,
      ),
    };
    expect(checkManifest(stripped).join(' ')).toMatch(/attribution/);
  });

  it('the generated file lives at the conventional path', () => {
    expect(NOTICE_PATH).toBe('NOTICE');
    expect(fs.existsSync(path.join(repoRoot, NOTICE_PATH))).toBe(true);
  });
});
