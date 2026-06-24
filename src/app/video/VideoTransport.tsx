// VideoTransport — the playback transport for the Video editor space (spine 1d
// follow-up). A jump-to-start button, a play/pause toggle, and a frame/time
// readout, all bound to the GLOBAL timeStore (the one clock the composite reads).
//
// The composite already redraws on every `timeStore.frame` change and Space
// already toggles play globally — what was missing was a VISIBLE transport in the
// surface (play state was invisible; the ruler wasn't scrubable). This bar plus
// the draggable comp ruler (LayerTimeline) make the authored opacity/rotation
// keyframes watchable while playing. The comp-frame readout routes through the
// SAME global↔comp map as the ruler playhead (videoTimelineGeometry, H95).
//
// REF: docs/COMPOSITOR-DESIGN.md §7; vyapti V8 (UI projection) + V57; issue #237.

import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { CompositionParams } from '../../nodes/Composition';
import { globalFrameToCompFrame } from './videoTimelineGeometry';

export function VideoTransport({ comp }: { comp: CompositionParams }) {
  const playing = useTimeStore((s) => s.playing);
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);

  const fps = comp.fps ?? 30;
  const totalFrames = Math.max(1, comp.durationFrames ?? 150);
  const compFrame = globalFrameToCompFrame(frame, FRAMES_PER_SECOND, fps, totalFrames);

  return (
    <div
      data-testid="video-transport"
      data-playing={playing}
      className="flex items-center gap-2 border-b border-line bg-bg px-3 py-1 text-xs"
    >
      <button
        type="button"
        data-testid="video-transport-start"
        aria-label="Jump to start"
        title="Jump to start"
        onClick={() => useTimeStore.getState().setTime(0)}
        className="rounded border border-line px-1.5 py-0.5 leading-none text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⏮
      </button>
      <button
        type="button"
        data-testid="video-transport-play"
        aria-label={playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => useTimeStore.getState().toggle()}
        className="rounded border border-line px-2 py-0.5 leading-none text-fg/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {playing ? '⏸' : '▶'}
      </button>
      <span data-testid="video-transport-readout" className="font-mono tabular-nums text-mute">
        {compFrame} / {totalFrames} · {seconds.toFixed(2)}s
      </span>
    </div>
  );
}
