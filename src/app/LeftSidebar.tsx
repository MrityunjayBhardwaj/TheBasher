// LeftSidebar — R5 wrapper per UI-SPEC §5.5. Hosts two tabs in v0.5:
//
//   - 'scene' — DAG tree projection (existing SceneTree.tsx)
//   - 'agent' — LLM director chat (existing AgentChat.tsx)
//
// Library tab was dropped in W2.5 — bundled-asset access moves to
// AssetsPopover (§5.5.2). The wrapper owns the tab strip, the
// chevron collapse affordance (D-03), and the slot in which the
// active tab's content mounts. Both tab bodies are mounted at all
// times via display:none toggling so subscriptions stay alive
// (e.g. AgentChat's running orchestrator turn doesn't tear down
// when the user flips to the Scene tab).
//
// Persistence — useLeftSidebarStore handles K11 boot lifecycle for
// activeTab. The collapse flag is owned by useChromeStore.leftSidebarCollapsed
// (the W1 store; D-03 placed the chevron inside this wrapper instead
// of standalone in Layout, but the underlying state is the same flag —
// no second source of truth).
//
// V8 file-rooted: src/app/. Reads UI projection stores; no DAG mutation.
// AgentChat (mounted as a tab body) emits DAG ops via the orchestrator
// — that path is its own, not introduced by this wrapper.
//
// REF: docs/UI-SPEC.md §5.5, §3.2 (per-panel collapse), §7.3
// (left-sidebar persistence); D-01, D-03 locked W3.

import type { ReactNode } from 'react';
import { AgentChat } from './AgentChat';
import { SceneTree } from './SceneTree';
import { useChromeStore } from './stores/chromeStore';
import { useLeftSidebarStore, type LeftSidebarTab } from './stores/leftSidebarStore';

interface TabDef {
  readonly value: LeftSidebarTab;
  readonly label: string;
}

const TABS: readonly TabDef[] = [
  { value: 'scene', label: 'Scene' },
  { value: 'agent', label: 'Agent' },
];

export function LeftSidebar(): ReactNode {
  const collapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const toggle = useChromeStore((s) => s.toggleLeftSidebar);
  const activeTab = useLeftSidebarStore((s) => s.activeTab);
  const setActiveTab = useLeftSidebarStore((s) => s.setActiveTab);

  if (collapsed) {
    // Collapsed strip: 28px wide, chevron-only. Clicking expands and
    // returns to the last-active tab (persisted via leftSidebarStore).
    return (
      <aside
        data-testid="left-sidebar"
        data-collapsed="true"
        className="flex h-full w-full flex-col"
      >
        <button
          type="button"
          onClick={toggle}
          data-testid="left-sidebar-expand-toggle"
          title="Expand left sidebar"
          className="flex h-8 w-7 items-center justify-center self-start rounded text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ›
        </button>
      </aside>
    );
  }

  // Expanded: tab strip on top, active tab body below.
  return (
    <aside
      data-testid="left-sidebar"
      data-collapsed="false"
      data-active-tab={activeTab}
      className="flex h-full w-full flex-col"
    >
      <header
        data-testid="left-sidebar-tab-strip"
        className="flex items-center border-b border-border bg-bg/95 font-mono text-[11px]"
      >
        {TABS.map((t) => {
          const active = activeTab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setActiveTab(t.value)}
              data-testid={`left-sidebar-tab-${t.value}`}
              data-active={active || undefined}
              className={`flex h-7 items-center px-3 uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                active
                  ? 'border-b-2 border-accent text-accent'
                  : 'border-b-2 border-transparent text-fg-dim hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          );
        })}
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggle}
          data-testid="left-sidebar-collapse-toggle"
          title="Collapse left sidebar"
          className="flex h-7 w-7 items-center justify-center text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ‹
        </button>
      </header>

      {/* Both tab bodies mount; CSS hides the inactive one. Keeps
          AgentChat subscriptions / orchestrator turns alive across
          tab flips (V8 spirit: don't tear down state-bearing surfaces
          when the user toggles chrome). */}
      <div
        style={{ display: activeTab === 'scene' ? 'flex' : 'none' }}
        className="min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="left-sidebar-body-scene"
      >
        <SceneTree />
      </div>
      <div
        style={{ display: activeTab === 'agent' ? 'flex' : 'none' }}
        className="min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="left-sidebar-body-agent"
      >
        <AgentChat />
      </div>
    </aside>
  );
}
