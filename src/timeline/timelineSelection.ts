// Timeline UI selection — which channel + layer the curve editor is
// editing right now. Pure UI state; not part of project save.
//
// V8 file-rooted: store lives in src/timeline/ alongside its consumers
// (Dopesheet + CurveEditor); only those two read/write it. No DAG
// dispatch passes through this module — it's a sister projection.

import { create } from 'zustand';

export interface TimelineSelectionStore {
  /** Channel node id currently surfaced in the curve editor; null = none. */
  activeChannelId: string | null;
  setActiveChannel(id: string | null): void;
}

export const useTimelineSelection = create<TimelineSelectionStore>((set) => ({
  activeChannelId: null,
  setActiveChannel: (id) => set({ activeChannelId: id }),
}));
