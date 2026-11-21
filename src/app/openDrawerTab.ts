// Open the bottom drawer on one of its tabs (#1703, #1707) — the one road View ▸ Nodes and the
// toolbar's Assets button take. Opening is idempotent: a drawer already open on the tab stays so,
// where the drawer's own toggle would close it.

import { useTimelineDockStore, type TimelineTab } from './stores/timelineDockStore';
import { useViewportStore } from './stores/viewportStore';

export function openDrawerTab(tab: TimelineTab): void {
  useTimelineDockStore.getState().setActiveTab(tab);
  useViewportStore.getState().setTimelineDrawerOpen(true);
}
