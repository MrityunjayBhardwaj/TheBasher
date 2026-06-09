// Layout owns the CSS-grid named regions. Entering "present" NEVER changes which
// React component tree owns the viewport — V8/K1 step 6 ("Canvas mounts ONCE,
// never on a layout shift"). The grid template + region visibility shifts via
// data attributes; the Canvas DOM node stays put.
//
// Per D-UX-5 (UI-SPEC §3.2): density axis dropped. One canonical layout. The
// operational mode enum (edit/run/animate/director) was dissolved in v0.6 #4;
// the only layout collapse is now `presentMode` (chromeStore, ephemeral) — the
// fullscreen "present" / director-cut that collapses every chrome region to 0.
//
// v0.6 #4 W1 — the four top bands + two tool surfaces consolidated. Chrome
// (save/breadcrumb) folded into the ProjectTabs identity bar; TopToolbar +
// ToolRail folded into the ONE floating pill (FloatingViewportToolbar,
// mounted at the <main> level so its Space toggle works in UV mode too). The
// grid is now 4 columns (tree | viewport | inspector | drawer) × 4 rows
// (projectTabs | menu | content | timeline). All tool buttons route through
// editorStore.setActiveTool — single writer to gizmoStore.mode (V19 honored).
//
// P6 W8 C5 — Skip-link (sr-only until focused) added as first focusable
// element per D-W8-5. Target: <main id="viewport" tabIndex={-1}> wrapping
// R6's grid-area div. The link is present in ALL modes (director
// included) so the first-Tab-from-page-load → viewport invariant holds
// regardless of which chrome surfaces are visible. The viewport-slot
// div gains `id="viewport"` + `tabIndex={-1}` so it becomes the
// programmatically-focusable jump target. role="main" + aria-label
// make it announce as the page's primary landmark to screen readers.
//
// REF: THESIS.md §11, §17; krama K1; docs/UI-SPEC.md §3.1, §3.2, §3.5,
// §5.3, §5.4, §8.1 (focus order), §8.2 (keyboard-only).

import { AssetDropZone } from './AssetDropZone';
import { DiffBar } from './DiffBar';
import { AssetErrorBanner } from './AssetErrorBanner';
import { FloatingViewportToolbar } from './FloatingViewportToolbar';
import { AgentDock } from './AgentDock';
import { LeftSidebar } from './LeftSidebar';
import { MenuBar } from './MenuBar';
import { NPanel } from './NPanel';
import { ProjectTabs } from './ProjectTabs';
import { TimelineDrawer } from '../timeline/TimelineDrawer';
import { UVEditor } from './UVEditor';
import { Viewport } from '../viewport/Viewport';
import { useSelectionSummary } from './hooks/useSelectionSummary';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';

export function Layout() {
  const space = useEditorStore((s) => s.space);
  const leftSidebarCollapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const presentMode = useChromeStore((s) => s.presentMode);
  const isPresent = presentMode;
  // #173/#174 — Inspector (R7) per-panel collapse flag (modes dissolved in
  // v0.6 #4 W2, so this rides on presentMode, not the old `director` mode).
  const inspectorCollapsed = useChromeStore((s) => s.inspectorCollapsed);
  // P6 W10 UIR F-4 — §8.3 R6 = "3D viewport — {selection summary}",
  // debounced 200ms. The <main> below IS the §8.3 R6 region (role=main,
  // skip-link target); its label was the static string
  // "3D viewport main content" — the screen-reader's only handle on 3D
  // state carried zero selection info. Same source as Viewport's
  // aria-live span (shared hook, never diverges).
  const viewportSummary = useSelectionSummary();
  // 3-column grid (v0.6 #4 W1 dropped the dedicated toolRail column — the four
  // tools consolidated into the ONE floating pill, Spline region ②; Wave C
  // dropped the agent `drawer` column — the agent moved to a full-width bottom
  // dock): tree | viewport | inspector. Present collapses everything but
  // viewport.
  //
  // Spline redesign Wave B — the scene outliner is ALWAYS-ON (default
  // expanded). When the user folds it the tree column shrinks to a 28px chevron
  // strip (expand toggle stays visible, V35); expanded returns to the full
  // 260px outliner.
  const treeWidth = isPresent ? '0' : leftSidebarCollapsed ? '28px' : '260px';
  // #173/#174 — Inspector (R7) per-panel collapse. chromeStore.inspectorCollapsed
  // has existed since P6 (D-UX-5 / §3.2 promised it); #174 wired it. Collapsed →
  // 28px chevron strip (mirrors the tree column, V35); NPanel owns the chevron
  // toggle + the collapsed expand strip. Reconciled with the Spline Wave C
  // full-height inspector: the 300px column collapses to 28px. Present forces 0.
  const inspectorWidth = isPresent ? '0' : inspectorCollapsed ? '28px' : '300px';
  return (
    <div
      data-testid="layout"
      data-present={isPresent ? 'true' : undefined}
      data-space={space}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        // Spline redesign Wave C — the dedicated 280px agent `drawer` column is
        // gone: the agent moved to a full-width bottom dock (the user's locked
        // placement), freeing the right column for a FULL-height Spline
        // inspector (300px). Three columns now: tree | viewport | inspector.
        // The inspector column honors #174's collapse (`inspectorWidth` → 28px).
        gridTemplateColumns: isPresent ? '0 1fr 0' : `${treeWidth} 1fr ${inspectorWidth}`,
        // v0.6 #4 W1 — the Chrome (save/breadcrumb) + TopToolbar bands were
        // consolidated (Chrome → ProjectTabs identity bar; TopToolbar → the
        // floating pill). Two top rows remain: R1 projectTabs + R2 menu. Wave C
        // inserts the always-on `agentdock` row (190px) above the timeline; the
        // timeline row (`auto`) still holds the always-visible Timebar
        // (Auto-Key indicator) + the drawer body when revealed. Present
        // collapses every row but the viewport.
        gridTemplateRows: isPresent ? '0 0 1fr 0 0' : '32px auto 1fr 190px auto',
        gridTemplateAreas: `
          "projectTabs projectTabs projectTabs"
          "menu menu menu"
          "tree viewport inspector"
          "agentdock agentdock agentdock"
          "timeline timeline timeline"
        `,
      }}
    >
      {/* P6 W8 C5 — Skip-link (D-W8-5). First focusable element on the
          page in every mode. sr-only by default; focus-visible promotes
          it to a visible fixed-position pill. Pressing Enter navigates
          the URL hash to #viewport, and the matching `id="viewport"`
          + `tabIndex={-1}` on the <main> below receive programmatic
          focus. WCAG 2.4.1 (bypass blocks). */}
      <a
        href="#viewport"
        data-testid="skip-link"
        className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-2 focus-visible:top-2 focus-visible:z-50 focus-visible:rounded focus-visible:bg-bg-2 focus-visible:px-3 focus-visible:py-2 focus-visible:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        Skip to viewport
      </a>
      <div style={{ gridArea: 'projectTabs', display: isPresent ? 'none' : 'block' }}>
        <ProjectTabs />
      </div>
      <div style={{ gridArea: 'menu', display: isPresent ? 'none' : 'block' }}>
        <MenuBar />
      </div>

      {/* P6 W3 — LeftSidebar (R5) replaces the inline SceneTree + chevron
          pattern from W2.6. Tab strip + collapse chevron are owned by
          LeftSidebar itself (D-03); Layout's role here is just to
          allocate the grid slot. */}
      <div
        style={{
          gridArea: 'tree',
          display: isPresent ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
        }}
        data-testid="tree-slot"
        data-left-sidebar-collapsed={leftSidebarCollapsed ? 'true' : 'false'}
      >
        <LeftSidebar />
      </div>

      <main
        id="viewport"
        tabIndex={-1}
        role="main"
        aria-label={`3D viewport — ${viewportSummary}`}
        style={{ gridArea: 'viewport' }}
        className="relative overflow-hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        data-testid="viewport-slot"
        onContextMenu={(e) => {
          // RMB click (without drag) → Blender-style Add menu. RMB drag
          // still pans via OrbitControls — the browser only fires
          // contextmenu when there was no drag motion. preventDefault
          // suppresses the native menu so ours wins.
          e.preventDefault();
          useAddMenuStore.getState().openAt(e.clientX, e.clientY);
        }}
      >
        {/* Space toggle uses display:none so the Canvas DOM node stays
            mounted while the user is in the UV editor — K1 step 6 (Canvas
            mounts ONCE; never on space switch — same discipline as mode
            switch). Returning to view3d is instant; GPU state preserved. */}
        <div
          style={{
            display: space === 'view3d' ? 'block' : 'none',
            position: 'absolute',
            inset: 0,
          }}
          data-testid="view3d-slot"
        >
          <DiffBar />
          <AssetErrorBanner />
          <AssetDropZone>
            <Viewport />
          </AssetDropZone>
          {/* P6 W2.6 — viewport-overlay NPanel removed. NPanel is now
              the docked Inspector (right column); viewport-side toggles
              (grid, axis widget) move to W7's FloatingViewportToolbar. */}
        </div>
        <div
          style={{
            display: space === 'uv' ? 'block' : 'none',
            position: 'absolute',
            inset: 0,
          }}
          data-testid="uv-slot"
        >
          <UVEditor />
        </div>
        {/* v0.6 #4 W1 — the ONE consolidated toolbar (Spline region ②).
            Mounted at the <main> level (not inside the 3D slot) so its Space
            toggle stays reachable in UV mode, where view3d-slot is
            display:none. Self-gates to null in present mode. */}
        <FloatingViewportToolbar />
      </main>

      <div
        style={{
          gridArea: 'inspector',
          display: isPresent ? 'none' : 'block',
        }}
      >
        <NPanel />
      </div>

      {/* Spline redesign Wave C — the agent's always-on home is now this
          full-width bottom dock (above the timeline), not the old right column.
          Present hides it with the rest of the chrome. */}
      <div
        style={{
          gridArea: 'agentdock',
          display: isPresent ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
        data-testid="agentdock-slot"
      >
        <AgentDock />
      </div>

      {/* Timeline slot stays ALWAYS mounted/visible (collapsed only in present).
          We do NOT hide it when the drawer is closed even though the floating
          pill now carries a reveal: the always-visible Timebar row carries the
          Auto-Key record indicator (`autokey-dot`/`autokey-toggle`), which is a
          footgun mitigation DESIGNED to be unmissable + global. Collapsing the
          slot would hide that indicator and re-open the silent-data-loss footgun
          it exists to prevent — so the ~39px is load-bearing, not disposable
          chrome (Chesterton). The pill `floating-toolbar-timeline` reveals the
          drawer BODY; the always-visible Timebar + its in-row ▾ toggle stay put.
          (Reclaiming this space would first require relocating the Auto-Key
          indicator to an always-visible surface — out of W1 scope.) */}
      <div
        style={{ gridArea: 'timeline', display: isPresent ? 'none' : 'block' }}
        data-testid="timeline-slot"
      >
        <TimelineDrawer />
      </div>
    </div>
  );
}
