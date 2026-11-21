// generatedStillStore — what the 2D View's Generated tab is showing (#1718).
//
// The variants of the last Generate and which one is picked. Not saved, by design: a variant is
// a run of the still workflow with another seed, and the one that matters is kept in the graph
// (its seed in the workflow file, its picture where the node's still lands, `madeFrom`), so a
// reload loses only variants nobody kept. The choices of shot and still workflow live here too,
// as UI state; neither is a fact of the scene.
//
// V8: src/app/stores/. No DAG mutation here.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';
import type { StillVariant } from '../generated/generatedStill';

export type GeneratedStatus = 'idle' | 'rendering' | 'generating' | 'running' | 'error';

export interface GeneratedStillState {
  /** The shot whose first frame the still is made from (0-based). */
  readonly shotIndex: number;
  /** The still workflow chosen, or null for the first one in the graph. */
  readonly stillId: NodeId | null;
  /** The variants of the last Generate, for `variantsOf`. */
  readonly variantsOf: NodeId | null;
  readonly variants: readonly StillVariant[];
  /** The variant the director picked, by seed. */
  readonly picked: number | null;
  readonly status: GeneratedStatus;
  /** What the last action said, in plain words (a failure, or what it ran). */
  readonly message: string | null;
}

export interface GeneratedStillStore extends GeneratedStillState {
  setShotIndex: (index: number) => void;
  setStillId: (id: NodeId | null) => void;
  setVariants: (of: NodeId, variants: readonly StillVariant[]) => void;
  pick: (seed: number | null) => void;
  setStatus: (status: GeneratedStatus, message?: string | null) => void;
  reset: () => void;
}

const INITIAL: GeneratedStillState = {
  shotIndex: 0,
  stillId: null,
  variantsOf: null,
  variants: [],
  picked: null,
  status: 'idle',
  message: null,
};

export const useGeneratedStillStore = create<GeneratedStillStore>((set) => ({
  ...INITIAL,
  setShotIndex: (shotIndex) => set({ shotIndex: Math.max(0, Math.floor(shotIndex)) }),
  setStillId: (stillId) => set({ stillId }),
  setVariants: (variantsOf, variants) =>
    set({ variantsOf, variants: [...variants], picked: variants[0]?.seed ?? null }),
  pick: (picked) => set({ picked }),
  setStatus: (status, message = null) => set({ status, message }),
  reset: () => set(INITIAL),
}));
