// Timebar — minimal play/pause + scrub UI bound to timeStore.
//
// Lives in the layout's "timeline" grid slot. Acceptance #1 needs a
// user-perceivable affordance to scrub time; this is it. A full clip-aware
// timeline ships in P3 (THESIS.md §42).
//
// V1 stays clean: the slider mutates `timeStore` (UI projection), not the
// DAG. The viewport reads time on render and re-evaluates.

import { useTimeStore } from './stores/timeStore';

export function Timebar() {
  const seconds = useTimeStore((s) => s.seconds);
  const duration = useTimeStore((s) => s.durationSeconds);
  const playing = useTimeStore((s) => s.playing);
  return (
    <div
      className="flex items-center gap-3 border-t border-border bg-muted/30 px-3 py-1 text-xs text-fg/70"
      data-testid="timebar"
    >
      <button
        type="button"
        data-testid="timebar-toggle"
        onClick={() => useTimeStore.getState().toggle()}
        className="rounded border border-border px-2 py-0.5 font-mono hover:bg-muted"
      >
        {playing ? 'pause' : 'play'}
      </button>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={seconds}
        onChange={(e) => useTimeStore.getState().setTime(parseFloat(e.target.value))}
        className="flex-1"
        data-testid="timebar-scrub"
      />
      <span className="w-24 text-right font-mono tabular-nums" data-testid="timebar-readout">
        {seconds.toFixed(2)}s / {duration.toFixed(2)}s
      </span>
    </div>
  );
}
