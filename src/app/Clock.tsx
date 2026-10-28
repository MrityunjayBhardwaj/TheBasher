// Clock — runs requestAnimationFrame and steps the playhead while it is playing.
//
// File-rooted in `src/app/` (not `src/viewport/`) so V8 stays clean: this
// component invokes `useTimeStore.stepFrames(n)` which is a UI-projection
// store mutation, not a DAG dispatch. The DAG store remains untouched by
// playback.
//
// #1733 — each animation frame asks the pacer (`playbackPacing.ts`, Blender's playback step) how
// many whole frames are due: none until a frame period has passed, then one ("play every frame")
// or as many as real time has covered ("drop frames"). The achieved rate is published to the
// time store a few times a second for the Timebar.
//
// Mounting: rendered exactly once at App root (alongside Layout). The rAF
// loop runs even when paused — it reads `playing` and returns — so the cost of
// running while idle is one store read per frame.
//
// REF: THESIS.md §49, vyapti V8, krama K1; ref/GROUND_TRUTH_FRAME_UPDATE.md §STAGE 5.

import { useEffect } from 'react';
import { createPacer, framesDue, meterStep, resetPacer } from './playbackPacing';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';

export function Clock() {
  useEffect(() => {
    let rafId = 0;
    let last: number | null = null;
    const pacer = createPacer();
    function loop(now: number) {
      const time = useTimeStore.getState();
      if (!time.playing) {
        resetPacer(pacer);
      } else if (last !== null) {
        const frames = framesDue(pacer, time.sync, (now - last) / 1000, FRAMES_PER_SECOND);
        if (frames > 0) {
          time.stepFrames(frames);
          const rate = meterStep(pacer, now);
          if (rate !== null) time.setAchievedFps(rate);
        }
      }
      last = now;
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);
  return null;
}
