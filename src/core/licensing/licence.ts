// The licence vocabulary a director reads (#1722): what an asset, a checkpoint or a generation
// service lets you do with a film, and what credit it needs.
//
// `allowedModels.ts` answers a different question with the same manifest: MAY THIS APP RUN that
// checkpoint at all. This module answers the director's question about what is already in a
// project: CAN I SELL A FILM THAT CONTAINS IT, and WHO DO I CREDIT. Both read
// `external-models.json`, so a verdict recorded once answers both and the two cannot drift.
//
// 🔴 UNKNOWN NEVER READS AS ALLOWED. `commercial` has three answers, and only `'yes'` lets an
// export through quietly. A licence nobody recorded, a hosted service whose terms depend on an
// account plan Basher cannot see (#762), a file somebody imported — each is `'unknown'`, and
// `'unknown'` is listed beside `'no'` when a film is exported for commercial use. A missing
// record is a question, never a pass.
//
// REF: src/core/licensing/external-models.json (the verdicts and their citations);
//      docs/EXTERNAL-MODEL-LICENCES.md; issues #1722, #762.

import { MODEL_RECORDS, modelRecordFor, type ModelLicenceRecord } from './allowedModels';

/** Whether a film containing it may be sold. Only `'yes'` is a yes. */
export type CommercialUse = 'yes' | 'no' | 'unknown';

/** The family a licence belongs to — what its badge says. */
export type LicenceKind =
  | 'permissive' // MIT, Apache-2.0, CC0, your own work: use it, nothing owed in a render
  | 'credit-required' // commercial use is granted, and a credit is owed
  | 'non-commercial' // the terms forbid commercial or production use
  | 'provider-terms' // a hosted service's terms of service
  | 'unknown'; // nobody has recorded what it is

export interface Licence {
  readonly kind: LicenceKind;
  /** The licence's own name, e.g. "MIT" or "NVIDIA Open Model License". */
  readonly name: string;
  readonly commercial: CommercialUse;
  /** The exact credit text owed, verbatim. null when nothing is owed — or when nobody knows,
   *  which `kind: 'unknown'` says. */
  readonly credit: string | null;
  /** One plain sentence: where this fact comes from, or why it is not known. */
  readonly why: string;
}

/** True only for a recorded yes. Every other answer — no, unknown — is listed at export. */
export function commercialAllowed(licence: Licence): boolean {
  return licence.commercial === 'yes';
}

/** The compact label a Library tile shows. */
export const LICENCE_BADGE: Record<LicenceKind, string> = {
  permissive: 'Free to use',
  'credit-required': 'Credit required',
  'non-commercial': 'Non-commercial',
  'provider-terms': 'Provider terms',
  unknown: 'Licence unknown',
};

/** What a file imported from outside carries: nothing anyone recorded. */
export const UNKNOWN_IMPORT_LICENCE: Licence = {
  kind: 'unknown',
  name: 'Unknown',
  commercial: 'unknown',
  credit: null,
  why: 'Imported from outside Basher. Check the terms where it came from.',
};

/** Basher's own MIT licence, for assets this repository made and owns. */
export const BASHER_MIT_LICENCE: Licence = {
  kind: 'permissive',
  name: 'MIT',
  commercial: 'yes',
  credit: null,
  why: "Made by Basher's own scripts and shipped under the repository's MIT licence.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoints — from the manifest
// ─────────────────────────────────────────────────────────────────────────────

/** A recorded verdict, said as the director's licence. */
export function licenceOfRecord(record: ModelLicenceRecord): Licence {
  switch (record.verdict) {
    case 'BLOCKED':
      return {
        kind: 'non-commercial',
        name: record.licence,
        commercial: 'no',
        credit: null,
        why: record.reason,
      };
    case 'ALLOWED_WITH_CONDITIONS':
      return {
        kind: 'credit-required',
        name: record.licence,
        commercial: 'yes',
        credit: record.attribution ?? null,
        why: record.conditions.join(' '),
      };
    case 'ALLOWED':
      return {
        kind: 'permissive',
        name: record.licence,
        commercial: 'yes',
        credit: null,
        why: record.reason,
      };
  }
}

/** The file name with a model-weights extension taken off (`x.safetensors` → `x`). */
function withoutWeightsExtension(name: string): string {
  return name.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i, '');
}

/**
 * The licence of a checkpoint, by the name a node or a workflow uses for it. A name the manifest
 * does not record is `unknown` — never allowed.
 */
export function licenceOfModel(modelId: string): Licence {
  const record = modelRecordFor(modelId) ?? modelRecordFor(withoutWeightsExtension(modelId));
  if (record) return licenceOfRecord(record);
  return {
    kind: 'unknown',
    name: 'No recorded licence',
    commercial: 'unknown',
    credit: null,
    why: `No licence is recorded for "${modelId}". Check its terms before selling a film made with it.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation providers — a registry keyed by the capability id a node records
// ─────────────────────────────────────────────────────────────────────────────

interface ProviderEntry {
  /** What the director reads. */
  readonly label: string;
  /** The manifest record of the hosted service it calls, when it calls one. */
  readonly serviceRecordId?: string;
}

/**
 * Every model-generation provider a `ModelGenerate` node (or a kept asset's `generation.json`)
 * can name, keyed by the capability's `id`. A provider not listed here is unknown.
 */
export const MODEL_PROVIDERS: Readonly<Record<string, ProviderEntry>> = {
  // The offline stub: it makes a placeholder shape on this machine and calls nothing.
  'stub-modelgen': { label: 'Basher placeholder generator' },
  'tripo-model-generation': { label: 'Tripo AI', serviceRecordId: 'tripo-api' },
};

/**
 * The licence of what a provider generated.
 *
 * A HOSTED SERVICE IS `unknown` FOR COMMERCIAL USE, even with a recorded verdict to use it. The
 * verdict says the app may call the service; whether its OUTPUT may be sold is, by Tripo's own
 * description, a property of the account's plan — which nothing here can observe (#762). Saying
 * yes would be the green tick for a thing that cannot be checked.
 */
export function licenceOfProvider(providerId: string): Licence {
  const entry = MODEL_PROVIDERS[providerId];
  if (!entry) {
    return {
      kind: 'unknown',
      name: 'Unknown provider',
      commercial: 'unknown',
      credit: null,
      why: `No terms are recorded for the provider "${providerId}".`,
    };
  }
  if (!entry.serviceRecordId) {
    return {
      kind: 'permissive',
      name: 'Basher placeholder',
      commercial: 'yes',
      credit: null,
      why: `${entry.label} runs on this machine and calls no service, so no third-party terms apply.`,
    };
  }
  const record = MODEL_RECORDS.find((r) => r.id === entry.serviceRecordId);
  return {
    kind: 'provider-terms',
    name: record ? `${entry.label}: ${record.licence}` : `${entry.label} terms of service`,
    commercial: 'unknown',
    credit: null,
    why:
      `${entry.label} describes commercial rights to its output as depending on your plan. ` +
      'Basher cannot see your plan, so check it before selling a film made with it.',
  };
}

/** A provider's display name, or the id itself when it is not registered. */
export function providerLabel(providerId: string): string {
  return MODEL_PROVIDERS[providerId]?.label ?? providerId;
}
