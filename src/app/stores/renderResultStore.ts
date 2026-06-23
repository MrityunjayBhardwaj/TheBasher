// renderResultStore — the in-app "Render Result" image shown in the 2D View's
// Render Result pane (Blender's Image Editor → Render Result data-block).
//
// Before this, a still render (#168) was only ever DOWNLOADED — there was no
// in-app viewer. This store holds the most-recent result as a data URL so the
// Render Result pane can draw it, and so it SURVIVES a tab/space switch (the
// pane uses display:none; the image must live outside the DOM node).
//
// One held result at a time (Blender keeps render slots; v1 keeps the latest).
// `source` records where it came from so the pane can badge "AI" vs the raw
// render — the fal AI edit (follow-up) writes here with source: 'ai', reusing
// the same data-URL shape sync_mode returns.
//
// Ephemeral (NOT persisted): a 1080p result is megabytes — too large for
// localStorage, and a render result is session-scoped (re-render on reload),
// exactly like Blender's unsaved Render Result.
//
// V8 file-rooted: src/app/stores/. No DAG mutation.

import { create } from 'zustand';

export type RenderResultStatus = 'idle' | 'rendering' | 'ready' | 'error';
export type RenderResultSource = 'render' | 'ai';

export interface RenderResultState {
  status: RenderResultStatus;
  /** PNG (or AI output) as a data URL; null until the first result lands. */
  dataUrl: string | null;
  width: number;
  height: number;
  source: RenderResultSource | null;
  /** Human-readable failure reason when status === 'error'. */
  error: string | null;
}

export interface RenderResultStore extends RenderResultState {
  setRendering(): void;
  setResult(result: {
    dataUrl: string;
    width: number;
    height: number;
    source: RenderResultSource;
  }): void;
  setError(message: string): void;
}

const INITIAL: RenderResultState = {
  status: 'idle',
  dataUrl: null,
  width: 0,
  height: 0,
  source: null,
  error: null,
};

export const useRenderResultStore = create<RenderResultStore>((set) => ({
  ...INITIAL,

  setRendering() {
    set({ status: 'rendering', error: null });
  },
  setResult({ dataUrl, width, height, source }) {
    set({ status: 'ready', dataUrl, width, height, source, error: null });
  },
  setError(message) {
    set({ status: 'error', error: message });
  },
}));
