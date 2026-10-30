// playbackPacing — how many frames one playback step advances (#1733).
//
// Blender's playback step (`screen_animation_step_invoke`, editors/screen/screen_ops.cc) runs on a
// timer whose period is one scene frame (screen_ops.cc:6296), and chooses the step by the scene's
// sync mode (screen_ops.cc:6149-6191):
//
//   - "Drop frames" (SCE_FRAME_DROP): the step is the real time since the last step, in frames,
//     plus the fraction left over last time; the whole part is taken and the fraction carried. A
//     step under one frame becomes one frame (Blender: skipping there "leads to jittery playback").
//     A slow scene skips frames and stays in real time.
//   - "Play every frame": one frame per step. A slow scene plays slower and shows every frame.
//
// Either way the scene is drawn at one whole frame per step — never part of the scene on an older
// frame, never a time between frames.
//
// The browser's clock is the animation frame, which fires at the display's rate, not the scene's.
// A tick that comes before a frame period has passed is the timer not having fired yet: no step.
// A tick within EARLY_SECONDS of the period counts as the timer firing (vsync jitter would
// otherwise drop alternate steps on a display that runs at the scene rate).
//
// Before this, the clock advanced by real time clamped to 100 ms per tick, at any fraction of a
// frame: a scene slower than 10 fps played in slow motion (0.40× real time at 150 ms a frame,
// p1733), in a mode neither of Blender's is.
//
// REF: ref/GROUND_TRUTH_FRAME_UPDATE.md §STAGE 5; issue #1733; src/app/Clock.tsx (the caller).

export type PlaybackSync = 'drop' | 'every';

/** How early a tick may be and still count as a frame period having passed. */
export const EARLY_SECONDS = 0.002;
/** A gap longer than this is the tab having been hidden, not a slow frame: resume one frame on. */
export const STALL_SECONDS = 1;
/** How often the achieved rate is published. */
const METER_WINDOW_SECONDS = 0.5;

export interface Pacer {
  /** Real time since the last step, in seconds. */
  pending: number;
  /** The fraction of a frame carried from the last "drop frames" step (`lagging_frame_count`). */
  lagging: number;
  /** Steps taken, and when counting began (ms), for the achieved rate. */
  shown: number;
  windowStart: number | null;
}

export function createPacer(): Pacer {
  return { pending: 0, lagging: 0, shown: 0, windowStart: null };
}

/** Forget the time carried and the rate counted — on pause, so a resume starts clean. */
export function resetPacer(p: Pacer): void {
  p.pending = 0;
  p.lagging = 0;
  p.shown = 0;
  p.windowStart = null;
}

/**
 * The frames to advance on a tick `elapsed` seconds after the previous tick, at `fps`: 0 when a
 * frame period has not passed yet, 1 in "every" mode, and in "drop" mode the frames real time has
 * covered (at least 1), the fraction carried.
 */
export function framesDue(p: Pacer, sync: PlaybackSync, elapsed: number, fps: number): number {
  const period = 1 / fps;
  p.pending += elapsed > STALL_SECONDS ? period : Math.max(0, elapsed);
  if (p.pending < period - EARLY_SECONDS) return 0;
  const elapsedFrames = p.pending * fps;
  p.pending = 0;
  if (sync === 'every') return 1;
  const delta = elapsedFrames + p.lagging;
  if (delta < 1) {
    p.lagging = 0;
    return 1;
  }
  const step = Math.floor(delta);
  p.lagging = delta - step;
  return step;
}

/**
 * Count a step shown at `now` (ms). Returns the achieved rate — steps per real second over the
 * window just closed — when a window closes, else null.
 */
export function meterStep(p: Pacer, now: number): number | null {
  if (p.windowStart === null) {
    p.windowStart = now;
    p.shown = 0;
    return null;
  }
  p.shown += 1;
  const seconds = (now - p.windowStart) / 1000;
  if (seconds < METER_WINDOW_SECONDS) return null;
  const rate = p.shown / seconds;
  p.windowStart = now;
  p.shown = 0;
  return rate;
}
