// Timebar — minimal play/pause + scrub UI bound to timeStore.
//
// Lives in the layout's "timeline" grid slot. Acceptance #1 needs a
// user-perceivable affordance to scrub time; this is it. A full clip-aware
// timeline ships in P3 (THESIS.md §42).
//
// V1 stays clean: the slider mutates `timeStore` (UI projection), not the
// DAG. The viewport reads time on render and re-evaluates.
//
// P7 D2 (D-02 / D-06): an Auto-Key (record) toggle + an UNMISSABLE record
// indicator. When Auto-Key is armed, an inspector edit auto-keys at the
// playhead (D4). The unmissability is acceptance-blocking, NOT polish:
// the CONTEXT pre-mortem names "stray keys when record is silently on" as
// the Blender Auto-Key footgun. Mitigation is Blender's own pattern — a red
// record dot PLUS a tinted header treatment so the mode is impossible to
// miss regardless of which panel has focus. The toggle is the ONLY writer
// (it calls autoKeyStore.toggle); the indicator is a pure render of
// autoKeyStore.enabled — no new state. `record` accent token = UI-SPEC.md:200,
// exposed as the Tailwind `record` token (darkened to #cc2222 for the v0.6 #4
// light palette so the armed border still clears SC 1.4.11 3:1).

import { useAutoKeyStore } from './stores/autoKeyStore';
import { useTimeStore } from './stores/timeStore';

export function Timebar() {
  const seconds = useTimeStore((s) => s.seconds);
  const duration = useTimeStore((s) => s.durationSeconds);
  const playing = useTimeStore((s) => s.playing);
  const autoKey = useAutoKeyStore((s) => s.enabled);
  return (
    <div
      className={
        'flex items-center gap-3 border-t px-3 py-1 text-xs ' +
        (autoKey
          ? // Tinted header treatment — the unmissable mode skin. Red-tinted
            // background + record-colored border so Auto-Key is visible no
            // matter which panel has focus (footgun mitigation, D-02).
            'border-record/70 bg-record/15 text-fg/80'
          : 'border-border bg-muted/30 text-fg/70')
      }
      data-testid="timebar"
      data-autokey={autoKey ? 'on' : 'off'}
    >
      <button
        type="button"
        data-testid="timebar-toggle"
        onClick={() => useTimeStore.getState().toggle()}
        className="rounded border border-border px-2 py-0.5 font-mono hover:bg-muted"
      >
        {playing ? 'pause' : 'play'}
      </button>
      <button
        type="button"
        data-testid="autokey-toggle"
        aria-pressed={autoKey}
        title={autoKey ? 'Auto-Key is ON — edits insert keyframes' : 'Enable Auto-Key (record)'}
        onClick={() => useAutoKeyStore.getState().toggle()}
        className={
          'flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono ' +
          (autoKey
            ? 'border-record bg-record/25 text-record'
            : 'border-border text-fg/70 hover:bg-muted')
        }
      >
        <span
          // The red record dot. Filled + faintly pulsing only when armed so
          // the eye is drawn to it; a hollow ring when idle.
          data-testid="autokey-dot"
          aria-hidden="true"
          className={
            'inline-block h-2 w-2 rounded-full ' +
            (autoKey ? 'bg-record animate-pulse ring-2 ring-record/40' : 'border border-fg/40')
          }
        />
        REC
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
