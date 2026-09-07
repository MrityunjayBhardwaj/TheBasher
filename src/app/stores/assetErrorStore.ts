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

/**
 * The banner's leading label for a row, when "asset failed:" would be a lie (#711).
 *
 * ── WHY A SECOND MAP AND NOT A WIDER VALUE ────────────────────────────────────────────
 *
 * The obvious shape is `errors: Record<string, {message, label}>`. It was measured and
 * rejected on cost: `errors` is read as a STRING map by a dozen assertions across five
 * spec files (`errors[path]).toMatch(...)`, `Object.values(...)[0]`), and 46 call sites
 * report into it. Widening the value churns all of that to move a label.
 *
 * Two maps normally invite drift, and that objection is answered by CONTAINMENT rather
 * than waved away: both are written and deleted only inside this module's own actions,
 * always in the same statement, so there is no second place that could update one and
 * miss the other. A caller cannot reach `labels` at all.
 *
 * ── WHY IT EXISTS AT ALL ──────────────────────────────────────────────────────────────
 *
 * Not every row is an asset that failed, and the banner asserted otherwise for all of
 * them. Measured on `main`, at least three row kinds are something else: a modifier whose
 * source is not sync-buildable (#711 — the registry classifies that state as still
 * loading, so "asset failed" contradicts it), a material-slot refusal, and a generation
 * that degraded to a stub. The last of those is the strongest evidence, because a call
 * site already works AROUND the prefix in a comment: "The banner prefixes its own 'asset
 * failed:', so a message that opened with the consequence read as two clauses". A label
 * that makes a writer reword a true sentence is a label doing damage.
 */
export interface AssetErrorStore {
  /** assetRef → human-readable failure reason. */
  errors: Record<string, string>;
  /** assetRef → the banner's leading label, when the default would misstate the row. */
  labels: Record<string, string>;
  report: (assetRef: string, message: string, label?: string) => void;
  clear: (assetRef: string) => void;
  clearAll: () => void;
}

/** What the banner says when a row carries no label of its own. */
export const DEFAULT_ERROR_LABEL = 'asset failed:';

export const useAssetErrorStore = create<AssetErrorStore>((set) => ({
  errors: {},
  labels: {},
  report(assetRef, message, label) {
    set((s) => {
      // Idempotent: skip the set when the same assetRef already carries
      // the same message. An error boundary can re-invoke componentDid-
      // Catch on re-render; without this guard each re-render would
      // produce a new object identity and churn every subscriber.
      // The LABEL is part of that identity — a row whose message is
      // unchanged but whose label is not has still changed on screen.
      if (s.errors[assetRef] === message && s.labels[assetRef] === label) return s;
      const labels = { ...s.labels };
      // Deleted rather than stored as `undefined`: the banner falls back on absence, and
      // an explicit `undefined` key would make a re-report that DROPS a label look like a
      // row that never had one to `in`, while still showing up in `Object.keys`.
      if (label === undefined) delete labels[assetRef];
      else labels[assetRef] = label;
      return { errors: { ...s.errors, [assetRef]: message }, labels };
    });
  },
  clear(assetRef) {
    set((s) => {
      if (!(assetRef in s.errors)) return s;
      const next = { ...s.errors };
      delete next[assetRef];
      const labels = { ...s.labels };
      delete labels[assetRef];
      return { errors: next, labels };
    });
  },
  clearAll() {
    set((s) => (Object.keys(s.errors).length === 0 ? s : { errors: {}, labels: {} }));
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
