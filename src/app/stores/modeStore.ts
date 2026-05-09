// Mode store: operational mode (Edit / Run / Animate / Director).
//
// Per D-UX-5 (UI-SPEC.md §3.3), the Mode type was repurposed from density
// values (simple / director / pro) to operational-mode values
// (edit / run / animate / director). Density was dropped in favor of
// per-panel collapse via chromeStore (Spline pattern).
//
// Persistence rules (UI-SPEC §7.3):
//   - 'edit' and 'animate' persist to localStorage
//   - 'run' and 'director' do NOT persist; they reset to last persisted on reload
//   - Legacy density values ('simple', 'pro', and the legacy density-'director')
//     coerce to 'edit' on first read so prior installs don't wedge into a stale
//     mode. The legacy 'director' coercion is conservative: that value previously
//     meant "rich chrome density", not the new chrome-hidden Director Cut, so
//     coercing avoids accidentally landing users in full-screen review on first
//     reload after the upgrade.
//
// REF: docs/UI-SPEC.md §3.3 (operational mode), §3.4 (state machine),
// §7.3 (persistence).

import { create } from 'zustand';

export type Mode = 'edit' | 'run' | 'animate' | 'director';

const STORAGE_KEY = 'basher.mode';

const PERSISTABLE: ReadonlySet<Mode> = new Set<Mode>(['edit', 'animate']);

function readPersisted(): Mode {
  if (typeof localStorage === 'undefined') return 'edit';
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'edit' || raw === 'animate') return raw;
  return 'edit';
}

export interface ModeStore {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

export const useModeStore = create<ModeStore>((set) => ({
  mode: readPersisted(),
  setMode(mode) {
    if (typeof localStorage !== 'undefined') {
      if (PERSISTABLE.has(mode)) {
        localStorage.setItem(STORAGE_KEY, mode);
      }
    }
    set({ mode });
  },
}));
