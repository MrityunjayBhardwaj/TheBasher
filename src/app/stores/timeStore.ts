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
// REF: THESIS.md §49, vyapti V1, V3, V8.

import { create } from 'zustand';

const FRAMES_PER_SECOND = 60;
const DEFAULT_DURATION_SECONDS = 10;

export interface TimeStore {
  /** Current scrub time in seconds. */
  seconds: number;
  /** Frame index at FRAMES_PER_SECOND (derived from `seconds`). */
  frame: number;
  /** Normalized 0..1 over the project duration. */
  normalized: number;
  /** Total duration of the project's playable range. */
  durationSeconds: number;
  /** Whether the rAF clock is advancing time. */
  playing: boolean;

  setTime(seconds: number): void;
  setDuration(seconds: number): void;
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

function deriveFrame(seconds: number): number {
  return Math.round(seconds * FRAMES_PER_SECOND);
}

function deriveNormalized(seconds: number, duration: number): number {
  if (duration <= 0) return 0;
  return seconds / duration;
}

export const useTimeStore = create<TimeStore>((set, get) => ({
  seconds: 0,
  frame: 0,
  normalized: 0,
  durationSeconds: DEFAULT_DURATION_SECONDS,
  playing: false,

  setTime(seconds) {
    const { durationSeconds } = get();
    const clamped = clampToDuration(seconds, durationSeconds);
    set({
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, durationSeconds),
    });
  },

  setDuration(seconds) {
    const next = Math.max(0.001, seconds);
    const { seconds: cur } = get();
    const clamped = clampToDuration(cur, next);
    set({
      durationSeconds: next,
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, next),
    });
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
    const { playing, seconds, durationSeconds } = get();
    if (!playing) return;
    let next = seconds + delta;
    // Loop at duration end so playback is observable in steady state without
    // the user hitting reset every cycle.
    if (durationSeconds > 0 && next > durationSeconds) {
      next = next % durationSeconds;
    }
    const clamped = clampToDuration(next, durationSeconds);
    set({
      seconds: clamped,
      frame: deriveFrame(clamped),
      normalized: deriveNormalized(clamped, durationSeconds),
    });
  },
}));
