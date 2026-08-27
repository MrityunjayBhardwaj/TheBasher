// Blocked-checkpoint ids for tests, DERIVED from the manifest rather than spelled.
//
// A test that proves we refuse a blocked checkpoint has to name one, and naming
// one in source is exactly what `scripts/external-model-audit.mjs` reds on. The
// gate is right to: it reads source text and cannot tell "uses it" from "tests
// that we refuse it". Deriving the id at run time satisfies both — the test names
// a real blocked checkpoint, and no blocked string appears in any file.
//
// The alternative is an exemption per test file, and the exemption list is
// enumerated exactly on purpose (#737): every entry is a hole, and holes cut for
// tests are the ones nobody re-examines. This module means no new hole is needed.
//
// It also keeps the tests correct across a verdict change. A spelled id goes
// stale the day a checkpoint is re-recorded; a derived one follows the manifest.
//
// REF: scripts/external-model-audit.mjs (EXEMPT, and why it is a literal list);
// src/core/licensing/external-models.json.

import { MODEL_RECORDS, type ModelLicenceRecord } from './allowedModels';

/** Every record currently recorded BLOCKED. */
export function blockedRecords(): readonly ModelLicenceRecord[] {
  return MODEL_RECORDS.filter((r) => r.verdict === 'BLOCKED');
}

/**
 * One blocked record, or a throw. Throwing is deliberate: a suite that asserts a
 * refusal has nothing to prove if nothing is blocked, and silently skipping would
 * leave it green while testing nothing.
 */
export function aBlockedRecord(): ModelLicenceRecord {
  const [first] = blockedRecords();
  if (!first) {
    throw new Error(
      'No BLOCKED model is recorded, so a refusal test has nothing to prove. ' +
        'If every verdict is now permissive, delete the test rather than let it pass vacuously.',
    );
  }
  return first;
}

/** A blocked record whose source is a Hugging Face model page, so it has an
 *  org-qualified form to exercise. Throws for the same reason as above. */
export function aBlockedHuggingFaceRecord(): ModelLicenceRecord {
  const found = blockedRecords().find((r) => r.source.includes('huggingface.co/'));
  if (!found) {
    throw new Error(
      'No BLOCKED huggingface-sourced model is recorded, so the org-qualified ' +
        'refusal has nothing to prove.',
    );
  }
  return found;
}

/** The org-qualified id of a record whose source is a Hugging Face model page —
 *  `<org>/<first name>`. Undefined when the source is not a model page. */
export function qualifiedIdOf(record: ModelLicenceRecord): string | undefined {
  const org = /huggingface\.co\/([^/]+)\//.exec(record.source)?.[1];
  const [firstName] = record.name.split(',').map((n) => n.trim());
  return org && firstName ? `${org}/${firstName}` : undefined;
}

/** The owner/repo path of a record whose source is a GitHub repository. Used to
 *  prove a code-repository path mints no checkpoint key. */
export function repoPathOf(record: ModelLicenceRecord): string | undefined {
  return /github\.com\/([^/]+\/[^/?#]+)/.exec(record.source)?.[1];
}
