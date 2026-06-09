// Layout owns the CSS-grid named regions. Mode toggling NEVER changes which
// React component tree owns the viewport — V8/K1 step 6 ("Canvas mounts ONCE,
// never on mode switch"). The grid template + region visibility shifts via
// data attributes; the Canvas DOM node stays put.
//
// Per D-UX-5 (UI-SPEC §3.2): density axis dropped. One canonical layout. The
// only mode-induced grid change is Director (D-UX-9) — chrome regions collapse
// to 0 width.
//
// P6 W2 — TopToolbar replaces TransformToolbar's old slot. New `toolRail`
// column added to the grid template: 32px expanded, 0 collapsed
// (chromeStore), 0 in director. This is the first chromeStore consumer.
//
// P6 W7 — TransformToolbar deleted; its gizmo + shading + snap controls
// migrated to FloatingViewportToolbar (R8, viewport overlay). SpaceGroup
// inlined directly into TopToolbar.tsx so the workspace toggle (3D ↔ UV)
// remains a top-bar affordance. R8's tool buttons all route through
// editorStore.setActiveTool — the only writer to gizmoStore.mode outside
// editorStore's propagation is now gone (V19 honored).
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
import { Chrome } from './Chrome';
import { DiffBar } from './DiffBar';
import { AssetErrorBanner } from './AssetErrorBanner';
import { LeftSidebar } from './LeftSidebar';
import { MenuBar } from './MenuBar';
import { NPanel } from './NPanel';
import { ProjectTabs } from './ProjectTabs';
import { RightDrawer } from './RightDrawer';
import { TimelineDrawer } from '../timeline/TimelineDrawer';
import { TopToolbar } from './TopToolbar';
import { ToolRail } from './ToolRail';
import { UVEditor } from './UVEditor';
import { Viewport } from '../viewport/Viewport';
import { useSelectionSummary } from './hooks/useSelectionSummary';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { useModeStore } from './stores/modeStore';

export function Layout() {
  const mode = useModeStore((s) => s.mode);
  const space = useEditorStore((s) => s.space);
  const toolRailCollapsed = useChromeStore((s) => s.toolRailCollapsed);
  const leftSidebarCollapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const inspectorCollapsed = useChromeStore((s) => s.inspectorCollapsed);
  const isDirector = mode === 'director';
  // P6 W10 UIR F-4 — §8.3 R6 = "3D viewport — {selection summary}",
  // debounced 200ms. The <main> below IS the §8.3 R6 region (role=main,
  // skip-link target); its label was the static string
  // "3D viewport main content" — the screen-reader's only handle on 3D
  // state carried zero selection info. Same source as Viewport's
  // aria-live span (shared hook, never diverges).
  const viewportSummary = useSelectionSummary();
  // 5-column grid (P6 W2.5 dropped the dedicated library column; bundled
  // glTF samples are now reachable from TopToolbar's Assets popover):
  //   tree  |  toolRail  |  viewport  |  inspector  |  drawer
  // Director collapses everything but viewport.
  const toolRailWidth = isDirector ? '0' : toolRailCollapsed ? '0' : '32px';
  // P6 W2.6 — SceneTree default-collapsed. When collapsed the tree column
  // shrinks to a 28px chevron strip (toggle stays visible); expanded
  // returns to the full 260px tree.
  const treeWidth = isDirector ? '0' : leftSidebarCollapsed ? '28px' : '260px';
  // #173 — Inspector (R7) per-panel collapse. chromeStore.inspectorCollapsed
  // has existed since P6 (D-UX-5 / §3.2 promised it) but was wired to nothing;
  // this is the consumer. Collapsed → 28px chevron strip (mirrors the tree
  // column); NPanel owns the chevron toggle + the collapsed expand strip.
  // Director still forces 0 (chrome hidden regardless of the flag).
  const inspectorWidth = isDirector ? '0' : inspectorCollapsed ? '28px' : '280px';
  // P6 W10 UIR F-3 — §5.4 literally: the rail "collapses to 0". The grid
  // column goes to genuine 0 width when collapsed (was 32px — the spec
  // promise was unmet). The re-expand affordance does NOT live inside the
  // 0-width column (that would orphan it); ToolRail renders it as an
  // absolutely-positioned edge tab that escapes the collapsed column via
  // the slot's `overflow: visible`.
  return (
    <div
      data-testid="layout"
      data-mode={mode}
      data-space={space}
      data-tool-rail-collapsed={toolRailCollapsed ? 'true' : 'false'}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        gridTemplateColumns: isDirector
          ? '0 0 1fr 0 0'
          : `${treeWidth} ${toolRailWidth} 1fr ${inspectorWidth} 280px`,
        // P6 W3 — projectTabs row added at the top (R1 per §5.1). Director
        // mode collapses it to 0 alongside the other chrome rows.
        gridTemplateRows: isDirector ? '0 0 0 0 1fr 0' : '32px auto auto auto 1fr auto',
        gridTemplateAreas: `
          "projectTabs projectTabs projectTabs projectTabs projectTabs"
          "menu menu menu menu menu"
          "chrome chrome chrome chrome chrome"
          "toolbar toolbar toolbar toolbar toolbar"
          "tree toolRail viewport inspector drawer"
          "timeline timeline timeline timeline timeline"
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
      <div style={{ gridArea: 'projectTabs', display: isDirector ? 'none' : 'block' }}>
        <ProjectTabs />
      </div>
      <div style={{ gridArea: 'menu', display: isDirector ? 'none' : 'block' }}>
        <MenuBar />
      </div>
      <div style={{ gridArea: 'chrome', display: isDirector ? 'none' : 'block' }}>
        <Chrome />
      </div>
      <div style={{ gridArea: 'toolbar', display: isDirector ? 'none' : 'block' }}>
        <TopToolbar />
      </div>

      <div
        style={{
          gridArea: 'toolRail',
          display: isDirector ? 'none' : 'block',
          minHeight: 0,
          // F-3: collapsed rail is a 0-width column; the re-expand edge
          // tab must escape it, so the slot must not clip overflow.
          overflow: 'visible',
          position: 'relative',
        }}
      >
        <ToolRail />
      </div>

      {/* P6 W3 — LeftSidebar (R5) replaces the inline SceneTree + chevron
          pattern from W2.6. Tab strip + collapse chevron are owned by
          LeftSidebar itself (D-03); Layout's role here is just to
          allocate the grid slot. */}
      <div
        style={{
          gridArea: 'tree',
          display: isDirector ? 'none' : 'flex',
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
      </main>

      <div
        style={{
          gridArea: 'inspector',
          display: isDirector ? 'none' : 'block',
        }}
      >
        <NPanel />
      </div>

      <div
        style={{
          gridArea: 'drawer',
          display: isDirector ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <RightDrawer />
      </div>

      {/* Timeline is mode-gated (D-UX-1) — visible only in Animate. The
          subtree stays mounted (V11 Canvas-mounts-once analog: store
          subscriptions and DOM stay; CSS hides). */}
      <div
        style={{ gridArea: 'timeline', display: mode === 'animate' ? 'block' : 'none' }}
        data-testid="timeline-slot"
      >
        <TimelineDrawer />
      </div>
    </div>
  );
}
