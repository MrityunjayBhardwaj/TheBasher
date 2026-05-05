// Project store: tracks the active project's metadata. The DAG itself lives
// in `useDagStore`. Splitting them keeps the project header (id, name,
// timestamps) from flickering on every node edit.
//
// REF: THESIS.md §38 (P0 acceptance #4: save/reload round-trip).

import { create } from 'zustand';
import type { Project } from './schema';

export interface ProjectStore {
  current: Project | null;
  setCurrent: (project: Project | null) => void;
  patchMeta: (patch: Partial<Pick<Project, 'name' | 'updatedAt'>>) => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  current: null,
  setCurrent: (project) => set({ current: project }),
  patchMeta: (patch) =>
    set((s) =>
      s.current ? { current: { ...s.current, ...patch, updatedAt: Date.now() } } : s,
    ),
}));
