// Notification (toast) store — a transient, auto-dismissing feedback surface
// for one-shot user actions and degraded-capability warnings.
//
// Why a NEW store and not assetErrorStore: the asset-error store is
// PERSISTENT (keyed by assetRef, clears when the asset re-renders OK — its
// lifecycle is tied to asset state). A toast is TRANSIENT (auto-dismiss after
// a timeout, severity-varied, fire-and-forget). Different invariant spans →
// different modules; folding them would entangle two lifecycles. This mirrors
// assetErrorStore's GOOD patterns (zustand UI-projection store, idempotent
// sets, no DAG dispatch) without inheriting its persistence.
//
// First two callers (the reason this exists):
//   - #170 renderImageAction — "Render failed / Rendered 1920×1080" feedback
//     (the render action used to `void` its result → silent no-op).
//   - #148 boot — "Storage unavailable — your work won't be saved" when the
//     OPFS → IndexedDB → Memory fallback chain lands on Memory.
//
// Auto-dismiss is owned by the COMPONENT (ToastViewport runs the per-toast
// setTimeout), not the store — the store stays a pure data container with no
// side-effects, exactly like assetErrorStore. `durationMs: 0` = sticky (the
// user must dismiss it; used for the storage warning, which must not vanish).
//
// V8 file-rooted: a UI-projection store in src/app/stores/. No DAG dispatch
// passes through it.
//
// REF: #170, #148; assetErrorStore (the persistent sibling); THESIS §14.

import { create } from 'zustand';

export type ToastSeverity = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  readonly id: number;
  readonly severity: ToastSeverity;
  readonly message: string;
  /** ms before auto-dismiss; 0 = sticky (the user must dismiss). */
  readonly durationMs: number;
}

export interface NotifyInput {
  /** Defaults to 'info'. */
  severity?: ToastSeverity;
  message: string;
  /** Defaults per severity (DEFAULT_DURATION). Pass 0 for a sticky toast. */
  durationMs?: number;
}

/** Per-severity default lifetimes. Errors linger longest; warnings need a
 *  read; info/success are quick confirmations. */
export const DEFAULT_DURATION: Record<ToastSeverity, number> = {
  info: 4000,
  success: 4000,
  warn: 6000,
  error: 8000,
};

/** Cap the visible stack so a runaway caller can't flood the corner. Oldest
 *  toasts fall off the top. */
export const MAX_TOASTS = 4;

export interface NotificationStore {
  toasts: Toast[];
  /** Monotonic id source — deterministic across a session (no Date.now /
   *  Math.random), so tests can assert ids and React keys stay stable. */
  nextId: number;
  /** Push a toast. Idempotent on (severity, message): a duplicate that is
   *  still visible is NOT re-added (returns the existing id) so a double-click
   *  or a repeated boot warning doesn't stack. Returns the toast id. */
  notify: (input: NotifyInput) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  toasts: [],
  nextId: 1,
  notify(input) {
    const severity = input.severity ?? 'info';
    const durationMs = input.durationMs ?? DEFAULT_DURATION[severity];
    const { toasts, nextId } = get();
    // Idempotent: an identical toast already on screen is reused, not stacked.
    const dup = toasts.find((t) => t.severity === severity && t.message === input.message);
    if (dup) return dup.id;
    const id = nextId;
    const toast: Toast = { id, severity, message: input.message, durationMs };
    // Cap the stack, but drop the OLDEST AUTO-DISMISS toast first — never evict
    // a sticky (durationMs 0) toast just because transient ones piled up. The
    // #148 "your work won't be saved" warning is sticky and must not be pushed
    // out by render-spam. If everything is sticky the cap is soft (sticky
    // toasts are rare + intentional), which is the safe direction.
    const trimmed = [...toasts, toast];
    while (trimmed.length > MAX_TOASTS) {
      const oldestDismissible = trimmed.findIndex((t) => t.durationMs > 0);
      if (oldestDismissible === -1) break; // all sticky — keep them all
      trimmed.splice(oldestDismissible, 1);
    }
    set({ toasts: trimmed, nextId: id + 1 });
    return id;
  },
  dismiss(id) {
    set((s) => {
      if (!s.toasts.some((t) => t.id === id)) return s;
      return { toasts: s.toasts.filter((t) => t.id !== id) };
    });
  },
  clear() {
    set((s) => (s.toasts.length === 0 ? s : { toasts: [] }));
  },
}));
