// LeftSidebar — the Spline-style left panel: the outliner over the project's
// scene. (#1703 moved Shots to the bottom drawer; #1707 moved the asset library
// to the drawer's Library tab, so the panel is the outliner only.)
//
//   header   — project name + collapse chevron
//   Outliner — search + Scenes label + SceneTree (DAG projection)
//
// The agent surface is the right-hand chat column (#1704), not a tab here.
//
// Collapse is preserved (V35 — the reveal affordance stays reachable while
// collapsed): collapsed renders a 28px strip whose only control is the expand
// chevron. Default is EXPANDED (chromeStore.leftSidebarCollapsed defaults
// false — the outliner is always-on like Spline).
//
// V8 file-rooted: src/app/. Reads UI projection stores; no DAG mutation.
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §12 (projection); vyapti V34, V35;
// UX-BACKLOG #6; issue #1707.

import { useState, type ReactNode } from 'react';
import { useProjectStore } from '../core/project/store';
import { SceneTree } from './SceneTree';
import { useChromeStore } from './stores/chromeStore';

export function LeftSidebar(): ReactNode {
  const collapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const toggle = useChromeStore((s) => s.toggleLeftSidebar);
  const projectName = useProjectStore((s) => s.current?.name);
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

      <div
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
    </aside>
  );
}
