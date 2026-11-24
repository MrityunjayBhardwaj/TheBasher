// The check a film export runs before it renders anything (#1722).
//
// Off → nothing to check. On → `licenceReport` over the whole project; if any part is not cleared
// for commercial use (a non-commercial licence, or one nobody can vouch for), the warning lists
// each one — asset and model — and the export waits. It goes on only if the director confirms.
//
// Every film export road calls THIS before it starts: File ▸ Render Animation and the
// compositor's Export. A road that skipped it would be a commercial export with no warning.
//
// REF: src/app/licence/licenceReport.ts (the one list); issue #1722.

import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { readImportLicences } from './assetLicences';
import { importedAssetRefs, licenceReport, type LicenceReport } from './licenceReport';
import { useExportLicenceStore } from './exportLicenceStore';

/** The report for `state`, with every import's licence read from the records beside it. */
export async function projectLicenceReport(state: DagState): Promise<LicenceReport> {
  const licences = await readImportLicences(importedAssetRefs(state));
  return licenceReport(state, (path) => licences.get(path));
}

/**
 * True when the export may go on: commercial use is off, every part is cleared, or the director
 * read the list and confirmed.
 */
export async function confirmLicencesForExport(): Promise<boolean> {
  if (!useExportLicenceStore.getState().commercialUse) return true;
  const report = await projectLicenceReport(useDagStore.getState().state);
  if (report.notCleared.length === 0) return true;
  return useExportLicenceStore.getState().ask(report.notCleared);
}
