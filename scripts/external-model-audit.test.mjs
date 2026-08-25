import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkManifest, blockedNeedles, findBlockedReferences } from './external-model-audit.mjs';

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
