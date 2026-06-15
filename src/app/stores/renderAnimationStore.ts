// renderAnimationStore — UI projection of an in-progress animation render
// (#189): how many frames are done, the format, and a cancel handle. A UI
// projection (V8) — it never touches the DAG; the action drives it.

import { create } from 'zustand';
import type { RenderAnimationFormat } from '../../render/renderAnimation';

export interface RenderAnimationStore {
  /** True while a render is running (the progress modal mounts on this). */
  active: boolean;
  format: RenderAnimationFormat | null;
  done: number;
  total: number;
  /** Cancel the running render (aborts the loop). Null when idle. */
  cancel: (() => void) | null;

  begin(format: RenderAnimationFormat, total: number, cancel: () => void): void;
  setProgress(done: number, total: number): void;
  end(): void;
}

export const useRenderAnimationStore = create<RenderAnimationStore>((set) => ({
  active: false,
  format: null,
  done: 0,
  total: 0,
  cancel: null,
  begin(format, total, cancel) {
    set({ active: true, format, done: 0, total, cancel });
  },
  setProgress(done, total) {
    set({ done, total });
  },
  end() {
    set({ active: false, format: null, done: 0, total: 0, cancel: null });
  },
}));
