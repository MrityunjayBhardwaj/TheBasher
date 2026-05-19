// LeftSidebar store — persisted active tab (Scene / Agent) for R5
// LeftSidebar. Per UI-SPEC §5.5 the LeftSidebar carries two tabs in v0.5:
//
//   - 'scene' — DAG tree projection (existing SceneTree.tsx)
//   - 'agent' — LLM director chat (existing AgentChat.tsx)
//
// (Library tab was dropped in W2.5 — see §5.5.2. AssetsPopover supplies
// bundled-asset access from TopToolbar instead.)
//
// Persistence rules (UI-SPEC §7.3, krama K11):
//   - Default activeTab on first visit = 'scene' (D-01, locked W3).
//   - Subsequent loads restore the last-chosen tab.
//   - Legacy or unknown values coerce to 'scene' (K11 step 4 discipline:
//     when the persisted value isn't in the *current* PERSISTABLE set,
//     fall back rather than preserve a stale shape).
//   - Corrupt JSON → defaults; no module-load crash.
//   - localStorage access guarded with safeGet/safeSet wrappers (V18) so
//     vitest happy-dom partial-stub env (H26) doesn't break module load.
//
// V8 file-rooted: this store lives in src/app/stores/ alongside the other
// UI projection stores. No DAG dispatch passes through it.
//
// REF: docs/UI-SPEC.md §5.5, §7.3, §11 (acceptance); krama K11; vyapti V18;
// hetvabhasa H26 (the trap V18 prevents).

import { create } from 'zustand';

const STORAGE_KEY = 'basher.leftSidebar.v1';

export type LeftSidebarTab = 'scene' | 'agent';

export interface LeftSidebarState {
  activeTab: LeftSidebarTab;
}

export interface LeftSidebarStore extends LeftSidebarState {
  setActiveTab: (tab: LeftSidebarTab) => void;
}

// First-visit defaults. D-01: Scene is the primary surface for the
// director-first workflow; users flip to Agent when they explicitly
// want the LLM. After first visit, K11 persistence restores whatever
// the user last had.
const DEFAULT_STATE: LeftSidebarState = {
  activeTab: 'scene',
};

// Whitelist of legitimate persistable values. Anything outside this set
// (legacy 'library' from pre-W2.5 hand-edits, future renames, malformed
// strings) coerces to the default in readPersisted. PERSISTABLE is also
// checked before setItem writes — narrows the surface for future
// type-shape changes.
const PERSISTABLE: ReadonlySet<LeftSidebarTab> = new Set<LeftSidebarTab>(['scene', 'agent']);

// V18 — defensive Storage access. The plain `typeof localStorage ===
// 'undefined'` guard misfires in happy-dom (stub is *defined* but methods
// aren't bound at module-load). Checking callable methods is the only
// reliable shape. Try/catch wraps the call itself for SSR/quota cases.
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

function isLeftSidebarTab(v: unknown): v is LeftSidebarTab {
  return typeof v === 'string' && PERSISTABLE.has(v as LeftSidebarTab);
}

function readPersisted(): LeftSidebarState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<LeftSidebarState>;
    // K11 step 4 — legacy coercion. If the stored value is no longer in
    // PERSISTABLE (e.g. a future schema rename), fall back to default
    // rather than preserve a value the type no longer accepts.
    if (isLeftSidebarTab(parsed.activeTab)) {
      return { activeTab: parsed.activeTab };
    }
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: LeftSidebarState): void {
  // Only write if the value is in the legitimate set — guards against
  // a future setter being called with an unrecognized tab name.
  if (!PERSISTABLE.has(state.activeTab)) return;
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useLeftSidebarStore = create<LeftSidebarStore>((set, get) => ({
  ...readPersisted(),
  setActiveTab(tab) {
    // Guard at the entry: if a non-persistable value somehow arrives
    // (TypeScript circumvented at runtime), silently no-op rather than
    // corrupt the store. PERSISTABLE-pass is the only mutation path.
    if (!PERSISTABLE.has(tab)) return;
    set({ activeTab: tab });
    writePersisted({ ...get(), activeTab: tab });
  },
}));
