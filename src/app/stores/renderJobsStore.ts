// renderJobsStore — UI projection tracking which render workflows are
// currently executing.
//
// The DAG describes the plan; runComfyUIWorkflow (and runRenderJob)
// realize it. Without an in-flight set, two clicks on "Render" during
// execution produce two concurrent submits to ComfyUI for the same
// workflow node — at minimum, wasted work; at worst, racing writes to
// the same D-04 path.
//
// File-rooted V8: this store is a UI projection, mutated by
// src/app/render/runWorkflow.ts surfaces. Never touches the DAG.
//
// REF: project_p5_plan B2; vyapti V8.

import { create } from 'zustand';
import type { NodeId } from '../../core/dag/types';

export interface RenderJobsStore {
  /** Set of workflow / job node ids currently executing. */
  readonly inFlight: ReadonlySet<NodeId>;
  /** True iff `id` is currently executing. */
  isInFlight(id: NodeId): boolean;
  /** Mark a job in-flight. Returns false if it was already in-flight
   *  (caller should treat as a no-op). */
  markInFlight(id: NodeId): boolean;
  /** Mark a job not-in-flight. Idempotent. */
  clearInFlight(id: NodeId): void;
}

export const useRenderJobsStore = create<RenderJobsStore>((set, get) => ({
  inFlight: new Set<NodeId>(),
  isInFlight(id) {
    return get().inFlight.has(id);
  },
  markInFlight(id) {
    if (get().inFlight.has(id)) return false;
    set((s) => {
      const next = new Set(s.inFlight);
      next.add(id);
      return { inFlight: next };
    });
    return true;
  },
  clearInFlight(id) {
    if (!get().inFlight.has(id)) return;
    set((s) => {
      const next = new Set(s.inFlight);
      next.delete(id);
      return { inFlight: next };
    });
  },
}));
