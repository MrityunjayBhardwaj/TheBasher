// exportDagJson — package the active project's DAG state as a downloadable
// JSON file. Extracted from MenuBar in P6 W2 so TopToolbar's Export button
// can share the same path; two consumers, one source of truth.
//
// V1 alignment: this is read-only over the DAG (snapshot via getState). It
// does NOT mutate. Reads useProjectStore for the current project name (or
// falls back to "untitled") and useDagStore for the DAG snapshot.
//
// REF: docs/UI-SPEC.md §5.3 (TopToolbar Export button).

import { useDagStore } from '../core/dag/store';
import { useProjectStore } from '../core/project/store';

export function exportDagJson(): void {
  const current = useProjectStore.getState().current;
  const dag = useDagStore.getState().state;
  const project = current ?? { id: 'untitled', name: 'Untitled' };
  const payload = {
    formatVersion: 1,
    id: project.id,
    name: project.name,
    state: dag,
    exportedAt: Date.now(),
  };
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
