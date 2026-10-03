// Time store — current scrub time + play/pause state.
//
// THESIS.md §49: Time enters every animation/render evaluator through a
// typed Time socket. The viewport reads this store and threads
// `ctx.time` into evaluate(); a TimeSource node (impure) folds that ctx
// value into a typed Time output that downstream pure consumers wire to.
//
// Discipline: this is a UI projection of the playhead, NOT the DAG. Mutating
// time NEVER touches the DAG store. The viewport reads time on each render
// and re-evaluates; pure-node caches invalidate via the TimeSource hash
// flip, not by an Op (V1 stays clean).
//
// rAF lives in `src/app/Clock.tsx` — file-rooted V8 keeps the rAF dispatch
// out of `src/viewport/`. Tests drive `setTime(seconds)` directly.
//
// Frame mirror (the W9 escape-hatch chokepoint): `frame` is derived inside
// THREE setters — `setTime`, `setDuration`, `tick`. Each one, immediately
// after committing the canonical state, mirrors the new frame into
// `viewportStore.currentFrameRef.current`. This is a React-bypass field used
// by TimelineCanvas's 60fps rAF loop so a scrub/playback does not re-render
// every seconds-subscriber.
//
// WHY here and NOT in Clock: Clock owns the rAF but NOT the frame value — it
// only calls `tick()`. Non-playback scrub (dragScrub, ruler drag) and
// `setDuration` reframing mutate `frame` by calling `setTime`/`setDuration`
// DIRECTLY, bypassing Clock entirely. Mirroring in Clock would silently
// freeze the escape-hatch playhead during scrub and on duration change.
// timeStore's three setters are the single chokepoint where `frame`
// mutates, so writing the mirror here makes the invariant
// `currentFrameRef.current === useTimeStore.getState().frame`
// hold by construction after EVERY state transition (playback AND scrub AND
// duration change) — never-diverge by single-writer. Cross-store call is
// call-time `getState()` (no module-top-level cycle); both are
// src/app/stores/* projection stores, V8-clean.
//
// REF: THESIS.md §49, vyapti V1, V3, V8.
// REF: D-W9-1, D-W9-9; vyapti V8.

import { create } from 'zustand';
import { useViewportStore } from './viewportStore';

export const FRAMES_PER_SECOND = 60;
const DEFAULT_DURATION_SECONDS = 10;

export interface TimeStore {
  /** Current scrub time in seconds. */
  seconds: number;
  /** Frame index at FRAMES_PER_SECOND (derived from `seconds`). */
  frame: number;
  /** Normalized 0..1 over the project duration. */
  normalized: number;
  /** Total duration of the project's playable range: playback loops here. In 3D it is the
   *  scene's End (#1287, `sceneRange.ts`); Video mode sizes it to the composition. */
  durationSeconds: number;
  /** How far the playhead may go (#1287). Blender does not hold the playhead inside the frame
   *  range, so content past End can be scrubbed to; the 3D timeline reaches to whichever ends
   *  later, End or the content. Never below `durationSeconds`. */
  extentSeconds: number;
  /** Whether the rAF clock is advancing time. */
  playing: boolean;

  setTime(seconds: number): void;
  /** Set the playable range, and let the playhead reach exactly that far (Video mode). */
  setDuration(seconds: number): void;
  /** #1287 — set the playable range (End) and how far past it the playhead may go. The playhead
   *  is not moved by a change of End, as in Blender, unless it is now past the reach. */
  setRange(endSeconds: number, extentSeconds: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Advance time by `delta` seconds (called by Clock.tsx on each rAF tick). */
  tick(delta: number): void;
}

function clampToDuration(seconds: number, duration: number): number {
  if (duration <= 0) return 0;
  if (seconds < 0) return 0;
  if (seconds > duration) return duration;
  return seconds;
}

/** The playhead's reach: never short of the playable range. */
function reachOf(duration: number, extent: number): number {
  return Math.max(duration, Number.isFinite(extent) ? extent : 0);
}

function deriveFrame(seconds: number): number {
  return Math.round(seconds * FRAMES_PER_SECOND);
}

function deriveNormalized(seconds: number, duration: number): number {
  if (duration <= 0) return 0;
  return seconds / duration;
}

/** Mirror the just-committed frame into the React-bypass escape hatch on
 *  viewportStore. Called immediately after each `set({ frame })` so the
 *  invariant `currentFrameRef.current === frame` holds by construction. The
 *  cross-store reference is resolved at call time via `getState()` (no
 *  module-init cycle). See D-W9-1, D-W9-9. */
function mirrorFrame(frame: number): void {
  useViewportStore.getState().currentFrameRef.current = frame;
}

export const useTimeStore = create<TimeStore>((set, get) => ({
  seconds: 0,
  frame: 0,
  normalized: 0,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  extentSeconds: DEFAULT_DURATION_SECONDS,
  playing: false,

  setTime(seconds) {
    const { durationSeconds, extentSeconds } = get();
    const clamped = clampToDuration(seconds, reachOf(durationSeconds, extentSeconds));
    set({
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, durationSeconds),
    });
    // Mirror after the canonical state is committed (single chokepoint).
    mirrorFrame(deriveFrame(clamped));
  },

  setDuration(seconds) {
    const next = Math.max(0.001, seconds);
    const { seconds: cur } = get();
    const clamped = clampToDuration(cur, next);
    set({
      durationSeconds: next,
      extentSeconds: next,
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, next),
    });
    mirrorFrame(deriveFrame(clamped));
  },

  setRange(endSeconds, extentSeconds) {
    const end = Math.max(0.001, endSeconds);
    const extent = reachOf(end, extentSeconds);
    const { seconds: cur, durationSeconds, extentSeconds: prevExtent } = get();
    if (end === durationSeconds && extent === prevExtent) return;
    const clamped = clampToDuration(cur, extent);
    set({
      durationSeconds: end,
      extentSeconds: extent,
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, end),
    });
    mirrorFrame(deriveFrame(clamped));
  },

  play() {
    set({ playing: true });
  },

  pause() {
    set({ playing: false });
  },

  toggle() {
    set({ playing: !get().playing });
  },

  tick(delta) {
    const { playing, seconds, durationSeconds, extentSeconds } = get();
    if (!playing) return;
    let next = seconds + delta;
    // Loop at duration end so playback is observable in steady state without
    // the user hitting reset every cycle. #1287 — a playhead already past End (scrubbed there)
    // goes back to the start, as Blender's does.
    if (durationSeconds > 0 && next > durationSeconds) {
      next = seconds >= durationSeconds ? 0 : next % durationSeconds;
    }
    const clamped = clampToDuration(next, reachOf(durationSeconds, extentSeconds));
    set({
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, durationSeconds),
    });
    mirrorFrame(deriveFrame(clamped));
  },
}));
