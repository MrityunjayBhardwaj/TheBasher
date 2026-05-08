// TimelineDrawer — wraps the existing Timebar (always visible) plus the
// collapsible drawer that shows Dopesheet (top) + CurveEditor (bottom).
// THESIS §13.
//
// Drawer state lives in viewportStore (timelineDrawerOpen). A small
// chevron button toggles it. Default closed — preserves P0/P2 acceptance
// pixel-diff baselines until the drawer is explicitly opened.

import { useTimeStore } from '../app/stores/timeStore';
import { useViewportStore } from '../app/stores/viewportStore';
import { Timebar } from '../app/Timebar';
import { Dopesheet } from './Dopesheet';
import { CurveEditor } from './CurveEditor';

const DRAWER_HEIGHT_PX = 240;

export function TimelineDrawer() {
  const open = useViewportStore((s) => s.timelineDrawerOpen);
  const toggle = useViewportStore((s) => s.toggleTimelineDrawer);
  const duration = useTimeStore((s) => s.durationSeconds);

  return (
    <div data-testid="timeline-drawer" data-open={open} className="flex w-full flex-col">
      {open && (
        <div
          className="flex w-full flex-col border-t border-line"
          style={{ height: DRAWER_HEIGHT_PX }}
        >
          <div data-testid="dopesheet-pane" style={{ flex: '1 1 60%', minHeight: 0 }}>
            <Dopesheet duration={duration} />
          </div>
          <div
            data-testid="curve-editor-pane"
            className="border-t border-line"
            style={{ flex: '1 1 40%', minHeight: 0 }}
          >
            <CurveEditor duration={duration} />
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
