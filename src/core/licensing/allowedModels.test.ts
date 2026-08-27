// The licence gate's resolution rules. These are safety assertions, not
// characterisation: every arm below is a form a caller can really supply, and
// the ones that must NOT resolve are the point of the file.
//
// REF: ref/architecture/ai-track.md phase A0; docs/EXTERNAL-MODEL-LICENCES.md.

import { describe, expect, it } from 'vitest';
import {
  MODEL_RECORDS,
  ModelNotLicensedError,
  assertModelAllowed,
  modelRecordFor,
} from './allowedModels';
import {
  aBlockedHuggingFaceRecord,
  qualifiedIdOf,
  repoPathOf,
  blockedRecords,
} from './blockedModelForTests';

// Derived, never spelled: naming a blocked checkpoint in source is what the
// build-time gate reds on, and it cannot tell "uses it" from "refuses it".
const BLOCKED_HF = aBlockedHuggingFaceRecord();
const BLOCKED_QUALIFIED = qualifiedIdOf(BLOCKED_HF)!;

describe('a checkpoint resolves by every form a caller can hold (#748)', () => {
  it('resolves the bare name', () => {
    expect(modelRecordFor('Kimodo-SOMA-RP-v1.1')?.id).toBe('kimodo-open-model-checkpoints');
  });

  it('resolves the org-qualified name, which is how the checkpoint is addressed', () => {
    // The manifest's own `source` points at huggingface.co/nvidia/Kimodo-SOMA-RP-v1.1,
    // so the qualified form is the one a settings field or an agent param carries.
    expect(modelRecordFor('nvidia/Kimodo-SOMA-RP-v1.1')?.id).toBe('kimodo-open-model-checkpoints');
  });

  it('resolves the qualified form of a BLOCKED checkpoint to its BLOCK, not to silence', () => {
    // The sharp half. Unqualified, this reported BLOCKED. Qualified, it reported
    // UNRECORDED — still refused, but the message invited the reader to "record it
    // in external-models.json", which is precisely the record we refused to write.
    expect(modelRecordFor(BLOCKED_QUALIFIED)?.verdict).toBe('BLOCKED');
    expect(() => assertModelAllowed(BLOCKED_QUALIFIED)).toThrow(/BLOCKED/);
  });

  it('is case- and whitespace-insensitive, as an id typed into a field will be', () => {
    expect(modelRecordFor('  NVIDIA/kimodo-soma-rp-v1.1  ')?.id).toBe(
      'kimodo-open-model-checkpoints',
    );
  });
});

describe('resolution stays default-deny — the qualification is not a prefix strip (#748)', () => {
  it('refuses the same checkpoint name under an org the record does not claim', () => {
    // The falsification that separates this fix from a last-path-segment match.
    // A re-upload by another account is different weights under the same name; the
    // verdict was written about NVIDIA's, and must not travel with the string.
    expect(modelRecordFor('someoneelse/Kimodo-SOMA-RP-v1.1')).toBeUndefined();
    expect(() => assertModelAllowed('someoneelse/Kimodo-SOMA-RP-v1.1')).toThrow(
      ModelNotLicensedError,
    );
  });

  it('refuses a qualified form built on a code repository rather than a model page', () => {
    // A GitHub owner/repo is a repo path, not a checkpoint address, so no
    // qualified key is minted for it. Derived from whichever blocked record is
    // github-sourced, so it stays true if the manifest changes.
    const repoSourced = blockedRecords().find((r) => r.source.includes('github.com/'));
    expect(repoSourced, 'no github-sourced blocked record to exercise').toBeTruthy();
    expect(modelRecordFor(repoPathOf(repoSourced!)!)).toBeUndefined();
  });

  it('refuses an unrecorded id outright', () => {
    expect(() => assertModelAllowed('nvidia/Some-Model-Nobody-Recorded')).toThrow(
      /no recorded licence verdict/,
    );
  });
});

describe('the qualified keys are derived from the manifest, not restated', () => {
  it('mints a qualified form for every checkpoint of every huggingface-sourced record', () => {
    // Derivation is the invariant; the count above is one instance of it. A record
    // added later gets its qualified keys for free, and this reds if it does not.
    const hfRecords = MODEL_RECORDS.filter((r) => r.source.includes('huggingface.co/'));
    expect(hfRecords.length).toBeGreaterThan(0);
    for (const record of hfRecords) {
      const org = /huggingface\.co\/([^/]+)\//.exec(record.source)?.[1];
      expect(org).toBeTruthy();
      for (const name of record.name.split(',').map((n) => n.trim())) {
        expect(modelRecordFor(`${org}/${name}`)?.id).toBe(record.id);
      }
    }
  });
});
