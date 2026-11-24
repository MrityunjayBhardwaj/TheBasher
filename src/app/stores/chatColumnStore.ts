// Chat column store (#1704) — is the right-hand chat column open, and has the agent said something
// the director has not seen?
//
// Shape: { open, narrowOpen, unread }.
//   - `open` — the desktop column, open by default. Persisted (one localStorage key, the
//     timelineDockStore safeGet/coerce pattern) so a director who folds chat away keeps it folded.
//   - `narrowOpen` — below LAYOUT_NARROW_MAX the column is an overlay drawer, closed by default.
//     Ephemeral like chromeStore's narrow drawers: a reload or a resize back boots it closed.
//   - `unread` — an agent reply landed while the chat was not on screen. Ephemeral; cleared the
//     moment the chat is shown.
//
// No DAG mutation and nothing here touches the agent session: folding the column hides the one
// AgentChat, it never unmounts it, so history and the composer's draft survive.

import { create } from 'zustand';

import type { Message } from '../../agent/session/store';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** #1704 — the chat's fold/unfold shortcut as the platform writes it. Kept here, not in ChatColumn,
 *  so the composer inside the column can name it without importing the column back (#1705). */
export const CHAT_SHORTCUT_LABEL = isMac ? '⌘L' : 'Ctrl+L';

const STORAGE_KEY = 'basher.chatColumn.v1';

export interface ChatColumnState {
  open: boolean;
  narrowOpen: boolean;
  unread: boolean;
}

export interface ChatColumnStore extends ChatColumnState {
  /** Open or fold the chat for the current layout (narrow → the overlay drawer). */
  setVisible: (narrow: boolean, visible: boolean) => void;
  /** Flip the chat for the current layout; returns whether it is now shown. */
  toggle: (narrow: boolean) => boolean;
  setUnread: (unread: boolean) => void;
}

const DEFAULT_STATE: ChatColumnState = { open: true, narrowOpen: false, unread: false };

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

function readPersisted(): ChatColumnState {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as { open?: unknown };
    return {
      ...DEFAULT_STATE,
      open: typeof parsed.open === 'boolean' ? parsed.open : DEFAULT_STATE.open,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writePersisted(open: boolean): void {
  safeSetItem(STORAGE_KEY, JSON.stringify({ open }));
}

/** Is the chat on screen in this layout? */
export function chatVisible(s: ChatColumnState, narrow: boolean): boolean {
  return narrow ? s.narrowOpen : s.open;
}

export const useChatColumnStore = create<ChatColumnStore>((set, get) => ({
  ...readPersisted(),

  setVisible(narrow, visible) {
    if (narrow) {
      set({ narrowOpen: visible, ...(visible ? { unread: false } : {}) });
      return;
    }
    set({ open: visible, ...(visible ? { unread: false } : {}) });
    writePersisted(visible);
  },

  toggle(narrow) {
    const next = !chatVisible(get(), narrow);
    get().setVisible(narrow, next);
    return next;
  },

  setUnread(unread) {
    if (get().unread !== unread) set({ unread });
  },
}));

/** What the agent has said so far, as a comparable key: the last assistant message's id plus how
 *  much it carries. Empty while that message is still the blank bubble a round opens with, so a
 *  turn that has only started does not count as a reply. A change to a non-empty key is a reply
 *  the director has not seen if the chat is folded. */
export function agentReplyKey(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const steps = m.steps?.length ?? 0;
    if (!m.content && !m.summary && steps === 0) return '';
    return `${m.id}:${m.content.length}:${m.summary ?? ''}:${steps}`;
  }
  return '';
}
