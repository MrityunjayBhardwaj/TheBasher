// Project store: tracks the active project's metadata. The DAG itself lives
// in `useDagStore`. Splitting them keeps the project header (id, name,
// timestamps) from flickering on every node edit.
//
// P6 W3 — `dirty` and `lastSavedAt` are UI-projection fields ONLY (NOT
// persisted to the project file). They power ProjectTabs's unsaved indicator
// (D-UX-12 dot + "saved Nm ago" tooltip). The persisted Project schema is
// unchanged; on-disk OPFS payloads remain identical. `lastSavedAt` mirrors
// the project's most recent saveCurrent() wall-clock; `dirty` flips true when
// the DAG store mutates, false when saveCurrent() completes.
//
// V1 cleanliness: this store is a UI projection. `markDirty` is invoked from
// a dispatcher subscription (boot.ts) — it READS dispatch transitions and
// records meta state. It never writes to the DAG.
//
// REF: THESIS.md §38 (P0 acceptance #4: save/reload round-trip); UI-SPEC §5.1
// D-UX-12 (unsaved indicator).

import { create } from 'zustand';
import type { Project } from './schema';

export interface ProjectStore {
  current: Project | null;
  /** True iff the DAG has been mutated since the last save. UI-only. */
  dirty: boolean;
  /** Wall-clock ms of the most recent save in this session; null = never
   *  saved this session. Used by ProjectTabs tooltip (computed at hover
   *  time — no setInterval). UI-only. */
  lastSavedAt: number | null;
  /** Set the active project. Resets dirty=false and lastSavedAt=updatedAt
   *  because hydrating a project is "fresh from disk" — no unsaved edits
   *  exist in the new project until something dispatches. */
  setCurrent: (project: Project | null) => void;
  patchMeta: (patch: Partial<Pick<Project, 'name' | 'updatedAt'>>) => void;
  /** Called by the boot dispatcher subscription on every dag state
   *  transition (post-hydrate). Flips dirty=true; idempotent. */
  markDirty: () => void;
  /** Called by saveCurrent() after a successful write. Flips dirty=false
   *  and updates lastSavedAt to now. */
  markSaved: () => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  current: null,
  dirty: false,
  lastSavedAt: null,
  setCurrent: (project) =>
    set({
      current: project,
      dirty: false,
      lastSavedAt: project ? project.updatedAt : null,
    }),
  patchMeta: (patch) =>
    set((s) => (s.current ? { current: { ...s.current, ...patch, updatedAt: Date.now() } } : s)),
  markDirty: () => set({ dirty: true }),
  markSaved: () => set({ dirty: false, lastSavedAt: Date.now() }),
}));
