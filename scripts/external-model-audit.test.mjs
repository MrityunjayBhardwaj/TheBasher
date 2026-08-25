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
  EXEMPT,
} from './external-model-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'external-models.json'), 'utf8'));

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
