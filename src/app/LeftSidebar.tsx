// LeftSidebar — the Spline-style left panel: a two-tab surface (Outliner |
// Assets) over the project's scene + asset library.
//
//   header   — project name + collapse chevron
//   tabstrip — Outliner | Assets
//   Outliner — search + Scenes label + SceneTree (DAG projection)
//   Assets   — Import… button + AssetLibrary (bundled samples + my imports),
//              Blender's asset-browser model
//
// UX backlog #6 re-homed the asset Library here. The old footer (Library ·
// Import · Help & Feedback) is gone: Library became the Assets tab, Import is
// the Assets-tab header button, and Help & Feedback (a placeholder with no
// system behind it) was dropped. The floating AssetsPopover is deleted — the
// library now has ONE home (V34, one path); the toolbar "Assets" button
// selects this tab (expanding the sidebar if collapsed).
//
// The agent surface is the bottom AgentDock (§196), not a tab here.
//
// Collapse is preserved (V35 — the reveal affordance stays reachable while
// collapsed): collapsed renders a 28px strip whose only control is the expand
// chevron. Default is EXPANDED (chromeStore.leftSidebarCollapsed defaults
// false — the outliner is always-on like Spline).
//
// V8 file-rooted: src/app/. Reads UI projection stores; no DAG mutation.
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §12 (projection); vyapti V34, V35;
// UX-BACKLOG #6.

import { useState, type ReactNode } from 'react';
import { useProjectStore } from '../core/project/store';
import { SceneTree } from './SceneTree';
import { AssetLibrary } from './AssetLibrary';
import { openImportPicker } from './asset/importPicker';
import { useChromeStore } from './stores/chromeStore';
import { useLeftSidebarStore, type LeftSidebarTab } from './stores/leftSidebarStore';

const TABS: { id: LeftSidebarTab; label: string }[] = [
  { id: 'outliner', label: 'Outliner' },
  { id: 'assets', label: 'Assets' },
];

function TabButton({
  id,
  label,
  active,
  onClick,
}: {
  id: LeftSidebarTab;
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`left-sidebar-tab-${id}`}
      data-active={active || undefined}
      onClick={onClick}
      className={`flex-1 border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'border-accent text-fg' : 'border-transparent text-fg-dim hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

export function LeftSidebar(): ReactNode {
  const collapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const toggle = useChromeStore((s) => s.toggleLeftSidebar);
  const projectName = useProjectStore((s) => s.current?.name);
  const activeTab = useLeftSidebarStore((s) => s.activeTab);
  const setActiveTab = useLeftSidebarStore((s) => s.setActiveTab);
  const [search, setSearch] = useState('');

  if (collapsed) {
    // Collapsed strip: 28px wide, chevron-only. The expand affordance must stay
    // reachable while collapsed (V35) — it is the only control here.
    return (
      <aside
        data-testid="left-sidebar"
        data-collapsed="true"
        role="region"
        aria-label="Scene outliner (collapsed)"
        className="flex h-full w-full flex-col bg-transparent"
      >
        <button
          type="button"
          onClick={toggle}
          data-testid="left-sidebar-expand-toggle"
          title="Expand scene outliner"
          aria-label="Expand scene outliner"
          className="flex h-8 w-7 items-center justify-center self-start rounded text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="left-sidebar"
      data-collapsed="false"
      data-active-tab={activeTab}
      role="region"
      aria-label="Scene outliner"
      className="flex h-full min-h-0 w-full flex-col bg-transparent"
    >
      {/* Header — project name + collapse chevron. */}
      <header
        data-testid="left-sidebar-header"
        className="flex h-9 items-center gap-2 border-b border-border px-3"
      >
        <span className="grow truncate text-[13px] font-medium text-fg" title={projectName}>
          {projectName ?? 'Untitled'}
        </span>
        <button
          type="button"
          onClick={toggle}
          data-testid="left-sidebar-collapse-toggle"
          title="Collapse scene outliner"
          aria-label="Collapse scene outliner"
          className="flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ‹
        </button>
      </header>

      {/* Tab strip — Outliner | Assets (UX backlog #6: the asset Library is a
          tab beside the tree, not a footer link / floating popover). */}
      <div
        role="tablist"
        aria-label="Left panel tabs"
        data-testid="left-sidebar-tabstrip"
        className="flex items-stretch border-b border-border"
      >
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            id={t.id}
            label={t.label}
            active={activeTab === t.id}
            onClick={() => setActiveTab(t.id)}
          />
        ))}
      </div>

      {activeTab === 'outliner' ? (
        <div
          role="tabpanel"
          aria-label="Outliner"
          data-testid="left-sidebar-outliner-panel"
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* Search — substring filter over the tree. */}
          <div className="px-3 pb-2 pt-2.5">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search objects…"
              aria-label="Search scene objects"
              data-testid="left-sidebar-search"
              className="h-7 w-full rounded-md border border-border bg-bg px-2.5 text-[12px] text-fg placeholder:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            />
          </div>

          {/* Scenes group label. */}
          <div
            data-testid="left-sidebar-scenes-label"
            className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-fg-dim"
          >
            Scenes
          </div>

          {/* Tree — DAG projection, fills remaining height, scrolls. */}
          <div className="min-h-0 flex-1" data-testid="left-sidebar-body-scene">
            <SceneTree filter={search} />
          </div>
        </div>
      ) : (
        <div
          role="tabpanel"
          aria-label="Assets"
          data-testid="left-sidebar-assets-panel"
          className="flex min-h-0 flex-1 flex-col px-2 pt-2"
        >
          {/* Import… — re-homed from the dropped footer; same picker File ▸
              Import… uses (V34, one path). Blender's asset browser carries
              its own import affordance. */}
          <button
            type="button"
            data-testid="left-sidebar-import"
            onClick={() => openImportPicker()}
            className="mb-2 flex items-center justify-center gap-1 rounded-md border border-border bg-bg-1/40 px-2 py-1.5 text-[12px] font-medium text-fg/80 transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <span aria-hidden>＋</span>
            <span>Import…</span>
          </button>
          <AssetLibrary />
        </div>
      )}
    </aside>
  );
}
