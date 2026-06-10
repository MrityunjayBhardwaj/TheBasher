// AgentDock — the always-on agent surface (Spline redesign Wave C).
//
// Replaces RightDrawer. The W-B inspector restructure needed the right column
// for a full-height Spline inspector, so the agent moved OUT of the cramped
// 280px right drawer into a full-width dock along the bottom (above the
// timeline) — the user's locked Wave C placement. Always-on signals the
// agent's co-equal, agent-native status (THESIS §196 director-first +
// agent-native): it is not a summonable afterthought, it is part of the frame.
//
// One agent component (§196): this dock hosts the SAME AgentChat that drove the
// orchestrator before — no fork, no second chat. The component's zustand
// session store is the single source of agent state, so relocating its mount
// point changes nothing about behavior.
//
// V8 file-rooted: src/app/. No DAG mutation here; AgentChat emits ops via the
// orchestrator (its own path, unchanged by this relocation).
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §15, §196.

import type { ReactNode } from 'react';
import { AgentChat } from './AgentChat';

export function AgentDock(): ReactNode {
  return (
    <aside
      data-testid="agent-dock"
      role="region"
      aria-label="Agent"
      className="flex h-full min-h-0 flex-col border-t border-border bg-bg-2"
    >
      <div className="min-h-0 flex-1">
        <AgentChat />
      </div>
    </aside>
  );
}
