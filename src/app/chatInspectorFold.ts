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

// #1706 — the rule reacts to the USER toggling a panel. Going to a proposal line from the chat's
// change list also unfolds the inspector, but the director is reviewing in the chat: folding it
// would hide the card they just clicked. Both open is a legal state, so that unfold goes through
// `unfoldInspectorKeepingChat`, which the reaction below skips. (Zustand notifies subscribers
// synchronously inside `set`, so the flag is up for exactly that one transition.)
let programmaticUnfold = false;

/** Unfold the inspector without the rule folding chat (navigation, not a user toggle). */
export function unfoldInspectorKeepingChat(): void {
  if (!useChromeStore.getState().inspectorCollapsed) return;
  programmaticUnfold = true;
  try {
    useChromeStore.getState().setInspectorCollapsed(false);
  } finally {
    programmaticUnfold = false;
  }
}

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
    if (
      prev.inspectorCollapsed &&
      !s.inspectorCollapsed &&
      !programmaticUnfold &&
      foldRuleApplies(windowWidth())
    ) {
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
