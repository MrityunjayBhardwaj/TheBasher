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

// Defensive against test envs where `localStorage` exists but its methods
// are stubbed weirdly (happy-dom + vitest module-load ordering — same
// hetvabhasa H26 that chromeStore guards against). modeStore initially
// got away with a typeof-undefined check because all P6 W1 tests went
// through happy-dom's setup phase before this module loaded; W2's
// ComfyStatusIndicator test pulls modeStore in earlier and trips the
// uninitialized-Storage path. K11 says every persisted store must use
// the same safe wrappers — applying that uniformly here.
function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore — storage quota / disabled / SSR */
  }
}

function readPersisted(): Mode {
  const raw = safeGetItem(STORAGE_KEY);
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
    if (PERSISTABLE.has(mode)) {
      safeSetItem(STORAGE_KEY, mode);
    }
    set({ mode });
  },
}));
