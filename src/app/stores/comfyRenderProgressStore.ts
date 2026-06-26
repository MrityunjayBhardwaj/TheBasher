// comfyRenderProgressStore — the live progress of a "Render coherent clip" batch
// (Inc 4 slice 5b). compileComfyBatch feeds it the ComfyUI /ws stream (sampler step
// k/N, the executing node, partial preview images) so the otherwise-opaque multi-
// second batch shows a progress bar + a streaming preview thumbnail instead of a
// frozen UI. ONE batch render at a time (the action is modal-ish).
//
// The preview is held as an OBJECT URL (a Blob, not a data URL — preview frames
// stream every sampler step, and object URLs avoid the base64 re-encode each time);
// the store owns its lifecycle and revokes the previous URL on every replace + on end,
// so it can't leak across a long render.
//
// V8 file-rooted: src/app/stores/. No DAG mutation. Ephemeral (session-scoped).

import { create } from 'zustand';

export interface ComfyRenderProgressState {
  /** True while a coherent-clip render is in flight (the surface shows iff active). */
  active: boolean;
  /** Human label (the workflow name). */
  label: string;
  /** Sampler step within the executing node (value/max). 0/0 before the first event. */
  value: number;
  max: number;
  /** The currently-executing node id (null between nodes / at the end). */
  node: string | null;
  /** Object URL of the latest partial preview frame, or null. */
  previewUrl: string | null;

  /** Begin a render: clears any prior preview + marks active. */
  begin: (label: string) => void;
  /** A progress/executing update from the /ws stream. */
  setProgress: (value: number, max: number, node: string | null) => void;
  /** A partial preview frame — revokes the previous object URL, holds the new one. */
  setPreview: (bytes: Uint8Array, mime: string) => void;
  /** End the render: revokes the preview URL + marks inactive. */
  end: () => void;
}

export const useComfyRenderProgressStore = create<ComfyRenderProgressState>((set, get) => ({
  active: false,
  label: '',
  value: 0,
  max: 0,
  node: null,
  previewUrl: null,

  begin: (label) => {
    const prev = get().previewUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({ active: true, label, value: 0, max: 0, node: null, previewUrl: null });
  },

  setProgress: (value, max, node) => set({ value, max, node }),

  setPreview: (bytes, mime) => {
    const prev = get().previewUrl;
    // Copy into a fresh ArrayBuffer so the Blob owns stable bytes (the source view
    // may be a slice of a transferable websocket buffer).
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    if (prev) URL.revokeObjectURL(prev);
    set({ previewUrl: url });
  },

  end: () => {
    const prev = get().previewUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({ active: false, previewUrl: null, node: null });
  },
}));
