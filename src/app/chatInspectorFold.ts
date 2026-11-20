// #1704 — the chat/inspector fold rule (the issue's decided text).
//
// At window widths ≤ CHAT_INSPECTOR_FOLD_MAX the chat column and the expanded inspector cannot both
// be open and leave the viewport's centre usable, so:
//   - OPENING the chat column folds the inspector to its rail;
//   - UNFOLDING the inspector folds the chat column to its rail.
// It reacts to those two transitions only. It never re-folds on its own afterwards: a boot or a
// resize that finds both open leaves them open, and above the limit (or in the narrow layout, where
// both are overlay drawers) nothing auto-folds. Neither store imports the other; this module is the
// one place the two are tied.

import { useEffect } from 'react';

import { CHAT_INSPECTOR_FOLD_MAX, LAYOUT_NARROW_MAX } from './layoutIslands';
import { useChatColumnStore } from './stores/chatColumnStore';
import { useChromeStore } from './stores/chromeStore';

/** Does the fold rule apply at this window width? */
export function foldRuleApplies(windowWidth: number): boolean {
  return windowWidth >= LAYOUT_NARROW_MAX && windowWidth <= CHAT_INSPECTOR_FOLD_MAX;
}

/** Subscribe the rule; returns the unsubscribe. `windowWidth` is read at each transition. */
export function installChatInspectorFold(windowWidth: () => number): () => void {
  const offChat = useChatColumnStore.subscribe((s, prev) => {
    if (!prev.open && s.open && foldRuleApplies(windowWidth())) {
      if (!useChromeStore.getState().inspectorCollapsed) {
        useChromeStore.getState().setInspectorCollapsed(true);
      }
    }
  });
  const offInspector = useChromeStore.subscribe((s, prev) => {
    if (prev.inspectorCollapsed && !s.inspectorCollapsed && foldRuleApplies(windowWidth())) {
      if (useChatColumnStore.getState().open)
        useChatColumnStore.getState().setVisible(false, false);
    }
  });
  return () => {
    offChat();
    offInspector();
  };
}

/** Mount the rule for the editor's lifetime (Layout). */
export function useChatInspectorFold(): void {
  useEffect(() => installChatInspectorFold(() => window.innerWidth), []);
}
