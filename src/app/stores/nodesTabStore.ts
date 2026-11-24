// #1953 — the Nodes drawer tab's own state (design board 8b): its right panel (N) and the view flag.
//
//   - `panelOpen` — the tab's own right panel, listing the selected node's full parameters.
//     Opens with the tab, as the board draws it; N folds and unfolds it. Persisted (one key, the
//     timelineDockStore safeGet pattern) so a director who folds it keeps it folded.
//   - `inspectorFoldedByPanel` — the panel folded the inspector to its rail and the director has
//     not touched it since (nodesInspectorFold.ts), so it is the panel's to give back. Saved with
//     `panelOpen`, so a reload (the drawer comes back closed) gives it back at once.
//   - `viewing` — the one node whose result the viewport shows (`viewFlag.ts`), or null for the
//     scene as it is. EPHEMERAL: how the director is looking, never part of the scene, so it is
//     neither saved nor undone, and a reload comes back to the plain scene.
//
// No DAG mutation: nothing here routes through the Op system.

import { create } from 'zustand';

import type { NodeId } from '../../core/dag/types';

const STORAGE_KEY = 'basher.nodesTab.v1';

export interface NodesTabState {
  panelOpen: boolean;
  inspectorFoldedByPanel: boolean;
  viewing: NodeId | null;
}

export interface NodesTabStore extends NodesTabState {
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setInspectorFoldedByPanel: (folded: boolean) => void;
  /** View `id`'s result; viewing the node already viewed goes back to the plain scene. */
  toggleViewing: (id: NodeId) => void;
  setViewing: (id: NodeId | null) => void;
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

type Saved = Pick<NodesTabState, 'panelOpen' | 'inspectorFoldedByPanel'>;

function readSaved(): Saved {
  try {
    const parsed = JSON.parse(safeGetItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;
    return {
      panelOpen: typeof parsed?.panelOpen === 'boolean' ? parsed.panelOpen : true,
      inspectorFoldedByPanel: parsed?.inspectorFoldedByPanel === true,
    };
  } catch {
    return { panelOpen: true, inspectorFoldedByPanel: false };
  }
}

function writeSaved(s: Saved): void {
  safeSetItem(
    STORAGE_KEY,
    JSON.stringify({ panelOpen: s.panelOpen, inspectorFoldedByPanel: s.inspectorFoldedByPanel }),
  );
}

export const useNodesTabStore = create<NodesTabStore>((set, get) => ({
  ...readSaved(),
  viewing: null,
  setPanelOpen(open) {
    set({ panelOpen: open });
    writeSaved(get());
  },
  setInspectorFoldedByPanel(folded) {
    set({ inspectorFoldedByPanel: folded });
    writeSaved(get());
  },
  togglePanel() {
    get().setPanelOpen(!get().panelOpen);
  },
  toggleViewing(id) {
    set({ viewing: get().viewing === id ? null : id });
  },
  setViewing(id) {
    set({ viewing: id });
  },
}));
