// #1709 — the split/outliner fold rule (decided against design board 11a, where the left side is
// only a slim rail while the 2D View shows the 3D view beside it).
//
// While the split SHOWS (the 2D space, in a 2D mode with the split on, the 3D side not collapsed)
// the two sides need the room, so:
//   - the split starting to show folds the outliner to its rail;
//   - the split going away (toggled off, Render, leaving the 2D space, collapsing the 3D side)
//     restores the outliner — but only if THIS rule folded it and the director has not touched it
//     since. Re-opening (or re-folding) it themselves during the split makes it theirs, and it is
//     left as they set it.
// It reacts to those transitions only, like the chat/inspector rule (chatInspectorFold.ts), and
// tells its own write from the director's the same way: a flag up for exactly its own `set`
// (zustand notifies subscribers synchronously inside `set`). In the narrow layout the outliner is
// an overlay drawer and takes no room, so nothing folds there. Neither store imports the other;
// this module is the one place they are tied.

import { useEffect } from 'react';

import { LAYOUT_NARROW_MAX } from './layoutIslands';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { useSplitViewStore, type SplitViewState } from './stores/splitViewStore';
import { useTwoDViewStore, type TwoDViewMode } from './stores/twoDViewStore';

/** Is the 3D view showing beside the 2D View right now? */
export function splitShowing(
  space: string,
  mode: TwoDViewMode,
  split: Pick<SplitViewState, 'split' | 'collapsed'>,
): boolean {
  return space === 'uv' && split.split[mode] && !split.collapsed;
}

/** Subscribe the rule; returns the unsubscribe. `windowWidth` is read at each transition. */
export function installSplitOutlinerFold(windowWidth: () => number): () => void {
  // "We folded it and the director has not touched it since: ours to restore" lives in the split
  // store, saved with the split, so a reload while the split is open does not forget it.
  const folded = () => useSplitViewStore.getState().outlinerFoldedBySplit;
  const setFolded = (v: boolean) => useSplitViewStore.getState().setOutlinerFoldedBySplit(v);
  let ownWrite = false;
  const setOutliner = (collapsed: boolean) => {
    ownWrite = true;
    try {
      useChromeStore.getState().setLeftSidebarCollapsed(collapsed);
    } finally {
      ownWrite = false;
    }
  };

  const now = () =>
    splitShowing(
      useEditorStore.getState().space,
      useTwoDViewStore.getState().mode,
      useSplitViewStore.getState(),
    );
  let showing = now();
  // A reload lands outside the split (the editor opens in 3D): the split this memory was kept for
  // is gone, so restore now rather than wait for a close that will not come.
  if (!showing && folded()) {
    setFolded(false);
    if (useChromeStore.getState().leftSidebarCollapsed) setOutliner(false);
  }

  const react = () => {
    const next = now();
    if (next === showing) return;
    showing = next;
    if (next) {
      if (windowWidth() >= LAYOUT_NARROW_MAX && !useChromeStore.getState().leftSidebarCollapsed) {
        setOutliner(true);
        setFolded(true);
      }
    } else if (folded()) {
      setFolded(false);
      if (useChromeStore.getState().leftSidebarCollapsed) setOutliner(false);
    }
  };

  const offEditor = useEditorStore.subscribe(react);
  const offMode = useTwoDViewStore.subscribe(react);
  const offSplit = useSplitViewStore.subscribe(react);
  const offChrome = useChromeStore.subscribe((s, prev) => {
    if (s.leftSidebarCollapsed !== prev.leftSidebarCollapsed && !ownWrite && folded()) {
      setFolded(false);
    }
  });
  return () => {
    offEditor();
    offMode();
    offSplit();
    offChrome();
  };
}

/** Mount the rule for the editor's lifetime (Layout). */
export function useSplitOutlinerFold(): void {
  useEffect(() => installSplitOutlinerFold(() => window.innerWidth), []);
}
