// The Model generate run a director is watching (#1720): which `ModelGenerate` node the Generate
// form is showing, and the run in flight, if any.
//
// Session state only — nothing here is saved. The request and its variants live on the node
// (`src/nodes/ModelGenerate.ts`), so a reload loses only "which one was I looking at" and "is one
// running", both of which are true only while this page is open.
//
// The viewport reads `run` to draw the placeholder box where the model will land
// (`src/viewport/GenerationPlaceholder.tsx`); the Generate form reads it for progress.
//
// V8: app-layer; no DAG mutation here.

import { create } from 'zustand';
import type { Vec3 } from '../../nodes/types';

/**
 * Where a generated model lands, and so where its placeholder stands: the origin, because the
 * import road puts a file's objects where the file puts them and a generator centres its mesh
 * there. Half a unit up so a unit box sits on the ground rather than through it.
 */
export const GENERATION_LANDING_CENTRE: Vec3 = [0, 0.5, 0];

export interface ModelGenerationRun {
  /** The `ModelGenerate` node the run adds variants to. */
  readonly nodeId: string;
  /** Variants this run asked for, and how many have arrived. */
  readonly total: number;
  readonly done: number;
  /** What the provider says it is doing, and how far (0–100) within the current variant. */
  readonly label: string;
  readonly percent: number;
}

export interface ModelGenerationState {
  /** The node whose variants the Generate form shows; null before the first run. */
  readonly activeNodeId: string | null;
  readonly run: ModelGenerationRun | null;
  setActive(nodeId: string | null): void;
  startRun(nodeId: string, total: number): void;
  progress(patch: Partial<Pick<ModelGenerationRun, 'done' | 'label' | 'percent'>>): void;
  finishRun(): void;
}

export const useModelGenerationStore = create<ModelGenerationState>((set) => ({
  activeNodeId: null,
  run: null,
  setActive: (nodeId) => set({ activeNodeId: nodeId }),
  startRun: (nodeId, total) =>
    set({
      activeNodeId: nodeId,
      run: { nodeId, total, done: 0, label: 'Starting…', percent: 0 },
    }),
  progress: (patch) => set((s) => (s.run ? { run: { ...s.run, ...patch } } : {})),
  finishRun: () => set({ run: null }),
}));
