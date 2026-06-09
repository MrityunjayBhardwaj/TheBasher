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
import { LeftSidebar } from './LeftSidebar';
import { MenuBar } from './MenuBar';
import { NPanel } from './NPanel';
import { ProjectTabs } from './ProjectTabs';
import { RightDrawer } from './RightDrawer';
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
  // P6 W10 UIR F-4 — §8.3 R6 = "3D viewport — {selection summary}",
  // debounced 200ms. The <main> below IS the §8.3 R6 region (role=main,
  // skip-link target); its label was the static string
  // "3D viewport main content" — the screen-reader's only handle on 3D
  // state carried zero selection info. Same source as Viewport's
  // aria-live span (shared hook, never diverges).
  const viewportSummary = useSelectionSummary();
  // 4-column grid (v0.6 #4 W1 dropped the dedicated toolRail column — the
  // four tools consolidated into the ONE floating pill, Spline region ②):
  //   tree  |  viewport  |  inspector  |  drawer
  // Present collapses everything but viewport.
  //
  // Spline redesign Wave B — the scene outliner is ALWAYS-ON (default
  // expanded). When the user folds it the tree column shrinks to a 28px chevron
  // strip (expand toggle stays visible, V35); expanded returns to the full
  // 260px outliner.
  const treeWidth = isPresent ? '0' : leftSidebarCollapsed ? '28px' : '260px';
  return (
    <div
      data-testid="layout"
      data-present={isPresent ? 'true' : undefined}
      data-space={space}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        gridTemplateColumns: isPresent ? '0 1fr 0 0' : `${treeWidth} 1fr 280px 280px`,
        // v0.6 #4 W1 — the Chrome (save/breadcrumb) + TopToolbar bands were
        // consolidated (Chrome → ProjectTabs identity bar; TopToolbar → the
        // floating pill). Two top rows remain: R1 projectTabs + R2 menu. The
        // timeline row (`auto`) holds the always-visible Timebar (Auto-Key
        // indicator) + the drawer body when revealed; present collapses it.
        gridTemplateRows: isPresent ? '0 0 1fr 0' : '32px auto 1fr auto',
        gridTemplateAreas: `
          "projectTabs projectTabs projectTabs projectTabs"
          "menu menu menu menu"
          "tree viewport inspector drawer"
          "timeline timeline timeline timeline"
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

      <div
        style={{
          gridArea: 'drawer',
          display: isPresent ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <RightDrawer />
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
