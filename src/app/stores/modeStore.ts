// Mode store: Simple / Director / Pro. Persisted to localStorage so mode is
// stable across reloads (THESIS.md §17). New users land in Simple, but for
// P0 the default is Director — the full chrome demonstrates more of the
// layout (NEXT_SESSION.md locked decision).

import { create } from 'zustand';

export type Mode = 'simple' | 'director' | 'pro';

const STORAGE_KEY = 'basher.mode';

function readPersisted(): Mode {
  if (typeof localStorage === 'undefined') return 'director';
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'simple' || raw === 'director' || raw === 'pro') return raw;
  return 'director';
}

export interface ModeStore {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

export const useModeStore = create<ModeStore>((set) => ({
  mode: readPersisted(),
  setMode(mode) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, mode);
    }
    set({ mode });
  },
}));
