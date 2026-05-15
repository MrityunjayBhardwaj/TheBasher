// TimelineDrawer — Timebar (always visible) + collapsible drawer body
// hosting the dopesheet view (TimelineCanvas, the canvas-2D surface
// the SVG Dopesheet was replaced by in P6 W9) and CurveEditor as tabs
// (P6 W5 — UI-SPEC §5.9; D-UX-2). The "Dopesheet" tab id/label is
// unchanged — only the rendering technology advanced (D-W9-2). Bottom
// toolbar with track-ops buttons added P6 W6.
//
// Drawer open/closed lives in viewportStore (timelineDrawerOpen).
// Default closed — preserves P0/P2 acceptance pixel-diff baselines.
//
// Active tab (when open) lives in timelineDockStore (D-W5-2: persisted).
// Tab semantics (D-W5-1): both panes stay mounted whenever the drawer
// is open; the inactive pane is hidden via `display: none` so store
// subscriptions (V8) and pane-internal scroll position survive a tab
// switch. Selecting a channel row in Dopesheet does NOT auto-switch
// to Curve Editor (D-W5-3 — explicit tab entry only).
//
// W6 adds a 28px bottom toolbar inside the drawer body. Buttons:
//   [Key] [Delete] [Simplify ▴] [Clear]
// Each wires to the same handler the corresponding keyboard shortcut
// uses (Key/Delete share buildKeyframeInsertOp / buildKeyframeDeleteOp
// from KeyboardShortcuts.tsx; Clear dispatches via the
// clearChannelMutator; Simplify opens the SimplifyPopover). Track
// filters + transport buttons + Cut/Copy/Paste land later (W7+).

import { useState } from 'react';
import { useTimeStore, FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { useModeStore } from '../app/stores/modeStore';
import {
  useTimelineDockStore,
  type TimelineTab,
} from '../app/stores/timelineDockStore';
import { useDagStore } from '../core/dag/store';
import { useTimelineSelection } from './timelineSelection';
import {
  buildKeyframeInsertOp,
  buildKeyframeDeleteOp,
} from '../app/KeyboardShortcuts';
import { clearChannelMutator, validatePlan } from '../agent/mutators';
import { Timebar } from '../app/Timebar';
import { TimelineCanvas } from './TimelineCanvas';
import { CurveEditor } from './CurveEditor';
import { SimplifyPopover } from './SimplifyPopover';

const DRAWER_HEIGHT_PX = 240;
const HEADER_HEIGHT_PX = 28;
const TOOLBAR_HEIGHT_PX = 28;

export function TimelineDrawer() {
  const open = useViewportStore((s) => s.timelineDrawerOpen);
  const toggle = useViewportStore((s) => s.toggleTimelineDrawer);
  const duration = useTimeStore((s) => s.durationSeconds);
  const frame = useTimeStore((s) => s.frame);
  const activeTab = useTimelineDockStore((s) => s.activeTab);
  const setActiveTab = useTimelineDockStore((s) => s.setActiveTab);
  const mode = useModeStore((s) => s.mode);

  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));

  return (
    <div
      data-testid="timeline-drawer"
      data-open={open}
      role="region"
      aria-label={`Timeline — mode ${mode ?? 'unknown'}, frame ${frame}`}
      className="flex w-full flex-col"
    >
      {open && (
        <div
          className="flex w-full flex-col border-t border-line"
          style={{ height: DRAWER_HEIGHT_PX }}
        >
          <DockHeader
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            frame={frame}
            totalFrames={totalFrames}
          />
          <div className="relative flex-1" style={{ minHeight: 0 }}>
            <div
              data-testid="timeline-canvas-pane"
              data-active={activeTab === 'dopesheet'}
              className="absolute inset-0"
              style={{ display: activeTab === 'dopesheet' ? 'flex' : 'none' }}
            >
              <TimelineCanvas duration={duration} />
            </div>
            <div
              data-testid="curve-editor-pane"
              data-active={activeTab === 'curve'}
              className="absolute inset-0"
              style={{ display: activeTab === 'curve' ? 'flex' : 'none' }}
            >
              <CurveEditor duration={duration} />
            </div>
          </div>
          <DockToolbar />
        </div>
      )}
      <div className="flex items-stretch">
        <button
          type="button"
          data-testid="timeline-drawer-toggle"
          aria-label={open ? 'Collapse timeline drawer' : 'Expand timeline drawer'}
          aria-expanded={open}
          className="flex w-8 items-center justify-center border-r border-line bg-bg-2 text-fg hover:bg-line focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          onClick={toggle}
        >
          {open ? '▾' : '▴'}
        </button>
        <div className="flex-1">
          <Timebar />
        </div>
      </div>
    </div>
  );
}

function DockHeader({
  activeTab,
  onSelectTab,
  frame,
  totalFrames,
}: {
  activeTab: TimelineTab;
  onSelectTab: (tab: TimelineTab) => void;
  frame: number;
  totalFrames: number;
}) {
  return (
    <div
      data-testid="timeline-tab-strip"
      role="tablist"
      aria-label="Timeline tabs"
      className="flex items-stretch border-b border-line bg-bg-2 text-xs"
      style={{ height: HEADER_HEIGHT_PX }}
    >
      <TabButton
        id="dopesheet"
        label="Dopesheet"
        active={activeTab === 'dopesheet'}
        onClick={() => onSelectTab('dopesheet')}
      />
      <TabButton
        id="curve"
        label="Curve Editor"
        active={activeTab === 'curve'}
        onClick={() => onSelectTab('curve')}
      />
      <div className="flex-1" />
      <div className="flex items-center gap-3 px-3 text-mute">
        <span data-testid="timeline-dock-frame-readout">
          {frame} / {totalFrames}
        </span>
        <span data-testid="timeline-dock-fps-readout">{FRAMES_PER_SECOND} fps</span>
      </div>
    </div>
  );
}

function TabButton({
  id,
  label,
  active,
  onClick,
}: {
  id: TimelineTab;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`timeline-tab-${id}`}
      data-active={active}
      onClick={onClick}
      className={`flex items-center border-r border-line px-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        active ? 'bg-bg text-fg' : 'text-mute hover:bg-line/40 hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function DockToolbar() {
  // Re-render the toolbar whenever the relevant pieces of timelineSelection
  // change, so the disabled state of each button reflects the live
  // (channel, keyframe) selection.
  const activeChannelId = useTimelineSelection((s) => s.activeChannelId);
  const activeKeyframeId = useTimelineSelection((s) => s.activeKeyframeId);
  const [simplifyOpen, setSimplifyOpen] = useState(false);

  function onKey() {
    const op = buildKeyframeInsertOp();
    if (op) {
      useDagStore.getState().dispatchAtomic([op], 'user', 'insert keyframe');
    }
  }

  function onDelete() {
    const op = buildKeyframeDeleteOp();
    if (op) {
      useDagStore.getState().dispatchAtomic([op], 'user', 'delete keyframe');
      useTimelineSelection.getState().setActiveKeyframe(null);
    }
  }

  function onClear() {
    if (!activeChannelId) return;
    const state = useDagStore.getState().state;
    const plan = validatePlan(
      clearChannelMutator,
      { channelId: activeChannelId },
      state,
      'clear channel',
    );
    if (!plan.ok) return;
    if (plan.ops.length === 0) return; // already empty
    useDagStore.getState().dispatchAtomic(plan.ops, 'user', 'clear channel');
    useTimelineSelection.getState().setActiveKeyframe(null);
  }

  return (
    <div
      data-testid="timeline-dock-toolbar"
      className="relative flex items-center gap-1 border-t border-line bg-bg-2 px-2 text-xs"
      style={{ height: TOOLBAR_HEIGHT_PX }}
    >
      <ToolbarButton
        id="key"
        label="Key"
        title="Insert a keyframe at the current frame on the active channel (K)"
        disabled={activeChannelId === null}
        onClick={onKey}
      />
      <ToolbarButton
        id="delete"
        label="Delete"
        title="Delete the selected keyframe (Del)"
        disabled={activeKeyframeId === null}
        onClick={onDelete}
      />
      <span className="mx-2 h-4 w-px bg-line" />
      <ToolbarButton
        id="simplify"
        label="Simplify…"
        title="Reduce keyframe density on the active channel within tolerance"
        disabled={activeChannelId === null}
        onClick={() => setSimplifyOpen((v) => !v)}
      />
      <ToolbarButton
        id="clear"
        label="Clear"
        title="Wipe all keyframes from the active channel"
        disabled={activeChannelId === null}
        onClick={onClear}
      />
      <div className="flex-1" />
      <SimplifyPopover open={simplifyOpen} onClose={() => setSimplifyOpen(false)} />
    </div>
  );
}

function ToolbarButton({
  id,
  label,
  title,
  disabled,
  onClick,
}: {
  id: string;
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`timeline-toolbar-${id}`}
      data-disabled={disabled}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        disabled
          ? 'cursor-not-allowed text-mute'
          : 'text-fg hover:bg-line'
      }`}
    >
      {label}
    </button>
  );
}
