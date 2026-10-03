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

import { useDagStore } from '../core/dag/store';
import { useAutoKeyStore } from './stores/autoKeyStore';
import { FRAMES_PER_SECOND, useTimeStore } from './stores/timeStore';
import { useShallow } from 'zustand/react/shallow';
import { sceneContentEnd, sceneEndSeconds, setSceneEnd } from './sceneRange';
import { useEditorStore } from './stores/editorStore';

export function Timebar() {
  const seconds = useTimeStore((s) => s.seconds);
  const duration = useTimeStore((s) => s.durationSeconds);
  // #1287 — the playhead may go past End (Blender does not hold it inside the range).
  const extent = useTimeStore((s) => s.extentSeconds);
  // The scene's End, from the graph: the field edits the scene, whatever range is playing.
  const sceneEnd = useDagStore((s) => sceneEndSeconds(s.state));
  // #1287 — content that runs past End is said, not quietly cut: Blender leaves End alone when a
  // longer clip arrives, and so does Basher, but it names what runs past and offers to extend.
  const past = useDagStore(
    useShallow((s) => {
      const end = sceneContentEnd(s.state);
      return { seconds: end.seconds, label: end.label };
    }),
  );
  const space = useEditorStore((s) => s.space);
  const runsPast = space !== 'video' && past.seconds > sceneEnd + 0.5 / FRAMES_PER_SECOND;
  const pastSentence =
    `${past.label ?? 'Animation'} runs to ${past.seconds.toFixed(2)}s, past End ` +
    `(${sceneEnd.toFixed(2)}s): playback loops and Render ▸ Animation stops at End. ` +
    'Extend moves End to where it ends.';
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
        max={Math.max(duration, extent)}
        step={0.01}
        value={seconds}
        onChange={(e) => useTimeStore.getState().setTime(parseFloat(e.target.value))}
        className="min-w-[4rem] flex-1"
        data-testid="timebar-scrub"
      />
      <span
        className="w-24 shrink-0 whitespace-nowrap text-right font-mono tabular-nums"
        data-testid="timebar-readout"
      >
        {seconds.toFixed(2)}s / {duration.toFixed(2)}s
      </span>
      {/* #1287 — the scene's End (Blender's Timeline header End). Committed on Enter or blur as
          one undoable edit; `key` resets the draft when End changes elsewhere (undo, agent). */}
      <label
        className="flex items-center gap-1"
        title="Scene End (Ctrl+End sets it at the playhead)"
      >
        End
        <input
          key={sceneEnd}
          type="number"
          min={1 / FRAMES_PER_SECOND}
          step={1 / FRAMES_PER_SECOND}
          defaultValue={sceneEnd.toFixed(2)}
          onBlur={(e) => {
            const typed = parseFloat(e.currentTarget.value);
            if (Number.isFinite(typed)) setSceneEnd(typed);
            // Show what End now is: a blank, a refused or a same-frame entry reads back the
            // stored value rather than leaving the draft standing.
            e.currentTarget.value = sceneEndSeconds(useDagStore.getState().state).toFixed(2);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="w-16 rounded border border-border bg-transparent px-1 font-mono tabular-nums"
          data-testid="timebar-end"
        />
        s
      </label>
      {runsPast && (
        // One compact control, because the island is narrow: what is wrong (⚠) and the fix
        // (Extend to where the content ends). Who runs past, and what End does, are in its label.
        <button
          type="button"
          data-testid="timebar-past-end"
          aria-label={pastSentence}
          title={pastSentence}
          onClick={() => setSceneEnd(past.seconds)}
          className="shrink-0 whitespace-nowrap rounded border border-warn/60 px-1.5 py-0.5 text-warn hover:bg-warn/15"
        >
          ⚠ Extend to {past.seconds.toFixed(2)}s
        </button>
      )}
    </div>
  );
}
