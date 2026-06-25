// settingsStore — app-level user settings (the app's FIRST settings surface).
//
// Holds the ComfyUI connection config (server URL + optional auth header) so the
// boot-time `pickComfyUI()` can target a configurable server instead of the
// hardcoded default (the documented-but-unwired `settings.get('comfyui.serverUrl')`
// gap — ComfyUI epic Inc 2). The values are PERSISTED (localStorage); the modal
// open/close flag is EPHEMERAL (chrome state, never persisted).
//
// On any value change we persist AND reset the cached ComfyUI capability so the
// next request re-probes the new URL (the cache is a session singleton in boot).
//
// One localStorage key. K11 boot lifecycle (init → hydrate → coerce → persist).
// V18 safeGet/safeSet wrappers. V8 file-rooted: src/app/stores/. No DAG mutation.

import { create } from 'zustand';
import { DEFAULT_COMFYUI_URL } from '../../core/comfy';

const STORAGE_KEY = 'basher.settings.v1';

/** The persisted slice (the modal open flag is NOT part of this). */
export interface PersistedSettings {
  /** ComfyUI server base URL (e.g. http://127.0.0.1:8188). */
  comfyUrl: string;
  /** Optional value for the `Authorization` header sent to ComfyUI ('' = none). */
  comfyAuthHeader: string;
  /**
   * When true, a ComfyUIWorkflow layer SUBMITS its per-frame compiled workflow to
   * the configured server (real /prompt → /view) instead of drawing the
   * deterministic placeholder stub (inc 3 real submit). Default FALSE so the app
   * (and CI / offline) stays on the GPU-free stub — real generation is opt-in,
   * expensive, and server-dependent.
   */
  comfyLiveGenerate: boolean;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  comfyUrl: DEFAULT_COMFYUI_URL,
  comfyAuthHeader: '',
  comfyLiveGenerate: false,
};

export interface SettingsStore extends PersistedSettings {
  /** Settings modal visibility — ephemeral, not persisted. */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setComfyUrl: (url: string) => void;
  setComfyAuthHeader: (header: string) => void;
  setComfyLiveGenerate: (on: boolean) => void;
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

// K11 step 4 — coerce a malformed / partial persisted blob back to typed
// defaults rather than corrupt the store (a non-string URL becomes the default).
function readPersisted(): PersistedSettings {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      comfyUrl:
        typeof parsed.comfyUrl === 'string' && parsed.comfyUrl.trim()
          ? parsed.comfyUrl
          : DEFAULT_SETTINGS.comfyUrl,
      comfyAuthHeader:
        typeof parsed.comfyAuthHeader === 'string'
          ? parsed.comfyAuthHeader
          : DEFAULT_SETTINGS.comfyAuthHeader,
      comfyLiveGenerate:
        typeof parsed.comfyLiveGenerate === 'boolean'
          ? parsed.comfyLiveGenerate
          : DEFAULT_SETTINGS.comfyLiveGenerate,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writePersisted(state: PersistedSettings): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...readPersisted(),
  isOpen: false,

  open() {
    set({ isOpen: true });
  },
  close() {
    set({ isOpen: false });
  },
  setComfyUrl(url) {
    const comfyUrl = url.trim() || DEFAULT_COMFYUI_URL;
    set({ comfyUrl });
    writePersisted({ comfyUrl, comfyAuthHeader: get().comfyAuthHeader });
  },
  setComfyAuthHeader(header) {
    const comfyAuthHeader = header.trim();
    set({ comfyAuthHeader });
    writePersisted({
      comfyUrl: get().comfyUrl,
      comfyAuthHeader,
      comfyLiveGenerate: get().comfyLiveGenerate,
    });
  },
  setComfyLiveGenerate(on) {
    set({ comfyLiveGenerate: on });
    writePersisted({
      comfyUrl: get().comfyUrl,
      comfyAuthHeader: get().comfyAuthHeader,
      comfyLiveGenerate: on,
    });
  },
}));
