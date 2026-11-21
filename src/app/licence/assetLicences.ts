// The licence of an asset in your imports (#1722) — the async half `licenceReport` must not do.
//
// An import's licence comes from records stored BESIDE it in its folder, never from the project:
// the asset store is shared by every project, a rename moves the folder whole, and no saved
// format changes. In order:
//
//   1. `licence.json` — what the director said, from the Library's details. Wins, because it is
//      the one answer that comes from someone who knows: a director who imported a CC0 model, or
//      who has checked their Tripo plan, has the fact the app cannot observe.
//   2. `generation.json` — a kept generation's record (#1720): its provider's terms.
//   3. Neither — an outside import: unknown.
//
// REF: src/app/asset/generateModel.ts (`generation.json`, `assetFolderOf`);
//      src/app/licence/licenceReport.ts; issue #1722.

import {
  licenceOfProvider,
  UNKNOWN_IMPORT_LICENCE,
  type Licence,
} from '../../core/licensing/licence';
import { getStorage } from '../boot';
import { USER_IMPORTS_ROOT } from '../asset/importCommon';
import { assetFolderOf, readGenerationRecord } from '../asset/generateModel';

/** The record a director's licence choice is kept in, beside the asset. */
export const LICENCE_RECORD_FILE = 'licence.json';

/** What a director can say about an asset they imported. */
export type UserLicenceChoice = 'unknown' | 'own' | 'cc0' | 'cc-by' | 'non-commercial';

export interface UserLicenceRecord {
  readonly choice: UserLicenceChoice;
  /** The credit a CC BY asset needs, as the director typed it. */
  readonly credit?: string;
}

export const USER_LICENCE_CHOICES: readonly { id: UserLicenceChoice; label: string }[] = [
  { id: 'unknown', label: 'Unknown' },
  { id: 'own', label: 'My own work' },
  { id: 'cc0', label: 'CC0 (public domain)' },
  { id: 'cc-by', label: 'CC BY (credit required)' },
  { id: 'non-commercial', label: 'Non-commercial only' },
];

/** The licence a director's choice means. */
export function licenceOfUserRecord(record: UserLicenceRecord): Licence {
  const said = 'You set this licence in the Library.';
  switch (record.choice) {
    case 'own':
      return {
        kind: 'permissive',
        name: 'Your own work',
        commercial: 'yes',
        credit: null,
        why: said,
      };
    case 'cc0':
      return { kind: 'permissive', name: 'CC0', commercial: 'yes', credit: null, why: said };
    case 'cc-by': {
      const credit = record.credit?.trim() || null;
      return {
        kind: 'credit-required',
        name: 'CC BY',
        commercial: 'yes',
        credit,
        why: credit ? said : `${said} Add the credit the creator asks for.`,
      };
    }
    case 'non-commercial':
      return {
        kind: 'non-commercial',
        name: 'Non-commercial',
        commercial: 'no',
        credit: null,
        why: said,
      };
    case 'unknown':
      return UNKNOWN_IMPORT_LICENCE;
  }
}

function isUserLicenceRecord(v: unknown): v is UserLicenceRecord {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    USER_LICENCE_CHOICES.some((c) => c.id === r.choice) &&
    (r.credit === undefined || typeof r.credit === 'string')
  );
}

/** The director's recorded choice beside `assetPath`, or null when there is none. */
export async function readUserLicence(assetPath: string): Promise<UserLicenceRecord | null> {
  if (!assetPath.startsWith(`${USER_IMPORTS_ROOT}/`)) return null;
  try {
    const storage = await getStorage();
    const recordPath = `${assetFolderOf(assetPath)}/${LICENCE_RECORD_FILE}`;
    if (!(await storage.exists(recordPath))) return null;
    const parsed = JSON.parse(new TextDecoder().decode(await storage.read(recordPath))) as unknown;
    return isUserLicenceRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Record the director's choice beside `assetPath`. Throws on a path outside your imports. */
export async function writeUserLicence(
  assetPath: string,
  record: UserLicenceRecord,
): Promise<void> {
  if (!assetPath.startsWith(`${USER_IMPORTS_ROOT}/`)) {
    throw new Error(`Only your imports carry a licence you set; "${assetPath}" is not one.`);
  }
  const storage = await getStorage();
  await storage.write(
    `${assetFolderOf(assetPath)}/${LICENCE_RECORD_FILE}`,
    new TextEncoder().encode(JSON.stringify(record, null, 2)),
  );
}

/**
 * The licence of an asset outside the bundled samples: the director's choice, else a kept
 * generation's provider terms, else unknown.
 */
export async function importLicenceOf(assetPath: string): Promise<Licence> {
  const said = await readUserLicence(assetPath);
  if (said) return licenceOfUserRecord(said);
  const generated = await readGenerationRecord(assetPath);
  if (generated) return licenceOfProvider(generated.provider);
  return UNKNOWN_IMPORT_LICENCE;
}

/** Every path's licence, read in parallel — the lookup `licenceReport` takes. */
export async function readImportLicences(
  paths: readonly string[],
): Promise<ReadonlyMap<string, Licence>> {
  const entries = await Promise.all(paths.map(async (p) => [p, await importLicenceOf(p)] as const));
  return new Map(entries);
}
