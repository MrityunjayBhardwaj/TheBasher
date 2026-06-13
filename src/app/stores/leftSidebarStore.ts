// LeftSidebar store — persisted active tab (Outliner / Assets) for R5
// LeftSidebar. The left panel carries two tabs:
//
//   - 'outliner' — DAG tree projection (existing SceneTree.tsx) + search
//   - 'assets'   — the asset Library (sample assets + my imports + Import…),
//                  re-homed here from the floating popover / footer (UX
//                  backlog #6 — the left footer's Library/Import/Help were
//                  dropped; the library now lives in a tab beside the tree,
//                  Blender's asset-browser model). The toolbar "Assets"
//                  button selects this tab.
//
// (History: the Wave B redesign dropped the older Scene|Agent tab strip —
// the agent moved to the bottom dock — leaving this store dormant. #6
// repurposes it for Outliner|Assets.)
//
// Persistence rules (UI-SPEC §7.3, krama K11):
//   - Default activeTab on first visit = 'outliner'.
//   - Subsequent loads restore the last-chosen tab.
//   - Legacy or unknown values coerce to 'outliner' (K11 step 4 discipline:
//     when the persisted value isn't in the *current* PERSISTABLE set, fall
//     back rather than preserve a stale shape — old 'scene'/'agent' values
//     land on the default).
//   - Corrupt JSON → defaults; no module-load crash.
//   - localStorage access guarded with safeGet/safeSet wrappers (V18) so
//     vitest happy-dom partial-stub env (H26) doesn't break module load.
//
// V8 file-rooted: this store lives in src/app/stores/ alongside the other
// UI projection stores. No DAG dispatch passes through it.
//
// REF: docs/UI-SPEC.md §5.5, §7.3, §11 (acceptance); krama K11; vyapti V18;
// hetvabhasa H26 (the trap V18 prevents); UX-BACKLOG #6.

import { create } from 'zustand';

const STORAGE_KEY = 'basher.leftSidebar.v1';

export type LeftSidebarTab = 'outliner' | 'assets';

export interface LeftSidebarState {
  activeTab: LeftSidebarTab;
}

export interface LeftSidebarStore extends LeftSidebarState {
  setActiveTab: (tab: LeftSidebarTab) => void;
}

// First-visit defaults. The Outliner is the primary surface for the
// director-first workflow; users flip to Assets when they want to browse
// or import. After first visit, K11 persistence restores whatever the user
// last had.
const DEFAULT_STATE: LeftSidebarState = {
  activeTab: 'outliner',
};

// Whitelist of legitimate persistable values. Anything outside this set
// (legacy 'scene'/'agent'/'library' from earlier tab schemes, future
// renames, malformed strings) coerces to the default in readPersisted.
// PERSISTABLE is also checked before setItem writes — narrows the surface
// for future type-shape changes.
const PERSISTABLE: ReadonlySet<LeftSidebarTab> = new Set<LeftSidebarTab>(['outliner', 'assets']);

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
