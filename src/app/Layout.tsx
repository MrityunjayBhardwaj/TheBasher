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
// mounted at the <main> level so its Space toggle works in UV mode too). All
// tool buttons route through editorStore.setActiveTool — single writer to
// gizmoStore.mode (V19 honored).
//
// UX-BACKLOG #2 — the outliner, inspector and playback bar are not grid bands:
// they float as absolute rounded islands over the viewport (mounted inside
// <main>; geometry from ./layoutIslands).
//
// #1704 — the agent's chat is a grid column of its own at the right, from under
// the menu bar to the window's bottom (ChatColumn). The viewport and the bottom
// drawer end at its left edge; folding it resizes <main>, never remounts the
// Canvas.
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

import type { CSSProperties } from 'react';

import { AssetDropZone } from './AssetDropZone';
import { DiffBar } from './DiffBar';
import { AssetErrorBanner } from './AssetErrorBanner';
import { FloatingViewportToolbar } from './FloatingViewportToolbar';
import { ChatColumn } from './ChatColumn';
import { LeftSidebar } from './LeftSidebar';
import { MenuBar } from './MenuBar';
import { NPanel } from './NPanel';
import { ProjectTabs } from './ProjectTabs';
import { TimelineDrawer } from '../timeline/TimelineDrawer';
import { TwoDView } from './TwoDView';
import { SpreadsheetView } from './SpreadsheetView';
import { VideoMode } from './video/VideoMode';
import { Viewport } from '../viewport/Viewport';
import { useIsNarrowLayout } from './hooks/useIsNarrowLayout';
import { useSelectionSummary } from './hooks/useSelectionSummary';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChatColumnStore } from './stores/chatColumnStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { useViewportStore } from './stores/viewportStore';
import {
  BOTTOM_BAND,
  CENTER_SURFACE_MAX_WIDTH,
  CENTER_SURFACE_TOP,
  centerSurfaceWidthCss,
  chatColumnWidth,
  INSPECTOR_WIDTH,
  ISLAND_GAP,
  OUTLINER_WIDTH,
  sideIslandWidth,
} from './layoutIslands';

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
  // dropped the agent `drawer` column; #1704 brought the chat back as a full-height
  // column at the far right): tree | viewport | inspector. Present collapses
  // everything but viewport.
  //
  // Spline redesign Wave B — the scene outliner is ALWAYS-ON (default
  // expanded). When the user folds it the tree column shrinks to a 28px chevron
  // strip (expand toggle stays visible, V35); expanded returns to the full
  // 260px outliner.
  // UX-BACKLOG #2 — the outliner + inspector are no longer grid columns; they
  // are floating islands over a full-bleed viewport (see the islands mounted
  // inside <main> below). Their width still honors the per-panel collapse
  // (V35): a collapsed panel shrinks to a chevron-only strip whose expand
  // toggle stays reachable. Present mode hides the islands entirely.
  const outlinerIslandWidth = sideIslandWidth(leftSidebarCollapsed, OUTLINER_WIDTH);
  const inspectorIslandWidth = sideIslandWidth(inspectorCollapsed, INSPECTOR_WIDTH);

  // UX-BACKLOG #2 follow-up 2 — below LAYOUT_NARROW_MAX the three columns of
  // chrome won't fit, so the side islands re-dock as OFF-CANVAS OVERLAY DRAWERS
  // (closed by default; a per-side edge tab reveals one, a scrim dismisses it)
  // and the centered surfaces (toolbar pill + bottom stack) go full-width. Above
  // the breakpoint nothing here changes — the desktop side-by-side islands
  // render byte-identically (every branch below guards on isNarrow).
  const isNarrow = useIsNarrowLayout();
  const narrowLeftDrawerOpen = useChromeStore((s) => s.narrowLeftDrawerOpen);
  const narrowRightDrawerOpen = useChromeStore((s) => s.narrowRightDrawerOpen);
  const toggleSideDrawer = useChromeStore((s) => s.toggleNarrowDrawer);
  // #1704 — one overlay at a time on a narrow window: revealing a side panel folds the chat drawer.
  const toggleNarrowDrawer = (side: 'left' | 'right') => {
    useChatColumnStore.getState().setVisible(true, false);
    toggleSideDrawer(side);
  };
  const closeNarrowDrawers = useChromeStore((s) => s.closeNarrowDrawers);

  // ONE source for a side island's box (V46) across both layout modes. Desktop:
  // top-anchored, bottom-clear column hugging its edge. Narrow: a full-height
  // overlay drawer hugging its edge, slid off past its own width when closed and
  // flush when open (the transform animates the slide).
  // #237 — the outliner/inspector/toolbar/bottom-stack are 3D-editor chrome.
  // In VIDEO space the compositor (video-slot z-45) is the whole surface; this
  // chrome must be HIDDEN, not just covered (a covered affordance still
  // intercepts clicks → the H122/H129 family). Gated by display:none (not
  // unmount) so mount-once state survives the space switch, same discipline as
  // the view3d/uv/video slots themselves.
  const chromeHidden = isPresent || space === 'video';
  // #1703 — an open drawer is a row of its own under the viewport, never an island over it.
  const drawerOpen = useViewportStore((s) => s.timelineDrawerOpen);
  // #1704 — the chat column's width: open, the rail, or nothing (narrow overlays; present hides).
  const chatOpen = useChatColumnStore((s) => s.open);
  const chatWidth = chatColumnWidth({ isNarrow, isPresent, open: chatOpen });
  const sideIslandStyle = (side: 'left' | 'right', width: number, open: boolean): CSSProperties => {
    const base: CSSProperties = {
      position: 'absolute',
      top: ISLAND_GAP,
      width,
      [side]: ISLAND_GAP,
      display: chromeHidden ? 'none' : 'flex',
      // Narrow drawers overlay the bottom stack; desktop islands sit beside it.
      zIndex: isNarrow ? 40 : 20,
    };
    if (!isNarrow) return { ...base, bottom: BOTTOM_BAND };
    const offscreen =
      side === 'left'
        ? `translateX(calc(-100% - ${ISLAND_GAP}px))`
        : `translateX(calc(100% + ${ISLAND_GAP}px))`;
    return {
      ...base,
      bottom: ISLAND_GAP,
      transform: open ? 'translateX(0)' : offscreen,
      transition: 'transform 0.2s ease',
    };
  };

  // Centered surfaces (toolbar + bottom stack): the collapse-aware reserve, from
  // the ONE geometry source (V46) — see centerSurfaceWidthCss. Capped at 960.
  const centerSurfaceWidth = centerSurfaceWidthCss({
    isNarrow,
    leftCollapsed: leftSidebarCollapsed,
    inspectorCollapsed,
    capPx: CENTER_SURFACE_MAX_WIDTH,
  });

  // The 2D View (UV + Render Result) is a BOUNDED center surface — a Blender-
  // style editor area, not a full-bleed backdrop — so its tabs and pane chrome
  // never slide under the floating toolbar or the side islands (the H91/V45
  // overlap family). It uses the SAME collapse-aware reserve as the other
  // centered surfaces (V46: one geometry source), but no 960px cap — the editor
  // fills the clear band. Starts below the toolbar (CENTER_SURFACE_TOP) and
  // stops above the bottom playback bar (BOTTOM_BAND).
  const twoDViewWidth = centerSurfaceWidthCss({
    isNarrow,
    leftCollapsed: leftSidebarCollapsed,
    inspectorCollapsed,
  });
  const twoDViewStyle: CSSProperties = {
    // 'block' (not 'flex') — TwoDView is h-full/w-full and owns its own flex
    // column; the wrapper just bounds it. Keeps the p26 display:block contract.
    display: space === 'uv' ? 'block' : 'none',
    position: 'absolute',
    top: CENTER_SURFACE_TOP,
    bottom: BOTTOM_BAND,
    left: '50%',
    transform: 'translateX(-50%)',
    width: twoDViewWidth,
    zIndex: 15,
  };
  // #1556 — the Spreadsheet takes the same bounded center surface, so the outliner stays beside
  // it to pick what it shows.
  const sheetViewStyle: CSSProperties = {
    ...twoDViewStyle,
    display: space === 'sheet' ? 'block' : 'none',
  };
  return (
    <div
      data-testid="layout"
      data-present={isPresent ? 'true' : undefined}
      data-space={space}
      className="relative grid h-full w-full bg-bg text-fg"
      style={{
        // UX-BACKLOG #2 — the tree | viewport | inspector three-column grid
        // collapsed to ONE full-bleed column. The outliner + inspector are no
        // longer reserved columns; they float as absolute islands over the
        // viewport (mounted inside <main>), so the viewport reads full-width
        // behind them (Spline ③/④ sidebars float over the canvas).
        // #1637 — `minmax(0, …)`: a bare `1fr` is `minmax(auto, 1fr)`, so the column
        // grew to its widest row's content — 38 project tabs made the editor 4,334 px in
        // a 1,512 px window and put the viewport's centre off-screen.
        // #1704 — a second column holds the chat (ChatColumn), sized here: open, the folded rail,
        // or 0 (narrow, where the chat overlays; present, where it is hidden).
        gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px`,
        // v0.6 #4 W1 — the Chrome (save/breadcrumb) + TopToolbar bands were
        // consolidated (Chrome → ProjectTabs identity bar; TopToolbar → the
        // floating pill). Two top rows remain: R1 projectTabs + R2 menu.
        // UX-BACKLOG #2 slice 2 — no agentdock / timeline rows: the closed playback bar floats as a
        // bottom-center island over the viewport (mounted inside <main>). Present collapses every
        // row but the viewport.
        // #1703 — a fourth row holds the open bottom drawer below the viewport: the viewport ends
        // where the drawer begins, so the drawer never covers the picture. #1704 — it spans the
        // first column only, ending at the chat column.
        gridTemplateRows: isPresent ? '0 0 1fr 0' : '32px auto 1fr auto',
        // #1704 — the chat spans the viewport and drawer rows, so it runs from under the menu bar to
        // the window's bottom and the drawer ends at its left edge.
        gridTemplateAreas: `
          "projectTabs projectTabs"
          "menu menu"
          "viewport chat"
          "drawer chat"
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
          style={twoDViewStyle}
          data-testid="uv-slot"
          className="overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
          onContextMenu={(e) => e.stopPropagation()}
        >
          <TwoDView />
        </div>
        <div
          style={sheetViewStyle}
          data-testid="sheet-slot"
          className="overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
          onContextMenu={(e) => e.stopPropagation()}
        >
          {space === 'sheet' && <SpreadsheetView />}
        </div>
        {/* Video mode (the third editor space) — the AE-style compositor. Like
            the 2D View it swaps in via display:none (Canvas stays mounted, K1
            step 6). It is full-bleed over <main> and sits ABOVE the 3D/2D
            floating chrome (toolbar + side islands + bottom stack) via a high
            z-index, so the compositor reads as its own surface. Properly HIDING
            that 3D-specific chrome in video mode is a follow-up (#237) — for now
            it is covered, not unmounted. */}
        <div
          style={{
            display: space === 'video' ? 'block' : 'none',
            position: 'absolute',
            inset: 0,
            zIndex: 45,
          }}
          data-testid="video-slot"
          className="bg-bg"
          onContextMenu={(e) => e.stopPropagation()}
        >
          <VideoMode />
        </div>
        {/* v0.6 #4 W1 — the ONE consolidated toolbar (Spline region ②).
            Mounted at the <main> level (not inside the 3D slot) so its Space
            toggle stays reachable in UV mode, where view3d-slot is
            display:none. Self-gates to null in present mode. #237 — wrapped in a
            display:none gate so it HIDES (not just covers) in VIDEO space, where
            the compositor owns the surface and carries its own transport. The
            wrapper is a zero-box static block (the pill is absolute, anchored to
            <main>), so showing/hiding never shifts the toolbar's geometry. */}
        <div style={{ display: chromeHidden ? 'none' : 'block' }}>
          <FloatingViewportToolbar />
        </div>

        {/* UX-BACKLOG #2 — the outliner (left) + inspector (right) float as
            absolute islands OVER the full-bleed viewport (Spline ③/④). They are
            TOP-anchored and stop short of the bottom (BOTTOM_BAND) so the
            bottom-right orbit gizmo + Persp/Ortho pill and the bottom-center
            playback bar stay clear — no viewport widget
            has to dodge them (the H91/V45 floating-overlap trap). The wrappers carry the
            FloatingViewportToolbar surface tokens (rounded-2xl border bg-bg-2/95
            shadow-xl backdrop-blur-md — V39 over-stage chrome, contrast-matrix
            covered); the inner panels render transparent so the wrapper surface
            shows through. onContextMenu stops here so a right-click on a panel
            does NOT bubble to <main> and pop the viewport Add menu. In present
            mode they stay MOUNTED but display:none (mount-once discipline — the
            panels keep their state; display:none also removes them from the tab
            order, the D-W8-8 accessibility contract). */}
        <div
          data-testid="tree-slot"
          data-left-sidebar-collapsed={leftSidebarCollapsed ? 'true' : 'false'}
          data-narrow-drawer={isNarrow ? 'true' : 'false'}
          onContextMenu={(e) => e.stopPropagation()}
          style={sideIslandStyle('left', outlinerIslandWidth, narrowLeftDrawerOpen)}
          className="flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          <LeftSidebar />
        </div>
        <div
          data-testid="inspector-slot"
          data-narrow-drawer={isNarrow ? 'true' : 'false'}
          onContextMenu={(e) => e.stopPropagation()}
          style={sideIslandStyle('right', inspectorIslandWidth, narrowRightDrawerOpen)}
          className="flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          <NPanel />
        </div>

        {/* UX-BACKLOG #2 follow-up 2 — narrow-layout drawer affordances. Only
            mounted below the breakpoint (so the desktop DOM is unchanged). A
            scrim dims + dismisses an open drawer; per-side edge tabs reveal a
            closed drawer. The tabs sit ABOVE the scrim (z-40) so the still-closed
            side stays tappable while the other drawer is open. */}
        {isNarrow && !chromeHidden ? (
          <>
            {narrowLeftDrawerOpen || narrowRightDrawerOpen ? (
              <div
                data-testid="narrow-drawer-scrim"
                onClick={closeNarrowDrawers}
                className="absolute inset-0 z-30 bg-black/40"
              />
            ) : null}
            {!narrowLeftDrawerOpen ? (
              <button
                type="button"
                data-testid="left-drawer-tab"
                aria-label="Open outliner"
                onClick={() => toggleNarrowDrawer('left')}
                className="absolute left-0 top-1/2 z-40 flex h-14 -translate-y-1/2 items-center rounded-r-lg border border-l-0 border-border bg-bg-2/95 px-1 text-fg-dim shadow-xl shadow-black/40 backdrop-blur-md hover:text-fg"
              >
                <span aria-hidden>›</span>
              </button>
            ) : null}
            {!narrowRightDrawerOpen ? (
              <button
                type="button"
                data-testid="right-drawer-tab"
                aria-label="Open inspector"
                onClick={() => toggleNarrowDrawer('right')}
                className="absolute right-0 top-1/2 z-40 flex h-14 -translate-y-1/2 items-center rounded-l-lg border border-r-0 border-border bg-bg-2/95 px-1 text-fg-dim shadow-xl shadow-black/40 backdrop-blur-md hover:text-fg"
              >
                <span aria-hidden>‹</span>
              </button>
            ) : null}
          </>
        ) : null}

        {/* UX-BACKLOG #2 slice 2 — the bottom-centre island. #1704 — it holds only playback now:
            the chat left for its own column (ChatColumn, the `chat` grid area). Bottom-anchored and
            width-capped by the same collapse-aware reserve as the toolbar (centerSurfaceWidthCss),
            so it stays in the clear band between the side islands, with the bottom-right orbit
            gizmo + Persp/Ortho pill to its right. onContextMenu stops here (it overlaps <main>). */}
        <div
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: ISLAND_GAP,
            left: '50%',
            transform: 'translateX(-50%)',
            width: centerSurfaceWidth,
            // #237 — hidden in VIDEO too (the 3D TimelineDrawer z-20 was COVERED
            // by video-slot z-45, so a click on the covered drawer was
            // intercepted — H122/H129). The compositor has its own LayerTimeline.
            display: chromeHidden ? 'none' : 'flex',
          }}
          className="z-20 flex flex-col gap-2"
        >
          {/* The Timebar carries the always-on Auto-Key record indicator
                  (footgun mitigation — must stay visible); only the drawer BODY
                  is revealable. Mounted always (collapsed only in present, which
                  hides the whole stack). */}
          {/* #1703 — closed, the playback bar floats here; open, the drawer moves to its own
              full-width row below <main> (the `drawer` grid area). */}
          {!drawerOpen ? (
            <div
              data-testid="timeline-slot"
              data-docked="false"
              className="overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
            >
              <TimelineDrawer />
            </div>
          ) : null}
        </div>
      </main>
      {drawerOpen ? (
        <div
          data-testid="timeline-slot"
          data-docked="true"
          onContextMenu={(e) => e.stopPropagation()}
          style={{ gridArea: 'drawer', display: chromeHidden ? 'none' : 'block' }}
          className="min-w-0 border-t border-border bg-bg-2"
        >
          <TimelineDrawer />
        </div>
      ) : null}
      {/* #1704 — the chat column: every space (3D, 2D, Video), hidden only in present mode. */}
      <ChatColumn isNarrow={isNarrow} hidden={isPresent} />
    </div>
  );
}
