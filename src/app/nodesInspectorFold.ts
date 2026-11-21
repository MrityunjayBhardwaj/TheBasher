// #1953 — the Nodes panel / inspector fold rule (design board 8b: "the inspector is a rail while
// Nodes owns its own panel").
//
// The Nodes tab's own panel (N) draws the selected node's full settings with the inspector's own
// block, so the two open at once show every control, and the rename field, twice. So, like the
// split's rule for the outliner (splitOutlinerFold.ts):
//   - the Nodes panel starting to show (the drawer open on the Nodes tab, its panel unfolded)
//     folds the inspector to its rail;
//   - the panel going away (folded with N, another tab, the drawer closed) restores the inspector,
//     but only if THIS rule folded it and the director has not touched it since. Opening (or
//     folding) it themselves while the panel shows makes it theirs, and it is left as they set it.
// It reacts to those transitions only. Its own writes never read as the director's by ORDER: it
// folds before raising "we folded it" and lowers it before unfolding, and the director's-touch
// watch only clears a memory that is up (zustand notifies synchronously inside `set`). "We folded
// it" is saved with the Nodes tab's state, so a reload (which opens with the drawer closed)
// restores at once rather than leaving the inspector folded for good. The restore goes through
// `unfoldInspectorKeepingChat`: it is not a director's unfold, so the chat rule must not fold chat
// for it. In the narrow layout the inspector is an overlay drawer and takes no room: nothing folds.

import { useEffect } from 'react';

import { unfoldInspectorKeepingChat } from './chatInspectorFold';
import { LAYOUT_NARROW_MAX } from './layoutIslands';
import { useChromeStore } from './stores/chromeStore';
import { useNodesTabStore } from './stores/nodesTabStore';
import { useTimelineDockStore } from './stores/timelineDockStore';
import { useViewportStore } from './stores/viewportStore';

/** Is the Nodes tab's own panel on screen? */
export function nodesPanelShowing(drawerOpen: boolean, tab: string, panelOpen: boolean): boolean {
  return drawerOpen && tab === 'nodes' && panelOpen;
}

/** Subscribe the rule; returns the unsubscribe. `windowWidth` is read at each transition. */
export function installNodesInspectorFold(windowWidth: () => number): () => void {
  const folded = () => useNodesTabStore.getState().inspectorFoldedByPanel;
  const setFolded = (v: boolean) => useNodesTabStore.getState().setInspectorFoldedByPanel(v);
  const restore = () => {
    setFolded(false);
    if (useChromeStore.getState().inspectorCollapsed) unfoldInspectorKeepingChat();
  };

  const now = () =>
    nodesPanelShowing(
      useViewportStore.getState().timelineDrawerOpen,
      useTimelineDockStore.getState().activeTab,
      useNodesTabStore.getState().panelOpen,
    );
  let showing = now();
  if (!showing && folded()) restore();

  const react = () => {
    const next = now();
    if (next === showing) return;
    showing = next;
    if (next) {
      if (windowWidth() >= LAYOUT_NARROW_MAX && !useChromeStore.getState().inspectorCollapsed) {
        // Fold first, then remember: the director's-touch watch below only clears a memory
        // that is already up, so the rule's own two writes never read as the director's.
        useChromeStore.getState().setInspectorCollapsed(true);
        setFolded(true);
      }
    } else if (folded()) {
      restore();
    }
  };

  const offViewport = useViewportStore.subscribe(react);
  const offDock = useTimelineDockStore.subscribe(react);
  const offNodes = useNodesTabStore.subscribe(react);
  const offChrome = useChromeStore.subscribe((s, prev) => {
    if (s.inspectorCollapsed !== prev.inspectorCollapsed && folded()) setFolded(false);
  });
  return () => {
    offViewport();
    offDock();
    offNodes();
    offChrome();
  };
}

/** Mount the rule for the editor's lifetime (Layout). */
export function useNodesInspectorFold(): void {
  useEffect(() => installNodesInspectorFold(() => window.innerWidth), []);
}
