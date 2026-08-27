// The runtime half of the external-model licence gate.
//
// `scripts/external-model-audit.mjs` answers at BUILD time by scanning source
// text. It cannot see a model id that does not exist until run time — one
// assembled by concatenation, read from a param, or typed into a field (#739).
// This module answers the same question at the moment the id becomes real, from
// the SAME manifest, so the build-time and run-time answers cannot drift.
//
// Default-deny. An id that is not recorded is REFUSED, not permitted: a typo, a
// newly published checkpoint, or a name invented by an agent must not pass merely
// because nobody has written a verdict for it yet. Permission comes from a record,
// never from the absence of one.
//
// REF: docs/EXTERNAL-MODEL-LICENCES.md, THESIS.md §35 (permissive only),
// ref/architecture/ai-track.md phase A0.

import manifest from './external-models.json' with { type: 'json' };

export type LicenceVerdict = 'ALLOWED' | 'ALLOWED_WITH_CONDITIONS' | 'BLOCKED';

export interface ModelLicenceRecord {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly source: string;
  readonly licence: string;
  readonly verdict: LicenceVerdict;
  readonly reason: string;
  readonly conditions: readonly string[];
  readonly citations: readonly string[];
}

/** Every recorded verdict. Exported so callers derive ids from the record rather
 *  than restating them — a restated id goes stale silently when a verdict moves. */
export const MODEL_RECORDS = manifest.models as readonly ModelLicenceRecord[];
const RECORDS = MODEL_RECORDS;

/**
 * Every string a record answers to: its id, plus each comma-separated name. A
 * record can cover a family — six Kimodo checkpoints share one verdict — so the
 * caller's concrete checkpoint name has to resolve, not just the family id.
 */
function keysFor(record: ModelLicenceRecord): string[] {
  const names = record.name.split(',').map((n) => n.trim());
  return [record.id, ...names].filter(Boolean).map((k) => k.toLowerCase());
}

/** The record covering `modelId`, or undefined when nothing covers it. */
export function modelRecordFor(modelId: string): ModelLicenceRecord | undefined {
  const needle = modelId.trim().toLowerCase();
  if (!needle) return undefined;
  return RECORDS.find((r) => keysFor(r).includes(needle));
}

export class ModelNotLicensedError extends Error {
  readonly modelId: string;
  readonly verdict: LicenceVerdict | 'UNRECORDED';

  constructor(modelId: string, verdict: LicenceVerdict | 'UNRECORDED', detail: string) {
    super(detail);
    this.name = 'ModelNotLicensedError';
    this.modelId = modelId;
    this.verdict = verdict;
  }
}

/**
 * Throws unless `modelId` is recorded as usable. Returns the record so a caller
 * can surface the conditions of a conditional grant at the point of use — an
 * attribution notice is only honoured if someone can see it is owed.
 */
export function assertModelAllowed(modelId: string): ModelLicenceRecord {
  const record = modelRecordFor(modelId);
  if (!record) {
    throw new ModelNotLicensedError(
      modelId,
      'UNRECORDED',
      `Model "${modelId}" has no recorded licence verdict, so it cannot be used. ` +
        `Record it in src/core/licensing/external-models.json with the licence text cited, ` +
        `then re-run npm run license-audit. Recorded ids: ${RECORDS.map((r) => r.id).join(', ')}.`,
    );
  }
  if (record.verdict === 'BLOCKED') {
    throw new ModelNotLicensedError(
      modelId,
      'BLOCKED',
      `Model "${modelId}" is BLOCKED: ${record.reason} ` +
        `Licence: ${record.licence}. See docs/EXTERNAL-MODEL-LICENCES.md.`,
    );
  }
  return record;
}

/** Conditions owed by a conditional grant. Empty for an unconditional one. */
export function conditionsFor(modelId: string): readonly string[] {
  return modelRecordFor(modelId)?.conditions ?? [];
}
