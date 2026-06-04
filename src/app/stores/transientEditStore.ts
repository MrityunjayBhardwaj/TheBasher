// Transient edit store — ephemeral, non-persisted, non-Op UI projection for a
// Blender-style "edited-but-not-keyed" value (the orange dirty state). Issue
// #149 / D-149-1.
//
// Discipline (mirrors autoKeyStore.ts:6-9 / timeStore.ts:8-11 EXACTLY): this is
// a UI-mode projection, NOT the DAG and NOT the Op log (V1-EXEMPT, the same
// shelf as timeStore/autoKeyStore/gizmoStore). A transient edit NEVER dispatches
// an Op, NEVER calls setParam, and is NEVER persisted. It models "a one-frame
// un-persisted keyframe, precedence transient > channel" — the value the user is
// holding before they explicitly key it (K/I or the NPanel diamond).
//
// MULTI-SLOT (D-149-1): keyed by `${nodeId}|${paramPath}`, multiple un-keyed
// edits coexist (each field shows orange independently). This is REQUIRED for
// the locked "4-color across ALL fields" to be meaningful — a single slot would
// let only ONE field be orange at a time.
//
// Lifecycle (krama): grab (paused, Auto-Key OFF) → set; frame-INT change →
// clearAll (Task A2, the depsgraph re-eval model, D-149-2); explicit key →
// clear that slot (Wave E). The frame subscription lives in A2, deliberately
// separate from this pure store for testability.
//
// CRITICAL (B12 — "snapshot-not-subscribed" silent failure): every mutator
// produces a NEW Map (never mutate-in-place) so subscribed selectors re-fire.
// A mutate-in-place Map keeps the same reference → zustand sees no change →
// the render overlay (Wave B) and the orange indicator (Wave F) never update.
//
// REF: issue #149, CONTEXT D-149-1; autoKeyStore.ts (mirror), timeStore.ts:8-11
//      (UI-mode-not-DAG discipline); vyapti V1 (the EXEMPTION), V20.

import { create } from 'zustand';
import { useTimeStore } from './timeStore';

/** A single held edit: the value the user is editing before an explicit key. */
export interface TransientEdit {
  nodeId: string;
  paramPath: string;
  value: unknown;
}

export interface TransientEditStore {
  /** Held edits, keyed by `${nodeId}|${paramPath}`. New Map on every write. */
  edits: Map<string, TransientEdit>;
  /** Hold an edit for (nodeId, paramPath). Overwrites an existing slot. */
  set(nodeId: string, paramPath: string, value: unknown): void;
  /** Read a held edit, or undefined if none. */
  get(nodeId: string, paramPath: string): TransientEdit | undefined;
  /** Whether a slot is held (the orange membership check). */
  has(nodeId: string, paramPath: string): boolean;
  /** Release ONE slot (Wave E commit-clear). */
  clear(nodeId: string, paramPath: string): void;
  /** Release ALL slots (Wave D frame-change discard, D-149-2). */
  clearAll(): void;
}

/** The composite slot key. Single source so render + read + UI agree. */
export const keyOf = (nodeId: string, paramPath: string): string => `${nodeId}|${paramPath}`;

export const useTransientEditStore = create<TransientEditStore>((set, get) => ({
  edits: new Map<string, TransientEdit>(),

  set(nodeId, paramPath, value) {
    set((s) => {
      const m = new Map(s.edits); // NEW Map — subscribers must see a new ref (B12)
      m.set(keyOf(nodeId, paramPath), { nodeId, paramPath, value });
      return { edits: m };
    });
  },

  get(nodeId, paramPath) {
    return get().edits.get(keyOf(nodeId, paramPath));
  },

  has(nodeId, paramPath) {
    return get().edits.has(keyOf(nodeId, paramPath));
  },

  clear(nodeId, paramPath) {
    set((s) => {
      if (!s.edits.has(keyOf(nodeId, paramPath))) return s; // no-op → no churn
      const m = new Map(s.edits);
      m.delete(keyOf(nodeId, paramPath));
      return { edits: m };
    });
  },

  clearAll() {
    set((s) => {
      if (s.edits.size === 0) return s; // already empty → no new ref, no churn
      return { edits: new Map<string, TransientEdit>() };
    });
  },
}));

// A2 — frame-change discard (D-149-2, the Blender depsgraph re-eval model).
//
// A transient edit is "a one-frame un-persisted value" — it survives only on the
// frame it was made. Crossing to a new frame re-evaluates the scene and discards
// every transient. CRITICAL: clear on the derived INT `frame`, NOT `seconds` — a
// sub-frame seconds jitter (e.g. a playhead nudge that does not cross a frame
// boundary) must NOT wipe an in-progress edit (R-4 / V20 / W9 frame-INT
// discipline). timeStore is a plain zustand store (no subscribeWithSelector
// middleware), so we use the plain (state, prev) subscribe and compare the INT
// ourselves — equivalent to a selector subscribe on `s.frame`.
//
// D-149-2 scope: ONLY a frame change clears. Selection-change, undo, and the
// Auto-Key toggle do NOT clear (they never touch timeStore.frame). The
// subscription is module-init + idempotent (HMR-safe).
let unsubscribeFrameClear: (() => void) | null = null;

export function initTransientFrameClear(): void {
  if (unsubscribeFrameClear) return; // init-once (idempotent under HMR)
  unsubscribeFrameClear = useTimeStore.subscribe((state, prev) => {
    if (state.frame !== prev.frame) {
      useTransientEditStore.getState().clearAll();
    }
  });
}

initTransientFrameClear();
