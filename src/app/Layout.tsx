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
// UX-BACKLOG #2 — the grid is now a SINGLE full-bleed column × 3 rows
// (projectTabs | menu | viewport). The outliner, inspector, agent chat, and
// timeline are no longer grid bands: they float as absolute rounded islands
// over the viewport (mounted inside <main>; geometry from ./layoutIslands).
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
import {
  BOTTOM_BAND,
  CENTER_SIDE_RESERVED,
  COLLAPSED_STRIP,
  INSPECTOR_WIDTH,
  ISLAND_GAP,
  OUTLINER_WIDTH,
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
  // dropped the agent `drawer` column — the agent moved to a full-width bottom
  // dock): tree | viewport | inspector. Present collapses everything but
  // viewport.
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
  const outlinerIslandWidth = leftSidebarCollapsed ? COLLAPSED_STRIP : OUTLINER_WIDTH;
  const inspectorIslandWidth = inspectorCollapsed ? COLLAPSED_STRIP : INSPECTOR_WIDTH;
  return (
    <div
      data-testid="layout"
      data-present={isPresent ? 'true' : undefined}
      data-space={space}
      className="grid h-full w-full bg-bg text-fg"
      style={{
        // UX-BACKLOG #2 — the tree | viewport | inspector three-column grid
        // collapsed to ONE full-bleed column. The outliner + inspector are no
        // longer reserved columns; they float as absolute islands over the
        // viewport (mounted inside <main>), so the viewport reads full-width
        // behind them (Spline ③/④ sidebars float over the canvas).
        gridTemplateColumns: '1fr',
        // v0.6 #4 W1 — the Chrome (save/breadcrumb) + TopToolbar bands were
        // consolidated (Chrome → ProjectTabs identity bar; TopToolbar → the
        // floating pill). Two top rows remain: R1 projectTabs + R2 menu.
        // UX-BACKLOG #2 slice 2 — the agentdock + timeline rows are GONE: the
        // agent chat + timeline now float as a stacked bottom-center island over
        // the full-bleed viewport (mounted inside <main>), so the viewport reads
        // full-bleed top→bottom. Present collapses every row but the viewport.
        gridTemplateRows: isPresent ? '0 0 1fr' : '32px auto 1fr',
        gridTemplateAreas: `
          "projectTabs"
          "menu"
          "viewport"
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

        {/* UX-BACKLOG #2 — the outliner (left) + inspector (right) float as
            absolute islands OVER the full-bleed viewport (Spline ③/④). They are
            TOP-anchored and stop short of the bottom (BOTTOM_BAND) so the
            bottom-right orbit gizmo + Persp/Ortho pill and the bottom-center
            agent/timeline stack stay clear — no viewport widget has to dodge
            them (the H91/V45 floating-overlap trap). The wrappers carry the
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
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: ISLAND_GAP,
            top: ISLAND_GAP,
            bottom: BOTTOM_BAND,
            width: outlinerIslandWidth,
            display: isPresent ? 'none' : 'flex',
          }}
          className="z-20 flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          <LeftSidebar />
        </div>
        <div
          data-testid="inspector-slot"
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: ISLAND_GAP,
            top: ISLAND_GAP,
            bottom: BOTTOM_BAND,
            width: inspectorIslandWidth,
            display: isPresent ? 'none' : 'flex',
          }}
          className="z-20 flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
        >
          <NPanel />
        </div>

        {/* UX-BACKLOG #2 slice 2 — the agent chat + timeline float as a
                STACKED bottom-center island group (the user's chosen layout):
                agent chat on top, timeline (always-visible Timebar + revealable
                drawer body that expands upward) below it. Bottom-anchored, so
                the stack grows UP (agent conversation / opened drawer) without
                touching the side islands. Width-capped (CENTER_SIDE_RESERVED, as
                the toolbar) and centered, so it stays in the clear center band —
                the bottom-right orbit gizmo + Persp/Ortho pill sit to its right,
                untouched. Each surface is its own rounded island (same tokens as
                the side panels); the inner components render their own bg.
                onContextMenu stops here too (it overlaps <main>). */}
        <div
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: ISLAND_GAP,
            left: '50%',
            transform: 'translateX(-50%)',
            width: `min(960px, calc(100% - ${CENTER_SIDE_RESERVED}px))`,
            display: isPresent ? 'none' : 'flex',
          }}
          className="z-20 flex flex-col gap-2"
        >
          <div
            data-testid="agentdock-slot"
            className="overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
          >
            <AgentDock />
          </div>
          {/* The Timebar carries the always-on Auto-Key record indicator
                  (footgun mitigation — must stay visible); only the drawer BODY
                  is revealable. Mounted always (collapsed only in present, which
                  hides the whole stack). */}
          <div
            data-testid="timeline-slot"
            className="overflow-hidden rounded-2xl border border-border bg-bg-2/95 shadow-xl shadow-black/40 backdrop-blur-md"
          >
            <TimelineDrawer />
          </div>
        </div>
      </main>
    </div>
  );
}
