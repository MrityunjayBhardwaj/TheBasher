// livePreviewStore — the viewport's live preview (#1708): whether it is collapsed to its caption,
// and where its image sits over the canvas.
//
// `collapsed` is the director's choice and survives a reload (one localStorage key, the V18
// safeGet/safeSet wrappers, as twoDViewStore). `rect` is layout, published by the DOM frame
// (`LivePreview`) and read by the in-canvas pass (`LivePreviewPass`) each frame; it is never
// persisted. Neither touches the DAG (V8).

import { create } from 'zustand';

const STORAGE_KEY = 'basher.livePreview.v1';

/** The preview image's box in CSS pixels, relative to the viewport canvas's top-left. */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LivePreviewStore {
  collapsed: boolean;
  rect: PreviewRect | null;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  setRect: (rect: PreviewRect | null) => void;
}

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage?.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof localStorage?.setItem !== 'function') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore — storage quota / disabled / SSR */
  }
}

function readCollapsed(): boolean {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { collapsed?: unknown }).collapsed === true;
  } catch {
    return false;
  }
}

const sameRect = (a: PreviewRect | null, b: PreviewRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

export const useLivePreviewStore = create<LivePreviewStore>((set, get) => ({
  collapsed: readCollapsed(),
  rect: null,
  setCollapsed(collapsed) {
    set({ collapsed });
    safeSetItem(STORAGE_KEY, JSON.stringify({ collapsed }));
  },
  toggleCollapsed() {
    get().setCollapsed(!get().collapsed);
  },
  setRect(rect) {
    if (!sameRect(get().rect, rect)) set({ rect });
  },
}));
