// Timeline UI selection — which channel + which keyframe the timeline
// surfaces are operating on right now. Pure UI state; not part of the
// project save.
//
// V8 file-rooted: store lives in src/timeline/ alongside its consumers
// (Dopesheet + CurveEditor + KeyboardShortcuts in P6 W6). No DAG dispatch
// passes through this module — it's a sister projection.
//
// P6 W6 — adds activeKeyframeId: { channelId, time } compound key.
// Keyframes don't carry their own ids (they're entries in a keyframes
// array on the channel node's params), so we identify them by the
// (channel, time) pair. Defensive: any reader must null-check against
// the live channel state — a keyframe-delete action elsewhere can
// invalidate the reference.

import { create } from 'zustand';

export interface KeyframeRef {
  channelId: string;
  time: number;
}

export interface TimelineSelectionStore {
  /** Channel node id currently surfaced in the curve editor; null = none. */
  activeChannelId: string | null;
  /** Specific keyframe currently selected for delete / drag / cut; null = none. */
  activeKeyframeId: KeyframeRef | null;
  setActiveChannel(id: string | null): void;
  /** Set the active keyframe pointer. Passing null clears it. */
  setActiveKeyframe(ref: KeyframeRef | null): void;
}

export const useTimelineSelection = create<TimelineSelectionStore>((set) => ({
  activeChannelId: null,
  activeKeyframeId: null,
  setActiveChannel: (id) =>
    // Switching channels also clears any per-keyframe selection — the
    // (channel, time) pair from the old channel is meaningless against
    // the new one.
    set((s) => ({
      activeChannelId: id,
      activeKeyframeId: s.activeChannelId === id ? s.activeKeyframeId : null,
    })),
  setActiveKeyframe: (ref) => set({ activeKeyframeId: ref }),
}));
