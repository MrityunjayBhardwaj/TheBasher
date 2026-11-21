// Timeline dock active-tab store (P6 W5 — UI-SPEC §5.9; D-UX-2).
//
// The TimelineDrawer hosts two panes (Dopesheet + CurveEditor) as tabs.
// Only one is visually active at a time; both stay mounted so V8
// file-rooted store subscriptions don't tear down on switch.
//
// Shape (D-W5-2; #1703 adds `heights`):
//   { activeTab: TimelineTab, heights: { [tab]?: px } }
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

// #1703 — the decided drawer: Shots · Dopesheet · NLA · Curves · Nodes · Library. The Curves tab
// keeps the id 'curve'. Controllers stays after them until its fate is decided. The Light Studio
// left for the right panel, so a persisted 'lightStudio' coerces to the default.
export type TimelineTab =
  | 'shots'
  | 'dopesheet'
  | 'nla'
  | 'curve'
  | 'nodes'
  | 'library'
  | 'controllers';

const VALID_TABS: readonly TimelineTab[] = [
  'shots',
  'dopesheet',
  'nla',
  'curve',
  'nodes',
  'library',
  'controllers',
];

function isTimelineTab(value: unknown): value is TimelineTab {
  return typeof value === 'string' && (VALID_TABS as readonly string[]).includes(value);
}

// #1703 — each tab remembers its own drawer height (px of the drawer body: tab strip + pane +
// toolbar). A tab never resized has no entry and opens at its default. The store clamps to the
// absolute range below; the drawer additionally clamps to the window so the viewport above keeps
// a usable height (that bound depends on the window, so it is applied at render, not stored).
export const MIN_DRAWER_HEIGHT_PX = 120;
export const MAX_DRAWER_HEIGHT_PX = 2000;
export const DEFAULT_DRAWER_HEIGHT_PX = 240;
// A node graph needs room for boxes and wires, so Nodes opens taller than the time editors; the
// Library (#1707) needs a row of tiles plus the Generate form beside them.
const DEFAULT_TAB_HEIGHTS: Partial<Record<TimelineTab, number>> = { nodes: 480, library: 340 };

/** The height a tab opens at when it has never been resized. */
export function defaultDrawerHeight(tab: TimelineTab): number {
  return DEFAULT_TAB_HEIGHTS[tab] ?? DEFAULT_DRAWER_HEIGHT_PX;
}

export function clampDrawerHeight(px: number): number {
  return Math.round(Math.min(MAX_DRAWER_HEIGHT_PX, Math.max(MIN_DRAWER_HEIGHT_PX, px)));
}

export type TabHeights = Partial<Record<TimelineTab, number>>;

export interface TimelineDockState {
  activeTab: TimelineTab;
  /** #1703 — per-tab drawer height, only for tabs the user has resized. */
  heights: TabHeights;
}

export interface TimelineDockStore extends TimelineDockState {
  setActiveTab: (tab: TimelineTab) => void;
  /** #1703 — remember `tab`'s drawer height (clamped to the absolute range). */
  setTabHeight: (tab: TimelineTab, px: number) => void;
}

const DEFAULT_STATE: TimelineDockState = { activeTab: 'dopesheet', heights: {} };

/** The height `tab` opens at: what the user left it at, else its default. */
export function drawerHeightFor(heights: TabHeights, tab: TimelineTab): number {
  return heights[tab] ?? defaultDrawerHeight(tab);
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

// K11 step 4 — narrow legacy / future-renamed tab ids back to the
// default rather than corrupt the store.
function readPersisted(): TimelineDockState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as { activeTab?: unknown; heights?: unknown };
    return {
      activeTab: isTimelineTab(parsed.activeTab) ? parsed.activeTab : DEFAULT_STATE.activeTab,
      heights: coerceHeights(parsed.heights),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

// #1703 — keep only known tabs with finite numbers, clamped. A v1 record written before heights
// existed has none, and a tab id since renamed or removed is dropped rather than carried.
function coerceHeights(value: unknown): TabHeights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: TabHeights = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isTimelineTab(k) && typeof v === 'number' && Number.isFinite(v)) {
      out[k] = clampDrawerHeight(v);
    }
  }
  return out;
}

function writePersisted(state: TimelineDockState): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useTimelineDockStore = create<TimelineDockStore>((set, get) => ({
  ...readPersisted(),

  setActiveTab(tab) {
    if (!isTimelineTab(tab)) return;
    set({ activeTab: tab });
    writePersisted({ activeTab: tab, heights: get().heights });
  },

  setTabHeight(tab, px) {
    if (!isTimelineTab(tab) || !Number.isFinite(px)) return;
    const heights = { ...get().heights, [tab]: clampDrawerHeight(px) };
    set({ heights });
    writePersisted({ activeTab: get().activeTab, heights });
  },
}));
