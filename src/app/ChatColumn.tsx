// ChatColumn (#1704) — the agent's chat as one full-height column at the right of the window.
//
// The user's call (2026-10-20 design review, boards 1 and 10): chat leaves the bottom band, which
// becomes playback only, and takes a column from under the menu bar to the window's bottom. The
// viewport, the bottom drawer and the inspector end at its left edge. Folded, it is a slim rail
// with the chat icon, the ⌘L hint and an unread dot. Below LAYOUT_NARROW_MAX it is an overlay
// drawer (closed by default) so the viewport keeps its width, and closed it is an edge tab.
//
// ONE AgentChat (§196): the dock is always mounted, folding only hides it, so the conversation and
// the composer's half-typed draft survive a fold. Layout owns the grid column's width; this
// component owns what is drawn inside it.
//
// REF: src/app/Layout.tsx (the `chat` grid area); src/app/stores/chatColumnStore.ts.

import { useEffect, useRef, type CSSProperties } from 'react';

import { AgentDock } from './AgentDock';
import { useAgentSessionStore } from '../agent/session/store';
import { useDiffStore } from '../agent/diff';
import { usePendingProposal } from '../agent/diff/useProposal';
import { PROPOSAL_AMBER } from './ProposalCard';
import { agentReplyKey, chatVisible, useChatColumnStore } from './stores/chatColumnStore';
import { useChromeStore } from './stores/chromeStore';
import { CHAT_COLUMN_WIDTH } from './layoutIslands';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const CHAT_SHORTCUT_LABEL = isMac ? '⌘L' : 'Ctrl+L';

function ChatIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  );
}

/** Focus the composer once the column is on screen (after the display flip has committed). */
export function focusChatComposer(): void {
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="agentdock-slot"] [data-testid="agent-input"]',
    );
    input?.focus();
  });
}

export function ChatColumn({ isNarrow, hidden }: { isNarrow: boolean; hidden: boolean }) {
  const open = useChatColumnStore((s) => chatVisible(s, isNarrow));
  const unread = useChatColumnStore((s) => s.unread);
  const setVisible = useChatColumnStore((s) => s.setVisible);

  // A reply that lands while the chat is folded (or hidden by present mode) lights the dot.
  const shownRef = useRef(open && !hidden);
  shownRef.current = open && !hidden;
  useEffect(() => {
    let last = agentReplyKey(useAgentSessionStore.getState().session.messages);
    return useAgentSessionStore.subscribe((s) => {
      const key = agentReplyKey(s.session.messages);
      if (key === last) return;
      last = key;
      if (key !== '' && !shownRef.current) useChatColumnStore.getState().setUnread(true);
    });
  }, []);
  useEffect(() => {
    if (open && !hidden) useChatColumnStore.getState().setUnread(false);
  }, [open, hidden]);

  // #1706 — a proposal must never be invisible: its change list (and its only Accept) is in this
  // column, so one that arrives while the column is folded opens it. Keyed on the proposal, so a
  // director who folds the column again while it waits keeps it folded (the rail then carries the
  // amber "proposal waiting" cue). An effect, not a store subscription: a user-side mutator proposes
  // and accepts in one go (`dispatchMutator`), and by the time React commits that proposal is no
  // longer pending, so it never opens the column.
  const pending = usePendingProposal();
  const pendingKey = pending?.createdAt ?? null;
  const narrowRef = useRef(isNarrow);
  narrowRef.current = isNarrow;
  useEffect(() => {
    if (pendingKey === null) return;
    if (useDiffStore.getState().status !== 'pending') return;
    if (!chatVisible(useChatColumnStore.getState(), narrowRef.current)) {
      if (narrowRef.current) useChromeStore.getState().closeNarrowDrawers();
      useChatColumnStore.getState().setVisible(narrowRef.current, true);
    }
  }, [pendingKey]);

  const reveal = () => {
    if (isNarrow) useChromeStore.getState().closeNarrowDrawers();
    setVisible(isNarrow, true);
    focusChatComposer();
  };

  // Desktop: fills its grid cell (Layout sizes the column: CHAT_COLUMN_WIDTH open, the rail
  // folded). Narrow: the grid column is 0 wide, and an absolutely placed grid item's containing
  // block is its grid area, so `right: 0` pins the drawer to the window's right edge and it
  // overlays the viewport instead of taking width from it.
  const narrowStyle: CSSProperties = open
    ? { position: 'absolute', top: 0, bottom: 0, right: 0, width: CHAT_COLUMN_WIDTH, zIndex: 41 }
    : { position: 'absolute', top: 'calc(50% + 40px)', right: 0, zIndex: 41 };

  return (
    <div
      data-testid="agentdock-slot"
      data-open={open ? 'true' : 'false'}
      data-narrow-drawer={isNarrow ? 'true' : 'false'}
      onContextMenu={(e) => e.stopPropagation()}
      style={{
        gridArea: 'chat',
        display: hidden ? 'none' : 'flex',
        ...(isNarrow ? narrowStyle : {}),
      }}
      className={[
        'min-h-0 min-w-0 flex-col overflow-hidden',
        open
          ? 'border-l border-border bg-bg-2'
          : isNarrow
            ? 'rounded-l-lg border border-r-0 border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md'
            : 'border-l border-border bg-bg-2',
        open && isNarrow ? 'shadow-xl shadow-black/40' : '',
      ].join(' ')}
    >
      {/* The rail (folded): the one way back by mouse. */}
      {!open ? (
        <button
          type="button"
          data-testid="chat-rail"
          aria-label={
            pending
              ? 'Open chat (a proposal is waiting)'
              : unread
                ? 'Open chat (new reply)'
                : 'Open chat'
          }
          title={`Chat (${CHAT_SHORTCUT_LABEL})`}
          onClick={reveal}
          className={[
            'relative flex flex-col items-center gap-1 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            isNarrow ? 'px-2 py-3' : 'w-full pt-3',
          ].join(' ')}
        >
          <ChatIcon />
          {!isNarrow ? (
            <span className="text-[9px] leading-none text-fg/40">{CHAT_SHORTCUT_LABEL}</span>
          ) : null}
          {pending ? (
            <span
              data-testid="chat-proposal-cue"
              aria-hidden
              className="absolute left-1.5 top-2 h-2 w-2 rounded-full"
              style={{ background: PROPOSAL_AMBER }}
            />
          ) : null}
          {unread ? (
            <span
              data-testid="chat-unread-dot"
              aria-hidden
              className="absolute right-1.5 top-2 h-2 w-2 rounded-full bg-accent"
            />
          ) : null}
        </button>
      ) : null}

      {/* The column (open): header + the one AgentChat. Hidden, never unmounted, when folded. */}
      <div
        className="min-h-0 flex-1 flex-col"
        style={{ display: open ? 'flex' : 'none' }}
        data-testid="chat-column"
      >
        <div
          data-testid="chat-column-header"
          className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3"
        >
          <span className="text-xs font-semibold text-fg">Chat</span>
          <button
            type="button"
            data-testid="chat-column-close"
            aria-label="Fold chat"
            title={`Fold chat (${CHAT_SHORTCUT_LABEL})`}
            onClick={() => setVisible(isNarrow, false)}
            className="rounded px-1.5 py-0.5 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <span aria-hidden>⇥</span>
          </button>
        </div>
        <AgentDock />
      </div>
    </div>
  );
}
