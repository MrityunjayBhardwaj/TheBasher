// exportDagJson — package the active project's DAG state as a downloadable
// JSON file. Extracted from MenuBar in P6 W2 so TopToolbar's Export button
// can share the same path; two consumers, one source of truth.
//
// V1 alignment: this is read-only over the DAG (snapshot via getState). It
// does NOT mutate. Reads useProjectStore for the current project name (or
// falls back to "untitled") and useDagStore for the DAG snapshot.
//
// REF: docs/UI-SPEC.md §5.3 (TopToolbar Export button).

import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import { PROJECT_FORMAT_VERSION } from '../core/project/schema';
import { useProjectStore } from '../core/project/store';

export interface DagExportPayload {
  formatVersion: number;
  id: string;
  name: string;
  state: DagState;
  exportedAt: number;
}

/**
 * Pure builder for the export payload — the DOM-free seam so the stamped
 * `formatVersion` is testable without mocking Blob/URL/document.
 *
 * #428 — this used to hardcode `formatVersion: 1` while the live DAG is already
 * in the current shape (v3). Re-importing that file replayed the whole migration
 * ladder from v1 over already-current data; harmless only because every
 * migration so far is idempotent. It stamps `PROJECT_FORMAT_VERSION` now, so the
 * label tracks the format the snapshot is actually in — the same literal io.ts
 * and boot.ts use when serialising the live state.
 */
export function buildDagExportPayload(
  project: { id: string; name: string },
  dag: DagState,
  exportedAt: number,
): DagExportPayload {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: project.id,
    name: project.name,
    state: dag,
    exportedAt,
  };
}

export function exportDagJson(): void {
  const current = useProjectStore.getState().current;
  const dag = useDagStore.getState().state;
  const project = current ?? { id: 'untitled', name: 'Untitled' };
  const payload = buildDagExportPayload(project, dag, Date.now());
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/\s+/g, '-').toLowerCase() || 'project'}.basher.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
