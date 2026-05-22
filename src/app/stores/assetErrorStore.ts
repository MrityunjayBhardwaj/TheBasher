// Asset-error store — surfaces glTF (and any asset) load failures to the
// user (#83 gap 2).
//
// Before this store: a bad/missing/unsupported asset threw inside the
// R3F render tree, the Canvas-root <Suspense fallback={null}> swallowed
// it (suspense catches the promise; an actual error needs an error
// boundary), and the user saw a blank slot with no reason. That's the
// silent-failure mode #82's loud-throw discipline set out to kill —
// this is its viewport-side complement.
//
// Flow: AssetErrorBoundary (src/viewport/) catches the throw per-asset
// and calls `report(assetRef, message)`; AssetErrorBanner (src/app/)
// subscribes and renders "asset failed: <reason>". Keyed by assetRef so
// a re-imported / swapped asset replaces (not stacks) its own entry,
// and a successful re-render clears it.
//
// V8 file-rooted: a UI-projection store in src/app/stores/. No DAG
// dispatch passes through it.
//
// REF: #83 gap 2, #82 (loud-failure sibling), THESIS §14.

import { create } from 'zustand';

export interface AssetError {
  assetRef: string;
  message: string;
}

export interface AssetErrorStore {
  /** assetRef → human-readable failure reason. */
  errors: Record<string, string>;
  report: (assetRef: string, message: string) => void;
  clear: (assetRef: string) => void;
  clearAll: () => void;
}

export const useAssetErrorStore = create<AssetErrorStore>((set) => ({
  errors: {},
  report(assetRef, message) {
    set((s) => {
      // Idempotent: skip the set when the same assetRef already carries
      // the same message. An error boundary can re-invoke componentDid-
      // Catch on re-render; without this guard each re-render would
      // produce a new object identity and churn every subscriber.
      if (s.errors[assetRef] === message) return s;
      return { errors: { ...s.errors, [assetRef]: message } };
    });
  },
  clear(assetRef) {
    set((s) => {
      if (!(assetRef in s.errors)) return s;
      const next = { ...s.errors };
      delete next[assetRef];
      return { errors: next };
    });
  },
  clearAll() {
    set((s) => (Object.keys(s.errors).length === 0 ? s : { errors: {} }));
  },
}));

/**
 * Normalise a thrown value into a short, user-readable reason. React
 * error boundaries receive `unknown` — could be an Error, a string, or
 * a thrown non-Error. Keep it one line; the banner has limited space.
 */
export function formatAssetError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
