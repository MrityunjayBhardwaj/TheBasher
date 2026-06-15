// timelineViewStore — the SHARED zoom/pan/value-zoom state read by BOTH the
// dopesheet (canvas) and the curve editor (SVG), so switching tabs holds the
// same visible time window (UX-BACKLOG #11, the "unify" as a shared view).
//
// Pure UI state, NOT part of the project save (a sibling of timelineSelection).
// V8 file-rooted in src/timeline/ alongside its consumers; no DAG dispatch.
//
// `view` = { zoom, scroll } is the SHARED time axis (see timelineView.ts).
// `valueZoom` is the curve editor's value-axis scale only (the dopesheet has
// no value axis); it lives here so all timeline-view state is in one store.

import { create } from 'zustand';
import { DEFAULT_VIEW, MIN_VALUE_ZOOM, MAX_VALUE_ZOOM, type TimelineView } from './timelineView';

export interface TimelineViewStore {
  /** Shared time axis (zoom ≥ 1, scroll ∈ [0,1]). */
  view: TimelineView;
  /** Curve-editor value-axis zoom (0.5–8×); 1 = auto-fit the value domain. */
  valueZoom: number;
  setView(view: TimelineView): void;
  setValueZoom(z: number): void;
  reset(): void;
}

function clampValueZoom(z: number): number {
  return z < MIN_VALUE_ZOOM ? MIN_VALUE_ZOOM : z > MAX_VALUE_ZOOM ? MAX_VALUE_ZOOM : z;
}

export const useTimelineViewStore = create<TimelineViewStore>((set) => ({
  view: DEFAULT_VIEW,
  valueZoom: 1,
  setView: (view) => set({ view }),
  setValueZoom: (z) => set({ valueZoom: clampValueZoom(z) }),
  reset: () => set({ view: DEFAULT_VIEW, valueZoom: 1 }),
}));
