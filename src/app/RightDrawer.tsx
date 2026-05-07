// Agent chat — P2.5 ships in this slot. Simple mode shows the drawer with
// the chat component. Pro mode hides the drawer (Inspector occupies that
// slot); the chat is accessible via the drawer toggle.
//
// REF: THESIS.md §15, §21.

import { AgentChat } from './AgentChat';

export function RightDrawer() {
  return (
    <aside
      data-testid="right-drawer"
      className="flex flex-col min-h-0 border-l border-border bg-muted/40 text-xs text-fg/50"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        agent
      </header>
      <div className="flex flex-1 flex-col min-h-0">
        <AgentChat />
      </div>
    </aside>
  );
}
