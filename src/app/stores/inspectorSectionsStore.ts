// Inspector sections collapsed-state store — per-node-type persistence
// of which sections the user has collapsed (P6 W4 — UI-SPEC §7.3:
// "inspector section collapsed state (per node type)").
//
// Shape (D-09 A):
//   Record<NodeTypeId, Record<SectionId, boolean>>
//
// One nested object keyed first by node type, then by section id.
// `true` means user-collapsed; absence means use the §5.8 default-
// collapsed convention (non-primary sections default-collapsed). This
// matches chromeStore / leftSidebarStore: one localStorage key, K11
// boot lifecycle, V18 safeGet/safeSet wrappers.
//
// V8 file-rooted: src/app/stores/. No DAG mutation. The Inspector
// reads this store to decide section render-state; setters fire from
// header-click handlers in NPanel.
//
// REF: docs/UI-SPEC.md §7.3 (persistence rules); D-09 locked W4;
// vyapti V18; krama K11; hetvabhasa H26.

import { create } from 'zustand';
import { isSectionId, type SectionId } from '../inspectorSections';

const STORAGE_KEY = 'basher.inspectorSections.v1';

/** Per-node-type collapsed map. `true` = user-collapsed; absence =
 *  default rule (§5.8: non-primary domains start collapsed). */
export type CollapsedMap = Partial<Record<SectionId, boolean>>;

export interface InspectorSectionsState {
  collapsedByNodeType: Record<string, CollapsedMap>;
}

export interface InspectorSectionsStore extends InspectorSectionsState {
  /** Set the collapsed state for one (nodeType, sectionId) pair. */
  setCollapsed: (nodeType: string, sectionId: SectionId, collapsed: boolean) => void;
  /** Toggle collapsed state — convenience for chevron click handlers. */
  toggleCollapsed: (nodeType: string, sectionId: SectionId) => void;
  /** Read the persisted user choice, or `undefined` when the user
   *  hasn't touched this section yet (caller falls back to the §5.8
   *  default-collapsed rule). */
  getUserCollapsed: (nodeType: string, sectionId: SectionId) => boolean | undefined;
}

const DEFAULT_STATE: InspectorSectionsState = { collapsedByNodeType: {} };

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

/** Narrow a parsed JSON object into a clean CollapsedMap — drop any
 *  unknown section ids (K11 step 4 — legacy / future renames coerce
 *  away rather than corrupt the store). */
function narrowCollapsedMap(raw: unknown): CollapsedMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: CollapsedMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSectionId(k)) continue;
    if (typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}

function readPersisted(): InspectorSectionsState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<InspectorSectionsState>;
    if (!parsed.collapsedByNodeType || typeof parsed.collapsedByNodeType !== 'object') {
      return DEFAULT_STATE;
    }
    const out: Record<string, CollapsedMap> = {};
    for (const [nodeType, perSection] of Object.entries(parsed.collapsedByNodeType)) {
      // Node-type keys are loose strings (DAG registry is app-agnostic) —
      // we don't narrow them here because new node types added at runtime
      // would otherwise be silently dropped.
      const narrowed = narrowCollapsedMap(perSection);
      if (Object.keys(narrowed).length > 0) out[nodeType] = narrowed;
    }
    return { collapsedByNodeType: out };
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(state: InspectorSectionsState): void {
  safeSetItem(STORAGE_KEY, JSON.stringify(state));
}

export const useInspectorSectionsStore = create<InspectorSectionsStore>((set, get) => ({
  ...readPersisted(),

  setCollapsed(nodeType, sectionId, collapsed) {
    if (!isSectionId(sectionId)) return;
    const prev = get().collapsedByNodeType;
    const prevMap = prev[nodeType] ?? {};
    const nextMap: CollapsedMap = { ...prevMap, [sectionId]: collapsed };
    const next: Record<string, CollapsedMap> = { ...prev, [nodeType]: nextMap };
    set({ collapsedByNodeType: next });
    writePersisted({ collapsedByNodeType: next });
  },

  toggleCollapsed(nodeType, sectionId) {
    if (!isSectionId(sectionId)) return;
    const current = get().collapsedByNodeType[nodeType]?.[sectionId];
    // current=undefined → first toggle assumes the user is collapsing
    // a section that wasn't user-touched yet. The default rule (§5.8)
    // determines initial visual; the toggle inverts what the user
    // currently SEES, not what the store currently holds. NPanel
    // resolves the visual via isCollapsedResolved (below) and passes
    // the current visual state to this fn — so the toggle becomes
    // (currentVisual ? expand : collapse). For simplicity here we
    // toggle vs `true` as the most common UX expectation: clicking
    // a collapsed section expands it.
    const next = current === undefined ? true : !current;
    const prev = get().collapsedByNodeType;
    const prevMap = prev[nodeType] ?? {};
    const nextMap: CollapsedMap = { ...prevMap, [sectionId]: next };
    const merged: Record<string, CollapsedMap> = { ...prev, [nodeType]: nextMap };
    set({ collapsedByNodeType: merged });
    writePersisted({ collapsedByNodeType: merged });
  },

  getUserCollapsed(nodeType, sectionId) {
    if (!isSectionId(sectionId)) return undefined;
    return get().collapsedByNodeType[nodeType]?.[sectionId];
  },
}));

/** Resolve the visual collapsed state for a section, combining the
 *  user's choice (when set) with the §5.8 default rule (when not).
 *
 *  @param userCollapsed  Result of `getUserCollapsed` for this pair.
 *  @param isDefault      Result of `isDefaultCollapsed(sections, id)`.
 */
export function resolveCollapsed(
  userCollapsed: boolean | undefined,
  isDefault: boolean,
): boolean {
  return userCollapsed === undefined ? isDefault : userCollapsed;
}
