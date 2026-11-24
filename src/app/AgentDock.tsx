// AgentDock — the agent surface inside the right-hand chat column (#1704).
//
// Placement history: Spline redesign Wave C moved the agent out of the cramped
// 280px RightDrawer into a full-width dock along the bottom, and UX-BACKLOG #2
// floated it as a bottom-centre island above the playback bar. On the user's
// call in the 2026-10-20 design review (#1704) that is reversed: chat is one
// full-height column at the far right (ChatColumn), and the bottom bar is
// playback only. The column folds to a rail; it is never unmounted, so the
// conversation and the composer's draft survive a fold.
//
// One agent component (§196): this dock hosts the SAME AgentChat that drove the
// orchestrator before — no fork, no second chat. The component's zustand
// session store is the single source of agent state, so relocating its mount
// point changes nothing about behavior.
//
// V8 file-rooted: src/app/. No DAG mutation here; AgentChat emits ops via the
// orchestrator (its own path, unchanged by this relocation).
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §15, §196; src/app/ChatColumn.tsx.

import type { ReactNode } from 'react';
import { AgentChat } from './AgentChat';

export function AgentDock(): ReactNode {
  return (
    <aside
      data-testid="agent-dock"
      role="region"
      aria-label="Agent"
      className="flex min-h-0 flex-1 flex-col bg-transparent"
    >
      <AgentChat />
    </aside>
  );
}
