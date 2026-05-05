// Reserved slot for the agent chat (P2.5). Director mode keeps the slot
// visible in P0 so layout doesn't reflow when the chat ships.
//
// REF: THESIS.md §15.

export function RightDrawer() {
  return (
    <aside
      data-testid="right-drawer"
      className="flex flex-col border-l border-border bg-muted/40 text-xs text-fg/50"
    >
      <header className="border-b border-border px-3 py-2 font-mono uppercase tracking-wide text-fg/70">
        agent
      </header>
      <div className="flex flex-1 items-center justify-center p-4 text-center text-fg/40">
        chat lands in P2.5
      </div>
    </aside>
  );
}
