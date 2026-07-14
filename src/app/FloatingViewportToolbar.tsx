// FloatingViewportToolbar — the ONE consolidated editor toolbar (Spline
// region ②). v0.6 #4 W1 collapsed the four top bands + the duplicate
// ToolRail into this single floating pill, so every authoring affordance
// lives in one gaze-proximity surface over the viewport.
//
// Anatomy (left → right):
//
//   [↖][✥][⟲][⤢] │ [+ Add][📦 Assets] │ [3D|UV] │ [▶] │ [⌂][⊞] │
//   tools           create               space      play   view
//     [studio][wire][rendered] │ [snap][step] │ [☰] │ [100%▾][⬇ Export][⛚ Present]
//     shading                    snap            timeline  status / export / present
//
// Dispatch (single owner per control — no duplication, H27):
//   tools     → editorStore.setActiveTool (translate/rotate/scale propagate
//               to gizmoStore.mode per editorStore:55-58; V19 single writer).
//   Add       → addMenuStore.openAt (Blender-style Add menu; clamps to viewport).
//   Assets    → assetsPopoverStore (sample-asset / My-Imports popover).
//   space     → editorStore.setSpace (3D View ↔ UV Editor).
//   play      → timeStore.toggle (transport; the re-home for `run` mode, D-06).
//   home      → frameSelected() with frameAll() fallback.
//   grid      → viewportStore.toggleGridVisible.
//   shade     → viewportStore.setShading.
//   snap      → viewportStore.toggleSnapEnabled + setSnapStep.
//   timeline  → viewportStore.toggleTimelineDrawer (a toolbar-level reveal for
//               the `animate` drawer BODY; the always-visible Timebar row with
//               its in-row ▾ toggle stays put — it carries the Auto-Key
//               indicator and must remain visible).
//   export    → exportDagJson (shared with File → Export — single source).
//   present   → chromeStore.togglePresentMode (the re-home for `director`;
//               Esc returns via the KeyboardShortcuts Esc ladder).
//
// Present-mode hide: when chromeStore.presentMode is on, returns null. The
// pill is mounted at the Viewport <main> level (Layout.tsx) so it overlays
// BOTH the 3D and UV slots — the Space toggle must stay reachable in UV
// mode (where the view3d slot is display:none).
//
// File-rooted V8: src/app/. Reads + mutates UI projection stores only
// (editorStore, viewportStore, chromeStore, timeStore, selectionStore via
// framing, addMenuStore, assetsPopoverStore). Never the DAG.
//
// REF: docs/UI-SPEC.md §5.7, §5.3; .planning/phases/v06.4-director-ux/PLAN.md
// (W1-T3 — the single-pill inventory); memory/project_p6_w7_plan.md C1.

import { useState, type ReactNode } from 'react';
import { frameAll, frameSelected } from './character/framing';
import { exportDagJson } from './exportDag';
import { renderToViewWithFeedback } from './renderImageAction';
import { useAddMenuStore } from './stores/addMenuStore';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore, type ActiveTool, type SpaceType } from './stores/editorStore';
import { useGizmoStore } from './stores/gizmoStore';
import { centerSurfaceWidthCss } from './layoutIslands';
import { useIsNarrowLayout } from './hooks/useIsNarrowLayout';
import { useLeftSidebarStore } from './stores/leftSidebarStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTimeStore } from './stores/timeStore';
import { useViewportStore, type ShadingMode } from './stores/viewportStore';

interface ToolDef {
  readonly id: ActiveTool;
  readonly icon: string;
  readonly label: string;
  readonly shortcut: string;
  readonly testId: string;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'select', icon: '↖', label: 'Select', shortcut: 'Q', testId: 'floating-toolbar-sel' },
  { id: 'translate', icon: '✥', label: 'Move', shortcut: 'W', testId: 'floating-toolbar-move' },
  { id: 'rotate', icon: '⟲', label: 'Rotate', shortcut: 'E', testId: 'floating-toolbar-rot' },
  { id: 'scale', icon: '⤢', label: 'Scale', shortcut: 'R', testId: 'floating-toolbar-scl' },
];

interface ShadingDef {
  readonly value: ShadingMode;
  readonly label: string;
  readonly testId: string;
}

export const SHADING: readonly ShadingDef[] = [
  { value: 'studio', label: 'studio', testId: 'floating-toolbar-shading-studio' },
  { value: 'wireframe', label: 'wire', testId: 'floating-toolbar-shading-wireframe' },
  { value: 'rendered', label: 'rendered', testId: 'floating-toolbar-shading-rendered' },
];

interface SpaceEntry {
  readonly value: SpaceType;
  readonly label: string;
  readonly key: string;
}

const SPACES: readonly SpaceEntry[] = [
  { value: 'view3d', label: '3D View', key: 'Tab' },
  { value: 'uv', label: '2D View', key: 'Tab' },
];

/** Click handler for the Home (⌂) button. frameSelected early-returns
 *  when no node is selected — fall back to frameAll() in that case so
 *  the affordance always does something useful.
 *
 *  Exported for unit testing (the React shell is covered by Playwright;
 *  this helper carries the routing logic that needs deterministic test
 *  coverage). */
export function homeFrame(): void {
  const primary = useSelectionStore.getState().primaryNodeId;
  if (primary) {
    frameSelected();
  } else {
    frameAll();
  }
}

function ToolButton({
  active,
  title,
  ariaLabel,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  ariaLabel: string;
  testId: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}): ReactNode {
  const base =
    'flex h-7 w-7 items-center justify-center rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  const state = active ? 'bg-bg-1 text-accent' : 'text-fg-dim hover:bg-bg-1 hover:text-fg';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      title={title}
      aria-label={ariaLabel}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  title,
  ariaLabel,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  const base =
    'rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';
  // Active fill is OPAQUE `bg-bg-1` (matching the tool buttons), not an
  // `accent/15` wash — this surface sits OVER the GL canvas, and a translucent
  // tint lets a bright scene bleed through, crushing accent-text contrast below
  // AA over a white/studio scene (#57 over-canvas re-grounding). Opaque = no
  // bleed = AA holds on any backdrop.
  const state = active ? 'bg-bg-1 text-accent' : 'text-fg-dim hover:bg-bg-1 hover:text-fg';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      title={title}
      aria-label={ariaLabel}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}

function Divider(): ReactNode {
  return <div aria-hidden className="mx-1 h-5 w-px bg-border/60" />;
}

// Bordered text chip used by the moved-in chrome controls (Add / Assets /
// Export / Present). Keeps the R3 TopToolbar button styling verbatim so the
// a11y contrast matrix rows stay valid after the consolidation (W1-T3).
function BarButton({
  testId,
  title,
  onClick,
  active,
  ariaLabel,
  disabled,
  children,
}: {
  testId: string;
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  const state = active
    ? 'border-accent bg-accent/15 text-accent'
    : 'border-border bg-muted/40 text-fg/80 hover:border-accent hover:text-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
      aria-label={ariaLabel}
      aria-busy={disabled || undefined}
      className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 ${state}`}
    >
      {children}
    </button>
  );
}

/** Anchor for a menu/popover spawned by a toolbar button: just below the
 *  WHOLE toolbar pill (not the button), left-aligned to the clicked button.
 *
 *  The pill lives at `top-4` (top of the viewport) since v0.6 #4 W1; anchoring
 *  to the button's TOP made the menu render over the toolbar row (UX backlog
 *  #5). Anchoring to the toolbar element's bottom edge opens every toolbar
 *  menu cleanly downward, clear of the pill, regardless of the button's own
 *  padding — and keeps Add + Assets consistent. */
function toolbarMenuAnchor(e: React.MouseEvent<HTMLButtonElement>): { x: number; y: number } {
  const btn = e.currentTarget.getBoundingClientRect();
  const toolbar = e.currentTarget.closest('[role="toolbar"]')?.getBoundingClientRect();
  return { x: btn.left, y: (toolbar?.bottom ?? btn.bottom) + 6 };
}

function openAddMenuFrom(e: React.MouseEvent<HTMLButtonElement>): void {
  const { x, y } = toolbarMenuAnchor(e);
  useAddMenuStore.getState().openAt(x, y);
}

export function FloatingViewportToolbar(): ReactNode {
  // #170: render the production frame to a PNG with surfaced feedback. Local
  // `rendering` flag drives a brief "Rendering…" affordance + disables the
  // button so a large-resolution render can't be re-fired mid-flight (the
  // success/failure toast comes from renderImageWithFeedback). Set BEFORE the
  // await so React paints "Rendering…" before the blocking gl.render.
  const [rendering, setRendering] = useState(false);
  const handleRenderImage = async () => {
    if (rendering) return;
    setRendering(true);
    try {
      await renderToViewWithFeedback();
    } finally {
      setRendering(false);
    }
  };
  const presentMode = useChromeStore((s) => s.presentMode);
  const togglePresentMode = useChromeStore((s) => s.togglePresentMode);
  const playing = useTimeStore((s) => s.playing);
  const togglePlay = useTimeStore((s) => s.toggle);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const space = useEditorStore((s) => s.space);
  const setSpace = useEditorStore((s) => s.setSpace);
  const shading = useViewportStore((s) => s.shading);
  const setShading = useViewportStore((s) => s.setShading);
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const toggleGridVisible = useViewportStore((s) => s.toggleGridVisible);
  const snapEnabled = useViewportStore((s) => s.snapEnabled);
  const snapStep = useViewportStore((s) => s.snapStep);
  const toggleSnapEnabled = useViewportStore((s) => s.toggleSnapEnabled);
  const setSnapStep = useViewportStore((s) => s.setSnapStep);
  const snapAffect = useViewportStore((s) => s.snapAffect);
  const toggleSnapAffect = useViewportStore((s) => s.toggleSnapAffect);
  const gizmoOrientation = useGizmoStore((s) => s.orientation);
  const toggleGizmoOrientation = useGizmoStore((s) => s.toggleOrientation);
  const pivot = useViewportStore((s) => s.pivot);
  const setPivot = useViewportStore((s) => s.setPivot);
  const cameraZoom = useViewportStore((s) => s.cameraZoom);
  const timelineDrawerOpen = useViewportStore((s) => s.timelineDrawerOpen);
  const toggleTimelineDrawer = useViewportStore((s) => s.toggleTimelineDrawer);
  const lookThrough = useViewportStore((s) => s.lookThroughCamera);
  const toggleLookThroughCamera = useViewportStore((s) => s.toggleLookThroughCamera);

  // The asset Library lives in the LeftSidebar's "Assets" tab (UX backlog #6,
  // one home — V34). The toolbar button selects that tab and expands the
  // sidebar if it was collapsed.
  const leftTab = useLeftSidebarStore((s) => s.activeTab);
  const setLeftTab = useLeftSidebarStore((s) => s.setActiveTab);
  const leftCollapsed = useChromeStore((s) => s.leftSidebarCollapsed);
  const inspectorCollapsed = useChromeStore((s) => s.inspectorCollapsed);
  const setLeftCollapsed = useChromeStore((s) => s.setLeftSidebarCollapsed);
  // UX #2 follow-up 2 — narrow layout: the side panels are off-canvas drawers,
  // so the pill can span the full width (minus edge gaps) instead of reserving
  // for the islands.
  const isNarrow = useIsNarrowLayout();
  const assetsActive = leftTab === 'assets' && !leftCollapsed;

  // Present-mode chrome-hide: the pill vanishes when presentMode is on.
  // Self-gated rather than Layout.tsx-gated because the pill is a viewport
  // overlay, not a grid slot — returning null is the simplest path. Esc
  // (KeyboardShortcuts ladder) is the way back out, since the Present
  // toggle itself is hidden along with the pill.
  if (presentMode) return null;

  return (
    <div
      data-testid="floating-viewport-toolbar"
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={`Viewport toolbar — ${activeTool ?? 'no tool'} active`}
      // UX-BACKLOG #2 — the viewport is now full-bleed and the outliner/inspector
      // float as side islands over it. A toolbar centered on the viewport
      // midpoint would slide UNDER those islands at narrow widths (its right end
      // disappeared behind the inspector — observed at 1100px). Cap its width so
      // it stays in the clear center band between the islands; it still scrolls
      // horizontally (overflow-x-auto) when the controls exceed that band. The
      // reserve tracks the LIVE collapse flags (UX #2 follow-up 1) — folding a
      // side panel to its 28px strip lets the pill reclaim that width instead of
      // staying pinned to the expanded footprint.
      style={{
        maxWidth: centerSurfaceWidthCss({ isNarrow, leftCollapsed, inspectorCollapsed }),
      }}
      className="no-scrollbar absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-2/95 px-2 py-1 text-fg shadow-xl shadow-black/40 backdrop-blur-md [&>*]:shrink-0"
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.id}
          active={activeTool === t.id}
          title={`${t.label} (${t.shortcut})`}
          ariaLabel={`${t.label} tool`}
          testId={t.testId}
          onClick={() => setActiveTool(t.id)}
        >
          {t.icon}
        </ToolButton>
      ))}
      <Divider />
      {/* Create — Add menu + sample-assets popover (folded from R3/R4 in W1). */}
      <BarButton
        testId="top-toolbar-add"
        title="Add primitive (A or Shift+A)"
        ariaLabel="Add node menu"
        onClick={openAddMenuFrom}
      >
        <span aria-hidden>+</span>
        <span>Add</span>
      </BarButton>
      <BarButton
        testId="top-toolbar-assets"
        title="Asset library (left panel)"
        active={assetsActive}
        onClick={() => {
          // Reveal the asset Library: expand the sidebar (if folded) and switch
          // to its Assets tab. One library home (#6) — no floating popover.
          setLeftCollapsed(false);
          setLeftTab('assets');
        }}
      >
        <span aria-hidden>📦</span>
        <span>Assets</span>
      </BarButton>
      <Divider />
      {/* Space toggle 3D View ↔ UV Editor (folded from R3 SpaceGroup). */}
      <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
        {SPACES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setSpace(s.value)}
            data-testid={`toolbar-space-${s.value}`}
            title={`${s.label} (${s.key} to toggle)`}
            className={`rounded px-2 py-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              space === s.value ? 'bg-accent/15 text-accent' : 'text-fg/60 hover:text-fg'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <Divider />
      {/* Play ▶ transport (v0.6 #4 — the re-home for the deleted `run` mode;
          D-06: run became playback). Toggles useTimeStore.playing — the same
          transport Space drives. Ephemeral, no DAG state (V34-clean). */}
      <ToolButton
        active={playing}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        ariaLabel={playing ? 'Pause playback' : 'Play timeline'}
        testId="floating-toolbar-play"
        onClick={togglePlay}
      >
        {playing ? '⏸' : '▶'}
      </ToolButton>
      <Divider />
      <ToolButton
        active={false}
        title="Frame selection (F)"
        ariaLabel="Reset view"
        testId="floating-toolbar-home"
        onClick={homeFrame}
      >
        ⌂
      </ToolButton>
      <ToolButton
        active={gridVisible}
        title={gridVisible ? 'Hide grid' : 'Show grid'}
        ariaLabel={gridVisible ? 'Hide grid' : 'Show grid'}
        testId="floating-toolbar-grid"
        onClick={toggleGridVisible}
      >
        ⊞
      </ToolButton>
      <Divider />
      {SHADING.map((s) => (
        <Chip
          key={s.value}
          active={shading === s.value}
          title={`Shading: ${s.label}`}
          ariaLabel={`${s.label} shading`}
          testId={s.testId}
          onClick={() => setShading(s.value)}
        >
          {s.label}
        </Chip>
      ))}
      <Divider />
      {/* #165: look through the active scene camera (Blender Numpad 0). */}
      <Chip
        active={lookThrough}
        title="Look through active camera (0)"
        ariaLabel={lookThrough ? 'Exit camera view' : 'Look through active camera'}
        testId="floating-toolbar-look-through"
        onClick={toggleLookThroughCamera}
      >
        cam
      </Chip>
      <Divider />
      {/* #228 — transform pivot point (Blender pivot_point/index.rst). Drives the
          MULTI-object gizmo: median / bounding-box / individual / active. (3D
          cursor reserved — Basher has no cursor yet.) */}
      <select
        value={pivot === 'cursor' ? 'median' : pivot}
        onChange={(e) => setPivot(e.target.value as typeof pivot)}
        data-testid="floating-toolbar-pivot"
        aria-label="Transform pivot point"
        title="Transform pivot point (multi-select gizmo)"
        className="h-7 rounded-md border border-border bg-bg px-1.5 text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <option value="median">pivot: median</option>
        <option value="boundingBox">pivot: bbox</option>
        <option value="individual">pivot: individual</option>
        <option value="active">pivot: active</option>
      </select>
      <Divider />
      {/* #228 — transform orientation (Blender Global/Local). 'local' aligns the
          gizmo handles to the object's own axes. */}
      <Chip
        active={gizmoOrientation === 'local'}
        title={`Transform orientation: ${gizmoOrientation} (click to toggle Global/Local)`}
        ariaLabel={
          gizmoOrientation === 'local'
            ? 'Switch to global orientation'
            : 'Switch to local orientation'
        }
        testId="floating-toolbar-orientation"
        onClick={toggleGizmoOrientation}
      >
        {gizmoOrientation === 'local' ? 'local' : 'global'}
      </Chip>
      <Divider />
      <Chip
        active={snapEnabled}
        title="Toggle translation snap"
        ariaLabel={snapEnabled ? 'Disable snap' : 'Enable snap'}
        testId="floating-toolbar-snap-toggle"
        onClick={toggleSnapEnabled}
      >
        snap
      </Chip>
      <input
        type="number"
        step="0.05"
        min={0}
        value={snapStep}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) setSnapStep(n);
        }}
        data-testid="floating-toolbar-snap-step"
        aria-label="Snap step value"
        className="w-14 rounded border border-border bg-bg px-1.5 py-0.5 text-right text-[11px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        title="Snap step (world units)"
      />
      {/* #228 — Snapping ▸ Affect (Blender snapping.rst): which transform modes
          the snap gates. Shown only while snap is on; Move snaps by default,
          Rotate (5°) / Scale (0.1) are opt-in. */}
      {snapEnabled ? (
        <>
          <Chip
            active={snapAffect.move}
            title="Snap moves (translate)"
            ariaLabel={snapAffect.move ? 'Disable move snap' : 'Enable move snap'}
            testId="floating-toolbar-snap-affect-move"
            onClick={() => toggleSnapAffect('move')}
          >
            M
          </Chip>
          <Chip
            active={snapAffect.rotate}
            title="Snap rotations (5° increments)"
            ariaLabel={snapAffect.rotate ? 'Disable rotate snap' : 'Enable rotate snap'}
            testId="floating-toolbar-snap-affect-rotate"
            onClick={() => toggleSnapAffect('rotate')}
          >
            R
          </Chip>
          <Chip
            active={snapAffect.scale}
            title="Snap scaling (0.1 increments)"
            ariaLabel={snapAffect.scale ? 'Disable scale snap' : 'Enable scale snap'}
            testId="floating-toolbar-snap-affect-scale"
            onClick={() => toggleSnapAffect('scale')}
          >
            S
          </Chip>
        </>
      ) : null}
      <Divider />
      {/* Timeline reveal — a toolbar-level toggle for the timeline drawer body.
          The Timebar (with the Auto-Key indicator) stays always-visible below. */}
      <ToolButton
        active={timelineDrawerOpen}
        title={timelineDrawerOpen ? 'Hide timeline' : 'Show timeline'}
        ariaLabel={timelineDrawerOpen ? 'Hide timeline' : 'Show timeline'}
        testId="floating-toolbar-timeline"
        onClick={toggleTimelineDrawer}
      >
        ☰
      </ToolButton>
      <Divider />
      {/* Status / export / present (folded from R3 RightCluster). The zoom
          readout is a disabled button: §5.3 anatomy lists `[100% ▾]` as a
          display, not an interactive zoom-input. */}
      <button
        type="button"
        disabled
        data-testid="top-toolbar-zoom"
        title={`Viewport zoom — ${cameraZoom}%`}
        aria-label={`Viewport zoom ${cameraZoom} percent`}
        className="flex h-7 items-center gap-1 rounded-md border border-border bg-muted/30 px-2 text-[11px] font-medium text-fg-mute focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span data-testid="top-toolbar-zoom-value">{cameraZoom}%</span>
        <span aria-hidden>▾</span>
      </button>
      <BarButton
        testId="top-toolbar-render"
        title="Render image — current frame to PNG"
        ariaLabel={rendering ? 'Rendering image' : 'Render image'}
        onClick={() => void handleRenderImage()}
        disabled={rendering}
      >
        <span aria-hidden>{rendering ? '⏳' : '📷'}</span>
        <span>{rendering ? 'Rendering…' : 'Render'}</span>
      </BarButton>
      <BarButton testId="top-toolbar-export" title="Export DAG as JSON" onClick={exportDagJson}>
        <span aria-hidden>⬇</span>
        <span>Export</span>
      </BarButton>
      <BarButton
        testId="top-toolbar-present"
        title="Present — chrome-hidden viewport (Esc returns)"
        onClick={() => togglePresentMode()}
      >
        <span aria-hidden>⛚</span>
        <span>Present</span>
      </BarButton>
    </div>
  );
}
