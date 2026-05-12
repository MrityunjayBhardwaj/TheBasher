// Timeline dock active-tab store (P6 W5 — UI-SPEC §5.9; D-UX-2).
//
// The TimelineDrawer hosts two panes (Dopesheet + CurveEditor) as tabs.
// Only one is visually active at a time; both stay mounted so V8
// file-rooted store subscriptions don't tear down on switch.
//
// Shape (D-W5-2):
//   { activeTab: 'dopesheet' | 'curve' }
//
// One localStorage key. K11 boot lifecycle (init → hydrate → coerce →
// persist). V18 safeGet/safeSet wrappers. Mirrors the
// inspectorSectionsStore template — same pattern, simpler shape.
//
// V8 file-rooted: src/app/stores/. No DAG mutation. The dock owns its
// own visual state; nothing routes through the Op system (V1) because
// no scene data is touched.
//
// REF: docs/UI-SPEC.md §5.9 (R9 TimelineDock; tab semantics);
// D-W5-1..4 (memory/project_p6_w5_context.md); vyapti V8 + V18;
// krama K11 + K12.

import { create } from 'zustand';

const STORAGE_KEY = 'basher.timelineDock.v1';

export type TimelineTab = 'dopesheet' | 'curve';

const VALID_TABS: readonly TimelineTab[] = ['dopesheet', 'curve'];

function isTimelineTab(value: unknown): value is TimelineTab {
  return typeof value === 'string' && (VALID_TABS as readonly string[]).includes(value);
}

export interface TimelineDockState {
  activeTab: TimelineTab;
}

export interface TimelineDockStore extends TimelineDockState {
  setActiveTab: (tab: TimelineTab) => void;
}

const DEFAULT_STATE: TimelineDockState = { activeTab: 'dopesheet' };

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

// K11 step 4 — narrow legacy / future-renamed tab ids back to the
// default rather than corrupt the store.
function readPersisted(): TimelineDockState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<TimelineDockState>;
    if (isTimelineTab(parsed.activeTab)) return { activeTab: parsed.activeTab };
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: TimelineDockState): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useTimelineDockStore = create<TimelineDockStore>((set) => ({
  ...readPersisted(),

  setActiveTab(tab) {
    if (!isTimelineTab(tab)) return;
    set({ activeTab: tab });
    writePersisted({ activeTab: tab });
  },
}));
