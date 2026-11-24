// The commercial-use switch on a film export, and the warning it raises (#1722).
//
// `commercialUse` is remembered on this machine (its own localStorage key): a director whose work
// is commercial says so once, not on every export. It is OFF by default — a film nobody marked
// commercial raises nothing.
//
// `pending` is the open warning: the parts a commercial export would carry that are not cleared
// for it, and the promise the export is waiting on. Only `answer(true)` lets the export go on.
//
// REF: src/app/licence/exportLicenceGate.ts; src/app/licence/LicenceWarningDialog.tsx.

import { create } from 'zustand';
import type { LicencePart } from './licenceReport';

export const COMMERCIAL_USE_KEY = 'basher.exportCommercialUse.v1';

function readCommercialUse(): boolean {
  try {
    return globalThis.localStorage?.getItem(COMMERCIAL_USE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCommercialUse(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(COMMERCIAL_USE_KEY, on ? 'true' : 'false');
  } catch {
    // No storage — the switch still holds for this session.
  }
}

interface PendingWarning {
  readonly parts: readonly LicencePart[];
  readonly resolve: (proceed: boolean) => void;
}

interface ExportLicenceStore {
  readonly commercialUse: boolean;
  setCommercialUse: (on: boolean) => void;
  readonly pending: PendingWarning | null;
  /** Show the warning for `parts`; resolves true only when the director confirms. */
  ask: (parts: readonly LicencePart[]) => Promise<boolean>;
  /** The director's answer to the open warning. */
  answer: (proceed: boolean) => void;
}

export const useExportLicenceStore = create<ExportLicenceStore>((set, get) => ({
  commercialUse: readCommercialUse(),
  setCommercialUse: (on) => {
    writeCommercialUse(on);
    set({ commercialUse: on });
  },
  pending: null,
  ask: (parts) =>
    new Promise<boolean>((resolve) => {
      // A warning already open is answered "no" before the new one replaces it: an export left
      // waiting forever would hold the render lock with nothing on screen to release it.
      get().pending?.resolve(false);
      set({ pending: { parts, resolve } });
    }),
  answer: (proceed) => {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(proceed);
  },
}));
