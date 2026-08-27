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
import { DEFAULT_MOTIONGEN_MODEL, DEFAULT_MOTIONGEN_URL } from '../../core/motiongen';
import { modelRecordFor } from '../../core/licensing/allowedModels';

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
  /** Text-to-motion service base URL. No such service ships yet — see
   *  DEFAULT_MOTIONGEN_URL. Unreachable simply means the stub generates. */
  motionGenUrl: string;
  /**
   * The checkpoint text-to-motion generates with, org-qualified.
   *
   * This is the field the licence gate exists for. It is the one place a
   * BLOCKED checkpoint can enter the app by being typed, and a build-time scan
   * of source text cannot see a value that lives in a user's localStorage.
   */
  motionGenModel: string;
}

const DEFAULT_SETTINGS: PersistedSettings = {
  comfyUrl: DEFAULT_COMFYUI_URL,
  comfyAuthHeader: '',
  comfyLiveGenerate: false,
  motionGenUrl: DEFAULT_MOTIONGEN_URL,
  motionGenModel: DEFAULT_MOTIONGEN_MODEL,
};

export interface SettingsStore extends PersistedSettings {
  /** Settings modal visibility — ephemeral, not persisted. */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setComfyUrl: (url: string) => void;
  setComfyAuthHeader: (header: string) => void;
  setComfyLiveGenerate: (on: boolean) => void;
  setMotionGenUrl: (url: string) => void;
  setMotionGenModel: (model: string) => void;
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
      motionGenUrl:
        typeof parsed.motionGenUrl === 'string' && parsed.motionGenUrl.trim()
          ? parsed.motionGenUrl
          : DEFAULT_SETTINGS.motionGenUrl,
      // A persisted checkpoint id is COERCED against the licence manifest on the
      // way in, not merely on the way out. localStorage survives the verdict that
      // blocked it: a checkpoint recorded as usable today can be re-recorded as
      // BLOCKED tomorrow, and the id sitting in a browser from before that change
      // would otherwise be read back as configuration and used. Falling back to
      // the default is the safe reading — refusing to boot is not.
      motionGenModel:
        typeof parsed.motionGenModel === 'string' &&
        parsed.motionGenModel.trim() &&
        modelRecordFor(parsed.motionGenModel)?.verdict !== 'BLOCKED'
          ? parsed.motionGenModel
          : DEFAULT_SETTINGS.motionGenModel,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writePersisted(state: PersistedSettings): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * The persisted slice of the live store. Named explicitly rather than spread,
 * so `isOpen` and the actions cannot leak into localStorage, and so the
 * PersistedSettings type reds every setter the day a field is added.
 */
function persistedSliceOf(state: SettingsStore): PersistedSettings {
  return {
    comfyUrl: state.comfyUrl,
    comfyAuthHeader: state.comfyAuthHeader,
    comfyLiveGenerate: state.comfyLiveGenerate,
    motionGenUrl: state.motionGenUrl,
    motionGenModel: state.motionGenModel,
  };
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
    set({ comfyUrl: url.trim() || DEFAULT_COMFYUI_URL });
    writePersisted(persistedSliceOf(get()));
  },
  setComfyAuthHeader(header) {
    set({ comfyAuthHeader: header.trim() });
    writePersisted(persistedSliceOf(get()));
  },
  setComfyLiveGenerate(on) {
    set({ comfyLiveGenerate: on });
    writePersisted(persistedSliceOf(get()));
  },
  setMotionGenUrl(url) {
    set({ motionGenUrl: url.trim() || DEFAULT_MOTIONGEN_URL });
    writePersisted(persistedSliceOf(get()));
  },
  setMotionGenModel(model) {
    // Stores whatever the director typed, INCLUDING an unrecorded id — the
    // refusal that matters lives at `generate`, where the use would happen, and
    // a setter that silently substituted would hide the typo rather than let it
    // be corrected. A BLOCKED id is the exception: it never becomes
    // configuration, because persisting it is how it survives to a later session
    // whose reader has no idea it was refused.
    const trimmed = model.trim();
    const blocked = modelRecordFor(trimmed)?.verdict === 'BLOCKED';
    set({ motionGenModel: !trimmed || blocked ? DEFAULT_MOTIONGEN_MODEL : trimmed });
    writePersisted(persistedSliceOf(get()));
  },
}));
