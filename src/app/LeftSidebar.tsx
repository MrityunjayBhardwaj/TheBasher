// LeftSidebar — the always-on Spline-style scene OUTLINER (redesign Wave B).
//
// Replaces the W3 two-tab (Scene | Agent) wrapper. The Spline left panel is a
// single, always-on outliner, so the tab strip is gone:
//
//   header  — project name + collapse chevron
//   search  — substring filter over the tree (passed to SceneTree)
//   Scenes  — group label
//   tree    — SceneTree (DAG projection, restyled Spline rows)
//   footer  — Library · Import · Help & Feedback
//
// The agent surface did NOT live only here — AgentChat is also mounted in the
// always-present RightDrawer (grid area 'drawer'), so dropping the 'agent' tab
// keeps the agent first-class and reachable (§196). Wave C re-homes that
// cramped right column into a proper Spline-style agent surface.
//
// Footer affordances reuse EXISTING pipelines (V34, no second path):
//   - Library → opens AssetsPopover (the same bundled-asset panel the floating
//     toolbar's Assets button opens).
//   - Import  → openImportPicker (the SAME picker File ▸ Import… uses).
//   - Help & Feedback → placeholder (no help system yet; honest "coming soon").
//
// Collapse is preserved (V35 — the reveal affordance stays reachable while
// collapsed): collapsed renders a 28px strip whose only control is the expand
// chevron. Default is now EXPANDED (chromeStore.leftSidebarCollapsed defaults
// false in the Spline redesign — the outliner is always-on like Spline).
//
// V8 file-rooted: src/app/. Reads UI projection stores; no DAG mutation.
//
// REF: docs/UI-SPEC.md §5.5; THESIS.md §12 (projection); vyapti V34, V35.

import { useState, type ReactNode } from 'react';
import { useProjectStore } from '../core/project/store';
import { SceneTree } from './SceneTree';
import { useAssetsPopoverStore } from './AssetsPopover';
import { openImportPicker } from './asset/importPicker';
import { useChromeStore } from './stores/chromeStore';

function FooterButton({
  label,
  testId,
  onClick,
}: {
  label: string;
  testId: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="rounded px-2 py-1 text-left text-[12px] text-fg-dim transition-colors hover:bg-bg-1 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {label}
    </button>
  );
}

export function LeftSidebar(): ReactNode {
  const collapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const toggle = useChromeStore((s) => s.toggleLeftSidebar);
  const projectName = useProjectStore((s) => s.current?.name);
  const openAssetsAt = useAssetsPopoverStore((s) => s.openAt);
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
        className="flex h-full w-full flex-col bg-bg-2"
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
      className="flex h-full w-full flex-col border-r border-border bg-bg-2"
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

      {/* Footer — Library · Import · Help & Feedback (reuse existing paths). */}
      <footer
        data-testid="left-sidebar-footer"
        className="flex flex-col gap-0.5 border-t border-border px-2 py-2"
      >
        <FooterButton
          label="Library"
          testId="left-sidebar-library"
          onClick={(e) => {
            // Anchor the AssetsPopover just above the button's top-left — the
            // popover clamps to the viewport (it normally opens downward from
            // the toolbar; from this bottom-left footer it sits above).
            const r = e.currentTarget.getBoundingClientRect();
            openAssetsAt(r.left, r.top);
          }}
        />
        <FooterButton
          label="Import…"
          testId="left-sidebar-import"
          onClick={() => openImportPicker()}
        />
        <FooterButton
          label="Help & Feedback"
          testId="left-sidebar-help"
          onClick={() =>
            window.alert(
              'Help & feedback lands later. For now, the README and in-app menus cover the workflow.',
            )
          }
        />
      </footer>
    </aside>
  );
}
