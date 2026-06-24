// exportCompositionAction — the "Export Video" user action for the Compositor
// (spine 1e): render the active Composition's timeline to a downloadable MP4 or
// PNG sequence. The video-mode sibling of renderAnimationAction (#189): it reuses
// the SAME format-agnostic frame loop + sinks (renderAnimation.ts), but each frame
// is the composite (captureCompositeFrame) instead of a 3D scene render — so the
// exported video is byte-for-byte the SAME planComposite+drawComposite the viewer
// shows (render==viewport, [[V37]], by construction — no second composite path).
//
// The loop advances the GLOBAL playhead over the comp's frames; the composite reads
// it (the transport's clock). Playhead seconds, play state, AND the comp-synced
// duration are all saved and restored (finally) — the export never leaves the
// timeline mutated.
//
// REF: docs/COMPOSITOR-DESIGN.md §6/§8 (export); renderAnimation.ts (loop + sinks);
//      src/app/video/compositeDecode.ts (captureCompositeFrame); vyapti V37 + V38
//      (surface every outcome); dharana B24; issue #237.

import { useDagStore } from '../../core/dag/store';
import { useProjectStore } from '../../core/project/store';
import { useCompositionStore } from '../stores/compositionStore';
import { FRAMES_PER_SECOND, useTimeStore } from '../stores/timeStore';
import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import {
  createMp4Sink,
  createPngSequenceSink,
  renderAnimation,
  RenderAnimationAborted,
  type FrameSink,
  type RenderAnimationFormat,
} from '../../render/renderAnimation';
import { captureCompositeFrame } from './compositeDecode';
import { globalFrameToCompFrame } from './videoTimelineGeometry';
import { downloadBlob } from '../downloadBlob';
import { type NotifyInput, useNotificationStore } from '../stores/notificationStore';
import { useRenderAnimationStore } from '../stores/renderAnimationStore';

export interface ExportCompositionResult {
  ok: boolean;
  reason?: string;
  cancelled?: boolean;
  format?: RenderAnimationFormat;
  frameCount?: number;
}

/** Resolve the comp to export: the explicitly-active one (compositionStore), else
 *  the first Composition node in the DAG — the SAME resolution VideoMode uses. */
function resolveActiveComposition(
  state: DagState,
): { id: NodeId; params: CompositionParams } | null {
  const activeId = useCompositionStore.getState().activeCompositionId;
  const active = activeId ? state.nodes[activeId] : undefined;
  if (active && active.type === 'Composition') {
    return { id: activeId as NodeId, params: active.params as CompositionParams };
  }
  for (const node of Object.values(state.nodes)) {
    if (node.type === 'Composition') {
      return { id: node.id as NodeId, params: node.params as CompositionParams };
    }
  }
  return null;
}

/**
 * Export the active composition to a file and download it. `format` 'mp4' falls
 * back to a PNG sequence when WebCodecs H.264 is unavailable (a surfaced warning,
 * never silent — V38). Always restores the playhead + play state + duration;
 * returns a result the feedback wrapper maps to a toast.
 */
export async function exportCompositionToFile(
  format: RenderAnimationFormat,
): Promise<ExportCompositionResult> {
  const state = useDagStore.getState().state;
  const comp = resolveActiveComposition(state);
  if (!comp) return { ok: false, reason: 'no-composition' };

  const { params, id } = comp;
  const width = params.width ?? 1280;
  const height = params.height ?? 720;
  const fps = params.fps ?? 30;
  const durationFrames = Math.max(1, params.durationFrames ?? 150);
  // The comp's playable range is frames [0, durationFrames).
  const frameCount = durationFrames;

  // Pick the sink; MP4 → PNG-sequence fallback when WebCodecs is unavailable.
  let sink: FrameSink;
  if (format === 'mp4') {
    const mp4 = await createMp4Sink(width, height, fps);
    if (mp4) {
      sink = mp4;
    } else {
      sink = createPngSequenceSink();
      useNotificationStore.getState().notify({
        severity: 'warn',
        message: 'MP4 isn’t supported in this browser — exporting a PNG sequence (.zip) instead.',
        durationMs: 8000,
      });
    }
  } else {
    sink = createPngSequenceSink();
  }

  const ctrl = new AbortController();
  useRenderAnimationStore.getState().begin(sink.format, frameCount, () => ctrl.abort());

  const time = useTimeStore.getState();
  const restoreSeconds = time.seconds;
  const restoreDuration = time.durationSeconds;
  const wasPlaying = time.playing;
  useTimeStore.getState().pause();
  // Size the playhead range to the comp so setTime never clamps a frame away.
  useTimeStore.getState().setDuration(durationFrames / fps);

  // ONE reusable comp-sized offscreen canvas for the whole export (no per-frame
  // alloc). The MP4 sink handles odd→even dims via its own scratch.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    useRenderAnimationStore.getState().end();
    return { ok: false, reason: 'no-2d-context' };
  }

  try {
    const output = await renderAnimation(
      {
        frameCount,
        fps,
        setTime: (s) => useTimeStore.getState().setTime(s),
        // The composite reads timeStore synchronously; no live scene to settle.
        waitForApply: () => Promise.resolve(),
        capture: async () => {
          const compFrame = globalFrameToCompFrame(
            useTimeStore.getState().frame,
            FRAMES_PER_SECOND,
            fps,
            durationFrames,
          );
          // Read state fresh each frame (the DAG is stable across the export; only
          // time advances) and composite via the SAME core the viewer uses.
          await captureCompositeFrame(useDagStore.getState().state, id, params, compFrame, ctx);
          return canvas;
        },
      },
      sink,
      {
        signal: ctrl.signal,
        onProgress: (done, total) => useRenderAnimationStore.getState().setProgress(done, total),
      },
    );

    const compName = params.name || 'composition';
    const projName = useProjectStore.getState().current?.name ?? 'untitled';
    const slug = `${projName}-${compName}`.replace(/\s+/g, '-').toLowerCase() || 'composite';
    downloadBlob(output.blob, `${slug}-${width}x${height}.${output.ext}`);
    return { ok: true, format: output.format, frameCount: output.frameCount };
  } catch (e) {
    if (e instanceof RenderAnimationAborted) return { ok: false, cancelled: true };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    useTimeStore.getState().setDuration(restoreDuration);
    useTimeStore.getState().setTime(restoreSeconds);
    if (wasPlaying) useTimeStore.getState().play();
    useRenderAnimationStore.getState().end();
  }
}

/** Map an export outcome to a toast (V38 — every outcome surfaced). Pure. */
export function exportCompositionResultToToast(result: ExportCompositionResult): NotifyInput {
  if (result.ok) {
    const label = result.format === 'mp4' ? 'MP4' : 'PNG sequence';
    return {
      severity: 'success',
      message: `Exported ${result.frameCount} frames → ${label} downloaded.`,
    };
  }
  if (result.cancelled) {
    return { severity: 'info', message: 'Video export cancelled.' };
  }
  if (result.reason === 'no-composition') {
    return {
      severity: 'error',
      message:
        'Export failed — no composition to export. Create one first (File ▸ New Composition).',
      durationMs: 8000,
    };
  }
  return {
    severity: 'error',
    message: `Video export failed: ${result.reason ?? 'unknown error'}.`,
    durationMs: 8000,
  };
}

/** The user-facing action wired to feedback: export + download, then toast the
 *  outcome. The Export menu calls THIS, so a failure is never silent. */
export async function exportCompositionWithFeedback(
  format: RenderAnimationFormat,
): Promise<ExportCompositionResult> {
  const result = await exportCompositionToFile(format);
  useNotificationStore.getState().notify(exportCompositionResultToToast(result));
  return result;
}
