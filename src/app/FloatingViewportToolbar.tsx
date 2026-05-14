// FloatingViewportToolbar — R8 per UI-SPEC §5.7. Bottom-center overlay
// inside the viewport, hosting the most-frequent viewport actions in
// gaze-proximity to the model being edited.
//
// Anatomy (post D-W7-1 amendment — persp/ortho dropped):
//
//   [↖][✥][⟲][⤢] │ [⌂][⊞] │ [studio][wire][rendered] │ [snap][step]
//   tools           home grid    shading                snap
//
// Dispatch (D-W7-2 locked — single dispatcher via editorStore):
//   tools  → editorStore.setActiveTool (translate/rotate/scale propagate
//            to gizmoStore.mode automatically per editorStore:55-58;
//            Select leaves gizmoMode untouched).
//   home   → frameSelected() with fallback to frameAll() when no primary
//            selection. Reuses existing character/framing helpers.
//   grid   → viewportStore.toggleGridVisible.
//   shade  → viewportStore.setShading.
//   snap   → viewportStore.toggleSnapEnabled + setSnapStep.
//
// V19 (keyboard/UI shared helper): tool buttons all route through the
// same setActiveTool path that R4 ToolRail uses, so every Move/Rot/Scl
// across R4 + R8 + keyboard W/E/R highlights in sync.
//
// Director-mode hide: when mode === 'director', returns null. The R8
// chrome is part of the surfaces D-UX-9 hides; we self-gate here rather
// than relying on a Layout.tsx grid-slot rule because R8 mounts as a
// Viewport overlay (sibling of Canvas), not a grid slot.
//
// File-rooted V8: src/app/. Reads + mutates UI projection stores only
// (editorStore, viewportStore, modeStore, selectionStore via framing).
// Never the DAG.
//
// REF: docs/UI-SPEC.md §5.7, memory/project_p6_w7_context.md (D-W7-1..3),
// memory/project_p6_w7_plan.md C1.

import type { ReactNode } from 'react';
import { frameAll, frameSelected } from './character/framing';
import { useEditorStore, type ActiveTool } from './stores/editorStore';
import { useModeStore } from './stores/modeStore';
import { useSelectionStore } from './stores/selectionStore';
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
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  const base =
    'flex h-7 w-7 items-center justify-center rounded text-sm font-mono transition-colors';
  const state = active
    ? 'bg-bg-1 text-accent'
    : 'text-fg-dim hover:bg-bg-1 hover:text-fg';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      title={title}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  title,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  const base =
    'rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide transition-colors';
  const state = active
    ? 'bg-accent/25 text-accent'
    : 'text-fg-dim hover:bg-bg-1 hover:text-fg';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      title={title}
      className={`${base} ${state}`}
    >
      {children}
    </button>
  );
}

function Divider(): ReactNode {
  return <div aria-hidden className="mx-1 h-5 w-px bg-border" />;
}

export function FloatingViewportToolbar(): ReactNode {
  const mode = useModeStore((s) => s.mode);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const shading = useViewportStore((s) => s.shading);
  const setShading = useViewportStore((s) => s.setShading);
  const gridVisible = useViewportStore((s) => s.gridVisible);
  const toggleGridVisible = useViewportStore((s) => s.toggleGridVisible);
  const snapEnabled = useViewportStore((s) => s.snapEnabled);
  const snapStep = useViewportStore((s) => s.snapStep);
  const toggleSnapEnabled = useViewportStore((s) => s.toggleSnapEnabled);
  const setSnapStep = useViewportStore((s) => s.setSnapStep);

  // D-UX-9 chrome-hide: R8 vanishes in director mode. Self-gated rather
  // than Layout.tsx-gated because R8 is a viewport overlay, not a grid
  // slot — returning null is the simplest and least error-prone path.
  if (mode === 'director') return null;

  return (
    <div
      data-testid="floating-viewport-toolbar"
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border-strong bg-bg-2/90 px-2 py-1.5 font-mono text-fg shadow-sm backdrop-blur-sm"
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.id}
          active={activeTool === t.id}
          title={`${t.label} (${t.shortcut})`}
          testId={t.testId}
          onClick={() => setActiveTool(t.id)}
        >
          {t.icon}
        </ToolButton>
      ))}
      <Divider />
      <ToolButton
        active={false}
        title="Frame selection (F)"
        testId="floating-toolbar-home"
        onClick={homeFrame}
      >
        ⌂
      </ToolButton>
      <ToolButton
        active={gridVisible}
        title={gridVisible ? 'Hide grid' : 'Show grid'}
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
          testId={s.testId}
          onClick={() => setShading(s.value)}
        >
          {s.label}
        </Chip>
      ))}
      <Divider />
      <Chip
        active={snapEnabled}
        title="Toggle translation snap"
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
        className="w-14 rounded border border-border bg-bg px-1.5 py-0.5 text-right font-mono text-[10px] text-fg focus:border-accent focus:outline-none"
        title="Snap step (world units)"
      />
    </div>
  );
}
