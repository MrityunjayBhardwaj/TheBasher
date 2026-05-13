// TimelineDrawer — Timebar (always visible) + collapsible drawer body
// hosting Dopesheet and CurveEditor as tabs (P6 W5 — UI-SPEC §5.9;
// D-UX-2).
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
// W5 ships the tab strip + Frame/FPS readout in the header
// (UI-SPEC §5.10 distributed status rows 3-4). Track filters + the
// bottom toolbar (Key/Insert/Delete/Simplify/Clear/Cut/Copy/Paste/
// transport) land in W6 alongside the animate keyboard model and the
// anim.simplifyChannel / anim.clearChannel Mutators.

import { useTimeStore, FRAMES_PER_SECOND } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import {
  useTimelineDockStore,
  type TimelineTab,
} from '../app/stores/timelineDockStore';
import { Timebar } from '../app/Timebar';
import { Dopesheet } from './Dopesheet';
import { CurveEditor } from './CurveEditor';

const DRAWER_HEIGHT_PX = 240;
const HEADER_HEIGHT_PX = 28;

export function TimelineDrawer() {
  const open = useViewportStore((s) => s.timelineDrawerOpen);
  const toggle = useViewportStore((s) => s.toggleTimelineDrawer);
  const duration = useTimeStore((s) => s.durationSeconds);
  const frame = useTimeStore((s) => s.frame);
  const activeTab = useTimelineDockStore((s) => s.activeTab);
  const setActiveTab = useTimelineDockStore((s) => s.setActiveTab);

  const totalFrames = Math.max(1, Math.round(duration * FRAMES_PER_SECOND));

  return (
    <div data-testid="timeline-drawer" data-open={open} className="flex w-full flex-col">
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
              data-testid="dopesheet-pane"
              data-active={activeTab === 'dopesheet'}
              className="absolute inset-0"
              style={{ display: activeTab === 'dopesheet' ? 'flex' : 'none' }}
            >
              <Dopesheet duration={duration} />
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
        </div>
      )}
      <div className="flex items-stretch">
        <button
          type="button"
          data-testid="timeline-drawer-toggle"
          aria-label={open ? 'Collapse timeline drawer' : 'Expand timeline drawer'}
          aria-expanded={open}
          className="flex w-8 items-center justify-center border-r border-line bg-bg-2 text-fg hover:bg-line"
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
      className={`flex items-center border-r border-line px-3 ${
        active ? 'bg-bg text-fg' : 'text-mute hover:bg-line/40 hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}
