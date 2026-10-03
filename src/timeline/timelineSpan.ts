// #1287 — what the 3D timeline spans, and where the scene's End falls inside it.
//
// The timeline reaches to the playable range (the scene's End, or Video mode's composition) or,
// when content runs longer, as far as the playhead may go (`extentSeconds`), so a clip past End
// can be seen and scrubbed. The stretch past End is shaded on every surface, as Blender's
// animation editors shade outside the frame range.

import { useTimeStore } from '../app/stores/timeStore';

export interface TimelineSpan {
  /** Seconds the timeline spans: never short of End. */
  readonly span: number;
  /** The scene's End (the playable range) in seconds. */
  readonly rangeEnd: number;
}

export function useTimelineSpan(): TimelineSpan {
  const rangeEnd = useTimeStore((s) => s.durationSeconds);
  const extent = useTimeStore((s) => s.extentSeconds);
  return { span: Math.max(rangeEnd, extent), rangeEnd };
}
